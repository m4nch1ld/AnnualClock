import { describe, expect, test } from "vitest";
import { addDays, diffDays, isISODate, isoWeek, startOfIsoWeek, todayInZone } from "@/lib/dates";
import { endSeriesBefore, expandOccurrences, normalizeRRule, recurrenceKindOf, rruleForKind } from "@/lib/recurrence";
import { buildOccurrences, reminderOffsets, type Activity } from "@/lib/domain";

describe("dates", () => {
  test("ISO date validation", () => {
    expect(isISODate("2026-02-28")).toBe(true);
    expect(isISODate("2026-02-30")).toBe(false);
    expect(isISODate("2026-2-3")).toBe(false);
  });

  test("addDays / diffDays across DST and leap years", () => {
    expect(addDays("2026-03-28", 2)).toBe("2026-03-30"); // EU DST change weekend
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(diffDays("2026-12-31", "2027-01-01")).toBe(1);
  });

  test("ISO weeks (Monday start)", () => {
    expect(isoWeek("2026-01-01")).toEqual({ week: 1, year: 2026 }); // Thursday
    expect(isoWeek("2027-01-01")).toEqual({ week: 53, year: 2026 }); // Friday of W53/2026
    expect(isoWeek("2026-12-28")).toEqual({ week: 53, year: 2026 });
    expect(startOfIsoWeek("2026-10-11")).toBe("2026-10-05"); // Sunday -> Monday
  });

  test("today in Helsinki differs from UTC around midnight", () => {
    // 2026-06-30 22:30 UTC = 2026-07-01 01:30 in Helsinki (UTC+3)
    expect(todayInZone("Europe/Helsinki", new Date("2026-06-30T22:30:00Z"))).toBe("2026-07-01");
    expect(todayInZone("UTC", new Date("2026-06-30T22:30:00Z"))).toBe("2026-06-30");
  });
});

describe("recurrence", () => {
  test("presets and normalisation", () => {
    expect(rruleForKind("yearly")).toBe("FREQ=YEARLY");
    expect(rruleForKind("quarterly")).toBe("FREQ=MONTHLY;INTERVAL=3");
    expect(recurrenceKindOf("FREQ=MONTHLY;INTERVAL=3")).toBe("quarterly");
    expect(normalizeRRule("RRULE:FREQ=WEEKLY;BYDAY=MO")).toBe("FREQ=WEEKLY;BYDAY=MO");
    expect(normalizeRRule("FREQ=HOURLY")).toBeNull(); // too fine-grained
    expect(normalizeRRule("DTSTART:20260101T000000Z\nRRULE:FREQ=DAILY")).toBeNull();
    expect(normalizeRRule("nonsense")).toBeNull();
  });

  test("yearly expansion only within range", () => {
    const occ = expandOccurrences({ start_date: "2026-03-31", end_date: null, rrule: "FREQ=YEARLY" }, "2027-01-01", "2028-12-31");
    expect(occ.map((o) => o.date)).toEqual(["2027-03-31", "2028-03-31"]);
  });

  test("no occurrences before the series start", () => {
    const occ = expandOccurrences({ start_date: "2026-03-31", end_date: null, rrule: "FREQ=YEARLY" }, "2020-01-01", "2025-12-31");
    expect(occ).toEqual([]);
  });

  test("quarterly", () => {
    const occ = expandOccurrences({ start_date: "2026-01-15", end_date: null, rrule: "FREQ=MONTHLY;INTERVAL=3" }, "2026-01-01", "2026-12-31");
    expect(occ.map((o) => o.date)).toEqual(["2026-01-15", "2026-04-15", "2026-07-15", "2026-10-15"]);
  });

  test("periods keep duration and include ones overlapping the range start (year boundary)", () => {
    const occ = expandOccurrences({ start_date: "2025-12-14", end_date: "2026-01-08", rrule: "FREQ=YEARLY" }, "2026-01-01", "2026-12-31");
    expect(occ).toEqual([
      { date: "2025-12-14", endDate: "2026-01-08" },
      { date: "2026-12-14", endDate: "2027-01-08" },
    ]);
  });

  test("one-off items", () => {
    expect(expandOccurrences({ start_date: "2026-05-01", end_date: null, rrule: null }, "2026-01-01", "2026-12-31")).toHaveLength(1);
    expect(expandOccurrences({ start_date: "2026-05-01", end_date: null, rrule: null }, "2027-01-01", "2027-12-31")).toHaveLength(0);
  });

  test("splitting a series ends it the day before", () => {
    const ended = endSeriesBefore("FREQ=YEARLY", "2028-03-31");
    const occ = expandOccurrences({ start_date: "2026-03-31", end_date: null, rrule: ended }, "2026-01-01", "2030-12-31");
    expect(occ.map((o) => o.date)).toEqual(["2026-03-31", "2027-03-31"]);
  });
});

describe("occurrences", () => {
  const base: Activity = {
    id: "a1",
    clock_id: "c1",
    ring_id: "r1",
    title: "EUA verification due",
    description: null,
    type: "deadline",
    start_date: "2026-03-31",
    end_date: null,
    all_day: true,
    start_time: null,
    end_time: null,
    rrule: "FREQ=YEARLY",
    owner_id: null,
    status: "planned",
    predecessor_id: null,
    reminder_offsets: null,
    tags: [],
    links: [],
    assignee_ids: [],
  };

  test("per-occurrence completion and overdue", () => {
    const occ = buildOccurrences(
      [base],
      [{ activity_id: "a1", occurrence_date: "2026-03-31", status: "done", completed_at: null, completed_by: null, snoozed_until: null }],
      "2026-01-01",
      "2027-12-31",
      "2027-04-02",
    );
    expect(occ.map((o) => [o.date, o.status, o.overdue])).toEqual([
      ["2026-03-31", "done", false],
      ["2027-03-31", "planned", true],
    ]);
  });

  test("reminder offsets: activity override, else clock default; sanitised and sorted", () => {
    expect(reminderOffsets({ reminder_offsets: null }, { default_reminder_offsets: [7, 30, 1] })).toEqual([30, 7, 1]);
    expect(reminderOffsets({ reminder_offsets: [1, 1, 0, -3, 999] }, { default_reminder_offsets: [30] })).toEqual([1, 0]);
  });
});
