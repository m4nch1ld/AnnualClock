# AGENTS.md — handover for AI coding agents

You are taking over **ESL Annual Clock**, a working prototype built on Supabase + Vercel, and
your job is to **build and run it in ESL Shipping's Azure environment**. This repository is all
you get. Read this file fully, then follow [`docs/azure-runbook.md`](docs/azure-runbook.md).

## 1. What the product is

ESL Shipping (Finnish dry-bulk shipping company) needs one **annual clock** per department
(Operations, Chartering, Crewing, Technical, Environmental, Safety, Shipbuilding, General
management). A clock is a circular year planner (inspired by Plandisc): months and ISO weeks
around a wheel, concentric **rings**, **activities** drawn as arcs (periods) or markers
(deadlines/milestones). Work is recurring and regulatory (verifications, submissions, audits,
renewals, budget cycles). **The core value is that nothing is missed even if nobody opens the
app**: reminders, overdue escalations, Teams posts, weekly digests and calendar feeds are pushed
to people.

Canonical example: the Environmental director adds *EUA verification due* and *EUA submission /
surrender due*, both yearly, reminders 30/14/7/1 days before, notifying the director and
subscribed team members; if not marked done by the due date, an escalation goes to the clock
admins and General management.

## 2. Current state (what exists and is verified)

| Area | State |
|---|---|
| Clocks, rings, roles (viewer/editor/admin), super admin, General management read-all | ✅ RLS-enforced, tested |
| SVG wheel (zoom, drag, click-to-create, overlay of several clocks), list view (a11y fallback), month view, filters | ✅ |
| Activities: types, recurrence (RRULE), per-occurrence completion/snooze, "this and future" split, dependencies, soft delete, audit log | ✅ |
| Notifications: planner + idempotent job, email, in-app, Teams webhook, weekly digest, escalation, retries, signed email action links | ✅ unit-tested; real email sending only verified up to provider (Resend test mode) |
| ICS subscription feeds (per clock / combined) | ✅ |
| **"Add to my Outlook"** personal calendar entries kept in sync (email invitations; Graph provider ready) | ✅ unit-tested; Outlook behaviour to be verified with a verified sender domain (`docs/calendar.md`) |
| Admin: users, clocks, members/invites, notification settings, job health, CSV/ICS import, CSV export | ✅ |
| Auth | Supabase magic link (prototype). **Must be replaced by Entra ID on Azure** (runbook §7) |
| Hosting/scheduler | Vercel + Vercel Cron (prototype). **Azure: Container Apps + Container Apps Job** (runbook §5, §9) |
| Email | Resend (prototype). **Azure: Communication Services via SMTP** (`EMAIL_PROVIDER=smtp`, runbook §6) — already implemented |
| Database | **Azure SQL Database** (Software Factory policy: Azure SQL first), app schema `annual_clock` in the factory's **shared** database; Entra workload-identity sign-in. T-SQL migrations in `database/migrations`; RLS tested on SQL Server 2022 in CI — already implemented |

## 3. Non-negotiable rules (keep these when you change code)

1. **Authorization lives in Azure SQL Row-Level Security.** User-facing queries run in `withUser(profileId, tx => …)`
   (`lib/db/index.ts`), which puts the user's id, flags and clock roles into `SESSION_CONTEXT`; the security
   policy's predicates allow or deny every row (`docs/authorization.md`). Never query user
   data with `withService()` unless the code has explicitly authorised the action first (super-admin
   checks, token endpoints, scheduler). Rules: `docs/authorization.md`; tests: `tests/db/rls.test.ts`.
2. **Business logic stays in `/lib` as plain TypeScript** (no Next.js/Vercel/Supabase imports in
   `lib/notifications`, `lib/calendar`, `lib/recurrence.ts`, `lib/dates.ts`, `lib/domain.ts`,
   `lib/wheel`). Next.js routes/actions are thin wrappers.
3. **External services sit behind interfaces**: `AuthProvider`/`IdentityAdmin` (`lib/providers/auth.ts`),
   `EmailProvider` (`lib/providers/email.ts`), `NotificationChannel` (`lib/notifications/types.ts`),
   `CalendarProvider` + `InviteMailer` (`lib/calendar`). Swap implementations; don't spread vendor code.
4. **Validate all server input with Zod** (`lib/validation.ts`). Server actions are the mutation API.
5. **Dates**: all-day dates are `date` columns handled as `'YYYY-MM-DD'` strings with UTC arithmetic
   (`lib/dates.ts`). `lib/db` normalises results: `date` → `'YYYY-MM-DD'`, `datetimeoffset` → ISO string,
   `time` → `'HH:MM'`, `uniqueidentifier` → lowercase, JSON columns (`JSON_COLUMNS`) → parsed. Send times are computed in `Europe/Helsinki` with `@date-fns/tz` (DST-safe).
6. **Notification idempotency**: every delivery is claimed in `notification_log` (unique on
   occurrence + reminder key + recipient + channel) *before* sending. Never send outside the job's
   claim → send → mark flow.
7. **Schema changes = new T-SQL file** in `database/migrations/` (number prefix, never edit applied ones),
   objects in `[$(SCHEMA)]`, batches separated by `GO`. Every new table gets filter + block predicates in the
   security policy (`ALTER SECURITY POLICY … ADD …`) and RLS tests. No `OUTPUT` without `INTO` on tables with
   triggers; generate ids in the app (`randomUUID()`), use `tx.exec()` row counts.
8. **Secrets** only via env vars (Key Vault on Azure); only `NEXT_PUBLIC_*` reaches the browser.
9. Strings in `lib/i18n/en.ts` (Finnish to be added as `fi.ts`).

## 4. Repository map

```
app/                       Next.js 16 App Router
  (app)/clocks/            clock list, [slug] workspace, [slug]/settings (admin), actions.ts (activity mutations)
  (app)/overview           multi-clock overlay
  (app)/settings           user notification prefs, digest, ICS feeds
  (app)/admin              super admin: users, clocks, job health
  (app)/notifications      in-app notification list
  a/[token]                email action page (Mark done / Snooze) — signed token, POST-only change
  auth/confirm, auth/signout, login/   Supabase magic-link auth (to be replaced by Entra)
  api/cron/notifications   scheduler entry (Bearer CRON_SECRET): notification job + calendar retries
  api/ics/[token]          private ICS feed
  api/activities/[id]/ics  one-off .ics download
  api/clocks/[slug]/export CSV export
components/clock/          wheel.tsx (SVG), list-view, agenda-view, activity-panel, workspace
lib/
  db/                      mssql pool, withUser / withService (SESSION_CONTEXT), result normalisation
  data/clocks.ts           read queries
  notifications/           planner.ts (pure) · job.ts · sql-repository.ts · channels.ts · messages.ts · templates.ts
  calendar/                "Add to my Outlook": sync.ts · ics-invite.ts · mailers.ts · graph.ts · sql-repository.ts
  providers/               auth.ts (interfaces), email.ts (Resend/SMTP/console), supabase/ (to be removed on Azure)
  server/                  session, auth selection, rate limit, workspace loader, calendar hooks
  recurrence.ts dates.ts domain.ts validation.ts tokens.ts ics.ts import-export.ts i18n/ wheel/
database/migrations/       T-SQL: 0001 schema · 0002 security (RLS policy, column guards) · 0003 audit triggers
scripts/                   migrate.ts, seed.ts, notify.ts
tests/                     Vitest: lib/* (pure), db/rls.test.ts (real SQL Server via TEST_DATABASE_URL; CI service container)
e2e/                       Playwright smoke tests
docs/                      authorization, notifications, calendar, azure-runbook, azure-migration, backlog
Dockerfile                 standalone Next.js container (untested here: no Docker on the build machine)
```

## 5. Run and verify locally

```bash
npm ci
cp .env.example .env.local          # fill in; see comments. Needs SQL Server 2022+ or Azure SQL Database:
#   a) SQL Server in Docker:  docker run -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD=... -p 1433:1433 mcr.microsoft.com/mssql/server:2022-latest
#   b) an Azure SQL dev database (Entra auth: DATABASE_HOST/DATABASE_NAME, `az login` locally)
npm run db:migrate && npm run seed && npm run dev
npm test                # unit, notification job, calendar sync; + SQL Server RLS suite when TEST_DATABASE_URL is set (always in CI)
npm run typecheck
NEXT_DIST_DIR=.next-build npm run build   # production build without disturbing a running dev server
npm run test:e2e        # needs seeded data + DEMO_LOGIN_ENABLED=true (Supabase auth) — adapt after Entra
npm run notify:dry-run  # what the scheduler would send now; add -- --now=2027-03-01T07:00:00Z to simulate
```
Without Supabase env vars the app cannot sign anyone in until Entra auth (runbook §7) is
implemented — that is the expected first task on Azure. Tests and `notify:dry-run` work without it.

## 6. Your task list on Azure (in order)

Follow `docs/azure-runbook.md`; summary:

1. Provision: resource group, Key Vault, ACR, Container Apps env, Log Analytics — and get the app's database on the
   factory's **shared Azure SQL** (runbook §3): a schema `annual_clock` + a contained user for the app's workload identity.
2. Database: `npm run db:migrate` with a migration identity; optional `npm run seed`.
3. Email: Azure Communication Services Email with ESL's verified subdomain, SMTP credentials →
   `EMAIL_PROVIDER=smtp`, `SMTP_*`. (No code change needed.)
4. **Implement Entra ID sign-in** (runbook §7.2 lists every file to touch). Add `profiles.external_id`.
   Remove Supabase packages, routes and env vars afterwards.
5. Build the container (`Dockerfile`) via `az acr build`, deploy the Container App with Key Vault secret refs.
6. Scheduler: Container Apps Job hourly `curl` to `/api/cron/notifications` with `CRON_SECRET`.
7. Verify calendar invitations in Outlook (`docs/calendar.md`); optionally move to the Graph provider (runbook §8).
8. Update tests (e2e login helper), docs, `.env.example`, and remove `vercel.json` cron once Azure is live.
9. Run the acceptance checklist (§9).

## 7. Environment variables

| Variable | Used for | Azure source |
|---|---|---|
| `DATABASE_HOST` `DATABASE_NAME` | Azure SQL server + database; sign-in with the workload identity (Entra token, no password) | env (from the factory's data stack / bridge) |
| `AZURE_CLIENT_ID` | client id of a user-assigned managed identity (omit for system-assigned) | env |
| `DATABASE_SCHEMA` | the app's schema in the shared database (default `annual_clock`) | env |
| `DATABASE_URL` | alternative: ADO-style connection string (local SQL Server, CI) | local only |
| `DATABASE_MIGRATION_URL` | `npm run db:migrate` with a more privileged identity (falls back to the above) | CI / operator |
| `TEST_DATABASE_URL` | SQL Server where tests create throwaway databases | CI |
| `DATABASE_POOL_MAX` | pool size per replica (default 5) | env |
| `APP_BASE_URL` | links in emails, ICS, invites | env |
| `APP_TOKEN_SECRET` | HMAC for email action links (≥32 chars) | Key Vault |
| `CRON_SECRET` | protects `/api/cron/notifications` | Key Vault |
| `DEFAULT_TIMEZONE` / `DIGEST_SEND_TIME` | `Europe/Helsinki` / `08:00` | env |
| `EMAIL_PROVIDER` | `smtp` on Azure (`resend`, `console` also available) | env |
| `EMAIL_FROM` | sender, e.g. `ESL Annual Clock <noreply@annualclock.eslshipping.com>` | env |
| `SMTP_HOST` `SMTP_PORT` `SMTP_USER` `SMTP_PASS` | ACS SMTP (mail + calendar invites) | env + Key Vault |
| `CALENDAR_PROVIDER` | `ics_invite` (default) or `graph` | env |
| `CALENDAR_ORGANIZER_EMAIL` | ORGANIZER of invitations (defaults to EMAIL_FROM address) | env |
| `EMAIL_REDIRECT_TO` | demo safety net: all mail to one address. **Unset in prod** | — |
| `DEMO_LOGIN_ENABLED` | one-click demo users on /login. **Never in prod** | — |
| `DEMO_EMAIL_BASE` | seed only | — |
| `RESEND_API_KEY` | prototype email | remove on Azure |
| `NEXT_PUBLIC_SUPABASE_URL` `NEXT_PUBLIC_SUPABASE_ANON_KEY` `SUPABASE_SERVICE_ROLE_KEY` | prototype auth | remove after Entra |
| `ENTRA_TENANT_ID` `ENTRA_CLIENT_ID` `ENTRA_CLIENT_SECRET` `SESSION_SECRET` | **to be introduced** with Entra auth (runbook §7) | Key Vault / env |

## 8. Gotchas found while building

- `rrule` is CommonJS: import via the namespace interop used in `lib/recurrence.ts` / `lib/calendar/graph.ts`.
- One transaction = one connection: **never `Promise.all` queries on the same `tx`**.
- SQL Server specifics: no arrays/`jsonb` (JSON text + `openjson($1)` for lists), upsert = `UPDATE … WITH (UPDLOCK, HOLDLOCK); IF @@ROWCOUNT = 0 INSERT`,
  `TOP (n)` instead of `LIMIT`, no `OUTPUT` on tables with triggers, block predicates raise errors (33504) where Postgres
  silently updated 0 rows, unique indexes treat NULLs as equal (used for idempotency keys), FKs don't cascade (multiple
  cascade paths are rejected) — the app soft-deletes.
- The session context must be set by `withUser`/`withService` at the start of **every** transaction (pooled connections keep it).
- Files with `"use server"` export only async server actions — helpers that take a `tx` live in
  `lib/server/*` (otherwise they become publicly callable endpoints).
- SVG coordinates are rounded (`polar()` in `lib/wheel/geometry.ts`) to avoid hydration mismatches.
- Email links are prefetched by Outlook Safe Links: anything that changes state must be a POST
  (see `app/a/[token]` and `app/auth/confirm`).
- Outlook recognises meeting requests only as a `text/calendar; method=REQUEST` alternative part →
  invitations need SMTP (nodemailer `icalEvent`), not an API attachment.
- Next.js 16: middleware is `proxy.ts`; `params`/`searchParams`/`cookies()` are async; `after()` is used
  to sync calendars after the response.
- `npm install` on npm 11 may block `esbuild`'s install script (`npm install-scripts approve esbuild`).
- Building while `next dev` runs clobbers `.next`; use `NEXT_DIST_DIR=.next-build`.

## 9. Acceptance criteria (verify on Azure before handing back)

- [ ] Environmental director adds the two EUA dates (yearly, reminders 30/14/7/1), sees them on the
      wheel; `notify:dry-run --now=<30 days before>` lists the reminders; a real send reaches an
      eslshipping.com mailbox.
- [ ] A user without Safety membership cannot see or fetch Safety data (`/clocks/safety` → 404,
      `/api/clocks/safety/export` → 404; `npm test` RLS suite green).
- [ ] A user in two clocks can switch between them and see them overlaid (`/overview`).
- [ ] General management sees all clocks read-only.
- [ ] Running the notification job twice in a row sends nothing the second time (job_runs + notification_log).
- [ ] "Mark done" from an email link stops reminders/escalations for that occurrence only.
- [ ] Overdue items escalate to clock admins (+ General management) at +1/+7 days.
- [ ] ICS subscription works in Outlook; **"Add to my Outlook"** creates, updates (after a drag) and
      removes (after delete) the event in the user's own calendar.
- [ ] Sign-in with ESL Entra ID accounts only; no Supabase dependency left.
- [ ] README and docs updated to describe the Azure setup.

## 10. Where to look for more

`README.md` (overview, local run) · `docs/authorization.md` (RLS rules + Entra group mapping) ·
`docs/notifications.md` (scheduler, idempotency, channels, Teams setup) · `docs/calendar.md`
("Add to my Outlook") · `docs/azure-runbook.md` (step-by-step Azure build) ·
`docs/azure-migration.md` (service mapping) · `docs/backlog.md` (ideas not built).
