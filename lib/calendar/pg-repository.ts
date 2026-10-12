/** CalendarRepository on plain PostgreSQL (trusted service connection). */
import { withService, type Tx } from "../db";
import type { ActivitySyncContext, CalendarLink, CalendarRepository } from "./types";

type Runner = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

const LINK_COLS = `l.id, l.user_id, l.activity_id, l.scope, l.occurrence_date, l.provider, l.uid, l.external_id,
  l.sequence, l.content_hash, l.status, l.last_error`;

export function createPgCalendarRepository(run: Runner = withService): CalendarRepository {
  return {
    loadActivityContext(activityId) {
      return run(async (tx): Promise<ActivitySyncContext> => {
        const activity = await tx.one<NonNullable<ActivitySyncContext["activity"]>>(
          `select a.id, a.title, a.description, a.type, a.start_date, a.end_date, a.rrule, a.status,
             (a.deleted_at is not null or c.archived_at is not null) as deleted,
             a.clock_id, c.name as clock_name, c.slug as clock_slug, r.name as ring_name
           from activities a join clocks c on c.id = a.clock_id join rings r on r.id = a.ring_id where a.id = $1`,
          [activityId],
        );
        const links = await tx.query<ActivitySyncContext["links"][number]>(
          `select ${LINK_COLS}, p.email as user_email, p.full_name as user_name,
             (p.is_active and (p.global_role = 'super_admin' or p.all_clocks_viewer or exists (
               select 1 from clock_members m join activities a on a.clock_id = m.clock_id
               where a.id = l.activity_id and m.user_id = l.user_id))) as user_can_read
           from calendar_links l join profiles p on p.id = l.user_id
           where l.activity_id = $1 and l.status = 'active' order by l.created_at`,
          [activityId],
        );
        return { activity: activity ?? null, links };
      });
    },

    findActiveLink(userId, activityId, occurrenceDate) {
      return run(async (tx) =>
        (await tx.one<CalendarLink>(
          `select ${LINK_COLS} from calendar_links l
           where l.user_id = $1 and l.activity_id = $2 and l.status = 'active'
             and l.occurrence_date is not distinct from $3::date`,
          [userId, activityId, occurrenceDate],
        )) ?? null,
      );
    },

    insertLink(link) {
      return run(async (tx) => {
        const row = await tx.one<CalendarLink>(
          `insert into calendar_links as l (user_id, activity_id, scope, occurrence_date, provider, uid)
           values ($1, $2, $3, $4, $5, $6) returning ${LINK_COLS}`,
          [link.user_id, link.activity_id, link.scope, link.occurrence_date, link.provider, link.uid],
        );
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
      if (patch.synced) sets.push("last_synced_at = now()");
      if (!sets.length) return;
      await run((tx) => tx.query(`update calendar_links set ${sets.join(", ")} where id = $1`, vals));
    },

    async copySeriesLinks(fromActivityId, toActivityId, newUid) {
      await run(async (tx) => {
        const links = await tx.query<{ user_id: string; provider: string; uid: string }>(
          `select user_id, provider, uid from calendar_links where activity_id = $1 and status = 'active' and scope = 'series'`,
          [fromActivityId],
        );
        for (const l of links) {
          await tx.query(
            `insert into calendar_links (user_id, activity_id, scope, provider, uid) values ($1, $2, 'series', $3, $4) on conflict do nothing`,
            [l.user_id, toActivityId, l.provider, newUid(l.uid)],
          );
        }
      });
    },

    async shiftOccurrenceLinks(activityId, days) {
      if (!days) return;
      await run((tx) =>
        tx.query(
          `update calendar_links set occurrence_date = occurrence_date + $2::int
           where activity_id = $1 and status = 'active' and scope = 'occurrence'`,
          [activityId, days],
        ),
      );
    },

    activityIdsWithFailedLinks(limit) {
      return run(async (tx) =>
        (
          await tx.query<{ activity_id: string }>(
            `select distinct activity_id from calendar_links where status = 'active' and last_error is not null limit $1`,
            [limit],
          )
        ).map((r) => r.activity_id),
      );
    },
  };
}
