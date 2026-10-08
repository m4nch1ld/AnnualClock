/**
 * NotificationChannel implementations. Add SMS (e.g. Twilio) or Web Push by
 * implementing NotificationChannel and registering it in createChannels().
 */
import type { EmailProvider } from "../providers/email";
import { renderEmail, renderInApp, renderTeamsCard } from "./messages";
import type { ChannelId, NotificationChannel, NotificationRepository } from "./types";

export class EmailChannel implements NotificationChannel {
  readonly id = "email" as const;
  constructor(private email: EmailProvider) {}
  async send(ctx: Parameters<NotificationChannel["send"]>[0]) {
    if (!ctx.recipient?.email) throw new Error("recipient has no email");
    const msg = renderEmail(ctx);
    return this.email.send({ to: ctx.recipient.email, ...msg }).then((r) => ({ providerId: r.id }));
  }
}

export class InAppChannel implements NotificationChannel {
  readonly id = "in_app" as const;
  constructor(private repo: NotificationRepository) {}
  async send(ctx: Parameters<NotificationChannel["send"]>[0]) {
    if (!ctx.recipient) throw new Error("no recipient");
    const m = renderInApp(ctx);
    await this.repo.insertInApp({
      userId: ctx.recipient.id,
      clockId: ctx.clock?.id ?? null,
      activityId: ctx.activity?.id ?? null,
      occurrenceDate: ctx.intent.occurrenceDate,
      kind: ctx.intent.kind,
      ...m,
    });
  }
}

/** Posts an Adaptive Card to the clock's Teams channel webhook (stored server-side only). */
export class TeamsChannel implements NotificationChannel {
  readonly id = "teams" as const;
  constructor(
    private repo: NotificationRepository,
    private fetchImpl: typeof fetch = fetch,
  ) {}
  async send(ctx: Parameters<NotificationChannel["send"]>[0]) {
    if (!ctx.clock) throw new Error("no clock");
    const url = await this.repo.getTeamsWebhook(ctx.clock.id);
    if (!url) throw new Error("no Teams webhook configured");
    await postTeams(url, renderTeamsCard(ctx), this.fetchImpl);
  }
}

export async function postTeams(url: string, body: unknown, fetchImpl: typeof fetch = fetch) {
  if (!/^https:\/\//i.test(url)) throw new Error("Teams webhook must be https");
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Teams webhook HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export function createChannels(deps: { email: EmailProvider; repo: NotificationRepository }): Partial<Record<ChannelId, NotificationChannel>> {
  return {
    email: new EmailChannel(deps.email),
    in_app: new InAppChannel(deps.repo),
    teams: new TeamsChannel(deps.repo),
  };
}
