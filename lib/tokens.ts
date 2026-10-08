/**
 * Signed, expiring tokens for links in emails (mark done / snooze / open),
 * and opaque random tokens for ICS feeds (stored hashed, revocable).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const actionPayload = z.object({
  v: z.literal(1),
  act: z.enum(["done", "snooze", "open"]),
  aid: z.uuid(),
  occ: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  uid: z.uuid(),
  exp: z.number().int(),
});
export type ActionTokenPayload = z.infer<typeof actionPayload>;

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

function sign(data: string, secret: string) {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function createActionToken(
  p: Omit<ActionTokenPayload, "v" | "exp">,
  secret: string,
  ttlSeconds = 60 * 60 * 24 * 30,
  now = Date.now(),
): string {
  const payload: ActionTokenPayload = { v: 1, ...p, exp: Math.floor(now / 1000) + ttlSeconds };
  const body = b64(JSON.stringify(payload));
  return `${body}.${sign(body, secret)}`;
}

export type VerifyResult = { ok: true; payload: ActionTokenPayload } | { ok: false; reason: "malformed" | "signature" | "expired" };

export function verifyActionToken(token: string, secret: string, now = Date.now()): VerifyResult {
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return { ok: false, reason: "malformed" };
  const expected = Buffer.from(sign(body, secret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "signature" };
  let parsed;
  try {
    parsed = actionPayload.safeParse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!parsed.success) return { ok: false, reason: "malformed" };
  if (parsed.data.exp * 1000 < now) return { ok: false, reason: "expired" };
  return { ok: true, payload: parsed.data };
}

export function createOpaqueToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
