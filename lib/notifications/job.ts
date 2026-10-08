/**
 * The notification job. Call runNotificationJob() from any scheduler:
 * Vercel Cron (app/api/cron/notifications), an Azure Functions timer trigger,
 * pg_cron calling the route, or the CLI (scripts/notify.ts).
 *
 * Tolerant scheduling: each run processes every send time since the end of the
 * last successful window (capped), so a daily or late run catches up. Idempotent:
 * every delivery is claimed in notification_log with a unique key before sending.
 */
import { addDays, diffDays, todayInZone } from "../dates";
import { createActionToken } from "../tokens";
import { occurrenceRange, planNotifications } from "./planner";
import { intentKey, type ChannelId, type DeliveryContext, type NotificationChannel, type NotificationIntent, type NotificationRepository, type PlannerData } from "./types";

export interface JobDeps {
  repo: NotificationRepository;
  channels: Partial<Record<ChannelId, NotificationChannel>>;
  tokenSecret: string;
  baseUrl: string;
  timeZone?: string;
  digestSendTime?: string;
  log?: (entry: Record<string, unknown>) => void;
}

export interface JobOptions {
  now?: Date;
  dryRun?: boolean;
  /** max catch-up when the job has not run for a long time */
  maxCatchUpHours?: number;
  /** first run (no history): look back this far */
  initialLookbackHours?: number;
}

export interface JobResult {
  runId: string;
  dryRun: boolean;
  windowStart: string;
  windowEnd: string;
  planned: number;
  sent: number;
  failed: number;
  skipped: number;
  alreadySent: number;
  retried: number;
  byChannel: Record<string, number>;
  /** dry run: what would be sent */
  preview?: Array<NotificationIntent & { status: "would_send" | "already_sent"; recipient?: string; title?: string }>;
}

const MAX_ATTEMPTS = 5;
const OVERLAP_MS = 60 * 60 * 1000; // re-scan the last hour of the previous window (idempotent)

export function backoff(attempts: number): number {
  // 10 min, 20 min, 40 min, 80 min ...
  return 10 * 60 * 1000 * 2 ** Math.max(0, attempts - 1);
}

const defaultLog = (e: Record<string, unknown>) => console.log(JSON.stringify({ ts: new Date().toISOString(), job: "notifications", ...e }));

export async function runNotificationJob(deps: JobDeps, opts: JobOptions = {}): Promise<JobResult> {
  const log = deps.log ?? defaultLog;
  const now = opts.now ?? new Date();
  const timeZone = deps.timeZone ?? "Europe/Helsinki";
  const dryRun = !!opts.dryRun;
  const { runId, lastWindowEnd } = await deps.repo.startRun("notifications", dryRun);

  const maxCatchUp = (opts.maxCatchUpHours ?? 14 * 24) * 3600_000;
  const initial = (opts.initialLookbackHours ?? 24) * 3600_000;
  let windowStart = lastWindowEnd ? new Date(lastWindowEnd.getTime() - OVERLAP_MS) : new Date(now.getTime() - initial);
  if (now.getTime() - windowStart.getTime() > maxCatchUp) windowStart = new Date(now.getTime() - maxCatchUp);

  const result: JobResult = {
    runId,
    dryRun,
    windowStart: windowStart.toISOString(),
    windowEnd: now.toISOString(),
    planned: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    alreadySent: 0,
    retried: 0,
    byChannel: {},
  };
  log({ level: "info", msg: "run started", runId, dryRun, windowStart: result.windowStart, windowEnd: result.windowEnd });

  try {
    const range = occurrenceRange({ now, windowStart, timeZone }, 400, 60);
    const data = await deps.repo.loadPlannerData(range);
    const intents = planNotifications({ ...data, now, windowStart, timeZone, digestSendTime: deps.digestSendTime ?? "08:00" });
    result.planned = intents.length;

    if (dryRun) {
      const existing = await deps.repo.existing(intents);
      const users = new Map(data.users.map((u) => [u.id, u]));
      const acts = new Map(data.activities.map((a) => [a.id, a]));
      result.preview = intents.map((i) => ({
        ...i,
        status: existing.has(intentKey(i)) ? "already_sent" : "would_send",
        recipient: i.recipientId ? users.get(i.recipientId)?.email : `(${i.channel} channel)`,
        title: i.activityId ? acts.get(i.activityId)?.title : i.kind,
      }));
      result.alreadySent = result.preview.filter((p) => p.status === "already_sent").length;
      await deps.repo.finishRun(runId, { status: "success", windowStart, windowEnd: now, stats: summary(result) });
      return result;
    }

    // Retries first (failed or stuck entries from earlier runs).
    for (const entry of await deps.repo.loadRetryable(now, MAX_ATTEMPTS)) {
      result.retried++;
      await deliver(deps, data, entry.intent, entry.id, entry.attempts, now, timeZone, result, log);
    }

    for (const intent of intents) {
      const claim = await deps.repo.claim(intent);
      if (!claim) {
        result.alreadySent++;
        continue;
      }
      await deliver(deps, data, intent, claim.id, 0, now, timeZone, result, log);
    }

    await deps.repo.finishRun(runId, { status: "success", windowStart, windowEnd: now, stats: summary(result) });
    log({ level: "info", msg: "run finished", ...summary(result) });
    return result;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log({ level: "error", msg: "run failed", runId, error });
    await deps.repo.finishRun(runId, { status: "failed", windowStart, windowEnd: now, stats: summary(result), error });
    throw e;
  }
}

function summary(r: JobResult) {
  const { preview, ...rest } = r;
  void preview;
  return rest;
}

async function deliver(
  deps: JobDeps,
  data: PlannerData,
  intent: NotificationIntent,
  logId: string,
  priorAttempts: number,
  now: Date,
  timeZone: string,
  result: JobResult,
  log: (e: Record<string, unknown>) => void,
) {
  const channel = deps.channels[intent.channel];
  if (!channel) {
    await deps.repo.markSkipped(logId, `channel ${intent.channel} not configured`);
    result.skipped++;
    return;
  }
  let ctx: DeliveryContext;
  try {
    ctx = await buildContext(deps, data, intent, now, timeZone);
  } catch (e) {
    await deps.repo.markSkipped(logId, e instanceof Error ? e.message : String(e));
    result.skipped++;
    return;
  }
  const attempts = priorAttempts + 1;
  try {
    const res = await channel.send(ctx);
    await deps.repo.markSent(logId, res?.providerId);
    result.sent++;
    result.byChannel[intent.channel] = (result.byChannel[intent.channel] ?? 0) + 1;
    log({ level: "info", msg: "sent", channel: intent.channel, key: intent.key, activityId: intent.activityId, occurrence: intent.occurrenceDate, recipientId: intent.recipientId });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    const next = attempts >= MAX_ATTEMPTS ? null : new Date(now.getTime() + backoff(attempts));
    await deps.repo.markFailed(logId, error, attempts, next);
    result.failed++;
    log({ level: "warn", msg: "send failed", channel: intent.channel, key: intent.key, attempts, nextAttemptAt: next?.toISOString() ?? null, error });
  }
}

async function buildContext(
  deps: JobDeps,
  data: PlannerData,
  intent: NotificationIntent,
  now: Date,
  timeZone: string,
): Promise<DeliveryContext> {
  const clock = intent.clockId ? (data.clocks.find((c) => c.id === intent.clockId) ?? null) : null;
  const activity = intent.activityId ? (data.activities.find((a) => a.id === intent.activityId) ?? null) : null;
  const recipient = intent.recipientId ? (data.users.find((u) => u.id === intent.recipientId) ?? null) : null;
  if (intent.activityId && !activity) throw new Error("activity no longer exists");
  if (intent.recipientId && (!recipient || !recipient.is_active)) throw new Error("recipient inactive");
  const owner = activity?.owner_id ? data.users.find((u) => u.id === activity.owner_id) : undefined;
  const today = todayInZone(timeZone, now);
  const base = deps.baseUrl.replace(/\/$/, "");
  const year = intent.occurrenceDate?.slice(0, 4);
  const open =
    clock && activity
      ? `${base}/clocks/${clock.slug}?year=${year}&focus=${activity.id}:${intent.occurrenceDate}`
      : clock
        ? `${base}/clocks/${clock.slug}`
        : `${base}/clocks`;
  const links: DeliveryContext["links"] = { open, settings: `${base}/settings` };
  if (activity && recipient && intent.canAct && intent.occurrenceDate) {
    const t = (act: "done" | "snooze") =>
      `${base}/a/${createActionToken({ act, aid: activity.id, occ: intent.occurrenceDate!, uid: recipient.id }, deps.tokenSecret, undefined, now.getTime())}`;
    links.done = t("done");
    links.snooze = t("snooze");
  }
  const ctx: DeliveryContext = {
    intent,
    clock,
    activity,
    recipient,
    ownerName: owner ? (owner.full_name ?? owner.email) : null,
    daysRemaining: intent.dueDate ? diffDays(today, intent.kind === "escalation" ? intent.dueDate : (intent.occurrenceDate ?? intent.dueDate)) : null,
    links,
  };
  if (intent.kind === "digest" && recipient) {
    const to = addDays(today, 30);
    ctx.digest = { from: today, to, ...(await deps.repo.digestItems(recipient.id, today, to, today)) };
  }
  return ctx;
}
