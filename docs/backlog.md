# Backlog (ideas beyond the brief)

Not implemented on purpose (out of scope or "if time permits"). Candidates for the next iteration.

## Clock & activities
- Move a **single occurrence** to another date (exception date) without splitting the series.
- Print / export the wheel as PNG or PDF (the SVG is self-contained; serialise + rasterise).
- Restore soft-deleted activities from the UI (admins can already see them via audit/RLS).
- Optimistic concurrency (`updated_at` check) to warn about simultaneous edits.
- Quarter view and smoother pinch-zoom on tablets.
- Ring templates when creating a clock; copy activities from another clock/year.
- Attachments (evidence of completion, e.g. verification report) — storage interface exists conceptually.
- Per-activity "completion requires note/evidence".

## Calendar
- Switch "Add to my Outlook" to the Microsoft Graph provider after Entra ID (docs/calendar.md).
- "Add all my activities" bulk action; optional VALARM per user preference.
- Reflect per-occurrence completion in the calendar entry (e.g. ✓ prefix) if users want it.

## Notifications
- SMS (Twilio) and Web Push channels (interface ready, see docs/notifications.md).
- Per-user send time and quiet hours; Finnish email templates.
- Teams: Adaptive Card actions (mark done directly in Teams) via a bot or Power Automate flow.
- Escalation chain configurable per activity (e.g. escalate to a named deputy).
- Digest frequency options (daily / weekly) and per-clock digest.
- Alerting when the job has not run (e.g. Azure Monitor alert on missing `job_runs`).

## Platform & security
- Content-Security-Policy with nonces.
- Finnish UI catalogue (`lib/i18n/fi.ts`) and locale switch in settings.
- Entra ID group sync (see docs/azure-migration.md).
- Audit log export and retention policy; GDPR data export for a user.
- Load test with a few thousand activities across all clocks and virtualised list view.
- Archive old `notification_log` / `rate_limits` rows on a schedule.
