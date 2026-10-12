import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { runDefaultNotificationJob } from "@/lib/notifications";
import { calendar } from "@/lib/calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Scheduler entry point. Vercel Cron calls it with `Authorization: Bearer $CRON_SECRET`.
 * Any other scheduler (pg_cron + pg_net, GitHub Actions, Azure Logic App) can call
 * it the same way. `?dry=1` returns what would be sent without sending.
 */
function authorized(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

async function handle(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const dryRun = req.nextUrl.searchParams.get("dry") === "1";
  try {
    const result = await runDefaultNotificationJob({ dryRun });
    // Personal calendar entries whose last update/cancel failed are retried here.
    const calendarRetry = dryRun ? null : await calendar.retryFailed().catch((e) => ({ error: String(e) }));
    return NextResponse.json({ ...result, calendarRetry });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "job failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
