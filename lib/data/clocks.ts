/**
 * Read queries for clocks, rings and activities. Always called inside
 * withUser(), so results are filtered by RLS.
 */
import type { Tx } from "@/lib/db";
import type { Activity, Clock, OccurrenceState, Ring } from "@/lib/domain";
import type { ISODate } from "@/lib/dates";

const CLOCK_COLS = `id, name, slug, color, description, default_reminder_offsets, escalation_config,
  to_char(default_send_time, 'HH24:MI') as default_send_time, teams_enabled, is_general_management, position`;

export function listClocks(tx: Tx) {
  return tx.query<Clock>(`select ${CLOCK_COLS} from clocks where archived_at is null order by position, name`);
}

export function getClockBySlug(tx: Tx, slug: string) {
  return tx.one<Clock>(`select ${CLOCK_COLS} from clocks where slug = $1 and archived_at is null`, [slug]);
}

export function getClocksBySlugs(tx: Tx, slugs: string[]) {
  return tx.query<Clock>(`select ${CLOCK_COLS} from clocks where slug = any($1) and archived_at is null order by position, name`, [
    slugs,
  ]);
}

export function getRings(tx: Tx, clockIds: string[]) {
  return tx.query<Ring>(
    `select id, clock_id, name, color, position, hidden from rings where clock_id = any($1) order by position, name`,
    [clockIds],
  );
}

export const ACTIVITY_SELECT = `
  select a.id, a.clock_id, a.ring_id, a.title, a.description, a.type, a.start_date, a.end_date, a.all_day,
    to_char(a.start_time, 'HH24:MI') as start_time, to_char(a.end_time, 'HH24:MI') as end_time,
    a.rrule, a.owner_id, a.status, a.predecessor_id, a.reminder_offsets, a.tags, a.links, a.is_demo, a.updated_at,
    coalesce((select array_agg(x.user_id) from activity_assignees x where x.activity_id = a.id), '{}') as assignee_ids
  from activities a`;

export function getActivities(tx: Tx, clockIds: string[]) {
  return tx.query<Activity>(`${ACTIVITY_SELECT} where a.clock_id = any($1) and a.deleted_at is null order by a.start_date`, [
    clockIds,
  ]);
}

export function getActivity(tx: Tx, id: string) {
  return tx.one<Activity>(`${ACTIVITY_SELECT} where a.id = $1 and a.deleted_at is null`, [id]);
}

export function getOccurrenceStates(tx: Tx, activityIds: string[], from: ISODate, to: ISODate) {
  if (!activityIds.length) return Promise.resolve([] as OccurrenceState[]);
  return tx.query<OccurrenceState>(
    `select activity_id, occurrence_date, status, completed_at, completed_by, snoozed_until
     from activity_occurrences_state where activity_id = any($1) and occurrence_date between $2 and $3`,
    [activityIds, from, to],
  );
}

export interface PersonLite {
  id: string;
  email: string;
  full_name: string | null;
}

export function listPeople(tx: Tx) {
  return tx.query<PersonLite>(`select id, email, full_name from profiles where is_active order by coalesce(full_name, email)`);
}

export interface MemberRow extends PersonLite {
  role: "viewer" | "editor" | "admin";
  clock_id: string;
}

export function listMembers(tx: Tx, clockId: string) {
  return tx.query<MemberRow>(
    `select p.id, p.email, p.full_name, m.role, m.clock_id from clock_members m join profiles p on p.id = m.user_id
     where m.clock_id = $1 order by coalesce(p.full_name, p.email)`,
    [clockId],
  );
}
