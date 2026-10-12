/**
 * "Add to my Outlook" — personal calendar sync. Plain TypeScript, no Next.js /
 * Vercel / Supabase dependencies (runs unchanged on Azure).
 *
 * Two providers behind one interface:
 *  - ics_invite: emails an iCalendar invitation (METHOD:REQUEST / CANCEL). Works with
 *    any mail provider, no Microsoft permissions. Used by the prototype.
 *  - graph:      creates/updates/deletes the event via Microsoft Graph. Target for Azure
 *    once users sign in with Entra ID (delegated Calendars.ReadWrite).
 */
import type { ISODate } from "../dates";

export type CalendarProviderId = "ics_invite" | "graph";
export type LinkScope = "series" | "occurrence";

export interface CalendarLink {
  id: string;
  user_id: string;
  activity_id: string;
  scope: LinkScope;
  occurrence_date: ISODate | null;
  provider: CalendarProviderId;
  uid: string;
  external_id: string | null;
  sequence: number;
  content_hash: string | null;
  status: "active" | "removed";
  last_error: string | null;
}

/** Provider-independent description of the calendar event. */
export interface CalendarEvent {
  uid: string;
  sequence: number;
  summary: string;
  description: string;
  /** all-day start date */
  start: ISODate;
  /** inclusive last day (providers convert to exclusive end) */
  end: ISODate;
  /** RRULE body for series links, e.g. "FREQ=YEARLY"; null for single events */
  rrule: string | null;
  url: string;
  organizer: { email: string; name: string };
  attendee: { email: string; name: string };
}

export interface CalendarProvider {
  readonly id: CalendarProviderId;
  /** Create or update the event in the user's calendar. Returns a provider id if any. */
  upsert(link: CalendarLink, event: CalendarEvent, isNew: boolean): Promise<{ externalId?: string | null }>;
  /** Remove the event from the user's calendar. */
  cancel(link: CalendarLink, event: CalendarEvent): Promise<void>;
}

/** Everything sync needs about one activity and its links (loaded with the service connection). */
export interface ActivitySyncContext {
  activity: {
    id: string;
    title: string;
    description: string | null;
    type: string;
    start_date: ISODate;
    end_date: ISODate | null;
    rrule: string | null;
    status: string;
    deleted: boolean;
    clock_id: string;
    clock_name: string;
    clock_slug: string;
    ring_name: string;
  } | null;
  links: Array<CalendarLink & { user_email: string; user_name: string | null; user_can_read: boolean }>;
}

export interface CalendarRepository {
  loadActivityContext(activityId: string): Promise<ActivitySyncContext>;
  findActiveLink(userId: string, activityId: string, occurrenceDate: ISODate | null): Promise<CalendarLink | null>;
  insertLink(link: Omit<CalendarLink, "id" | "status" | "last_error" | "content_hash" | "external_id" | "sequence">): Promise<CalendarLink>;
  updateLink(id: string, patch: Partial<Pick<CalendarLink, "sequence" | "content_hash" | "status" | "external_id" | "last_error" | "occurrence_date">> & { synced?: boolean }): Promise<void>;
  /** Copy active series links of one activity to another (series split "this and future"). */
  copySeriesLinks(fromActivityId: string, toActivityId: string, newUid: (oldUid: string) => string): Promise<void>;
  /** Shift the occurrence date of active occurrence links (series moved by N days). */
  shiftOccurrenceLinks(activityId: string, days: number): Promise<void>;
  activityIdsWithFailedLinks(limit: number): Promise<string[]>;
}
