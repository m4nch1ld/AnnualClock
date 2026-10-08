import "server-only";
import { headers } from "next/headers";
import { withService } from "@/lib/db";

export async function clientIp(): Promise<string> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
}

/** Fixed-window rate limit backed by Postgres (works across serverless instances). */
export async function rateLimit(key: string, max: number, windowSeconds: number): Promise<boolean> {
  const row = await withService((tx) =>
    tx.one<{ ok: boolean }>(`select public.rate_limit_hit($1, $2, $3) as ok`, [key, windowSeconds, max]),
  );
  return !!row?.ok;
}
