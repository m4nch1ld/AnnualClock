# Migrating to Azure

The prototype was built so that moving from Supabase + Vercel to Azure is mostly
configuration. Business logic lives in `/lib` as plain TypeScript, the data model is
standard PostgreSQL 15+, and every external service sits behind a small interface.

## Mapping

| Prototype | Azure | Effort |
|---|---|---|
| Supabase Auth (email magic link) | **Microsoft Entra ID** (OIDC, single sign-on with Microsoft 365) | Implement `AuthProvider` (≈1 file) + sign-in route; replace `IdentityAdmin` with Microsoft Graph |
| Supabase Postgres | **Azure Database for PostgreSQL – Flexible Server** (PG 16/17) | Run the same migrations; redefine one SQL function |
| `pg` data access with RLS | unchanged | none |
| Vercel Cron → `/api/cron/notifications` | **Azure Functions timer trigger** calling `runDefaultNotificationJob()` | ≈20 lines |
| Resend (`EmailProvider`) | **Azure Communication Services Email** | Implement `EmailProvider` (≈30 lines) |
| Vercel (Next.js hosting) | **Azure Container Apps** (recommended) or Azure App Service; Static Web Apps works for hybrid Next.js but has limits | Dockerfile with `output: "standalone"` |
| Teams webhook | unchanged (or Graph API / bot later) | none |
| Environment variables | **Azure Key Vault** references in Container Apps / Functions settings | config |
| Rate limiting table | unchanged (Postgres) — or Azure Front Door WAF rules | none |

## Step by step

### 1. Database
1. Create Azure Database for PostgreSQL Flexible Server (EU region, PG 16+).
2. Create the roles the RLS policies use:
   ```sql
   create role authenticated nologin;
   create role anon nologin;
   grant authenticated to <app_login_role>;   -- so the app can `set local role authenticated`
   create schema auth;
   ```
3. Replace the identity hook. Supabase provides `auth.uid()`; on Azure define it (or change
   `app.current_user_id()`) to read the per-transaction setting the app already sets:
   ```sql
   create or replace function auth.uid() returns uuid language sql stable as $$
     select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
   $$;
   ```
   (`lib/db/index.ts` → `withUser()` already does `set_config('request.jwt.claim.sub', <user id>, true)`.)
4. Grant table privileges to `authenticated` (Supabase does this by default):
   `grant usage on schema public, app to authenticated; grant select, insert, update, delete on all tables in schema public to authenticated;`
   then re-run the RLS migration's `revoke`/column `grant` statements (they are idempotent).
5. `DATABASE_MIGRATION_URL=<azure> npm run db:migrate`.
6. Move data: `pg_dump --data-only --schema=public` from Supabase → `psql` into Azure, or use the CSV
   export per clock. Profiles keep their ids; map them to Entra object ids (step 2).
7. The only Supabase-specific extension usage is optional `pg_cron`/`pg_net`; nothing in the data
   model depends on them.

### 2. Identity (Entra ID)
1. App registration in Entra ID: redirect URI `https://<app>/auth/callback`, scopes `openid profile email`,
   group claims enabled (or use Graph).
2. Implement `AuthProvider` (`lib/providers/auth.ts`) with an OIDC library (e.g. `openid-client` or
   Auth.js Microsoft Entra provider): `getCurrentUser()` returns `{ id: <Entra object id>, email }`
   from the session cookie; `completeSignIn()` handles the code callback. Select it in
   `lib/server/auth.ts`. Remove the magic-link form and the demo switcher.
3. **Profile ids**: Entra object ids are GUIDs, so they fit `profiles.id`. Either migrate existing
   profiles to the object ids (update `profiles.id` and cascade), or add `profiles.external_id`.
4. **Authorization**: map Entra groups to clock roles as described in
   [`authorization.md`](authorization.md#mapping-to-microsoft-entra-id) — sync group memberships into
   `clock_members` on sign-in / nightly via Graph. RLS stays unchanged.
5. `IdentityAdmin.inviteUser` becomes "add the user to the clock's Entra group" (Graph) or is
   removed in favour of IT-managed groups.

### 3. Scheduler (Azure Functions)
```ts
// functions/notifications.ts  (Azure Functions v4, Node 20)
import { app } from "@azure/functions";
import { runDefaultNotificationJob } from "../lib/notifications";

app.timer("annual-clock-notifications", {
  schedule: "0 5 * * * *", // hourly at :05
  handler: async (_timer, ctx) => {
    const r = await runDefaultNotificationJob();
    ctx.log(JSON.stringify({ sent: r.sent, failed: r.failed, alreadySent: r.alreadySent }));
  },
});
```
The function needs `DATABASE_URL`, `APP_TOKEN_SECRET`, `APP_BASE_URL`, email settings. Hourly is
free on Azure, removing the Vercel Hobby daily limitation. Remove the `crons` entry from `vercel.json`.

### 4. Email (Azure Communication Services)
```ts
import { EmailClient } from "@azure/communication-email";
export class AcsEmailProvider implements EmailProvider {
  readonly name = "acs";
  private client = new EmailClient(process.env.ACS_CONNECTION_STRING!);
  async send(m: EmailMessage) {
    const poller = await this.client.beginSend({
      senderAddress: process.env.EMAIL_FROM!,
      recipients: { to: [{ address: m.to }] },
      content: { subject: m.subject, html: m.html, plainText: m.text },
    });
    const r = await poller.pollUntilDone();
    return { id: r.id };
  }
}
```
Register it in `getEmailProvider()` (`lib/providers/email.ts`) and verify the `eslshipping.com`
domain in ACS.

### 5. Hosting
- Add `output: "standalone"` to `next.config.ts`, build a container
  (`node .next/standalone/server.js`), deploy to **Azure Container Apps** with Key Vault–backed
  secrets and a managed identity.
- Put Azure Front Door in front for TLS, WAF and (optionally) private access for internal users.

## Things to change (checklist)

- [ ] `lib/server/auth.ts` → Entra `AuthProvider`; delete Supabase auth files and `@supabase/*`
- [ ] `proxy.ts` → check the Entra session cookie instead of Supabase's
- [ ] `auth.uid()` / `app.current_user_id()` defined on Azure Postgres (see above)
- [ ] roles `authenticated`, `anon` + grants on Azure Postgres
- [ ] `lib/providers/email.ts` → ACS provider
- [ ] Azure Function timer → `runDefaultNotificationJob()`; remove `vercel.json` cron
- [ ] Key Vault for `APP_TOKEN_SECRET`, `CRON_SECRET` (only if the HTTP route is kept), DB credentials
- [ ] Group → clock role sync (Graph) and disable in-app invites
- [ ] `APP_BASE_URL`, Teams webhooks unchanged
- [ ] Re-run `npm test` (RLS suite uses plain Postgres semantics) and `npm run test:e2e` against the new URL
