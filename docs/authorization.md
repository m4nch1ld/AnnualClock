# Authorization model

All rules are enforced in **Azure SQL Database Row-Level Security** (`database/migrations/0002_security.sql`).
The UI hides actions a user cannot perform, but that is a convenience only: every
query runs inside `withUser()` with the user's identity in the connection's session
context, so a user calling the API directly gets exactly the same answer as the UI.

Tests: `tests/db/rls.test.ts` runs the real migrations on a real SQL Server 2022 (CI service
container; locally when `TEST_DATABASE_URL` is set) through the app's own `lib/db`.

## Identities and roles

| Concept | Where | Meaning |
|---|---|---|
| User | `profiles` (internal id; `external_id` = identity-provider subject) | A person. `is_active = 0` removes all access. |
| Super admin | `profiles.global_role = 'super_admin'` | IT / prototype owner. Acts as admin of every clock; manages users and clocks. |
| General management | `profiles.all_clocks_viewer = 1` | **Read** access to every clock. Chosen over "membership in every clock" because new clocks are covered automatically and it maps to a single Entra group. |
| Clock role | `clock_members.role` | `viewer`, `editor` or `admin`, per clock. A user can be in 1..n clocks with different roles. |

## Permission matrix

| Action | viewer | editor | admin (clock) | all_clocks_viewer | super_admin |
|---|---|---|---|---|---|
| See clock, rings, activities, members | ✓ | ✓ | ✓ | ✓ (all clocks) | ✓ |
| Create / edit / drag / soft-delete activities | | ✓ | ✓ | | ✓ |
| Complete / snooze an occurrence | | ✓ | ✓ | | ✓ |
| See soft-deleted activities | | | ✓ | | ✓ |
| Read audit log | | ✓ | ✓ | ✓ | ✓ |
| Manage rings | | | ✓ | | ✓ |
| Edit clock settings (name, color, reminder defaults, escalation, Teams) | | | ✓ | | ✓ |
| Invite members / change roles / remove members | | | ✓ | | ✓ |
| Create / delete clocks, change slug or General-management marker, manage users, view job runs | | | | | ✓ |
| Own notification preferences and ICS feeds | ✓ | ✓ | ✓ | ✓ | ✓ |

Users without any role in a clock (and without the global flags) can neither
read nor write any row belonging to it.

## How it works on SQL Server

SQL Server RLS has no per-request database roles, so the app passes identity through
`SESSION_CONTEXT`, set by `lib/db` at the start of **every** transaction:

| Key | Set by | Meaning |
|---|---|---|
| `app_service` | `withService()` → 1, `withUser()` → 0 | trusted server code (scheduler, token endpoints, super-admin operations) |
| `user_id` | `withUser()` | the signed-in user — **only if the profile is active**, else NULL |
| `user_flags` | `withUser()` | `S` super admin, `G` General management |
| `clock_roles` | `withUser()` | JSON `{"<clock id>": "v" \| "e" \| "a"}` |

`withUser()` reads the flags and roles from `profiles`/`clock_members` **inside the same
transaction** before switching `app_service` to 0. The security policy's predicate
functions (`rls_*`, inline table-valued, schema-bound) only compare row columns with
this context — they never read tables, so there is no recursion and evaluation is cheap.
With no context set, every predicate denies.

Behaviour differences from a row filter only:
- **Filter predicates** hide rows (SELECT/UPDATE/DELETE see nothing → 0 rows affected).
- **Block predicates** reject writes on visible rows with an error (SQL error 33504), e.g. a
  viewer updating an activity. `lib/db` maps it to code `42501` / "permission denied".
- **Column rules** (SQL Server RLS is row-based) are triggers that `THROW 50001`:
  `trg_profiles_guard` (role/flags/email/active only by service), `trg_clocks_guard`
  (slug, General-management marker only by super admin), `trg_inapp_guard` (users only set
  `read_at`), `trg_ics_guard` (users only rename/revoke feeds).

Limits: `clock_roles` must fit in session context (≈90 clock memberships per user). Role
changes take effect from the user's next request (each request re-reads them).

### Email action links
"Mark done" / "Snooze" links in emails carry an HMAC-signed, expiring token
(`lib/tokens.ts`) naming the activity, occurrence and recipient. The server
verifies the signature and expiry, checks the recipient is **still active**, and
performs the write **through RLS as the recipient** (`withUser(token.uid)`) — so it only
succeeds if they can still edit the clock. Viewers do not get these buttons.

### Server-only data
- `clock_secrets` (Teams webhook URLs), `rate_limits`, `calendar_links` writes,
  `notification_log` writes, `job_runs` writes, `audit_log` writes: allowed only with
  `app_service = 1`. Users read their own notifications, links and log entries; clock
  admins read their clock's notification log; super admins read job runs.
- Audit triggers raise `app_service` only for their own insert into `audit_log` and restore it.

## SQL building blocks (`[annual_clock]` schema)

| Function | Allows when |
|---|---|
| `rls_ctx(@clock_id)` | (helper) exposes svc, super_admin, gm, uid, role from session context |
| `rls_service(x)` | service context |
| `rls_super(x)` | service or super admin |
| `rls_signed_in(x)` | service or an active signed-in user |
| `rls_self(@user_id)` | service or the row belongs to the user |
| `rls_read_clock(@clock_id)` | service, super admin, General management, or any role in the clock |
| `rls_edit_clock(@clock_id)` | service, super admin, or editor/admin |
| `rls_admin_clock(@clock_id)` | service, super admin, or admin |
| `rls_read_activity`, `rls_prefs_*`, `rls_nlog_read`, `rls_ics_write`, `rls_audit_read` | table-specific combinations (see migration) |

Application code may call these directly for UI checks, e.g.
`select case when exists (select 1 from [annual_clock].rls_admin_clock($1)) then 1 else 0 end`.

## Database permissions (shared database)

| Identity | Needs | Must NOT have |
|---|---|---|
| App runtime (Container App workload identity) | `SELECT, INSERT, UPDATE, DELETE, EXECUTE ON SCHEMA::annual_clock` | `db_owner`, `ALTER ANY SECURITY POLICY`, `ALTER` on the schema (it could disable the policy) |
| Migrations (CI / operator identity) | create tables, functions, triggers in the schema and `ALTER ANY SECURITY POLICY` | runtime traffic |

## Mapping to Microsoft Entra ID

Each clock maps to up to three Entra security groups, plus two global groups:

| Entra group | App concept |
|---|---|
| `Clock-<Department>-Viewers` | `clock_members.role = viewer` |
| `Clock-<Department>-Editors` | `clock_members.role = editor` |
| `Clock-<Department>-Admins` | `clock_members.role = admin` |
| `AnnualClock-GeneralManagement` | `profiles.all_clocks_viewer = 1` |
| `AnnualClock-SuperAdmins` | `profiles.global_role = super_admin` |

Recommended: on sign-in (and nightly via Microsoft Graph), read the user's group
memberships and upsert `clock_members` / profile flags. RLS stays unchanged, because
`withUser()` reads them from the tables on each request. See `docs/azure-runbook.md` §7.4.
