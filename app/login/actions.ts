"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { auth } from "@/lib/server/auth";
import { createDemoSession } from "@/lib/providers/supabase/auth";
import { clientIp, rateLimit } from "@/lib/server/rate-limit";
import { safeNext } from "@/lib/server/safe-redirect";
import { withService } from "@/lib/db";
import { env } from "@/lib/env";

export type LoginState = { status: "idle" | "sent" | "error"; message?: string };

const emailSchema = z.email().max(254).transform((s) => s.trim().toLowerCase());

export async function sendLinkAction(_prev: LoginState, form: FormData): Promise<LoginState> {
  const parsed = emailSchema.safeParse(String(form.get("email") ?? "").trim());
  if (!parsed.success) return { status: "error", message: "invalid" };
  const ip = await clientIp();
  const okIp = await rateLimit(`login:ip:${ip}`, 20, 3600);
  const okEmail = await rateLimit(`login:email:${parsed.data}`, 5, 3600);
  if (!okIp || !okEmail) return { status: "sent" }; // do not reveal throttling or account existence
  const next = safeNext(String(form.get("next") ?? ""));
  const url = new URL("/auth/confirm", env().APP_BASE_URL);
  url.searchParams.set("next", next);
  try {
    await auth.sendSignInLink(parsed.data, url.toString());
  } catch (e) {
    console.error(JSON.stringify({ level: "error", msg: "sign-in link failed", error: String(e) }));
  }
  return { status: "sent" };
}

export async function demoLoginAction(form: FormData) {
  if (!env().DEMO_LOGIN_ENABLED) throw new Error("Demo login is disabled");
  const email = emailSchema.parse(String(form.get("email") ?? ""));
  const isDemo = await withService((tx) =>
    tx.one<{ ok: boolean }>(`select true as ok from profiles where lower(email) = $1 and is_demo and is_active`, [email]),
  );
  if (!isDemo) throw new Error("Not a demo user");
  const user = await createDemoSession(email);
  if (!user) throw new Error("Demo sign-in failed");
  redirect(safeNext(String(form.get("next") ?? "")));
}
