/**
 * Calendar-date helpers. All-day dates are plain ISO strings ('YYYY-MM-DD')
 * and all arithmetic is done in UTC so DST never shifts a date.
 */
export type ISODate = string;

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isISODate(s: unknown): s is ISODate {
  if (typeof s !== "string" || !ISO_RE.test(s)) return false;
  const d = toUTCDate(s);
  return fromUTCDate(d) === s;
}

export function toUTCDate(s: ISODate): Date {
  const m = ISO_RE.exec(s);
  if (!m) throw new Error(`Invalid ISO date: ${s}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

export function fromUTCDate(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}

export function makeDate(year: number, month1: number, day: number): ISODate {
  return fromUTCDate(new Date(Date.UTC(year, month1 - 1, day)));
}

export function addDays(s: ISODate, n: number): ISODate {
  const d = toUTCDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return fromUTCDate(d);
}

/** b - a in whole days */
export function diffDays(a: ISODate, b: ISODate): number {
  return Math.round((toUTCDate(b).getTime() - toUTCDate(a).getTime()) / 86_400_000);
}

export function yearOf(s: ISODate): number {
  return Number(s.slice(0, 4));
}

export function monthOf(s: ISODate): number {
  return Number(s.slice(5, 7));
}

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInYear(y: number): number {
  return isLeapYear(y) ? 366 : 365;
}

export function daysInMonth(y: number, month1: number): number {
  return new Date(Date.UTC(y, month1, 0)).getUTCDate();
}

export function minDate(a: ISODate, b: ISODate): ISODate {
  return a < b ? a : b;
}

export function maxDate(a: ISODate, b: ISODate): ISODate {
  return a > b ? a : b;
}

/** ISO-8601 week number and week-year (weeks start Monday). */
export function isoWeek(s: ISODate): { week: number; year: number } {
  const d = toUTCDate(s);
  const day = (d.getUTCDay() + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - day + 3); // Thursday of this week
  const weekYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(weekYear, 0, 4));
  const ftDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ftDay + 3);
  return { week: 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86_400_000)), year: weekYear };
}

/** Monday on or before the given date. */
export function startOfIsoWeek(s: ISODate): ISODate {
  const d = toUTCDate(s);
  return addDays(s, -((d.getUTCDay() + 6) % 7));
}

/** Today's calendar date in the given IANA time zone. */
export function todayInZone(timeZone = "Europe/Helsinki", now: Date = new Date()): ISODate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
