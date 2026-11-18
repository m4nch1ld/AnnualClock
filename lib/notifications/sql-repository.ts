/**
 * NotificationRepository on Azure SQL / SQL Server. Runs as the trusted service
 * connection (withService → app_service = 1 in SESSION_CONTEXT).
 */
import { randomUUID } from "node:crypto";
import { S, withService, type Tx } from "../db";
import { buildOccurrences, type Activity, type OccurrenceState } from "../domain";
import { ACTIVITY_SELECT, CLOCK_COLS, inJson } from "../data/clocks";
import type { ISODate } from "../dates";
import { intentKey, type ClockInfo, type DigestItem, type NotificationIntent, type NotificationRepository, type PlannerData } from "./types";

type Runner = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

export function createSqlNotificationRepository(run: Runner = withService): NotificationRepository {
  return {
    async startRun(job, dryRun) {
      return run(async (tx) => {
        const last = await tx.one<{ window_end: string }>(
          `SELECT TOP (1) window_end FROM ${S}.job_runs
           WHERE job = $1 AND status = N'success' AND dry_run = 0 AND window_end IS NOT NULL
           ORDER BY window_end DESC`,
          [job],
        );
        const id = randomUUID();
        await tx.exec(`INSERT INTO ${S}.job_runs (id, job, dry_run) VALUES ($1, $2, $3)`, [id, job, dryRun]);
        return { runId: id, lastWindowEnd: last ? new Date(last.window_end) : null };
      });
    },

    async finishRun(runId, r) {
      await run((tx) =>
        tx.exec(
          `UPDATE ${S}.job_runs SET status = $2, window_start = $3, window_end = $4, stats = $5, error = $6,
             finished_at = sysdatetimeoffset() WHERE id = $1`,
          [runId, r.status, r.windowStart, r.windowEnd, r.stats, r.error ?? null],
        ),
      );
    },

    async loadPlannerData({ from, to }): Promise<PlannerData> {
      return run(async (tx) => {
        const clocks = await tx.query<ClockInfo>(
          `SELECT ${CLOCK_COLS.replace(/(^|,\s*)(\w+)/g, "$1c.$2")},
             CAST(CASE WHEN s.teams_webhook_url IS NOT NULL AND s.teams_webhook_url <> N'' THEN 1 ELSE 0 END AS bit) AS has_teams_webhook
           FROM ${S}.clocks c LEFT JOIN ${S}.clock_secrets s ON s.clock_id = c.id WHERE c.archived_at IS NULL`,
        );
        const activities = await tx.query<Activity>(
          `${ACTIVITY_SELECT} JOIN ${S}.clocks c ON c.id = a.clock_id AND c.archived_at IS NULL WHERE a.deleted_at IS NULL`,
        );
        const states = await tx.query<OccurrenceState>(
          `SELECT activity_id, occurrence_date, status, completed_at, completed_by, snoozed_until
           FROM ${S}.activity_occurrences_state WHERE occurrence_date BETWEEN $1 AND $2`,
          [from, to],
        );
        const members = await tx.query<PlannerData["members"][number]>(`SELECT clock_id, user_id, role FROM ${S}.clock_members`);
        const prefs = await tx.query<PlannerData["prefs"][number]>(
          `SELECT user_id, clock_id, enabled, channels, subscribe_all, delivery FROM ${S}.notification_prefs`,
        );
        const users = await tx.query<PlannerData["users"][number]>(
          `SELECT id, email, full_name, locale, is_active, all_clocks_viewer, global_role, weekly_digest FROM ${S}.profiles`,
        );
        return { clocks, activities, states, members, prefs, users };
      });
    },

    async claim(intent: NotificationIntent) {
      // The unique index ux_nlog_idempotency makes this the "send at most once" gate.
      const id = randomUUID();
      try {
        await run((tx) =>
          tx.exec(
            `INSERT INTO ${S}.notification_log (id, clock_id, activity_id, occurrence_date, reminder_key, recipient_id, channel, status, payload)
             VALUES ($1, $2, $3, $4, $5, $6, $7, N'pending', $8)`,
            [id, intent.clockId, intent.activityId, intent.occurrenceDate, intent.key, intent.recipientId, intent.channel, intent],
          ),
        );
        return { id };
      } catch (e) {
        if ((e as { code?: string }).code === "23505") return null;
        throw e;
      }
    },

    async existing(intents) {
      if (!intents.length) return new Set();
      const rows = await run((tx) =>
        tx.query<{ activity_id: string | null; occurrence_date: string | null; reminder_key: string; recipient_id: string | null; channel: string }>(
          `SELECT activity_id, occurrence_date, reminder_key, recipient_id, channel FROM ${S}.notification_log
           WHERE reminder_key IN ${inJson("$1")}`,
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
        tx.exec(
          `UPDATE ${S}.notification_log SET status = N'sent', sent_at = sysdatetimeoffset(), attempts = attempts + 1, error = NULL,
             next_attempt_at = NULL, updated_at = sysdatetimeoffset(),
             payload = CASE WHEN $2 IS NULL THEN payload ELSE JSON_MODIFY(payload, '$.providerId', $2) END
           WHERE id = $1`,
          [id, providerId ?? null],
        ),
      );
    },

    async markFailed(id, error, attempts, nextAttemptAt) {
      await run((tx) =>
        tx.exec(
          `UPDATE ${S}.notification_log SET status = N'failed', error = $2, attempts = $3, next_attempt_at = $4,
             updated_at = sysdatetimeoffset() WHERE id = $1`,
          [id, error.slice(0, 2000), attempts, nextAttemptAt],
        ),
      );
    },

    async markSkipped(id, reason) {
      await run((tx) =>
        tx.exec(`UPDATE ${S}.notification_log SET status = N'skipped', error = $2, updated_at = sysdatetimeoffset() WHERE id = $1`, [
          id,
          reason.slice(0, 2000),
        ]),
      );
    },

    async loadRetryable(now, maxAttempts) {
      const rows = await run((tx) =>
        tx.query<{ id: string; attempts: number; payload: NotificationIntent }>(
          `SELECT TOP (500) id, attempts, payload FROM ${S}.notification_log
           WHERE (status = N'failed' AND attempts < $2 AND next_attempt_at <= $1)
              OR (status = N'pending' AND created_at < dateadd(minute, -15, CAST($1 AS datetimeoffset(3))))
           ORDER BY created_at`,
          [now, maxAttempts],
        ),
      );
      return rows.map((r) => ({ id: r.id, attempts: r.attempts, intent: r.payload }));
    },

    async insertInApp(n) {
      await run((tx) =>
        tx.exec(
          `INSERT INTO ${S}.in_app_notifications (user_id, clock_id, activity_id, occurrence_date, kind, title, body, link)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [n.userId, n.clockId, n.activityId, n.occurrenceDate, n.kind, n.title, n.body, n.link],
        ),
      );
    },

    async getTeamsWebhook(clockId) {
      const row = await run((tx) =>
        tx.one<{ url: string | null }>(`SELECT teams_webhook_url AS url FROM ${S}.clock_secrets WHERE clock_id = $1`, [clockId]),
      );
      return row?.url || null;
    },

    async digestItems(userId, from: ISODate, to: ISODate, today: ISODate) {
      return run(async (tx) => {
        const user = await tx.one<{ all_clocks_viewer: boolean; global_role: string }>(
          `SELECT all_clocks_viewer, global_role FROM ${S}.profiles WHERE id = $1`,
          [userId],
        );
        const all = user?.all_clocks_viewer || user?.global_role === "super_admin";
        const clocks = await tx.query<{ id: string; name: string; slug: string }>(
          all
            ? `SELECT id, name, slug FROM ${S}.clocks WHERE archived_at IS NULL`
            : `SELECT c.id, c.name, c.slug FROM ${S}.clocks c JOIN ${S}.clock_members m ON m.clock_id = c.id AND m.user_id = $1
               WHERE c.archived_at IS NULL`,
          all ? [] : [userId],
        );
        const ids = clocks.map((c) => c.id);
        if (!ids.length) return { upcoming: [], overdue: [] };
        const activities = await tx.query<Activity>(
          `${ACTIVITY_SELECT} WHERE a.clock_id IN ${inJson("$1")} AND a.deleted_at IS NULL AND a.status <> N'cancelled'`,
          [ids],
        );
        const lookback = new Date(Date.parse(today) - 60 * 86400_000).toISOString().slice(0, 10);
        const states = activities.length
          ? await tx.query<OccurrenceState>(
              `SELECT activity_id, occurrence_date, status, completed_at, completed_by, snoozed_until
               FROM ${S}.activity_occurrences_state WHERE activity_id IN ${inJson("$1")} AND occurrence_date BETWEEN $2 AND $3`,
              [activities.map((a) => a.id), lookback, to],
            )
          : [];
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
