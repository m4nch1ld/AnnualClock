# "Add to my Outlook" — personal calendar entries

**UX decision (ESL, 2026-10-12):** every activity sends reminder emails by default; it does
**not** appear in anyone's personal calendar unless they ask. Each activity has an
**Add to my Outlook** button (activity panel → *My Outlook calendar*). The entry then
**stays in sync**: moving, editing or deleting the activity updates or removes it.

## Behaviour

| User action / event | Calendar effect |
|---|---|
| *Add all occurrences* (recurring activity) | one recurring all-day event (RRULE) |
| *Add only this occurrence* | one all-day event for that date |
| *Add to my Outlook* (one-off activity) | one all-day event (or multi-day for periods) |
| Activity moved / title, description, ring, recurrence changed | update (same UID, SEQUENCE + 1) |
| Only status / owner / reminders changed | nothing (content hash unchanged) |
| Activity deleted, cancelled, clock archived | cancellation |
| Occurrence no longer exists (series shortened) | cancellation of that occurrence link |
| "This and future" edit splits the series | old series updated (ends earlier); users who had the series get the new series too |
| User removed from the clock / deactivated | cancellation |
| *Remove from my calendar* | cancellation |
| Delivery fails | link keeps `last_error`; the scheduler (`/api/cron/notifications`) retries |

Events are **all-day, shown as Free** (deadlines do not block meeting time) and request no
RSVP replies. Reminders keep coming by email; the calendar entry is an extra.
*Download .ics* is a one-off copy (not updated) for other calendar apps.

## Architecture

```
activity panel ──► addToMyCalendar / removeFromMyCalendar   (app/(app)/clocks/actions.ts, RLS read check)
activity save/move/delete/status ──► syncCalendarAfter()   (lib/server/calendar-hooks.ts, runs after the response)
scheduler ──► calendar.retryFailed()                       (app/api/cron/notifications/route.ts)
                     │
                     ▼
        lib/calendar/sync.ts   (pure logic: build event, content hash, create/update/cancel decisions)
          ├─ CalendarRepository → lib/calendar/pg-repository.ts  (table calendar_links)
          └─ CalendarProvider
               ├─ IcsInviteProvider (lib/calendar/ics-invite.ts)  ← prototype default
               │     └─ InviteMailer: SmtpInviteMailer (nodemailer, proper text/calendar part)
               │                      EmailProviderInviteMailer (.ics attachment fallback)
               └─ GraphCalendarProvider (lib/calendar/graph.ts)    ← Azure target, not wired yet
```

Table `calendar_links` (migration `20261012000005`): one active row per user + activity
(+ occurrence). Stores the iCalendar `uid`, `sequence`, `content_hash`, Graph `external_id`,
`last_error`. RLS: users can read their own rows; all writes are server-side.

## Provider 1 — iCalendar invitation (prototype default)

`CALENDAR_PROVIDER=ics_invite`. The app emails the user a meeting request
(`METHOD:REQUEST`); Outlook adds it to their own calendar when accepted and applies later
REQUESTs with the same UID and higher SEQUENCE as updates, and `METHOD:CANCEL` as removal.

**Outlook needs the iCalendar data as a `text/calendar; method=REQUEST` alternative body
part** — an `.ics` attachment is shown as a file. That is why invites go through SMTP
(`SMTP_*` env vars; nodemailer `icalEvent`). Without SMTP, the regular `EmailProvider` sends
an attachment (works in Gmail/Apple, weaker in Outlook).

Before relying on it in production, verify in the ESL tenant (≈2 h): send REQUEST → update
(move the activity) → CANCEL to a test mailbox and check Outlook desktop, web and mobile add,
move and remove the event automatically. The sending domain must be verified (SPF/DKIM),
otherwise invites may be junked or flagged as external.

## Provider 2 — Microsoft Graph (target on Azure)

`CALENDAR_PROVIDER=graph`. Creates the event directly in the user's mailbox (no email, appears
instantly), updates with `PATCH /me/events/{id}`, removes with `DELETE`. `transactionId = uid`
makes creation idempotent. RRULE → Graph `patternedRecurrence` mapping is in `graph.ts`
(yearly, monthly by day or "last Friday", weekly, daily, UNTIL/COUNT); rules Graph cannot
express (e.g. last day of month) are rejected — the UI then needs "add this occurrence".

To enable (after Entra ID sign-in exists, see `docs/azure-runbook.md` step 7):
1. Entra app registration: delegated permissions `openid profile email offline_access
   Calendars.ReadWrite`; admin consent for the tenant.
2. Store each user's refresh token server-side, encrypted (new table, e.g.
   `user_oauth_tokens(user_id, provider, refresh_token_encrypted, expires_at)`, RLS no policies).
3. Implement `GraphTokenSource.getToken(userId)` (refresh → access token, cache until expiry) and
   register it at startup: `setGraphTokenSource(...)` (`lib/calendar/index.ts`).
4. Set `CALENDAR_PROVIDER=graph`. Existing `ics_invite` links keep their provider value; either
   leave them on email updates (the sync uses the configured provider for *all* links — so
   migrate: cancel old invites once, then re-create via Graph), or ask users to re-add.
   Simplest: run a one-off script that, for each active `ics_invite` link, sends CANCEL with the
   invite provider and then creates the event via Graph, updating `provider`/`external_id`.

Application permissions (`Calendars.ReadWrite` for the whole tenant) are **not** recommended;
if ever used, restrict them with an Exchange Online RBAC for Applications scope.

## Tests

`tests/lib/calendar.test.ts`: invite ICS content (REQUEST/CANCEL/PUBLISH), Graph recurrence
mapping, full sync lifecycle (add → no-op → update with SEQUENCE+1 → cancel, occurrence gone,
access lost, failure + retry, remove and re-add). `tests/db/rls.test.ts`: users only see their
own links and cannot write them.
