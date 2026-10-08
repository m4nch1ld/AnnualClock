"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { buildOccurrences, type Occurrence } from "@/lib/domain";
import { makeDate, monthOf, yearOf, type ISODate } from "@/lib/dates";
import { t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Wheel, type WheelBand } from "./wheel";
import { ListView } from "./list-view";
import { AgendaView } from "./agenda-view";
import { ActivityPanel, type PanelState } from "./activity-panel";
import { statusColor } from "./colors";
import type { WorkspaceData } from "./types";
import { moveActivity } from "@/app/(app)/clocks/actions";
import { cn } from "@/lib/utils";

type View = "wheel" | "list" | "agenda";
type StatusFilter = "all" | "open" | "overdue" | "planned" | "in_progress" | "done" | "cancelled";

export function ClockWorkspace({ data }: { data: WorkspaceData }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { year, today, clocks, rings, mode } = data;

  const [view, setView] = useState<View>((params.get("view") as View) || "wheel");
  const [colorBy, setColorBy] = useState<"ring" | "status">("ring");
  const [hiddenRings, setHiddenRings] = useState<Set<string>>(() => new Set(rings.filter((r) => r.hidden).map((r) => r.id)));
  const [owner, setOwner] = useState<string>("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const [zoomMonth, setZoomMonth] = useState<number | null>(null);
  const [agendaMonth, setAgendaMonth] = useState<number>(yearOf(today) === year ? monthOf(today) : 1);
  const [panel, setPanel] = useState<PanelState | null>(null);
  const [toast, setToast] = useState<{ message: string; undo?: () => void; error?: boolean } | null>(null);
  const [, startTransition] = useTransition();
  // Optimistic date overrides for drag-moved one-off activities until the server data refreshes.
  const [overrides, setOverrides] = useState<Record<string, { start_date: ISODate; end_date: ISODate | null }>>({});
  useEffect(() => setOverrides({}), [data.activities]);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), toast.undo ? 8000 : 4000);
    return () => clearTimeout(id);
  }, [toast]);

  // Phones default to the list view (unless a view was chosen explicitly).
  useEffect(() => {
    if (!params.get("view") && window.matchMedia("(max-width: 639px)").matches) setView("list");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changeView = (v: View) => {
    setView(v);
    const sp = new URLSearchParams(params.toString());
    sp.set("view", v);
    router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
  };

  const yearHref = (y: number) => {
    const sp = new URLSearchParams(params.toString());
    sp.set("year", String(y));
    return `${pathname}?${sp.toString()}`;
  };

  const peopleById = useMemo(() => new Map(data.people.map((p) => [p.id, p])), [data.people]);
  const personName = useCallback(
    (id: string | null) => (id ? (peopleById.get(id)?.full_name ?? peopleById.get(id)?.email ?? "—") : "—"),
    [peopleById],
  );
  const ringsById = useMemo(() => new Map(rings.map((r) => [r.id, r])), [rings]);
  const clocksById = useMemo(() => new Map(clocks.map((c) => [c.id, c])), [clocks]);

  const allOccurrences = useMemo(
    () =>
      buildOccurrences(
        data.activities.map((a) => (overrides[a.id] ? { ...a, ...overrides[a.id] } : a)),
        data.states,
        makeDate(year, 1, 1),
        makeDate(year, 12, 31),
        today,
      ),
    [data.activities, data.states, year, today, overrides],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allOccurrences.filter((o) => {
      const a = o.activity;
      if (hiddenRings.has(a.ring_id)) return false;
      if (owner && a.owner_id !== owner && !a.assignee_ids.includes(owner)) return false;
      switch (status) {
        case "open":
          if (o.status === "done" || o.status === "cancelled") return false;
          break;
        case "overdue":
          if (!o.overdue) return false;
          break;
        case "all":
          break;
        default:
          if (o.status !== status) return false;
      }
      if (q && !`${a.title} ${a.description ?? ""} ${a.tags.join(" ")}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [allOccurrences, hiddenRings, owner, status, query]);

  const colorFor = useCallback(
    (o: Occurrence) => {
      if (colorBy === "status" || o.overdue) return statusColor(o);
      if (mode === "overlay") return clocksById.get(o.activity.clock_id)?.color ?? "#39978F";
      return ringsById.get(o.activity.ring_id)?.color ?? "#39978F";
    },
    [colorBy, mode, clocksById, ringsById],
  );

  const bands: WheelBand[] = useMemo(() => {
    if (mode === "overlay") {
      return clocks.map((c) => {
        const clockRings = rings.filter((r) => r.clock_id === c.id);
        return {
          id: c.id,
          label: c.name,
          color: c.color,
          clockId: c.id,
          ringId: clockRings[0]?.id ?? "",
          items: filtered.filter((o) => o.activity.clock_id === c.id),
        };
      });
    }
    return rings
      .filter((r) => !hiddenRings.has(r.id))
      .map((r) => ({
        id: r.id,
        label: r.name,
        color: r.color,
        clockId: r.clock_id,
        ringId: r.id,
        items: filtered.filter((o) => o.activity.ring_id === r.id),
      }));
  }, [mode, clocks, rings, hiddenRings, filtered]);

  const canEdit = useCallback((clockId: string) => !!data.perms[clockId]?.canEdit, [data.perms]);
  const anyEditable = clocks.some((c) => canEdit(c.id));
  const selectedKey = panel?.kind === "view" ? panel.occ.key : null;

  const onSelect = useCallback((o: Occurrence) => setPanel({ kind: "view", occ: o }), []);
  const onCreate = useCallback(
    (band: WheelBand, date: ISODate) => setPanel({ kind: "create", clockId: band.clockId, ringId: band.ringId, date }),
    [],
  );
  const onDragCommit = useCallback(
    (o: Occurrence, start: ISODate, end: ISODate | null) => {
      if (o.recurring) {
        setPanel({ kind: "move", occ: o, start, end });
        return;
      }
      // One-off: save immediately (optimistic) with undo.
      const prev = { start_date: o.date, end_date: o.endDate };
      const move = (to: { start_date: ISODate; end_date: ISODate | null }, from: ISODate) =>
        moveActivity({ activity_id: o.activity.id, occurrence_date: from, new_start: to.start_date, new_end: to.end_date, scope: "all" });
      setOverrides((m) => ({ ...m, [o.activity.id]: { start_date: start, end_date: end } }));
      startTransition(async () => {
        const r = await move({ start_date: start, end_date: end }, o.date);
        if (!r.ok) {
          setOverrides((m) => {
            const n = { ...m };
            delete n[o.activity.id];
            return n;
          });
          setToast({ message: r.error, error: true });
          return;
        }
        router.refresh();
        setToast({
          message: t("activity.moved", { title: o.activity.title }),
          undo: () =>
            startTransition(async () => {
              setOverrides((m) => ({ ...m, [o.activity.id]: prev }));
              await move(prev, start);
              router.refresh();
              setToast(null);
            }),
        });
      });
    },
    [router],
  );

  const filtersActive = hiddenRings.size > 0 || owner || status !== "all" || query;
  const title = mode === "overlay" ? t("nav.overview") : clocks[0]?.name ?? "";

  return (
    <div className="flex flex-col gap-4">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1" role="group" aria-label="Year">
          <Link href={yearHref(year - 1)} className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm hover:bg-canvas" aria-label={t("clock.prevYear")}>
            ←
          </Link>
          <span className="min-w-14 text-center text-lg font-medium" aria-live="polite">
            {year}
          </span>
          <Link href={yearHref(year + 1)} className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm hover:bg-canvas" aria-label={t("clock.nextYear")}>
            →
          </Link>
          {yearOf(today) !== year && (
            <Link href={yearHref(yearOf(today))} className="ml-1 text-sm text-primary hover:underline">
              {t("clock.thisYear")}
            </Link>
          )}
        </div>

        <div className="flex rounded-md border border-border bg-surface p-0.5" role="tablist" aria-label={t("clock.views")}>
          {(["wheel", "list", "agenda"] as View[]).map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              onClick={() => changeView(v)}
              className={cn("rounded px-3 py-1 text-sm", view === v ? "bg-primary text-primary-foreground" : "text-ink hover:bg-canvas")}
            >
              {t(`clock.${v}`)}
            </button>
          ))}
        </div>

        {view === "wheel" && zoomMonth !== null && (
          <Button variant="outline" size="sm" onClick={() => setZoomMonth(null)}>
            {t("clock.resetZoom")}
          </Button>
        )}

        <label className="ml-auto flex items-center gap-2 text-sm text-muted">
          {t("clock.colorBy")}
          <Select value={colorBy} onChange={(e) => setColorBy(e.target.value as "ring" | "status")} className="w-auto">
            <option value="ring">{mode === "overlay" ? t("clock.columns.clock") : t("clock.colorByRing")}</option>
            <option value="status">{t("clock.colorByStatus")}</option>
          </Select>
        </label>
        {anyEditable && mode === "single" && (
          <Button
            onClick={() =>
              setPanel({
                kind: "create",
                clockId: clocks[0].id,
                ringId: rings.find((r) => !r.hidden)?.id ?? rings[0]?.id ?? "",
                date: yearOf(today) === year ? today : makeDate(year, 1, 1),
              })
            }
          >
            + {t("clock.newActivity")}
          </Button>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[15rem_1fr]">
        {/* filters */}
        <aside aria-label={t("clock.filters")} className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          <div>
            <label htmlFor="q" className="sr-only">
              {t("clock.search")}
            </label>
            <Input id="q" type="search" placeholder={t("clock.search")} value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <fieldset>
            <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">{t("clock.rings")}</legend>
            <ul className="space-y-1">
              {clocks.map((c) => (
                <li key={c.id}>
                  {mode === "overlay" && (
                    <div className="mt-2 flex items-center gap-1.5 text-xs font-medium">
                      <span className="size-2.5 rounded-full" style={{ background: c.color }} aria-hidden />
                      <Link href={`/clocks/${c.slug}?year=${year}`} className="hover:underline">
                        {c.name}
                      </Link>
                    </div>
                  )}
                  <ul className={cn(mode === "overlay" && "ml-4")}>
                    {rings
                      .filter((r) => r.clock_id === c.id)
                      .map((r) => (
                        <li key={r.id}>
                          <label className="flex cursor-pointer items-center gap-2 py-0.5 text-sm">
                            <input
                              type="checkbox"
                              className="accent-[var(--color-primary)]"
                              checked={!hiddenRings.has(r.id)}
                              onChange={(e) =>
                                setHiddenRings((s) => {
                                  const n = new Set(s);
                                  if (e.target.checked) n.delete(r.id);
                                  else n.add(r.id);
                                  return n;
                                })
                              }
                            />
                            <span className="size-3 rounded-sm" style={{ background: r.color }} aria-hidden />
                            {r.name}
                          </label>
                        </li>
                      ))}
                  </ul>
                </li>
              ))}
            </ul>
          </fieldset>
          <div>
            <label htmlFor="owner" className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
              {t("clock.owner")}
            </label>
            <Select id="owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="">{t("clock.anyOwner")}</option>
              {[...new Set(data.activities.flatMap((a) => [a.owner_id, ...a.assignee_ids]).filter(Boolean) as string[])]
                .map((id) => ({ id, name: personName(id) }))
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </Select>
          </div>
          <div>
            <label htmlFor="status" className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
              {t("clock.status")}
            </label>
            <Select id="status" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
              <option value="all">{t("clock.anyStatus")}</option>
              <option value="open">{t("clock.open")}</option>
              <option value="overdue">{t("clock.overdue")}</option>
              <option value="planned">{t("activity.statuses.planned")}</option>
              <option value="in_progress">{t("activity.statuses.in_progress")}</option>
              <option value="done">{t("activity.statuses.done")}</option>
              <option value="cancelled">{t("activity.statuses.cancelled")}</option>
            </Select>
          </div>
          {filtersActive && (
            <Button
              variant="link"
              size="sm"
              className="px-0"
              onClick={() => {
                setHiddenRings(new Set());
                setOwner("");
                setStatus("all");
                setQuery("");
              }}
            >
              {t("clock.clearFilters")}
            </Button>
          )}
          <p className="text-xs text-muted">{anyEditable ? t("clock.addHere") : t("clock.readOnlyNotice")}</p>
          <p className="text-xs text-muted">{t("clock.listHint")}</p>
        </aside>

        {/* main view + panel */}
        <div className={cn("grid gap-4", panel && "xl:grid-cols-[1fr_24rem]")}>
          <section aria-label={t(`clock.${view}`)} className="min-w-0">
            {view === "wheel" && (
              <Wheel
                year={year}
                today={today}
                bands={bands}
                title={title}
                colorBy={colorBy}
                colorFor={colorFor}
                selectedKey={selectedKey}
                canEdit={canEdit}
                personName={personName}
                onSelect={onSelect}
                onCreate={onCreate}
                onDragCommit={onDragCommit}
                zoomMonth={zoomMonth}
                onZoomMonth={setZoomMonth}
              />
            )}
            {view === "list" && (
              <ListView
                occurrences={filtered}
                ringsById={ringsById}
                clocksById={clocksById}
                showClock={mode === "overlay"}
                personName={personName}
                selectedKey={selectedKey}
                onSelect={onSelect}
              />
            )}
            {view === "agenda" && (
              <AgendaView
                year={year}
                month={agendaMonth}
                onMonthChange={setAgendaMonth}
                today={today}
                occurrences={filtered}
                colorFor={colorFor}
                onSelect={onSelect}
                selectedKey={selectedKey}
              />
            )}
          </section>
          {panel && (
            <ActivityPanel
              state={panel}
              data={data}
              allOccurrences={allOccurrences}
              personName={personName}
              onClose={() => setPanel(null)}
              onChange={setPanel}
              onSaved={(message) => {
                setPanel(null);
                router.refresh();
                if (message) setToast({ message });
              }}
            />
          )}
        </div>
      </div>
      <div aria-live="polite" className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2">
        {toast && (
          <div
            role="status"
            className={cn(
              "flex items-center gap-3 rounded-md px-4 py-2 text-sm shadow-lg",
              toast.error ? "bg-danger text-white" : "bg-header text-header-foreground",
            )}
          >
            {toast.message}
            {toast.undo && (
              <button type="button" onClick={toast.undo} className="font-medium text-brand underline">
                {t("activity.undo")}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
