# Authorization model

All rules are enforced in **PostgreSQL Row Level Security** (`supabase/migrations/*_rls.sql`).
The UI hides actions a user cannot perform, but that is a convenience only: every
query runs as the database role `authenticated` with the user's id set, so a
user calling the API directly gets exactly the same answer as the UI.

Tests: `tests/db/rls.test.ts` (runs the real migrations in an in-process Postgres).

## Identities and roles

| Concept | Where | Meaning |
|---|---|---|
| User | `profiles` (id = IdP subject) | A person. `is_active = false` removes all access. |
| Super admin | `profiles.global_role = 'super_admin'` | IT / prototype owner. Acts as admin of every clock; manages users and clocks. |
| General management | `profiles.all_clocks_viewer = true` | **Read** access to every clock. Chosen over "membership in every clock" because new clocks are covered automatically and it maps to a single Entra group. |
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
| Create / delete clocks, manage users, view job runs | | | | | ✓ |
| Own notification preferences and ICS feeds | ✓ | ✓ | ✓ | ✓ | ✓ |

Users without any role in a clock (and without the global flags) can neither
read nor write any row belonging to it.

### Email action links
"Mark done" / "Snooze" links in emails carry an HMAC-signed, expiring token
(`lib/tokens.ts`) naming the activity, occurrence and recipient. The server
verifies the signature and expiry, checks the recipient is **still active**, and
performs the write **through RLS as the recipient** — so it only succeeds if they can
still edit the clock. Viewers do not get these buttons.

### Server-only data
- `clock_secrets` (Teams webhook URLs), `rate_limits`: RLS enabled with **no
  policies** — unreachable for signed-in users; only trusted server code reads them.
- `notification_log`, `in_app_notifications`, `job_runs`, `audit_log`: written by
  the server / triggers only. Users read their own notifications; clock admins
  read their clock's log; super admins read job runs.
- Privileged profile columns (`global_role`, `all_clocks_viewer`, `is_active`)
  are not updatable by users (column-level grants). Super-admin operations run
  server-side after an explicit check.

## SQL building blocks

| Function | True when |
|---|---|
| `app.current_user_id()` | (identity hook) — returns the signed-in user's id |
| `app.is_super_admin()` | active user with `global_role = 'super_admin'` |
| `app.is_all_clocks_viewer()` | active user with `all_clocks_viewer` |
| `app.clock_role(clock)` | the user's role in the clock (null if none / inactive) |
| `app.can_read_clock(clock)` | super admin, all-clocks viewer, or any role |
| `app.can_edit_clock(clock)` | super admin, or editor/admin |
| `app.is_clock_admin(clock)` | super admin, or admin |

## Mapping to Microsoft Entra ID

Each clock maps to up to three Entra security groups, plus two global groups:

| Entra group | App concept |
|---|---|
| `Clock-<Department>-Viewers` | `clock_members.role = viewer` |
| `Clock-<Department>-Editors` | `clock_members.role = editor` |
| `Clock-<Department>-Admins` | `clock_members.role = admin` |
| `AnnualClock-GeneralManagement` | `profiles.all_clocks_viewer = true` |
| `AnnualClock-SuperAdmins` | `profiles.global_role = super_admin` |

Two implementation options:

1. **Sync (recommended):** on sign-in (and nightly via Microsoft Graph), read the
   user's group memberships and upsert `clock_members` / profile flags. RLS stays
   unchanged. Clock admins then manage membership in Entra instead of the app
   (disable the in-app invite UI or have it call Graph).
2. **Claims:** put group ids in the token and replace `app.clock_role()` with a
   lookup against a `clock_groups(clock_id, entra_group_id, role)` table and the
   group ids passed per request (`set_config('app.groups', ...)`).

`app.current_user_id()` is the only function that knows about the identity
provider; on Azure redefine it to read e.g. `current_setting('app.user_id')`,
set by the server per transaction (see `lib/db/index.ts`).
