/** CalendarRepository on Azure SQL / SQL Server (trusted service connection). */
import { randomUUID } from "node:crypto";
import { S, withService, type Tx } from "../db";
import type { ActivitySyncContext, CalendarLink, CalendarRepository } from "./types";

type Runner = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

const LINK_COLS = `l.id, l.user_id, l.activity_id, l.scope, l.occurrence_date, l.provider, l.uid, l.external_id,
  l.sequence, l.content_hash, l.status, l.last_error`;

export function createSqlCalendarRepository(run: Runner = withService): CalendarRepository {
  return {
    loadActivityContext(activityId) {
      return run(async (tx): Promise<ActivitySyncContext> => {
        const activity = await tx.one<NonNullable<ActivitySyncContext["activity"]>>(
          `SELECT a.id, a.title, a.description, a.type, a.start_date, a.end_date, a.rrule, a.status,
             CAST(CASE WHEN a.deleted_at IS NOT NULL OR c.archived_at IS NOT NULL THEN 1 ELSE 0 END AS bit) AS deleted,
             a.clock_id, c.name AS clock_name, c.slug AS clock_slug, r.name AS ring_name
           FROM ${S}.activities a JOIN ${S}.clocks c ON c.id = a.clock_id JOIN ${S}.rings r ON r.id = a.ring_id
           WHERE a.id = $1`,
          [activityId],
        );
        const links = await tx.query<ActivitySyncContext["links"][number]>(
          `SELECT ${LINK_COLS}, p.email AS user_email, p.full_name AS user_name,
             CAST(CASE WHEN p.is_active = 1 AND (p.global_role = N'super_admin' OR p.all_clocks_viewer = 1 OR EXISTS (
               SELECT 1 FROM ${S}.clock_members m JOIN ${S}.activities a ON a.clock_id = m.clock_id
               WHERE a.id = l.activity_id AND m.user_id = l.user_id)) THEN 1 ELSE 0 END AS bit) AS user_can_read
           FROM ${S}.calendar_links l JOIN ${S}.profiles p ON p.id = l.user_id
           WHERE l.activity_id = $1 AND l.status = N'active' ORDER BY l.created_at`,
          [activityId],
        );
        return { activity: activity ?? null, links };
      });
    },

    findActiveLink(userId, activityId, occurrenceDate) {
      return run(async (tx) =>
        (await tx.one<CalendarLink>(
          `SELECT ${LINK_COLS} FROM ${S}.calendar_links l
           WHERE l.user_id = $1 AND l.activity_id = $2 AND l.status = N'active'
             AND l.occurrence_date IS NOT DISTINCT FROM CAST($3 AS date)`,
          [userId, activityId, occurrenceDate],
        )) ?? null,
      );
    },

    insertLink(link) {
      return run(async (tx) => {
        const id = randomUUID();
        await tx.exec(
          `INSERT INTO ${S}.calendar_links (id, user_id, activity_id, scope, occurrence_date, provider, uid)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, link.user_id, link.activity_id, link.scope, link.occurrence_date, link.provider, link.uid],
        );
        const row = await tx.one<CalendarLink>(`SELECT ${LINK_COLS} FROM ${S}.calendar_links l WHERE l.id = $1`, [id]);
        return row!;
      });
    },

    async updateLink(id, patch) {
      const sets: string[] = [];
      const vals: unknown[] = [id];
      for (const k of ["sequence", "content_hash", "status", "external_id", "last_error", "occurrence_date"] as const) {
        if (k in patch) {
          vals.push(patch[k]);
          sets.push(`${k} = $${vals.length}`);
        }
      }
      if (patch.synced) sets.push("last_synced_at = sysdatetimeoffset()");
      if (!sets.length) return;
      sets.push("updated_at = sysdatetimeoffset()");
      await run((tx) => tx.exec(`UPDATE ${S}.calendar_links SET ${sets.join(", ")} WHERE id = $1`, vals));
    },

    async copySeriesLinks(fromActivityId, toActivityId, newUid) {
      await run(async (tx) => {
        const links = await tx.query<{ user_id: string; provider: string; uid: string }>(
          `SELECT user_id, provider, uid FROM ${S}.calendar_links WHERE activity_id = $1 AND status = N'active' AND scope = N'series'`,
          [fromActivityId],
        );
        for (const l of links) {
          await tx.exec(
            `IF NOT EXISTS (SELECT 1 FROM ${S}.calendar_links WITH (UPDLOCK, HOLDLOCK)
                            WHERE user_id = $1 AND activity_id = $2 AND occurrence_date IS NULL AND status = N'active')
               INSERT INTO ${S}.calendar_links (user_id, activity_id, scope, provider, uid) VALUES ($1, $2, N'series', $3, $4)`,
            [l.user_id, toActivityId, l.provider, newUid(l.uid)],
          );
        }
      });
    },

    async shiftOccurrenceLinks(activityId, days) {
      if (!days) return;
      await run((tx) =>
        tx.exec(
          `UPDATE ${S}.calendar_links SET occurrence_date = dateadd(day, $2, occurrence_date), updated_at = sysdatetimeoffset()
           WHERE activity_id = $1 AND status = N'active' AND scope = N'occurrence'`,
          [activityId, days],
        ),
      );
    },

    activityIdsWithFailedLinks(limit) {
      return run(async (tx) =>
        (
          await tx.query<{ activity_id: string }>(
            `SELECT DISTINCT TOP ($1) activity_id FROM ${S}.calendar_links WHERE status = N'active' AND last_error IS NOT NULL`,
            [limit],
          )
        ).map((r) => r.activity_id),
      );
    },
  };
}
