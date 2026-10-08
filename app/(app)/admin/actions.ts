"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/server/session";
import { withService, withUser } from "@/lib/db";
import { hexColor, uuid } from "@/lib/validation";
import { ensureIdentity, generateSignInTokenHash } from "@/lib/providers/supabase/admin-identity";
import { getEmailProvider } from "@/lib/providers/email";
import { renderSignInEmail } from "@/lib/notifications/templates";
import { runDefaultNotificationJob } from "@/lib/notifications";
import { env } from "@/lib/env";

type Result = { ok: true; message?: string } | { ok: false; error: string };

/** Super-admin operations: privileged columns are not user-writable, so these run as the service after an explicit check. */
async function requireSuperAdmin() {
  const s = await requireSession();
  if (!s.isSuperAdmin) throw new Error("forbidden");
  return s;
}

function fail(e: unknown): Result {
  if (e instanceof z.ZodError) return { ok: false, error: e.issues.map((i) => i.message).join("; ") };
  const m = (e as Error).message;
  if (m === "forbidden") return { ok: false, error: "Super admin only." };
  if (/duplicate key/.test(m)) return { ok: false, error: "That already exists." };
  console.error(JSON.stringify({ level: "error", msg: "admin action failed", error: m }));
  return { ok: false, error: "Something went wrong." };
}

const userUpdate = z.object({
  id: uuid,
  is_active: z.boolean().optional(),
  all_clocks_viewer: z.boolean().optional(),
  global_role: z.enum(["user", "super_admin"]).optional(),
});

export async function updateUser(raw: unknown): Promise<Result> {
  try {
    const s = await requireSuperAdmin();
    const p = userUpdate.parse(raw);
    if (p.id === s.profile.id && (p.is_active === false || p.global_role === "user")) {
      return { ok: false, error: "You cannot deactivate or demote yourself." };
    }
    await withService(async (tx) => {
      if (p.is_active !== undefined) await tx.query(`update profiles set is_active = $2 where id = $1`, [p.id, p.is_active]);
      if (p.all_clocks_viewer !== undefined) await tx.query(`update profiles set all_clocks_viewer = $2 where id = $1`, [p.id, p.all_clocks_viewer]);
      if (p.global_role !== undefined) await tx.query(`update profiles set global_role = $2 where id = $1`, [p.id, p.global_role]);
      await tx.query(
        `insert into audit_log (actor_id, entity, entity_id, action, diff) values ($1, 'profiles', $2, 'update', $3)`,
        [s.profile.id, p.id, JSON.stringify(p)],
      );
    });
    revalidatePath("/admin");
    return { ok: true, message: "Updated." };
  } catch (e) {
    return fail(e);
  }
}

const inviteInput = z.object({
  email: z.email().max(254).transform((s) => s.trim().toLowerCase()),
  full_name: z.string().trim().max(120).optional(),
  all_clocks_viewer: z.boolean().default(false),
});

export async function inviteUser(raw: unknown): Promise<Result> {
  try {
    await requireSuperAdmin();
    const p = inviteInput.parse(raw);
    const { id } = await ensureIdentity(p.email);
    await withService((tx) =>
      tx.query(
        `insert into profiles (id, email, full_name, all_clocks_viewer) values ($1, $2, $3, $4)
         on conflict (id) do update set is_active = true, all_clocks_viewer = excluded.all_clocks_viewer,
           full_name = coalesce(excluded.full_name, profiles.full_name)`,
        [id, p.email, p.full_name || null, p.all_clocks_viewer],
      ),
    );
    const th = await generateSignInTokenHash(p.email);
    if (th) {
      const url = new URL("/auth/confirm", env().APP_BASE_URL);
      url.searchParams.set("token_hash", th);
      url.searchParams.set("type", "magiclink");
      url.searchParams.set("next", "/clocks");
      await getEmailProvider().send({ to: p.email, ...renderSignInEmail({ url: url.toString(), email: p.email }) });
    }
    revalidatePath("/admin");
    return { ok: true, message: `Invited ${p.email}. Add them to clocks from each clock's settings.` };
  } catch (e) {
    return fail(e);
  }
}

const clockInput = z.object({
  name: z.string().trim().min(1).max(80),
  slug: z.string().trim().regex(/^[a-z0-9-]{2,40}$/, "Slug: lowercase letters, digits and dashes"),
  color: hexColor,
  description: z.string().trim().max(500).optional(),
  rings: z.array(z.string().trim().min(1).max(60)).max(10),
});

export async function createClock(raw: unknown): Promise<Result> {
  try {
    const s = await requireSuperAdmin();
    const p = clockInput.parse(raw);
    // As the super admin (RLS permits) so the audit log records the actor.
    await withUser(s.profile.id, async (tx) => {
      const c = await tx.one<{ id: string }>(
        `insert into clocks (name, slug, color, description, position) values ($1, $2, $3, $4,
           coalesce((select max(position) + 1 from clocks), 0)) returning id`,
        [p.name, p.slug, p.color, p.description || null],
      );
      const rings = p.rings.length ? p.rings : ["Regulatory", "Internal", "Reporting"];
      const palette = ["#16A082", "#39978F", "#55BFB6", "#425B76", "#1CC0A7"];
      for (const [i, name] of rings.entries()) {
        await tx.query(`insert into rings (clock_id, name, color, position) values ($1, $2, $3, $4)`, [c!.id, name, palette[i % palette.length], i]);
      }
      await tx.query(`insert into clock_members (clock_id, user_id, role) values ($1, $2, 'admin')`, [c!.id, s.profile.id]);
    });
    revalidatePath("/", "layout");
    return { ok: true, message: `Created ${p.name}. You are its first admin.` };
  } catch (e) {
    return fail(e);
  }
}

export async function setClockArchived(raw: unknown): Promise<Result> {
  try {
    const s = await requireSuperAdmin();
    const p = z.object({ id: uuid, archived: z.boolean() }).parse(raw);
    await withUser(s.profile.id, (tx) => tx.query(`update clocks set archived_at = case when $2 then now() end where id = $1`, [p.id, p.archived]));
    revalidatePath("/", "layout");
    return { ok: true, message: p.archived ? "Archived." : "Restored." };
  } catch (e) {
    return fail(e);
  }
}

export async function runJobNow(raw: unknown): Promise<Result> {
  try {
    await requireSuperAdmin();
    const p = z.object({ dryRun: z.boolean() }).parse(raw);
    const r = await runDefaultNotificationJob({ dryRun: p.dryRun });
    revalidatePath("/admin");
    return {
      ok: true,
      message: p.dryRun
        ? `Dry run: ${r.planned - r.alreadySent} would be sent, ${r.alreadySent} already sent.`
        : `Sent ${r.sent}, failed ${r.failed}, skipped ${r.skipped}, already sent ${r.alreadySent}, retried ${r.retried}.`,
    };
  } catch (e) {
    return fail(e);
  }
}
