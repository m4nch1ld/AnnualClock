/**
 * Minimal i18n: message catalogs per locale + locale-aware date formatting.
 * Add Finnish by creating fi.ts with the same keys and registering it below.
 */
import { en, type Messages } from "./en";
import { toUTCDate, type ISODate } from "../dates";

export type Locale = "en" | "fi";
const catalogs: Partial<Record<Locale, Messages>> = { en };

type Path<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Path<T[K], `${P}${K}.`>;
}[keyof T & string];
export type MessageKey = Path<Messages>;

export function t(key: MessageKey, vars?: Record<string, string | number>, locale: Locale = "en"): string {
  const catalog = catalogs[locale] ?? en;
  const raw = key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], catalog);
  const str = typeof raw === "string" ? raw : key;
  return vars ? str.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`)) : str;
}

/** Long-ish date: en "31 Mar 2026", fi "31.3.2026". */
export function formatDate(d: ISODate, locale: Locale = "en"): string {
  const date = toUTCDate(d);
  if (locale === "fi") return `${date.getUTCDate()}.${date.getUTCMonth() + 1}.${date.getUTCFullYear()}`;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(date);
}

export function formatDateRange(start: ISODate, end: ISODate | null, locale: Locale = "en"): string {
  return end && end !== start ? `${formatDate(start, locale)} – ${formatDate(end, locale)}` : formatDate(start, locale);
}

export function monthName(month1: number, locale: Locale = "en", style: "long" | "short" = "long"): string {
  return new Intl.DateTimeFormat(locale === "fi" ? "fi-FI" : "en-GB", { month: style, timeZone: "UTC" }).format(
    new Date(Date.UTC(2026, month1 - 1, 1)),
  );
}

export function weekdayName(iso: ISODate, locale: Locale = "en"): string {
  return new Intl.DateTimeFormat(locale === "fi" ? "fi-FI" : "en-GB", { weekday: "short", timeZone: "UTC" }).format(
    toUTCDate(iso),
  );
}
