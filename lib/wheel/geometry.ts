/**
 * Year-wheel geometry. Angle 0 = top (1 January), increasing clockwise.
 * Angles are in radians in [0, 2π).
 */
import { addDays, daysInMonth, daysInYear, diffDays, isoWeek, makeDate, maxDate, minDate, startOfIsoWeek, type ISODate } from "../dates";

export const TAU = Math.PI * 2;

export interface YearSpan {
  year: number;
  start: ISODate;
  end: ISODate; // inclusive (31 Dec)
  days: number;
}

export function yearSpan(year: number): YearSpan {
  return { year, start: makeDate(year, 1, 1), end: makeDate(year, 12, 31), days: daysInYear(year) };
}

/** Angle at the START of the given date. */
export function dateToAngle(date: ISODate, span: YearSpan): number {
  return (diffDays(span.start, date) / span.days) * TAU;
}

/** Angle at the END of the given date (start of next day). */
export function dateEndToAngle(date: ISODate, span: YearSpan): number {
  return ((diffDays(span.start, date) + 1) / span.days) * TAU;
}

/** Day that contains the given angle, clamped into the year. */
export function angleToDate(angle: number, span: YearSpan): ISODate {
  const a = ((angle % TAU) + TAU) % TAU;
  const idx = Math.min(span.days - 1, Math.max(0, Math.floor((a / TAU) * span.days)));
  return addDays(span.start, idx);
}

/** Rounded to 1/100 px so server- and browser-rendered SVG match exactly (hydration). */
export function polar(cx: number, cy: number, r: number, angle: number): [number, number] {
  return [Math.round((cx + r * Math.sin(angle)) * 100) / 100, Math.round((cy - r * Math.cos(angle)) * 100) / 100];
}

/** Convert an SVG point to (radius, angle) around the centre. */
export function toPolar(x: number, y: number, cx: number, cy: number): { r: number; angle: number } {
  const dx = x - cx;
  const dy = y - cy;
  const angle = (Math.atan2(dx, -dy) + TAU) % TAU;
  return { r: Math.hypot(dx, dy), angle };
}

const f = (n: number) => Math.round(n * 100) / 100;

/** SVG path for an annular sector between radii r0 < r1 and angles a0 < a1. */
export function sectorPath(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const sweep = a1 - a0;
  if (sweep >= TAU - 1e-6) {
    // full ring: two half arcs
    const [ox, oy] = polar(cx, cy, r1, 0);
    const [ox2, oy2] = polar(cx, cy, r1, Math.PI);
    const [ix, iy] = polar(cx, cy, r0, 0);
    const [ix2, iy2] = polar(cx, cy, r0, Math.PI);
    return [
      `M${f(ox)},${f(oy)}A${r1},${r1} 0 1 1 ${f(ox2)},${f(oy2)}A${r1},${r1} 0 1 1 ${f(ox)},${f(oy)}Z`,
      `M${f(ix)},${f(iy)}A${r0},${r0} 0 1 0 ${f(ix2)},${f(iy2)}A${r0},${r0} 0 1 0 ${f(ix)},${f(iy)}Z`,
    ].join("");
  }
  const large = sweep > Math.PI ? 1 : 0;
  const [x0, y0] = polar(cx, cy, r1, a0);
  const [x1, y1] = polar(cx, cy, r1, a1);
  const [x2, y2] = polar(cx, cy, r0, a1);
  const [x3, y3] = polar(cx, cy, r0, a0);
  return `M${f(x0)},${f(y0)}A${r1},${r1} 0 ${large} 1 ${f(x1)},${f(y1)}L${f(x2)},${f(y2)}A${r0},${r0} 0 ${large} 0 ${f(x3)},${f(y3)}Z`;
}

/** Open arc path along radius r (for text paths / connectors). */
export function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  return `M${f(x0)},${f(y0)}A${r},${r} 0 ${large} 1 ${f(x1)},${f(y1)}`;
}

/**
 * Clip an item's [start, end] dates into the year. Returns null if outside.
 * `clippedStart/End` flags tell the renderer the item continues beyond the year.
 */
export function clipToYear(start: ISODate, end: ISODate | null, span: YearSpan) {
  const e = end ?? start;
  if (e < span.start || start > span.end) return null;
  return {
    start: maxDate(start, span.start),
    end: minDate(e, span.end),
    clippedStart: start < span.start,
    clippedEnd: e > span.end,
  };
}

/** Greedy interval packing: returns a lane index for each item and the lane count. */
export function assignLanes<T extends { start: ISODate; end: ISODate }>(items: T[]): { lanes: number[]; count: number } {
  const order = items.map((it, i) => i).sort((a, b) => (items[a].start < items[b].start ? -1 : items[a].start > items[b].start ? 1 : 0));
  const laneEnds: ISODate[] = [];
  const lanes = new Array<number>(items.length).fill(0);
  for (const i of order) {
    const it = items[i];
    let lane = laneEnds.findIndex((end) => end < it.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(it.end);
    } else {
      laneEnds[lane] = it.end;
    }
    lanes[i] = lane;
  }
  return { lanes, count: Math.max(1, laneEnds.length) };
}

/** ISO weeks whose Monday falls in the year (plus week 1 starting in the previous year). */
export function weeksOfYear(span: YearSpan): Array<{ week: number; start: ISODate }> {
  const out: Array<{ week: number; start: ISODate }> = [];
  let monday = startOfIsoWeek(span.start);
  while (monday <= span.end) {
    out.push({ week: isoWeek(monday).week, start: maxDate(monday, span.start) });
    monday = addDays(monday, 7);
  }
  return out;
}

export function monthsOfYear(span: YearSpan): Array<{ month: number; start: ISODate; end: ISODate }> {
  return Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    start: makeDate(span.year, i + 1, 1),
    end: makeDate(span.year, i + 1, daysInMonth(span.year, i + 1)),
  }));
}
