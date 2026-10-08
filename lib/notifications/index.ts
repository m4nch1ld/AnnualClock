/**
 * Composition root for the notification job. Everything here is plain Node:
 * - Vercel:  app/api/cron/notifications/route.ts calls runDefaultNotificationJob()
 * - Azure:   a Functions timer trigger calls runDefaultNotificationJob() unchanged
 * - CLI:     scripts/notify.ts (dry run / manual run)
 */
import { getEmailProvider } from "../providers/email";
import { createChannels } from "./channels";
import { runNotificationJob, type JobOptions } from "./job";
import { createPgNotificationRepository } from "./pg-repository";

export * from "./types";
export { runNotificationJob } from "./job";
export { planNotifications, zonedInstant } from "./planner";

export function defaultJobDeps() {
  const repo = createPgNotificationRepository();
  const secret = process.env.APP_TOKEN_SECRET;
  if (!secret || secret.length < 32) throw new Error("APP_TOKEN_SECRET must be set (>= 32 chars)");
  return {
    repo,
    channels: createChannels({ email: getEmailProvider(), repo }),
    tokenSecret: secret,
    baseUrl: process.env.APP_BASE_URL ?? "http://localhost:3000",
    timeZone: process.env.DEFAULT_TIMEZONE ?? "Europe/Helsinki",
    digestSendTime: process.env.DIGEST_SEND_TIME ?? "08:00",
  };
}

export function runDefaultNotificationJob(opts: JobOptions = {}) {
  return runNotificationJob(defaultJobDeps(), opts);
}
