"use client";

/** Month view: Monday-first calendar grid plus an agenda list for the month. */
import { useMemo } from "react";
import type { Occurrence } from "@/lib/domain";
import { addDays, daysInMonth, isoWeek, makeDate, startOfIsoWeek, type ISODate } from "@/lib/dates";
import { formatDateRange, monthName, t, weekdayName } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "./status-badge";
import { cn } from "@/lib/utils";

interface Props {
  year: number;
  month: number;
  onMonthChange: (m: number) => void;
  today: ISODate;
  occurrences: Occurrence[];
  colorFor: (o: Occurrence) => string;
  onSelect: (o: Occurrence) => void;
  selectedKey: string | null;
}

export function AgendaView({ year, month, onMonthChange, today, occurrences, colorFor, onSelect, selectedKey }: Props) {
  const first = makeDate(year, month, 1);
  const last = makeDate(year, month, daysInMonth(year, month));
  const inMonth = useMemo(
    () => occurrences.filter((o) => o.date <= last && (o.endDate ?? o.date) >= first),
    [occurrences, first, last],
  );

  const weeks: ISODate[][] = [];
  for (let d = startOfIsoWeek(first); d <= last; d = addDays(d, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(d, i)));
  }
  const onDay = (d: ISODate) => inMonth.filter((o) => o.date <= d && (o.endDate ?? o.date) >= d);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => onMonthChange(month - 1)} disabled={month <= 1} aria-label="Previous month">
          ←
        </Button>
        <h2 className="min-w-40 text-center text-lg" aria-live="polite">
          {monthName(month)} {year}
        </h2>
        <Button variant="outline" size="sm" onClick={() => onMonthChange(month + 1)} disabled={month >= 12} aria-label="Next month">
          →
        </Button>
      </div>

      <div className="hidden overflow-hidden rounded-lg border border-border bg-surface sm:block" aria-hidden>
        <div className="grid grid-cols-[2.5rem_repeat(7,1fr)] bg-canvas text-xs text-muted">
          <div className="px-1 py-1.5 text-center">{t("clock.week", { week: "" }).trim()}</div>
          {weeks[0].map((d) => (
            <div key={d} className="px-2 py-1.5">
              {weekdayName(d)}
            </div>
          ))}
        </div>
        {weeks.map((w) => (
          <div key={w[0]} className="grid grid-cols-[2.5rem_repeat(7,1fr)] border-t border-border">
            <div className="px-1 py-1 text-center text-xs text-muted">{isoWeek(w[0]).week}</div>
            {w.map((d) => {
              const items = onDay(d);
              const outside = d < first || d > last;
              return (
                <div key={d} className={cn("min-h-24 border-l border-border p-1", outside && "bg-canvas/70")}>
                  <div className={cn("mb-1 text-xs", d === today ? "inline-block rounded bg-brand px-1.5 font-medium text-white" : "text-muted")}>
                    {Number(d.slice(8))}
                  </div>
                  <ul className="space-y-0.5">
                    {items.slice(0, 4).map((o) => (
                      <li key={o.key}>
                        <button
                          type="button"
                          tabIndex={-1}
                          onClick={() => onSelect(o)}
                          className={cn(
                            "block w-full truncate rounded px-1 py-0.5 text-left text-[11px] text-white",
                            o.status === "done" && "opacity-50 line-through",
                            selectedKey === o.key && "ring-2 ring-ink",
                          )}
                          style={{ background: colorFor(o) }}
                          title={o.activity.title}
                        >
                          {o.activity.title}
                        </button>
                      </li>
                    ))}
                    {items.length > 4 && <li className="text-[11px] text-muted">{t("clock.moreItems", { count: items.length - 4 })}</li>}
                  </ul>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <section aria-label={`${monthName(month)} ${year}`}>
        {inMonth.length === 0 ? (
          <p className="text-muted">{t("clock.noResults")}</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
            {inMonth.map((o) => (
              <li key={o.key} className={cn("flex flex-wrap items-center gap-3 px-3 py-2", selectedKey === o.key && "bg-teal-5/25")}>
                <span className="size-3 shrink-0 rounded-full" style={{ background: colorFor(o) }} aria-hidden />
                <span className="w-44 shrink-0 text-sm text-muted">{formatDateRange(o.date, o.endDate)}</span>
                <button type="button" onClick={() => onSelect(o)} className="flex-1 text-left text-sm font-medium hover:underline">
                  {o.activity.title}
                </button>
                <StatusBadge occ={o} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
