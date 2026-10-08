/**
 * NotificationRepository on plain PostgreSQL (works on Supabase and Azure
 * Database for PostgreSQL alike). Runs as the trusted service connection.
 */
import { withService, type Tx } from "../db";
import { buildOccurrences, type Activity, type OccurrenceState } from "../domain";
import { ACTIVITY_SELECT } from "../data/clocks";
import type { ISODate } from "../dates";
import { intentKey, type ClockInfo, type DigestItem, type NotificationIntent, type NotificationRepository, type PlannerData } from "./types";

type Runner = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

export function createPgNotificationRepository(run: Runner = withService): NotificationRepository {
  return {
    async startRun(job, dryRun) {
      return run(async (tx) => {
        const last = await tx.one<{ window_end: string }>(
          `select window_end from job_runs where job = $1 and status = 'success' and not dry_run and window_end is not null
           order by window_end desc limit 1`,
          [job],
        );
        const row = await tx.one<{ id: string }>(`insert into job_runs (job, dry_run) values ($1, $2) returning id`, [job, dryRun]);
        return { runId: row!.id, lastWindowEnd: last ? new Date(last.window_end) : null };
      });
    },

    async finishRun(runId, r) {
      await run((tx) =>
        tx.query(
          `update job_runs set status = $2, window_start = $3, window_end = $4, stats = $5, error = $6, finished_at = now() where id = $1`,
          [runId, r.status, r.windowStart.toISOString(), r.windowEnd.toISOString(), JSON.stringify(r.stats), r.error ?? null],
        ),
      );
    },

    async loadPlannerData({ from, to }): Promise<PlannerData> {
      return run(async (tx) => {
        const clocks = await tx.query<ClockInfo>(
          `select c.id, c.name, c.slug, c.color, c.description, c.default_reminder_offsets, c.escalation_config,
             to_char(c.default_send_time, 'HH24:MI') as default_send_time, c.teams_enabled, c.is_general_management, c.position,
             (s.teams_webhook_url is not null and s.teams_webhook_url <> '') as has_teams_webhook
           from clocks c left join clock_secrets s on s.clock_id = c.id where c.archived_at is null`,
        );
        const activities = await tx.query<Activity>(
          `${ACTIVITY_SELECT} join clocks c on c.id = a.clock_id and c.archived_at is null where a.deleted_at is null`,
        );
        const states = await tx.query<OccurrenceState>(
          `select activity_id, occurrence_date, status, completed_at, completed_by, snoozed_until
           from activity_occurrences_state where occurrence_date between $1 and $2`,
          [from, to],
        );
        const members = await tx.query<PlannerData["members"][number]>(`select clock_id, user_id, role from clock_members`);
        const prefs = await tx.query<PlannerData["prefs"][number]>(
          `select user_id, clock_id, enabled, channels, subscribe_all, delivery from notification_prefs`,
        );
        const users = await tx.query<PlannerData["users"][number]>(
          `select id, email, full_name, locale, is_active, all_clocks_viewer, global_role, weekly_digest from profiles`,
        );
        return { clocks, activities, states, members, prefs, users };
      });
    },

    async claim(intent: NotificationIntent) {
      return run(async (tx) => {
        const row = await tx.one<{ id: string }>(
          `insert into notification_log (clock_id, activity_id, occurrence_date, reminder_key, recipient_id, channel, status, payload)
           values ($1, $2, $3, $4, $5, $6, 'pending', $7)
           on conflict on constraint notification_log_idempotency do nothing returning id`,
          [intent.clockId, intent.activityId, intent.occurrenceDate, intent.key, intent.recipientId, intent.channel, JSON.stringify(intent)],
        );
        return row ? { id: row.id } : null;
      });
    },

    async existing(intents) {
      if (!intents.length) return new Set();
      const rows = await run((tx) =>
        tx.query<{ activity_id: string | null; occurrence_date: string | null; reminder_key: string; recipient_id: string | null; channel: string }>(
          `select activity_id, occurrence_date, reminder_key, recipient_id, channel from notification_log
           where reminder_key = any($1)`,
          [[...new Set(intents.map((i) => i.key))]],
        ),
      );
      return new Set(
        rows.map((r) =>
          intentKey({
            activityId: r.activity_id,
            occurrenceDate: r.occurrence_date,
            key: r.reminder_key,
            recipientId: r.recipient_id,
            channel: r.channel as NotificationIntent["channel"],
          }),
        ),
      );
    },

    async markSent(id, providerId) {
      await run((tx) =>
        tx.query(
          `update notification_log set status = 'sent', sent_at = now(), attempts = attempts + 1, error = null, next_attempt_at = null,
             payload = payload || jsonb_build_object('providerId', $2::text) where id = $1`,
          [id, providerId ?? null],
        ),
      );
    },

    async markFailed(id, error, attempts, nextAttemptAt) {
      await run((tx) =>
        tx.query(`update notification_log set status = 'failed', error = $2, attempts = $3, next_attempt_at = $4 where id = $1`, [
          id,
          error.slice(0, 2000),
          attempts,
          nextAttemptAt?.toISOString() ?? null,
        ]),
      );
    },

    async markSkipped(id, reason) {
      await run((tx) => tx.query(`update notification_log set status = 'skipped', error = $2 where id = $1`, [id, reason]));
    },

    async loadRetryable(now, maxAttempts) {
      const rows = await run((tx) =>
        tx.query<{ id: string; attempts: number; payload: NotificationIntent }>(
          `select id, attempts, payload from notification_log
           where (status = 'failed' and attempts < $2 and next_attempt_at <= $1)
              or (status = 'pending' and created_at < $1::timestamptz - interval '15 minutes')
           order by created_at limit 500`,
          [now.toISOString(), maxAttempts],
        ),
      );
      return rows.map((r) => ({ id: r.id, attempts: r.attempts, intent: r.payload }));
    },

    async insertInApp(n) {
      await run((tx) =>
        tx.query(
          `insert into in_app_notifications (user_id, clock_id, activity_id, occurrence_date, kind, title, body, link)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [n.userId, n.clockId, n.activityId, n.occurrenceDate, n.kind, n.title, n.body, n.link],
        ),
      );
    },

    async getTeamsWebhook(clockId) {
      const row = await run((tx) => tx.one<{ url: string | null }>(`select teams_webhook_url as url from clock_secrets where clock_id = $1`, [clockId]));
      return row?.url || null;
    },

    async digestItems(userId, from: ISODate, to: ISODate, today: ISODate) {
      return run(async (tx) => {
        const user = await tx.one<{ all_clocks_viewer: boolean; global_role: string }>(
          `select all_clocks_viewer, global_role from profiles where id = $1`,
          [userId],
        );
        const all = user?.all_clocks_viewer || user?.global_role === "super_admin";
        const clocks = await tx.query<{ id: string; name: string; slug: string }>(
          all
            ? `select id, name, slug from clocks where archived_at is null`
            : `select c.id, c.name, c.slug from clocks c join clock_members m on m.clock_id = c.id and m.user_id = $1 where c.archived_at is null`,
          all ? [] : [userId],
        );
        const ids = clocks.map((c) => c.id);
        if (!ids.length) return { upcoming: [], overdue: [] };
        const activities = await tx.query<Activity>(`${ACTIVITY_SELECT} where a.clock_id = any($1) and a.deleted_at is null and a.status <> 'cancelled'`, [ids]);
        const lookback = new Date(Date.parse(today) - 60 * 86400_000).toISOString().slice(0, 10);
        const states = await tx.query<OccurrenceState>(
          `select activity_id, occurrence_date, status, completed_at, completed_by, snoozed_until
           from activity_occurrences_state where activity_id = any($1) and occurrence_date between $2 and $3`,
          [activities.map((a) => a.id), lookback, to],
        );
        const occ = buildOccurrences(activities, states, lookback, to, today);
        const byId = new Map(clocks.map((c) => [c.id, c]));
        const toItem = (o: (typeof occ)[number]): DigestItem => ({
          clockName: byId.get(o.activity.clock_id)!.name,
          clockSlug: byId.get(o.activity.clock_id)!.slug,
          title: o.activity.title,
          date: o.date,
          endDate: o.endDate,
          dueDate: o.dueDate,
          overdue: o.overdue,
          activityId: o.activity.id,
        });
        return {
          upcoming: occ.filter((o) => o.date >= from && o.date <= to && o.status !== "done" && o.status !== "cancelled").map(toItem),
          overdue: occ.filter((o) => o.overdue).map(toItem),
        };
      });
    },
  };
}
