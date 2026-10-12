import type { Activity, Clock, OccurrenceState, Ring } from "@/lib/domain";
import type { ISODate } from "@/lib/dates";
import type { PersonLite } from "@/lib/data/clocks";

export interface ClockPerms {
  canEdit: boolean;
  isAdmin: boolean;
}

/** Everything the client workspace needs; serialisable from a Server Component. */
export interface WorkspaceData {
  mode: "single" | "overlay";
  year: number;
  today: ISODate;
  clocks: Clock[];
  rings: Ring[];
  activities: Activity[];
  states: OccurrenceState[];
  people: PersonLite[];
  /** member user ids per clock (owner/assignee pickers) */
  memberIds: Record<string, string[]>;
  perms: Record<string, ClockPerms>;
  currentUserId: string;
  /** the current user's active "Add to my Outlook" links */
  calendarLinks: Array<{ activity_id: string; scope: "series" | "occurrence"; occurrence_date: ISODate | null; pending: boolean }>;
}
