"use client";

/**
 * Sortable table grouped by month — the fully keyboard-accessible equivalent
 * of the wheel.
 */
import { useMemo, useState } from "react";
import type { Clock, Occurrence, Ring } from "@/lib/domain";
import { formatDate, formatDateRange, monthName, t } from "@/lib/i18n";
import { describeRRule } from "@/lib/recurrence";
import { monthOf, yearOf } from "@/lib/dates";
import { StatusBadge } from "./status-badge";
import { cn } from "@/lib/utils";

type Col = "date" | "title" | "clock" | "ring" | "type" | "owner" | "status";

interface Props {
  occurrences: Occurrence[];
  ringsById: Map<string, Ring>;
  clocksById: Map<string, Clock>;
  showClock: boolean;
  personName: (id: string | null) => string;
  selectedKey: string | null;
  onSelect: (o: Occurrence) => void;
}

export function ListView({ occurrences, ringsById, clocksById, showClock, personName, selectedKey, onSelect }: Props) {
  const [sort, setSort] = useState<{ col: Col; dir: 1 | -1 }>({ col: "date", dir: 1 });

  const groups = useMemo(() => {
    const val = (o: Occurrence): string => {
      switch (sort.col) {
        case "date":
          return o.date;
        case "title":
          return o.activity.title.toLowerCase();
        case "clock":
          return clocksById.get(o.activity.clock_id)?.name ?? "";
        case "ring":
          return ringsById.get(o.activity.ring_id)?.name ?? "";
        case "type":
          return o.activity.type;
        case "owner":
          return personName(o.activity.owner_id);
        case "status":
          return o.overdue ? "0" : o.status;
      }
    };
    const sorted = [...occurrences].sort((a, b) => {
      const c = val(a).localeCompare(val(b));
      return (c !== 0 ? c : a.date.localeCompare(b.date)) * sort.dir;
    });
    const map = new Map<string, Occurrence[]>();
    for (const o of sorted) {
      const k = o.date.slice(0, 7);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(o);
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1) * (sort.col === "date" ? sort.dir : 1));
  }, [occurrences, sort, ringsById, clocksById, personName]);

  const cols: Array<{ col: Col; label: string; hide?: boolean; className?: string }> = [
    { col: "date", label: t("clock.columns.date"), className: "w-40" },
    { col: "title", label: t("clock.columns.title") },
    { col: "clock", label: t("clock.columns.clock"), hide: !showClock },
    { col: "ring", label: t("clock.columns.ring"), className: "hidden md:table-cell" },
    { col: "type", label: t("clock.columns.type"), className: "hidden lg:table-cell" },
    { col: "owner", label: t("clock.columns.owner"), className: "hidden md:table-cell" },
    { col: "status", label: t("clock.columns.status") },
  ];
  const visibleCols = cols.filter((c) => !c.hide);

  if (occurrences.length === 0) return <p className="p-6 text-center text-muted">{t("clock.noResults")}</p>;

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{t("clock.listHint")}</caption>
        <thead className="bg-canvas text-left text-xs text-muted">
          <tr>
            {visibleCols.map((c) => (
              <th
                key={c.col}
                scope="col"
                className={cn("px-3 py-2 font-medium", c.className)}
                aria-sort={sort.col === c.col ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
              >
                <button
                  type="button"
                  className="inline-flex items-center gap-1 hover:text-ink"
                  onClick={() => setSort((s) => ({ col: c.col, dir: s.col === c.col ? ((-s.dir) as 1 | -1) : 1 }))}
                  aria-label={t("clock.sortBy", { column: c.label })}
                >
                  {c.label}
                  <span aria-hidden>{sort.col === c.col ? (sort.dir === 1 ? "▲" : "▼") : ""}</span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        {groups.map(([month, items]) => (
          <tbody key={month}>
            <tr>
              <th
                colSpan={visibleCols.length}
                scope="rowgroup"
                className="border-t border-border bg-canvas/60 px-3 py-1.5 text-left text-xs font-medium uppercase tracking-wide text-primary"
              >
                {monthName(monthOf(`${month}-01`))} {yearOf(`${month}-01`)}
              </th>
            </tr>
            {items.map((o) => {
              const ring = ringsById.get(o.activity.ring_id);
              const clock = clocksById.get(o.activity.clock_id);
              return (
                <tr
                  key={o.key}
                  className={cn(
                    "border-t border-border/70 hover:bg-canvas",
                    selectedKey === o.key && "bg-teal-5/25",
                    o.status === "done" && "text-muted",
                  )}
                >
                  <td className="px-3 py-2 align-top whitespace-nowrap">{formatDateRange(o.date, o.endDate)}</td>
                  <td className="px-3 py-2 align-top">
                    <button
                      type="button"
                      onClick={() => onSelect(o)}
                      className={cn("text-left font-medium text-ink hover:underline", o.status === "done" && "line-through decoration-muted")}
                    >
                      {o.activity.title}
                    </button>
                    {o.recurring && (
                      <span className="ml-2 text-xs text-muted" title={describeRRule(o.activity.rrule)}>
                        ↻<span className="sr-only"> {t("clock.recurring")}: {describeRRule(o.activity.rrule)}</span>
                      </span>
                    )}
                    {o.activity.end_date === null && o.dueDate !== o.date && (
                      <span className="ml-2 text-xs text-muted">{formatDate(o.dueDate)}</span>
                    )}
                  </td>
                  {showClock && (
                    <td className="px-3 py-2 align-top">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="size-2.5 rounded-full" style={{ background: clock?.color }} aria-hidden />
                        {clock?.name}
                      </span>
                    </td>
                  )}
                  <td className="hidden px-3 py-2 align-top md:table-cell">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="size-2.5 rounded-sm" style={{ background: ring?.color }} aria-hidden />
                      {ring?.name}
                    </span>
                  </td>
                  <td className="hidden px-3 py-2 align-top lg:table-cell">{t(`activity.types.${o.activity.type}`)}</td>
                  <td className="hidden px-3 py-2 align-top md:table-cell">{personName(o.activity.owner_id)}</td>
                  <td className="px-3 py-2 align-top">
                    <StatusBadge occ={o} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        ))}
      </table>
    </div>
  );
}
