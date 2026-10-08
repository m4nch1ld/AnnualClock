/**
 * Notification engine types. Plain TypeScript: no Next.js, Vercel or Supabase
 * dependencies, so the same module runs from an Azure Functions timer trigger.
 */
import type { ISODate } from "../dates";
import type { Activity, Clock, ClockRole, OccurrenceState } from "../domain";

/** Implemented channels. 'sms' and 'push' are reserved for future channels. */
export type ChannelId = "email" | "in_app" | "teams" | "sms" | "push";
export type NotificationKind = "reminder" | "snooze" | "escalation" | "digest" | "test";

export interface UserInfo {
  id: string;
  email: string;
  full_name: string | null;
  locale: string;
  is_active: boolean;
  all_clocks_viewer: boolean;
  global_role: "user" | "super_admin";
  weekly_digest: boolean;
}

export interface MemberInfo {
  clock_id: string;
  user_id: string;
  role: ClockRole;
}

export interface PrefInfo {
  user_id: string;
  clock_id: string;
  enabled: boolean;
  channels: string[];
  subscribe_all: boolean;
  delivery: "individual" | "digest";
}

export interface ClockInfo extends Clock {
  has_teams_webhook: boolean;
}

export interface PlannerData {
  clocks: ClockInfo[];
  activities: Activity[];
  states: OccurrenceState[];
  members: MemberInfo[];
  prefs: PrefInfo[];
  users: UserInfo[];
}

export interface PlannerInput extends PlannerData {
  now: Date;
  /** exclusive lower bound of the send-time window */
  windowStart: Date;
  timeZone: string;
  /** local time for the Monday digest, 'HH:MM' */
  digestSendTime: string;
}

/** One thing to deliver: (occurrence, reminder key, recipient, channel) is the idempotency key. */
export interface NotificationIntent {
  kind: NotificationKind;
  /** stored as notification_log.reminder_key, e.g. 'reminder:-14', 'escalation:+1' */
  key: string;
  channel: ChannelId;
  clockId: string | null;
  activityId: string | null;
  occurrenceDate: ISODate | null;
  endDate?: ISODate | null;
  dueDate?: ISODate;
  /** null for clock-level channels (Teams) */
  recipientId: string | null;
  /** planned send instant (ISO) */
  sendAt: string;
  /** reminder: days before; escalation: days after due */
  offsetDays?: number;
  /** recipient may complete/snooze from the message */
  canAct?: boolean;
  /** free-form data for special kinds (test, digest week) */
  meta?: Record<string, unknown>;
}

export interface DigestItem {
  clockName: string;
  clockSlug: string;
  title: string;
  date: ISODate;
  endDate: ISODate | null;
  dueDate: ISODate;
  overdue: boolean;
  activityId: string;
}

/** Everything a channel needs to render and deliver one intent. */
export interface DeliveryContext {
  intent: NotificationIntent;
  clock: ClockInfo | null;
  activity: Activity | null;
  recipient: UserInfo | null;
  ownerName: string | null;
  /** days from the recipient's today to the due/occurrence date (negative = overdue) */
  daysRemaining: number | null;
  links: { open: string; done?: string; snooze?: string; settings: string };
  digest?: { from: ISODate; to: ISODate; upcoming: DigestItem[]; overdue: DigestItem[] };
}

export interface NotificationChannel {
  readonly id: ChannelId;
  send(ctx: DeliveryContext): Promise<{ providerId?: string } | void>;
}

export interface ClaimResult {
  id: string;
}

export interface RetryableEntry {
  id: string;
  attempts: number;
  intent: NotificationIntent;
}

/** Persistence used by the job. Implemented with plain SQL in pg-repository.ts. */
export interface NotificationRepository {
  /** Start a run; returns its id and the end of the last successful window (if any). */
  startRun(job: string, dryRun: boolean): Promise<{ runId: string; lastWindowEnd: Date | null }>;
  finishRun(runId: string, result: { status: "success" | "failed"; windowStart: Date; windowEnd: Date; stats: object; error?: string }): Promise<void>;
  loadPlannerData(range: { from: ISODate; to: ISODate }): Promise<PlannerData>;
  /** Insert a pending log row; null if this (occurrence, key, recipient, channel) already exists. */
  claim(intent: NotificationIntent): Promise<ClaimResult | null>;
  /** Which of these intents are already logged (dry run). */
  existing(intents: NotificationIntent[]): Promise<Set<string>>;
  markSent(id: string, providerId?: string): Promise<void>;
  markFailed(id: string, error: string, attempts: number, nextAttemptAt: Date | null): Promise<void>;
  markSkipped(id: string, reason: string): Promise<void>;
  loadRetryable(now: Date, maxAttempts: number): Promise<RetryableEntry[]>;
  insertInApp(n: { userId: string; clockId: string | null; activityId: string | null; occurrenceDate: ISODate | null; kind: string; title: string; body: string; link: string }): Promise<void>;
  getTeamsWebhook(clockId: string): Promise<string | null>;
  digestItems(userId: string, from: ISODate, to: ISODate, today: ISODate): Promise<{ upcoming: DigestItem[]; overdue: DigestItem[] }>;
}

export const intentKey = (i: Pick<NotificationIntent, "activityId" | "occurrenceDate" | "key" | "recipientId" | "channel">) =>
  [i.activityId ?? "-", i.occurrenceDate ?? "-", i.key, i.recipientId ?? "-", i.channel].join("|");
