# Migrating to Azure — service mapping

The prototype was built so that moving from Supabase + Vercel to Azure is mostly
configuration. Business logic lives in `/lib` as plain TypeScript, the data model is standard
PostgreSQL 16+, and every external service sits behind a small interface.

**Step-by-step instructions: [`azure-runbook.md`](azure-runbook.md).** This page is the overview.

## Mapping

| Prototype | Azure | What changes in the code |
|---|---|---|
| Supabase Auth (email magic link) | **Microsoft Entra ID** (OIDC, M365 single sign-on) | New `AuthProvider` + `/auth/login` and `/auth/callback` routes; `profiles.external_id` column; remove `lib/providers/supabase` (runbook §7) |
| Supabase Postgres | **Azure Database for PostgreSQL Flexible Server** (PG 16) | none — run `supabase/bootstrap/plain-postgres.sql` once, then the same migrations (tested on every `npm test`) |
| RLS via `withUser()` | unchanged | none |
| Vercel Cron → `/api/cron/notifications` | **Container Apps Job** (hourly `curl` with `CRON_SECRET`), or Azure Functions timer | none (or ~20 lines for a Function, below) |
| Resend (`EmailProvider`) | **Azure Communication Services Email** via SMTP | none — `EMAIL_PROVIDER=smtp` + `SMTP_*` (already implemented) |
| "Add to my Outlook" via email invitations | same over ACS SMTP; later **Microsoft Graph** events | Graph provider is implemented (`lib/calendar/graph.ts`); needs a token source after Entra (docs/calendar.md) |
| Vercel hosting | **Azure Container Apps** (`Dockerfile`, `output: "standalone"`) | none |
| Vercel env vars | **Key Vault** references in Container Apps | config |
| Teams webhooks | unchanged | none |
| Rate limiting (Postgres table) | unchanged (optionally Front Door WAF) | none |

## Identity: keep internal ids

`profiles.id` stays the internal UUID that every foreign key references. Entra's object id
(`oid`) goes into a new `profiles.external_id` column. On first sign-in the callback matches
`external_id`, else the email (users invited or seeded before they ever signed in), and stores
the `oid`. `app.current_user_id()` / `auth.uid()` keep returning the internal id that
`withUser()` sets per transaction — RLS is untouched.

Authorization stays in the database (`clock_members`, `profiles.global_role`,
`profiles.all_clocks_viewer`). Mapping clocks to Entra groups is optional and described in
`authorization.md` and runbook §7.4.

## Optional: Azure Functions timer instead of the HTTP job

```ts
// functions/notifications.ts  (Azure Functions v4, Node 20) — bundle /lib with the function
import { app } from "@azure/functions";
import { runDefaultNotificationJob } from "../lib/notifications";
import { calendar } from "../lib/calendar";

app.timer("annual-clock-notifications", {
  schedule: "0 5 * * * *", // hourly at :05
  handler: async (_t, ctx) => {
    const r = await runDefaultNotificationJob();
    const c = await calendar.retryFailed();
    ctx.log(JSON.stringify({ sent: r.sent, failed: r.failed, alreadySent: r.alreadySent, calendar: c }));
  },
});
```
Needs the same env vars as the app (`DATABASE_URL`, `APP_TOKEN_SECRET`, `APP_BASE_URL`, email/SMTP).

## Checklist

- [ ] Bootstrap SQL + migrations on Azure Postgres (runbook §3)
- [ ] ACS Email with verified ESL subdomain; `EMAIL_PROVIDER=smtp` (runbook §6)
- [ ] Entra `AuthProvider`, `profiles.external_id`, Supabase removed (runbook §7)
- [ ] Container App with Key Vault secrets (runbook §4–5)
- [ ] Hourly scheduler job; remove `crons` from `vercel.json` (runbook §9)
- [ ] Calendar invitation behaviour verified in Outlook; optionally Graph provider (docs/calendar.md)
- [ ] `npm test`, build, and acceptance criteria (AGENTS.md §9) green on Azure
