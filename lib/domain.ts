/**
 * Domain types and pure occurrence logic shared by UI, server and the
 * notification job.
 */
import { addDays, type ISODate } from "./dates";
import { expandOccurrences } from "./recurrence";

export const CLOCK_ROLES = ["viewer", "editor", "admin"] as const;
export type ClockRole = (typeof CLOCK_ROLES)[number];
export const ACTIVITY_TYPES = ["deadline", "period", "milestone", "recurring_task"] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];
export const ACTIVITY_STATUSES = ["planned", "in_progress", "done", "cancelled"] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];

export interface EscalationConfig {
  enabled: boolean;
  offsets_days: number[];
  notify_admins: boolean;
  notify_general_management: boolean;
}

export const DEFAULT_ESCALATION: EscalationConfig = {
  enabled: true,
  offsets_days: [1, 7],
  notify_admins: true,
  notify_general_management: true,
};

export interface Clock {
  id: string;
  name: string;
  slug: string;
  color: string;
  description: string | null;
  default_reminder_offsets: number[];
  escalation_config: EscalationConfig;
  default_send_time: string; // 'HH:MM[:SS]'
  teams_enabled: boolean;
  is_general_management: boolean;
  position: number;
}

export interface Ring {
  id: string;
  clock_id: string;
  name: string;
  color: string;
  position: number;
  hidden: boolean;
}

export interface ActivityLink {
  label?: string;
  url: string;
}

export interface Activity {
  id: string;
  clock_id: string;
  ring_id: string;
  title: string;
  description: string | null;
  type: ActivityType;
  start_date: ISODate;
  end_date: ISODate | null;
  all_day: boolean;
  start_time: string | null;
  end_time: string | null;
  rrule: string | null;
  owner_id: string | null;
  status: ActivityStatus;
  predecessor_id: string | null;
  reminder_offsets: number[] | null;
  tags: string[];
  links: ActivityLink[];
  assignee_ids: string[];
  is_demo?: boolean;
  updated_at?: string;
}

export interface OccurrenceState {
  activity_id: string;
  occurrence_date: ISODate;
  status: ActivityStatus;
  completed_at: string | null;
  completed_by: string | null;
  snoozed_until: ISODate | null;
}

export interface Occurrence {
  key: string;
  activity: Activity;
  date: ISODate;
  endDate: ISODate | null;
  /** the date the occurrence is due: end of a period, else its date */
  dueDate: ISODate;
  status: ActivityStatus;
  completedAt: string | null;
  snoozedUntil: ISODate | null;
  overdue: boolean;
  recurring: boolean;
}

export const occurrenceKey = (activityId: string, date: ISODate) => `${activityId}:${date}`;

export function isClosed(status: ActivityStatus) {
  return status === "done" || status === "cancelled";
}

/** Effective status of one occurrence (per-occurrence state wins). */
export function effectiveStatus(activity: Activity, state: OccurrenceState | undefined): ActivityStatus {
  if (activity.status === "cancelled") return "cancelled";
  if (state) return state.status;
  return activity.rrule ? "planned" : activity.status;
}

/** Expand activities into occurrences overlapping [from, to], merged with state. */
export function buildOccurrences(
  activities: Activity[],
  states: OccurrenceState[],
  from: ISODate,
  to: ISODate,
  today: ISODate,
): Occurrence[] {
  const stateMap = new Map(states.map((s) => [occurrenceKey(s.activity_id, s.occurrence_date), s]));
  const out: Occurrence[] = [];
  for (const a of activities) {
    for (const o of expandOccurrences(a, from, to)) {
      const key = occurrenceKey(a.id, o.date);
      const st = stateMap.get(key);
      const status = effectiveStatus(a, st);
      const dueDate = o.endDate ?? o.date;
      out.push({
        key,
        activity: a,
        date: o.date,
        endDate: o.endDate,
        dueDate,
        status,
        completedAt: st?.completed_at ?? null,
        snoozedUntil: st?.snoozed_until ?? null,
        overdue: dueDate < today && !isClosed(status),
        recurring: !!a.rrule,
      });
    }
  }
  return out.sort((x, y) => (x.date === y.date ? x.activity.title.localeCompare(y.activity.title) : x.date < y.date ? -1 : 1));
}

/** Reminder offsets in effect for an activity (activity override, else clock default). */
export function reminderOffsets(activity: Pick<Activity, "reminder_offsets">, clock: Pick<Clock, "default_reminder_offsets">) {
  const raw = activity.reminder_offsets ?? clock.default_reminder_offsets ?? [];
  return [...new Set(raw.filter((n) => Number.isInteger(n) && n >= 0 && n <= 365))].sort((a, b) => b - a);
}

/** Dependency check: successor should not start before its predecessor is due. */
export function dependencyConflict(successor: Activity, predecessor: Activity | undefined): string | null {
  if (!predecessor) return null;
  const predDue = predecessor.end_date ?? predecessor.start_date;
  if (successor.start_date < predDue) {
    return `Starts before its predecessor "${predecessor.title}" is due (${predDue}).`;
  }
  return null;
}

export function activityDurationDays(a: Pick<Activity, "start_date" | "end_date">): number {
  if (!a.end_date) return 0;
  let n = 0;
  for (let d = a.start_date; d < a.end_date; d = addDays(d, 1)) n++;
  return n;
}
