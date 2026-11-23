# Azure runbook — build and run ESL Annual Clock in ESL's Azure

Audience: an engineer or AI coding agent with **only this repository** and access to ESL's
Azure subscription / Entra tenant. Follow the steps in order; each ends with a check.
Read [`AGENTS.md`](../AGENTS.md) first for the codebase rules.

> **In ESL this app is built and run by the Software Factory** (EDP landing zone + Shipyard): the
> factory's catalog, vending and Pulumi stacks create the resources below, including the app's
> database on the **shared Azure SQL** server. Use this runbook as the technical specification of
> what the app needs, and the `az` commands as a reference or for a standalone environment.
>
> **Status of these instructions:** the application code, T-SQL migrations and tests are verified
> (CI runs the database tests on SQL Server 2022: `npm test`, `npm run build`). The `az` commands and Dockerfile were
> written for this runbook but **have not been executed** against ESL's subscription —
> verify flags against current `az` CLI docs (`az <cmd> --help`) as you go.

## 0. Decisions to confirm with ESL before starting

| Decision | Default in this runbook |
|---|---|
| Azure region | `swedencentral` (EU, close to Finland; `northeurope` also fine) |
| Resource naming | `rg-annualclock-<env>`, `<type>-annualclock-<env>` |
| Public URL | `https://annualclock.eslshipping.com` (custom domain on Container Apps) |
| Sender domain for email | subdomain `annualclock.eslshipping.com` verified in Azure Communication Services (ESL IT adds SPF/DKIM DNS records) |
| Network | public endpoints + Entra ID sign-in (simplest). Private VNet integration is optional hardening |
| Who manages clock membership | **in the app** (clock admins), Entra only authenticates. Entra group sync is optional (§7.4) |
| Personal calendar | `CALENDAR_PROVIDER=ics_invite` first; switch to `graph` after §8 |

## 1. Target architecture

```
Users (M365 / Entra ID) ──HTTPS──► Azure Container Apps: ca-annualclock (Next.js standalone, Dockerfile)
                                      │  managed identity → Key Vault secrets
                                      ├──► Azure SQL Database — shared database, schema annual_clock (Entra token, no password)
                                      ├──► Azure Communication Services Email (SMTP)  → reminder/digest/invite emails
                                      ├──► Microsoft Graph (later: calendar events)
                                      └──► Teams Workflows webhooks (per clock, configured in the app)
Container Apps Job (cron, hourly) ── curl ──► https://<app>/api/cron/notifications  (Bearer CRON_SECRET)
Log Analytics ◄── container logs (structured JSON from the notification job)
```

Resources: resource group, Log Analytics workspace, Container Apps environment, container app,
container apps job, Azure Container Registry, Key Vault, Azure SQL (shared logical server + database),
Communication Services + Email Communication Service (+ domain), Entra app registration(s).

## 2. Variables

```bash
ENV=prod
LOC=swedencentral
RG=rg-annualclock-$ENV
NAME=annualclock$ENV            # lowercase, used for globally unique names
ACR=acr$NAME
KV=kv-$NAME
SQLSRV=sql-annualclock-$ENV      # in the factory: the pool's shared logical server
SQLDB=sqldb-shared-$ENV          # in the factory: the shared database
CAE=cae-$NAME
APP=ca-$NAME
APP_URL=https://annualclock.eslshipping.com   # or the default *.azurecontainerapps.io URL first
az group create -n $RG -l $LOC
```

## 3. Azure SQL Database (shared)

The app needs, per environment:
- a **schema** `annual_clock` in the shared database (all its objects live there; `DATABASE_SCHEMA`),
- a **contained database user for the app's workload identity** (Container App managed identity) with
  `SELECT, INSERT, UPDATE, DELETE, EXECUTE ON SCHEMA::annual_clock` — and nothing more (no `db_owner`,
  no `ALTER` on the schema, no `ALTER ANY SECURITY POLICY`: it could switch the access rules off),
- a **migration identity** (CI or operator) that may create objects in the schema and has
  `ALTER ANY SECURITY POLICY` (needed by `0002_security.sql`). In a shared database this permission is
  database-wide: let the platform team decide who holds it.

With the factory, these come from the catalog entry (`database: { engine: azureSql, mode: shared }`) and vending;
the container receives `DATABASE_HOST`, `DATABASE_NAME` (and `DATABASE_SCHEMA`) as env vars.
**Confirm the exact variable names and permissions against the factory's current `application.yaml` /
bridge contract** and map them in the app stack if they differ. Standalone equivalent:

```bash
# Entra-only logical server (admin = an Entra group you are in) and a serverless database
az sql server create -g $RG -n $SQLSRV -l $LOC --enable-ad-only-auth   --external-admin-principal-type Group --external-admin-name "<sql admins group>" --external-admin-sid <group object id>
az sql db create -g $RG -s $SQLSRV -n $SQLDB --edition GeneralPurpose --compute-model Serverless   --family Gen5 --capacity 1 --auto-pause-delay 60 --backup-storage-redundancy Zone
az sql server firewall-rule create -g $RG -s $SQLSRV -n me --start-ip-address <your-ip> --end-ip-address <your-ip>  # remove afterwards
```

As an Entra admin of the database (e.g. Azure Data Studio / `sqlcmd -G`), once per environment:
```sql
CREATE SCHEMA annual_clock;
CREATE USER [ca-annualclockprod] FROM EXTERNAL PROVIDER;   -- the Container App's managed identity (by name)
GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON SCHEMA::annual_clock TO [ca-annualclockprod];
CREATE USER [annualclock-migrations] FROM EXTERNAL PROVIDER;  -- CI identity running db:migrate
GRANT CREATE TABLE, CREATE FUNCTION, CREATE PROCEDURE, CREATE VIEW, ALTER ANY SECURITY POLICY TO [annualclock-migrations];
GRANT ALTER, CONTROL ON SCHEMA::annual_clock TO [annualclock-migrations];
```

Migrate + (optional) demo data, from a machine or CI job with the repo, signed in as the migration identity:
```bash
npm ci
# Entra auth via DefaultAzureCredential (az login / workload identity):
DATABASE_HOST=$SQLSRV.database.windows.net DATABASE_NAME=$SQLDB npm run db:migrate
DATABASE_HOST=... DATABASE_NAME=... DEMO_EMAIL_BASE=someone@eslshipping.com npm run seed   # optional demo data
```
(`npm run seed` without Supabase env vars creates profiles with deterministic ids; they become
real users when they first sign in with Entra — see §7.2 email matching.)

✅ Check: CI is green (the RLS suite runs on SQL Server 2022); `select * from annual_clock.schema_migrations`
lists `0001_schema.sql`, `0002_security.sql`, `0003_audit.sql`; signed in as the app identity,
`select count(*) from annual_clock.clocks` returns **0** (no session context → RLS denies), which proves the policy is on.

## 4. Key Vault and secrets

```bash
az keyvault create -g $RG -n $KV -l $LOC --enable-rbac-authorization true
gen() { node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"; }
az keyvault secret set --vault-name $KV -n app-token-secret  --value "$(gen)"
az keyvault secret set --vault-name $KV -n cron-secret       --value "$(gen)"
az keyvault secret set --vault-name $KV -n smtp-pass         --value '<ACS SMTP secret, §6>'
az keyvault secret set --vault-name $KV -n entra-client-secret --value '<§7>'
az keyvault secret set --vault-name $KV -n session-secret    --value "$(gen)"
```

## 5. Container image and Container App

```bash
az acr create -g $RG -n $ACR --sku Basic -l $LOC
# After Entra auth replaces Supabase (§7), no NEXT_PUBLIC_* build args are needed. Until then:
az acr build -r $ACR -t annual-clock:latest .
az monitor log-analytics workspace create -g $RG -n log-$NAME -l $LOC
az containerapp env create -g $RG -n $CAE -l $LOC \
  --logs-workspace-id $(az monitor log-analytics workspace show -g $RG -n log-$NAME --query customerId -o tsv) \
  --logs-workspace-key $(az monitor log-analytics workspace get-shared-keys -g $RG -n log-$NAME --query primarySharedKey -o tsv)
az containerapp create -g $RG -n $APP --environment $CAE \
  --image $ACR.azurecr.io/annual-clock:latest --registry-server $ACR.azurecr.io --registry-identity system \
  --system-assigned --ingress external --target-port 3000 --min-replicas 1 --max-replicas 3 --cpu 0.5 --memory 1.0Gi
# let the app's identity read secrets, then wire them
PRINCIPAL=$(az containerapp show -g $RG -n $APP --query identity.principalId -o tsv)
az role assignment create --assignee $PRINCIPAL --role "Key Vault Secrets User" --scope $(az keyvault show -n $KV --query id -o tsv)
KVU=https://$KV.vault.azure.net/secrets
az containerapp secret set -g $RG -n $APP --secrets \
  app-token-secret=keyvaultref:$KVU/app-token-secret,identityref:system \
  cron-secret=keyvaultref:$KVU/cron-secret,identityref:system \
  smtp-pass=keyvaultref:$KVU/smtp-pass,identityref:system \
  entra-client-secret=keyvaultref:$KVU/entra-client-secret,identityref:system \
  session-secret=keyvaultref:$KVU/session-secret,identityref:system
az containerapp update -g $RG -n $APP --set-env-vars \
  DATABASE_HOST=$SQLSRV.database.windows.net DATABASE_NAME=$SQLDB DATABASE_SCHEMA=annual_clock \
  APP_TOKEN_SECRET=secretref:app-token-secret CRON_SECRET=secretref:cron-secret \
  APP_BASE_URL=$APP_URL DEFAULT_TIMEZONE=Europe/Helsinki DIGEST_SEND_TIME=08:00 \
  EMAIL_PROVIDER=smtp EMAIL_FROM='ESL Annual Clock <noreply@annualclock.eslshipping.com>' \
  SMTP_HOST=smtp.azurecomm.net SMTP_PORT=587 SMTP_USER='<§6>' SMTP_PASS=secretref:smtp-pass \
  CALENDAR_PROVIDER=ics_invite DEMO_LOGIN_ENABLED=false \
  ENTRA_TENANT_ID='<§7>' ENTRA_CLIENT_ID='<§7>' ENTRA_CLIENT_SECRET=secretref:entra-client-secret SESSION_SECRET=secretref:session-secret
```
Custom domain + managed certificate: `az containerapp hostname add` / `hostname bind --validation-method CNAME` (ESL IT creates the CNAME/TXT records).

✅ Check: `curl -I $APP_URL/login` → 200. Container logs (`az containerapp logs show -g $RG -n $APP`) show no env validation errors.

## 6. Email — Azure Communication Services (SMTP)

1. Create an **Email Communication Service** (data location Europe) and add the custom domain
   `annualclock.eslshipping.com`; ESL IT adds the TXT (verification), SPF and DKIM records it shows.
   (For a quick test an *Azure managed domain* works, but Outlook may flag it as external.)
2. Create a **Communication Services** resource (data location Europe) and connect the domain.
3. SMTP authentication: create an Entra app registration (e.g. `annualclock-smtp`) with a client
   secret; grant it the role required for SMTP on the Communication Services resource and create the
   SMTP username as described in Microsoft's "Send email with SMTP" guide for ACS. Host
   `smtp.azurecomm.net`, port `587` (STARTTLS). Put the username in `SMTP_USER`, secret in Key Vault `smtp-pass`.
4. `EMAIL_PROVIDER=smtp` sends all mail (reminders, digests, sign-in/invite mails) through
   `SmtpEmailProvider`; calendar invitations use the same `SMTP_*` settings (`SmtpInviteMailer`).

✅ Check: Administration → clock settings → **Send test notification** arrives in an
eslshipping.com mailbox. Then do the calendar invite check in `docs/calendar.md`
(REQUEST → move activity → update → delete → CANCEL in Outlook desktop/web/mobile).

## 7. Authentication — Microsoft Entra ID (replaces Supabase Auth)

### 7.1 App registration
- Entra ID → App registrations → New: `ESL Annual Clock`, single tenant.
- Redirect URI (Web): `$APP_URL/auth/callback` (+ `http://localhost:3000/auth/callback` for dev).
- Client secret → Key Vault `entra-client-secret`.
- API permissions (delegated): `openid`, `profile`, `email`, `offline_access`, `User.Read`
  (+ `Calendars.ReadWrite` when doing §8). Grant admin consent.
- Optional: *Assignment required* on the enterprise app to restrict who can sign in.

### 7.2 Code changes (the only auth-specific code is in a handful of files)
1. Add a migration `…_external_identity.sql`: `alter table profiles add column external_id text unique;`
   (Entra object id). **Keep `profiles.id` as the internal uuid** — every FK points at it.
2. Implement `EntraAuthProvider` in `lib/providers/entra/auth.ts` implementing `AuthProvider`
   (`lib/providers/auth.ts`), using `openid-client` (authorization code + PKCE):
   - `sendSignInLink` → not used; replace the login form with a **Sign in with Microsoft** button
     that hits a new route `app/auth/login/route.ts` (builds the authorize URL, stores PKCE verifier +
     state + `next` in a short-lived httpOnly cookie, redirects).
   - `app/auth/callback/route.ts`: validate state, exchange code, read `oid`, `preferred_username`/`email`,
     `name` from the ID token. Look up `profiles` by `external_id = oid`; if none, by `lower(email)` (users
     invited or seeded before first sign-in) and set `external_id`; if still none, create a profile
     (no clock access until an admin adds them). Reject if `is_active = false`.
   - Session: encrypted, httpOnly, `SameSite=Lax`, `Secure` cookie containing `{ profileId, exp }`
     (e.g. `jose` JWE with `SESSION_SECRET`), 8–12 h; `getCurrentUser()` decrypts it and returns
     `{ id: profileId, email }`. `signOut()` clears it (optionally redirect to Entra logout).
   - If §8 is planned: store the refresh token encrypted (new table, see `docs/calendar.md`).
3. `lib/server/auth.ts`: export the Entra provider instead of the Supabase one.
4. `proxy.ts`: replace the Supabase cookie refresh with a check for the session cookie (redirect to
   `/login` when missing). Keep it an optimistic check — RLS remains the enforcement.
5. `IdentityAdmin` usages (`app/(app)/clocks/[slug]/settings/actions.ts` → `inviteMember`,
   `app/(app)/admin/actions.ts` → `inviteUser`): instead of `ensureIdentity`/`generateSignInTokenHash`,
   upsert a profile by email (new uuid if absent) and email a plain link to `$APP_URL` ("sign in with
   your ESL Microsoft account"). The email→profile match in the callback activates it.
6. Remove `app/auth/confirm`, the demo switcher (`DEMO_LOGIN_ENABLED`), `lib/providers/supabase/*`,
   `@supabase/*` packages and `NEXT_PUBLIC_SUPABASE_*` / `SUPABASE_SERVICE_ROLE_KEY` env vars.
   `npm run seed` already works without Supabase.
7. Database: unchanged. `withUser(profileId)` keeps putting the internal profile id, flags and
   clock roles into `SESSION_CONTEXT`; the RLS policy reads them.
8. Update `e2e/smoke.spec.ts` login helper (e.g. a test-only signed session cookie behind an env flag
   that is never enabled in production, or Playwright `storageState` from a real test account).

### 7.3 Authorization stays in the database
Nothing in `docs/authorization.md` changes: roles live in `clock_members`, `profiles.global_role`
and `profiles.all_clocks_viewer`; RLS enforces them. Set the first super admin by SQL (as a
database admin; the column guard only allows this in service context):
```sql
EXEC sp_set_session_context N'app_service', 1;
UPDATE annual_clock.profiles SET global_role = N'super_admin' WHERE lower(email) = N'<it-owner>@eslshipping.com';
```

### 7.4 Optional: Entra group → clock role sync
Mapping proposal in `docs/authorization.md` (`Clock-<Department>-Viewers/Editors/Admins`,
`AnnualClock-GeneralManagement`, `AnnualClock-SuperAdmins`). Implement as: table
`clock_groups(clock_id, entra_group_id, role)`; on sign-in read group ids (ID token `groups` claim or
Graph `/me/memberOf`) and upsert/delete `clock_members` rows that came from groups (add a
`source text default 'app'` column so app-managed memberships are not removed). Disable the in-app
member editor for group-managed clocks.

✅ Check: sign in with an ESL account; first sign-in of a seeded/invited email links to the existing
profile; a user without membership sees "no clocks"; `npm test` and the e2e smoke tests pass.

## 8. Personal calendar via Microsoft Graph (optional upgrade of "Add to my Outlook")
Follow `docs/calendar.md` → *Provider 2*. Requires §7 (delegated token with `Calendars.ReadWrite`
and `offline_access`). Implement `GraphTokenSource`, register with `setGraphTokenSource()` at startup,
set `CALENDAR_PROVIDER=graph`, migrate existing `ics_invite` links once.

## 9. Scheduler — Container Apps Job (hourly)

```bash
az containerapp job create -g $RG -n job-$NAME-notify --environment $CAE \
  --trigger-type Schedule --cron-expression "5 * * * *" --replica-timeout 300 --replica-retry-limit 1 \
  --image curlimages/curl:8.10.1 \
  --secrets cron-secret=keyvaultref:$KVU/cron-secret,identityref:system --mi-system-assigned \
  --env-vars CRON_SECRET=secretref:cron-secret APP_URL=$APP_URL \
  --command "/bin/sh" --args "-c" 'curl -fsS -m 240 -H "Authorization: Bearer $CRON_SECRET" "$APP_URL/api/cron/notifications"'
# (grant the job's identity "Key Vault Secrets User" like the app's)
```
Hourly is recommended (send time 08:00 Helsinki is then hit within the hour). The job is
idempotent and catches up, so missed runs are harmless.
**Alternative**: an Azure Functions timer trigger calling `runDefaultNotificationJob()` and
`calendar.retryFailed()` directly (code sketch in `docs/azure-migration.md`) — more moving parts;
the HTTP job above needs no extra code.

✅ Check: Administration → *Notification job* shows a successful run within the hour;
`npm run notify:dry-run` (pointed at the Azure DB) matches expectations.

## 10. Go-live checklist
- [ ] `DEMO_LOGIN_ENABLED` is not set (or `false`); `EMAIL_REDIRECT_TO` is not set.
- [ ] Demo data removed (`delete from clocks where is_demo; delete from profiles where is_demo;`) or kept intentionally.
- [ ] Real clocks/rings/members created (Administration → Clocks) and first super admin set.
- [ ] Teams webhooks configured per clock and tested.
- [ ] Azure SQL: temporary firewall rules removed; app identity has only schema-level DML/EXECUTE (no db_owner, no ALTER ANY SECURITY POLICY); point-in-time restore retention confirmed; auditing to Log Analytics on.
- [ ] Alert: Log Analytics query for no `"msg":"run finished"` in 3 h → email IT.
- [ ] Acceptance criteria in `AGENTS.md` §9 re-verified on Azure.
