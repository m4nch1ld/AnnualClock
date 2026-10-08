# Notifications

The goal: nothing is missed because nobody opened the clock. Reminders are pushed by
a scheduled job; ICS feeds provide a pull-based safety net.

## Flow

```
scheduler (Vercel Cron / Azure timer / pg_cron / CLI)
   └─> runNotificationJob(deps, { now })              lib/notifications/job.ts
         1. window = (end of last successful run − 1 h overlap, now]   (capped at 14 days)
         2. data   = repository.loadPlannerData()                      pg-repository.ts
         3. intents = planNotifications(data, window)                  planner.ts (pure)
         4. retry failed / stuck entries whose backoff has elapsed
         5. for each intent: claim (INSERT … ON CONFLICT DO NOTHING) → send via channel → mark sent/failed
         6. job_runs row with window + stats; structured JSON logs
```

## What gets planned

| Kind | When (local send time, Europe/Helsinki) | Recipients | Channels |
|---|---|---|---|
| Reminder `reminder:-N` | N days before each occurrence date, for every N in the activity's reminder offsets (else the clock default, e.g. 30/14/7/1; 0 = on the day) | owner, assignees, members who subscribed to the whole clock — if notifications are on for that clock | user's channels (email, in-app); email skipped for users who chose "weekly digest only" |
| Snooze `snooze:<date>` | on the snooze date | same as reminders | email + in-app |
| Escalation `escalation:+N` | N days after the due date (default +1 and +7) if the occurrence is not done/cancelled | clock admins and/or General management (per clock config) | always email + in-app |
| Teams | together with reminders/escalations | the clock's Teams channel | Adaptive Card via webhook |
| Weekly digest `digest:<ISO week>` | Monday at `DIGEST_SEND_TIME` (default 08:00) | users with weekly digest on | email: overdue + next 30 days across their clocks |

"Due date" = end date for periods, otherwise the date. Marking an occurrence done (in the
app or from the email link) removes it from planning, so no further reminders or
escalations are sent **for that occurrence**; other occurrences of the series are unaffected.

## Guarantees

- **Idempotent**: `notification_log` has a unique constraint on
  `(activity_id, occurrence_date, reminder_key, recipient_id, channel)` (`NULLS NOT DISTINCT`).
  A delivery is claimed before it is sent, so concurrent or repeated runs never send twice.
  Running the job twice in a row sends nothing the second time (tested).
- **Tolerant**: a late or missed run catches up on everything since the last successful window.
- **Retries**: failures are retried by later runs with exponential backoff (10, 20, 40, 80 min), up
  to 5 attempts. Entries stuck in `pending` (crash mid-send) are retried after 15 minutes.
- **Observable**: every send is a row in `notification_log` (visible to clock admins in clock
  settings); every run is a row in `job_runs` (visible to super admins under Administration, with
  a health badge if no successful run in 26 h).

## Scheduling options

| Option | Frequency | How |
|---|---|---|
| Vercel Hobby | daily | `vercel.json` (already configured, 05:00 UTC) |
| Vercel Pro | hourly | change schedule to `0 * * * *` |
| Supabase pg_cron + pg_net | hourly | see below |
| Azure Functions | any | timer trigger calling `runDefaultNotificationJob()` (see azure-migration.md) |
| Manual | — | `npm run notify:run`, or Administration → Run now |

pg_cron (optional, Supabase only — the app does not depend on it):

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule('annual-clock-notifications', '5 * * * *', $$
  select net.http_get(
    url := 'https://<your-app>.vercel.app/api/cron/notifications',
    headers := jsonb_build_object('Authorization', 'Bearer <CRON_SECRET>')
  );
$$);
```

## Channels

All channels implement `NotificationChannel` (`lib/notifications/types.ts`):

```ts
interface NotificationChannel { id: ChannelId; send(ctx: DeliveryContext): Promise<{ providerId?: string } | void> }
```

Implemented: `email` (any `EmailProvider`; Resend today), `in_app`, `teams`. To add SMS or Web
Push: implement the interface, register it in `createChannels()`, add the channel id to user
preferences and the planner's `USER_CHANNELS`.

### Microsoft Teams setup (per clock)

In the Teams channel: **⋯ → Workflows → "Post to a channel when a webhook request is received"**,
finish the wizard and copy the URL. In the app: *Clock settings → Notifications → Teams webhook URL*,
tick *Post reminders and escalations to Teams*, save, then *Send test notification*.
Legacy "Incoming Webhook" connector URLs (`*.webhook.office.com`) also work.

## Email links

Reminder emails include **Open in clock** and, for recipients who can edit the clock, **Mark done**
and **Snooze**. These carry an HMAC-signed token (`lib/tokens.ts`) with the activity, occurrence,
recipient and a 30-day expiry. The landing page (`/a/<token>`) only displays on GET; the change is
a POST, executed through RLS as the recipient. Rate limited per IP.
