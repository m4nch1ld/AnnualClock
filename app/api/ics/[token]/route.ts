import { NextResponse, type NextRequest } from "next/server";
import { hashToken } from "@/lib/tokens";
import { withService, withUser } from "@/lib/db";
import { getActivities, getOccurrenceStates, getRings, listClocks } from "@/lib/data/clocks";
import { buildOccurrences } from "@/lib/domain";
import { addDays, todayInZone } from "@/lib/dates";
import { buildIcs } from "@/lib/ics";
import { rateLimit } from "@/lib/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Private calendar feed. The URL token is stored only as a SHA-256 hash and can be
 * revoked. Data is read AS the token's user, so RLS applies (revoked membership =
 * the clock disappears from the feed).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token: raw } = await params;
  const token = raw.replace(/\.ics$/, "");
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return new NextResponse("Not found", { status: 404 });
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!(await rateLimit(`ics:ip:${ip}`, 120, 3600)) || !(await rateLimit(`ics:tok:${hashToken(token).slice(0, 16)}`, 60, 3600))) {
    return new NextResponse("Too many requests", { status: 429, headers: { "retry-after": "3600" } });
  }

  const row = await withService((tx) =>
    tx.one<{ id: string; user_id: string; clock_id: string | null; is_active: boolean }>(
      `update ics_tokens t set last_used_at = now() from profiles p
       where t.token_hash = $1 and t.revoked_at is null and p.id = t.user_id
       returning t.id, t.user_id, t.clock_id, p.is_active`,
      [hashToken(token)],
    ),
  );
  if (!row || !row.is_active) return new NextResponse("Not found", { status: 404 });

  const today = todayInZone();
  const from = addDays(today, -365);
  const to = addDays(today, 730);
  const base = (process.env.APP_BASE_URL ?? req.nextUrl.origin).replace(/\/$/, "");

  const ics = await withUser(row.user_id, async (tx) => {
    const clocks = (await listClocks(tx)).filter((c) => !row.clock_id || c.id === row.clock_id);
    const ids = clocks.map((c) => c.id);
    const rings = await getRings(tx, ids);
    const activities = await getActivities(tx, ids);
    const states = await getOccurrenceStates(tx, activities.map((a) => a.id), addDays(from, -400), to);
    const occ = buildOccurrences(activities, states, from, to, today);
    const clockById = new Map(clocks.map((c) => [c.id, c]));
    const ringById = new Map(rings.map((r) => [r.id, r]));
    return buildIcs({
      calendarName: row.clock_id && clocks[0] ? `Annual Clock – ${clocks[0].name}` : "Annual Clock – all my clocks",
      events: occ.map((o) => {
        const c = clockById.get(o.activity.clock_id)!;
        return {
          occ: o,
          clockName: c.name,
          ringName: ringById.get(o.activity.ring_id)?.name ?? "",
          url: `${base}/clocks/${c.slug}?year=${o.date.slice(0, 4)}&focus=${o.activity.id}:${o.date}`,
        };
      }),
    });
  });

  return new NextResponse(ics, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": 'inline; filename="annual-clock.ics"',
      "cache-control": "private, max-age=900",
    },
  });
}
