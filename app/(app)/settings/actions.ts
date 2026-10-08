"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/server/session";
import { withUser } from "@/lib/db";
import { createOpaqueToken } from "@/lib/tokens";
import { env } from "@/lib/env";
import { uuid } from "@/lib/validation";

const profileInput = z.object({
  full_name: z.string().trim().min(1).max(120),
  weekly_digest: z.boolean(),
});

export async function updateProfile(raw: unknown) {
  const s = await requireSession();
  const p = profileInput.parse(raw);
  await withUser(s.profile.id, (tx) =>
    tx.query(`update profiles set full_name = $2, weekly_digest = $3 where id = $1`, [s.profile.id, p.full_name, p.weekly_digest]),
  );
  revalidatePath("/settings");
  return { ok: true as const };
}

const prefsInput = z.object({
  clock_id: uuid,
  enabled: z.boolean(),
  channels: z.array(z.enum(["email", "in_app"])).max(2),
  subscribe_all: z.boolean(),
  delivery: z.enum(["individual", "digest"]),
});

export async function savePrefs(raw: unknown) {
  const s = await requireSession();
  const p = prefsInput.parse(raw);
  await withUser(s.profile.id, (tx) =>
    tx.query(
      `insert into notification_prefs (user_id, clock_id, enabled, channels, subscribe_all, delivery)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (user_id, clock_id) do update set enabled = excluded.enabled, channels = excluded.channels,
         subscribe_all = excluded.subscribe_all, delivery = excluded.delivery`,
      [s.profile.id, p.clock_id, p.enabled, [...new Set(p.channels)], p.subscribe_all, p.delivery],
    ),
  );
  revalidatePath("/settings");
  return { ok: true as const };
}

/** Creates a private ICS feed URL. The raw token is shown once; only its hash is stored. */
export async function createIcsFeed(clockId: string | null) {
  const s = await requireSession();
  const cid = clockId ? uuid.parse(clockId) : null;
  const { token, hash } = createOpaqueToken();
  await withUser(s.profile.id, (tx) =>
    tx.query(`insert into ics_tokens (user_id, clock_id, token_hash, label) values ($1, $2, $3, $4)`, [
      s.profile.id,
      cid,
      hash,
      `${token.slice(0, 4)}…`,
    ]),
  );
  revalidatePath("/settings");
  return { url: `${env().APP_BASE_URL.replace(/\/$/, "")}/api/ics/${token}.ics` };
}

export async function revokeIcsFeed(id: string) {
  const s = await requireSession();
  await withUser(s.profile.id, (tx) => tx.query(`update ics_tokens set revoked_at = now() where id = $1`, [uuid.parse(id)]));
  revalidatePath("/settings");
  return { ok: true as const };
}
