# ESL Annual Clock (prototype)

A circular year planner ("annual clock") for ESL Shipping departments, inspired by
Plandisc. Each department (Operations, Chartering, Crewing, Technical, Environmental,
Safety, Shipbuilding, General management) has its own clock with rings, recurring
activities and deadlines. **Reminders, escalations, Teams posts and calendar feeds
reach people even when nobody opens the app.** Users can also put any activity into their own
Outlook calendar with **Add to my Outlook**; the entry stays in sync with the clock
([`docs/calendar.md`](docs/calendar.md)).

| | |
|---|---|
| Stack | Next.js 16 (App Router, TypeScript strict) · Tailwind 4 · **Azure SQL Database** (shared database, own schema, row-level security) via `mssql` · Supabase Auth (prototype sign-in; Entra ID on Azure) · Resend / SMTP · scheduler-agnostic notification job |
| Tests | Vitest (unit, notification job, calendar sync; RLS on a real SQL Server 2022 in CI) · Playwright smoke tests |
| Docs | [`AGENTS.md`](AGENTS.md) (handover / Azure build) · [`docs/azure-runbook.md`](docs/azure-runbook.md) · [`docs/authorization.md`](docs/authorization.md) · [`docs/notifications.md`](docs/notifications.md) · [`docs/calendar.md`](docs/calendar.md) · [`docs/azure-migration.md`](docs/azure-migration.md) · [`docs/backlog.md`](docs/backlog.md) |

> **Building this on Azure?** Start with [`AGENTS.md`](AGENTS.md) and [`docs/azure-runbook.md`](docs/azure-runbook.md).

---

## 1. Run locally (≈15 minutes)

**Prerequisites:** Node 20+ (tested on 24), git, a SQL Server 2022+ or Azure SQL database, and a free Supabase project (prototype sign-in only).
Easiest SQL Server: `docker run -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD='<Strong!Pass1>' -p 1433:1433 -d mcr.microsoft.com/mssql/server:2022-latest`
(then `CREATE DATABASE annual_clock`), or an Azure SQL dev database with Entra sign-in (`az login`).

```bash
git clone <repo> esl-annual-clock && cd esl-annual-clock
npm install
cp .env.example .env.local
```

Fill in `.env.local` (every variable is explained in `.env.example`):

1. **Supabase → Project settings → API**: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
2. **Database**: `DATABASE_URL=Server=localhost,1433;Database=annual_clock;User Id=sa;Password=...;Encrypt=true;TrustServerCertificate=true`
   — or, for Azure SQL with Entra sign-in, `DATABASE_HOST` + `DATABASE_NAME` (no password). Objects go into schema
   `DATABASE_SCHEMA` (default `annual_clock`).
3. Generate secrets: `APP_TOKEN_SECRET` and `CRON_SECRET`
   (`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`).
4. Optional: `RESEND_API_KEY` (without it, emails are printed to the console). With Resend's test
   sender (`onboarding@resend.dev`) mail is only delivered to the Resend account owner's address,
   so set `EMAIL_REDIRECT_TO` to that address for demos.
5. Demo: `DEMO_LOGIN_ENABLED=true`, `DEMO_EMAIL_BASE=you@company.com` (demo users become
   `you+envdirector@company.com`, etc.).

```bash
npm run db:migrate   # applies database/migrations/*.sql (T-SQL; tracked in annual_clock.schema_migrations)
npm run seed         # 8 clocks × 3 rings, 6 demo users, 25 activities (resets rows marked is_demo)
npm run dev          # http://localhost:3000
```

Sign in with the **demo user switcher** on the login page, or enter the email of an existing
user to receive a magic link.

### Demo users (created by `npm run seed`)

| User | Access |
|---|---|
| Super admin (`DEMO_EMAIL_BASE`) | everything; admin of General management and Safety |
| Emma Environmental (Director) | admin of Environmental, editor in Safety |
| Erik Environmental (Team) | editor in Environmental, subscribed to all its activities |
| Greta General Management | read access to all clocks (`all_clocks_viewer`), weekly digest |
| Carl Crewing (Editor) | editor in Crewing |
| Vera Viewer | viewer in Operations and Environmental |

### Try the EUA example
1. Sign in as **Emma Environmental**, open **Environmental**. The demo already contains
   *EUA verification due* and *EUA submission / surrender due* (yearly, reminders 30/14/7/1,
   owner Emma, assignee Erik; *submission* follows *verification*). Add your own with **+ New activity**
   (Repeats: Yearly; untick "Use clock default" to set reminders).
2. See what the scheduler would send on the 30-day reminder date:
   `npx tsx scripts/notify.ts --dry-run --now=2027-03-01T07:00:00Z`
3. Send for real now: `npm run notify:run` (or *Administration → Run now*).
4. Open the "Mark done" link from the email (or the clock) — further reminders and escalations
   for **that occurrence only** stop; next year's occurrence still reminds.

## 2. Scripts

| Script | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm run db:migrate` | Apply T-SQL migrations (splits `GO` batches, substitutes the schema) |
| `npm run seed` | Reset and recreate demo data |
| `npm run notify:dry-run` | Print what the notification job would send now (no sends, no claims). `-- --now=<ISO>` simulates another moment |
| `npm run notify:run` | Run the notification job once |
| `npm test` | Vitest: unit, notification engine, calendar sync; SQL Server RLS suite when `TEST_DATABASE_URL` is set (always in CI) |
| `npm run test:e2e` | Playwright smoke tests (needs seeded data, `DEMO_LOGIN_ENABLED=true`; first time: `npx playwright install chromium`) |
| `npm run typecheck` | TypeScript |

## 3. Deploy

**Production target: ESL's Azure via the Software Factory** — follow [`AGENTS.md`](AGENTS.md) and
[`docs/azure-runbook.md`](docs/azure-runbook.md). The steps below describe the original prototype hosting
(Vercel + Supabase Auth) and still work for a quick demo, now with an Azure SQL database.

1. **Database**: an Azure SQL database reachable from Vercel (allow Azure/Vercel egress in its firewall, SQL auth
   connection string in `DATABASE_URL`). Run `npm run db:migrate` (and optionally `npm run seed`) from your machine.
   **Supabase**: create a project (EU region) for sign-in only.
2. **Supabase → Authentication → URL configuration**: Site URL = `https://<your-app>.vercel.app`,
   add `https://<your-app>.vercel.app/**` to Redirect URLs. (Sign-in links are generated server-side
   and emailed by the app, so Supabase's own email templates are not used.)
3. **Vercel**: import the git repository (framework: Next.js). Add every variable from
   `.env.example` in *Settings → Environment Variables* with production values, and set
   `APP_BASE_URL=https://<your-app>.vercel.app`, `DEMO_LOGIN_ENABLED=false`.
4. Deploy. `vercel.json` registers the cron job `GET /api/cron/notifications` daily at 05:00 UTC
   (08:00 Helsinki in summer, 07:00 in winter). Vercel automatically sends
   `Authorization: Bearer $CRON_SECRET`.
5. **Email**: verify your sending domain in Resend and set `EMAIL_FROM` to an address on it;
   remove `EMAIL_REDIRECT_TO`.
6. Check *Administration → Notification job* after the first scheduled run.

> **Vercel Hobby runs cron jobs once a day** (and the exact minute is not guaranteed).
> The job is tolerant: every run processes all send times since the last successful run
> (up to 14 days back) and is idempotent, so a daily run delivers everything — just up to a day
> late if the clock's send time is later than the cron time. For hourly runs either use **Vercel
> Pro** (`"schedule": "0 * * * *"`) or let **Supabase `pg_cron` + `pg_net`** call the route hourly
> (see [`docs/notifications.md`](docs/notifications.md)).

## 4. Architecture

```
app/                    Next.js routes: pages, server actions, API routes
  (app)/clocks/...      clock list, clock workspace (wheel/list/month), clock settings
  (app)/overview        multi-clock overlay ("All departments" for General management)
  (app)/settings        my notification preferences, digest, ICS feeds
  (app)/admin           super admin: users, clocks, notification job health
  a/[token]             email action page (Mark done / Snooze) — signed, expiring token
  api/cron/notifications  scheduler entry point (CRON_SECRET)
  api/ics/[token]       private calendar feed
  api/clocks/[slug]/export  CSV export
components/clock/       SVG wheel, list view, month view, activity panel
lib/                    framework-independent logic (portable to Azure Functions)
  notifications/        planner (pure) · job runner · SQL repository · channels · templates
  providers/            AuthProvider / EmailProvider + Supabase / Resend implementations
  db/                   mssql pool: withUser() (RLS via SESSION_CONTEXT) / withService()
  recurrence.ts dates.ts domain.ts wheel/ ics.ts import-export.ts tokens.ts validation.ts i18n/
database/migrations/    T-SQL: schema, row-level security policy, audit triggers
scripts/                migrate, seed, notify
tests/ e2e/             Vitest and Playwright
```

**Key decisions**

- **Azure SQL with row-level security.** User requests run inside `withUser(userId)`, which puts the
  user's id, flags and clock roles into `SESSION_CONTEXT`; the database's security policy enforces
  every rule — the mechanism the RLS tests exercise on SQL Server. All objects live in the
  app's own schema, so the factory's **shared** database can host it. Supabase is only the prototype's sign-in.
- **General management** = `profiles.all_clocks_viewer` flag (read access to all clocks, automatically
  including new ones). See `docs/authorization.md`.
- **Dates** for all-day items are `date` columns handled as ISO strings; send times are computed in
  Europe/Helsinki with DST handled by `@date-fns/tz`.
- **Recurrence** is stored as an RRULE body and expanded only for the requested range. Completion,
  snooze and status are per occurrence (`activity_occurrences_state`). "This and future" edits split
  the series.
- **Notifications**: see [`docs/notifications.md`](docs/notifications.md).
- **Personal calendar** ("Add to my Outlook"): opt-in per activity; iCalendar invitations by email,
  updated/cancelled when the activity changes; Microsoft Graph provider ready for Azure. See
  [`docs/calendar.md`](docs/calendar.md).
- **Theme**: ESL brand palette (green/teal accents, Poppins) in one file, `app/theme.css`.
- **i18n**: strings in `lib/i18n/en.ts`; add `fi.ts` with the same keys for Finnish. Dates use
  `d.M.yyyy` for Finnish, weeks start on Monday (ISO weeks).

## 5. Security notes

- No secrets in client bundles (only `NEXT_PUBLIC_SUPABASE_URL`/`ANON_KEY` are public; the anon
  role has no table access at all).
- All server input validated with Zod; server actions are origin-checked by Next.js (CSRF).
- Email action links: HMAC-signed, 30-day expiry, POST-only changes, rate limited, and executed
  through RLS as the recipient. Sign-in links require a click on a confirm page, so mail scanners
  (Outlook Safe Links) cannot consume them.
- ICS tokens: 256-bit random, stored as SHA-256 hashes, revocable, rate limited.
- Teams webhook URLs are stored in `clock_secrets` (no RLS policies → server only) and restricted
  to Microsoft webhook hosts.
- CSV export neutralises spreadsheet formulas.
- Security headers in `next.config.ts`. CSP is listed in the backlog.
