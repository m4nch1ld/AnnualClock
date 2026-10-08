import { describe, expect, test } from "vitest";
import {
  TAU,
  angleToDate,
  assignLanes,
  clipToYear,
  dateToAngle,
  monthsOfYear,
  toPolar,
  weeksOfYear,
  yearSpan,
} from "@/lib/wheel/geometry";

describe("wheel geometry", () => {
  const span = yearSpan(2026);

  test("1 January is at the top, 1 July is roughly at the bottom", () => {
    expect(dateToAngle("2026-01-01", span)).toBe(0);
    expect(dateToAngle("2026-07-02", span) / TAU).toBeCloseTo(182 / 365, 6);
  });

  test("angle -> date round-trips for every day", () => {
    for (let i = 0; i < span.days; i++) {
      const d = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
      const a = dateToAngle(d, span) + 0.5 * (TAU / span.days);
      expect(angleToDate(a, span)).toBe(d);
    }
  });

  test("toPolar: clockwise from 12 o'clock", () => {
    expect(toPolar(500, 100, 500, 500).angle).toBeCloseTo(0);
    expect(toPolar(900, 500, 500, 500).angle).toBeCloseTo(Math.PI / 2);
    expect(toPolar(100, 500, 500, 500).angle).toBeCloseTo((3 * Math.PI) / 2);
  });

  test("clipping at the year boundary", () => {
    expect(clipToYear("2025-12-14", "2026-01-08", span)).toEqual({
      start: "2026-01-01",
      end: "2026-01-08",
      clippedStart: true,
      clippedEnd: false,
    });
    expect(clipToYear("2026-12-14", "2027-01-08", span)?.clippedEnd).toBe(true);
    expect(clipToYear("2025-03-01", null, span)).toBeNull();
  });

  test("lanes: overlapping items get separate lanes", () => {
    const { lanes, count } = assignLanes([
      { start: "2026-01-01", end: "2026-01-10" },
      { start: "2026-01-05", end: "2026-01-12" },
      { start: "2026-01-11", end: "2026-01-20" },
    ]);
    expect(count).toBe(2);
    expect(lanes[0]).not.toBe(lanes[1]);
    expect(lanes[2]).toBe(lanes[0]);
  });

  test("months and ISO weeks", () => {
    const m = monthsOfYear(span);
    expect(m[1]).toEqual({ month: 2, start: "2026-02-01", end: "2026-02-28" });
    const w = weeksOfYear(span);
    expect(w[0]).toEqual({ week: 1, start: "2026-01-01" }); // week 1 starts Mon 29 Dec 2025, clipped
    expect(w.at(-1)?.week).toBe(53);
  });
});
