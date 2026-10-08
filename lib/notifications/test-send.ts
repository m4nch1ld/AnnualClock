/** "Send test notification" for clock admins: delivers to the admin on every configured channel. */
import { randomUUID } from "node:crypto";
import type { ChannelId, ClockInfo, NotificationChannel, NotificationIntent, NotificationRepository, UserInfo } from "./types";

export async function sendTestNotification(
  deps: { repo: NotificationRepository; channels: Partial<Record<ChannelId, NotificationChannel>>; baseUrl: string },
  clock: ClockInfo,
  user: UserInfo,
  channels: ChannelId[],
): Promise<Array<{ channel: ChannelId; ok: boolean; error?: string }>> {
  const base = deps.baseUrl.replace(/\/$/, "");
  const results: Array<{ channel: ChannelId; ok: boolean; error?: string }> = [];
  const key = `test:${randomUUID()}`;
  for (const ch of channels) {
    const channel = deps.channels[ch];
    if (!channel) {
      results.push({ channel: ch, ok: false, error: "not configured" });
      continue;
    }
    const intent: NotificationIntent = {
      kind: "test",
      key,
      channel: ch,
      clockId: clock.id,
      activityId: null,
      occurrenceDate: null,
      recipientId: ch === "teams" ? null : user.id,
      sendAt: new Date().toISOString(),
    };
    const claim = await deps.repo.claim(intent);
    try {
      await channel.send({
        intent,
        clock,
        activity: null,
        recipient: user,
        ownerName: null,
        daysRemaining: null,
        links: { open: `${base}/clocks/${clock.slug}`, settings: `${base}/settings` },
      });
      if (claim) await deps.repo.markSent(claim.id);
      results.push({ channel: ch, ok: true });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      if (claim) await deps.repo.markFailed(claim.id, error, 1, null);
      results.push({ channel: ch, ok: false, error });
    }
  }
  return results;
}
