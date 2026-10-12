"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/server/session";
import { withService, withUser, type Tx } from "@/lib/db";
import { hexColor, offsetsSchema, roleSchema, uuid } from "@/lib/validation";
import { defaultJobDeps } from "@/lib/notifications";
import { sendTestNotification } from "@/lib/notifications/test-send";
import type { ChannelId, ClockInfo, UserInfo } from "@/lib/notifications";
import { getEmailProvider } from "@/lib/providers/email";
import { ensureIdentity, generateSignInTokenHash } from "@/lib/providers/supabase/admin-identity";
import { renderInviteEmail } from "@/lib/notifications/templates";
import { env } from "@/lib/env";
import { syncCalendarLinksWhere } from "@/lib/server/calendar-hooks";

export type Result = { ok: true; message?: string } | { ok: false; error: string };

function failure(e: unknown): Result {
  if (e instanceof z.ZodError) return { ok: false, error: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  const msg = (e as Error)?.message ?? String(e);
  if (/row-level security|permission denied|not an admin/i.test(msg)) return { ok: false, error: "You need to be an admin of this clock." };
  if (/duplicate key/.test(msg)) return { ok: false, error: "That already exists." };
  console.error(JSON.stringify({ level: "error", msg: "clock settings action failed", error: msg }));
  return { ok: false, error: "Something went wrong." };
}

async function assertAdmin(tx: Tx, clockId: string) {
  const row = await tx.one<{ ok: boolean }>(`select app.is_clock_admin($1) as ok`, [clockId]);
  if (!row?.ok) throw new Error("not an admin");
}

/** Run as the user, after checking they administer the clock. */
async function asAdmin<T>(clockId: string, fn: (tx: Tx, uid: string) => Promise<T>) {
  const s = await requireSession();
  return withUser(s.profile.id, async (tx) => {
    await assertAdmin(tx, clockId);
    return fn(tx, s.profile.id);
  });
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
const notifInput = z.object({
  clock_id: uuid,
  default_reminder_offsets: offsetsSchema,
  default_send_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  escalation_config: z.object({
    enabled: z.boolean(),
    offsets_days: z.array(z.number().int().min(1).max(90)).max(5),
    notify_admins: z.boolean(),
    notify_general_management: z.boolean(),
  }),
  teams_enabled: z.boolean(),
});

export async function saveNotificationSettings(raw: unknown): Promise<Result> {
  try {
    const p = notifInput.parse(raw);
    await asAdmin(p.clock_id, (tx) =>
      tx.query(
        `update clocks set default_reminder_offsets = $2, default_send_time = $3, escalation_config = $4, teams_enabled = $5 where id = $1`,
        [
          p.clock_id,
          [...new Set(p.default_reminder_offsets)].sort((a, b) => b - a),
          p.default_send_time,
          JSON.stringify({ ...p.escalation_config, offsets_days: [...new Set(p.escalation_config.offsets_days)].sort((a, b) => a - b) }),
          p.teams_enabled,
        ],
      ),
    );
    revalidatePath("/clocks", "layout");
    return { ok: true, message: "Saved." };
  } catch (e) {
    return failure(e);
  }
}

/** Teams webhook hosts we allow (prevents using the server to call arbitrary URLs). */
const TEAMS_HOSTS = [/\.webhook\.office\.com$/i, /\.logic\.azure\.com$/i, /\.powerautomate\.com$/i, /\.powerplatform\.com$/i];

const webhookInput = z.object({
  clock_id: uuid,
  url: z
    .string()
    .trim()
    .max(2000)
    .nullable()
    .refine((u) => {
      if (!u) return true;
      try {
        const url = new URL(u);
        return url.protocol === "https:" && TEAMS_HOSTS.some((h) => h.test(url.hostname));
      } catch {
        return false;
      }
    }, "Must be an https Microsoft Teams / Power Automate webhook URL"),
});

export async function setTeamsWebhook(raw: unknown): Promise<Result> {
  try {
    const p = webhookInput.parse(raw);
    await asAdmin(p.clock_id, async () => {
      // Secrets table is server-only (no RLS policies): write with the service connection after the admin check.
      await withService((tx) =>
        tx.query(
          `insert into clock_secrets (clock_id, teams_webhook_url) values ($1, $2)
           on conflict (clock_id) do update set teams_webhook_url = excluded.teams_webhook_url`,
          [p.clock_id, p.url || null],
        ),
      );
    });
    revalidatePath("/clocks", "layout");
    return { ok: true, message: p.url ? "Webhook saved." : "Webhook removed." };
  } catch (e) {
    return failure(e);
  }
}

export async function sendTest(raw: unknown): Promise<Result> {
  try {
    const p = z.object({ clock_id: uuid }).parse(raw);
    const s = await requireSession();
    await asAdmin(p.clock_id, async () => {});
    const deps = defaultJobDeps();
    const data = await withService(async (tx) => {
      const clock = await tx.one<ClockInfo>(
        `select c.id, c.name, c.slug, c.color, c.description, c.default_reminder_offsets, c.escalation_config,
           to_char(c.default_send_time, 'HH24:MI') as default_send_time, c.teams_enabled, c.is_general_management, c.position,
           coalesce(s.teams_webhook_url, '') <> '' as has_teams_webhook
         from clocks c left join clock_secrets s on s.clock_id = c.id where c.id = $1`,
        [p.clock_id],
      );
      const user = await tx.one<UserInfo>(
        `select id, email, full_name, locale, is_active, all_clocks_viewer, global_role, weekly_digest from profiles where id = $1`,
        [s.profile.id],
      );
      return { clock: clock!, user: user! };
    });
    const channels: ChannelId[] = ["email", "in_app", ...(data.clock.has_teams_webhook ? (["teams"] as const) : [])];
    const results = await sendTestNotification(deps, data.clock, data.user, channels);
    const failed = results.filter((r) => !r.ok);
    return failed.length
      ? { ok: false, error: `Failed: ${failed.map((f) => `${f.channel} (${f.error})`).join(", ")}` }
      : { ok: true, message: `Test sent via ${results.map((r) => r.channel).join(", ")}.` };
  } catch (e) {
    return failure(e);
  }
}

// ---------------------------------------------------------------------------
// General, rings, members
// ---------------------------------------------------------------------------
const generalInput = z.object({
  clock_id: uuid,
  name: z.string().trim().min(1).max(80),
  color: hexColor,
  description: z.string().trim().max(500).nullable(),
});

export async function saveGeneral(raw: unknown): Promise<Result> {
  try {
    const p = generalInput.parse(raw);
    await asAdmin(p.clock_id, (tx) =>
      tx.query(`update clocks set name = $2, color = $3, description = $4 where id = $1`, [p.clock_id, p.name, p.color, p.description || null]),
    );
    revalidatePath("/clocks", "layout");
    return { ok: true, message: "Saved." };
  } catch (e) {
    return failure(e);
  }
}

const ringInput = z.object({
  clock_id: uuid,
  id: uuid.optional(),
  name: z.string().trim().min(1).max(60),
  color: hexColor,
  hidden: z.boolean().default(false),
});

export async function saveRing(raw: unknown): Promise<Result> {
  try {
    const p = ringInput.parse(raw);
    await asAdmin(p.clock_id, async (tx) => {
      if (p.id) {
        await tx.query(`update rings set name = $3, color = $4, hidden = $5 where id = $1 and clock_id = $2`, [p.id, p.clock_id, p.name, p.color, p.hidden]);
      } else {
        await tx.query(
          `insert into rings (clock_id, name, color, hidden, position)
           values ($1, $2, $3, $4, coalesce((select max(position) + 1 from rings where clock_id = $1), 0))`,
          [p.clock_id, p.name, p.color, p.hidden],
        );
      }
    });
    revalidatePath("/clocks", "layout");
    return { ok: true, message: "Saved." };
  } catch (e) {
    return failure(e);
  }
}

export async function moveRing(raw: unknown): Promise<Result> {
  try {
    const p = z.object({ clock_id: uuid, id: uuid, direction: z.enum(["up", "down"]) }).parse(raw);
    await asAdmin(p.clock_id, async (tx) => {
      const rings = await tx.query<{ id: string }>(`select id from rings where clock_id = $1 order by position, name`, [p.clock_id]);
      const i = rings.findIndex((r) => r.id === p.id);
      const j = p.direction === "up" ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= rings.length) return;
      [rings[i], rings[j]] = [rings[j], rings[i]];
      for (const [pos, r] of rings.entries()) await tx.query(`update rings set position = $2 where id = $1`, [r.id, pos]);
    });
    revalidatePath("/clocks", "layout");
    return { ok: true };
  } catch (e) {
    return failure(e);
  }
}

export async function deleteRing(raw: unknown): Promise<Result> {
  try {
    const p = z.object({ clock_id: uuid, id: uuid }).parse(raw);
    const r = await asAdmin(p.clock_id, async (tx) => {
      const used = await tx.one<{ n: number }>(`select count(*)::int as n from activities where ring_id = $1`, [p.id]);
      if (used && used.n > 0) return { ok: false as const, error: `The ring has ${used.n} activities. Move them to another ring first, or hide the ring instead (deleted activities are kept for the audit trail).` };
      await tx.query(`delete from rings where id = $1 and clock_id = $2`, [p.id, p.clock_id]);
      return { ok: true as const };
    });
    revalidatePath("/clocks", "layout");
    return r;
  } catch (e) {
    return failure(e);
  }
}

const inviteInput = z.object({
  clock_id: uuid,
  email: z.email().max(254).transform((s) => s.trim().toLowerCase()),
  full_name: z.string().trim().max(120).optional(),
  role: roleSchema,
});

/**
 * Invite by email: ensures an identity exists (Supabase Auth today, Entra later),
 * upserts the profile, grants the role, and emails a magic sign-in link.
 */
export async function inviteMember(raw: unknown): Promise<Result> {
  try {
    const p = inviteInput.parse(raw);
    const s = await requireSession();
    const clock = await asAdmin(p.clock_id, (tx) => tx.one<{ name: string; slug: string }>(`select name, slug from clocks where id = $1`, [p.clock_id]));
    const { id } = await ensureIdentity(p.email);
    await withService((tx) =>
      tx.query(
        `insert into profiles (id, email, full_name) values ($1, $2, $3)
         on conflict (id) do update set email = excluded.email, full_name = coalesce(profiles.full_name, excluded.full_name)`,
        [id, p.email, p.full_name || null],
      ),
    );
    await withUser(s.profile.id, (tx) =>
      tx.query(
        `insert into clock_members (clock_id, user_id, role) values ($1, $2, $3)
         on conflict (clock_id, user_id) do update set role = excluded.role`,
        [p.clock_id, id, p.role],
      ),
    );
    const tokenHash = await generateSignInTokenHash(p.email);
    const url = new URL("/auth/confirm", env().APP_BASE_URL);
    url.searchParams.set("next", `/clocks/${clock!.slug}`);
    if (tokenHash) {
      url.searchParams.set("token_hash", tokenHash);
      url.searchParams.set("type", "magiclink");
    }
    await getEmailProvider().send({
      to: p.email,
      ...renderInviteEmail({ url: url.toString(), clockName: clock!.name, role: p.role, inviter: s.profile.full_name ?? s.profile.email }),
    });
    revalidatePath("/clocks", "layout");
    return { ok: true, message: `Invited ${p.email} as ${p.role}.` };
  } catch (e) {
    return failure(e);
  }
}

export async function setMemberRole(raw: unknown): Promise<Result> {
  try {
    const p = z.object({ clock_id: uuid, user_id: uuid, role: roleSchema }).parse(raw);
    await asAdmin(p.clock_id, async (tx) => {
      await guardLastAdmin(tx, p.clock_id, p.user_id, p.role);
      await tx.query(`update clock_members set role = $3 where clock_id = $1 and user_id = $2`, [p.clock_id, p.user_id, p.role]);
    });
    revalidatePath("/clocks", "layout");
    return { ok: true, message: "Role updated." };
  } catch (e) {
    return failure(e);
  }
}

export async function removeMember(raw: unknown): Promise<Result> {
  try {
    const p = z.object({ clock_id: uuid, user_id: uuid }).parse(raw);
    await asAdmin(p.clock_id, async (tx) => {
      await guardLastAdmin(tx, p.clock_id, p.user_id, null);
      await tx.query(`delete from clock_members where clock_id = $1 and user_id = $2`, [p.clock_id, p.user_id]);
    });
    syncCalendarLinksWhere({ userId: p.user_id, clockId: p.clock_id }); // cancels entries they can no longer see
    revalidatePath("/clocks", "layout");
    return { ok: true, message: "Member removed." };
  } catch (e) {
    return failure(e);
  }
}

async function guardLastAdmin(tx: Tx, clockId: string, userId: string, newRole: string | null) {
  const admins = await tx.query<{ user_id: string }>(`select user_id from clock_members where clock_id = $1 and role = 'admin'`, [clockId]);
  if (admins.length === 1 && admins[0].user_id === userId && newRole !== "admin") {
    throw new z.ZodError([{ code: "custom", path: ["role"], message: "A clock needs at least one admin", input: newRole }]);
  }
}
