import { expect, test } from "vitest";
import { buildOccurrences, type Activity } from "@/lib/domain";
import { addDays } from "@/lib/dates";
import { assignLanes, clipToYear, yearSpan } from "@/lib/wheel/geometry";

test("500 activities (mixed recurrence) expand and lay out for a year well within a frame budget", () => {
  const rrules = [null, "FREQ=YEARLY", "FREQ=MONTHLY", "FREQ=MONTHLY;INTERVAL=3", "FREQ=WEEKLY"];
  const acts: Activity[] = Array.from({ length: 500 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    clock_id: "c",
    ring_id: `r${i % 3}`,
    title: `Activity ${i}`,
    description: null,
    type: i % 4 === 0 ? "period" : "deadline",
    start_date: addDays("2026-01-01", i % 365),
    end_date: i % 4 === 0 ? addDays("2026-01-01", (i % 365) + 5) : null,
    all_day: true,
    start_time: null,
    end_time: null,
    rrule: rrules[i % rrules.length],
    owner_id: null,
    status: "planned",
    predecessor_id: null,
    reminder_offsets: null,
    tags: [],
    links: [],
    assignee_ids: [],
  }));
  const t0 = performance.now();
  const occ = buildOccurrences(acts, [], "2026-01-01", "2026-12-31", "2026-06-01");
  const span = yearSpan(2026);
  for (const ring of ["r0", "r1", "r2"]) {
    const items = occ
      .filter((o) => o.activity.ring_id === ring)
      .map((o) => clipToYear(o.date, o.endDate, span)!)
      .map((c) => ({ start: c.start, end: c.end }));
    assignLanes(items);
  }
  const ms = performance.now() - t0;
  expect(occ.length).toBeGreaterThan(3000);
  expect(ms).toBeLessThan(1500);
  console.log(`500 activities -> ${occ.length} occurrences in ${ms.toFixed(0)} ms`);
});
