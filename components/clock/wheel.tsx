"use client";

/**
 * The year wheel. Hand-written SVG: month and ISO-week bands outside, one
 * concentric band per ring (or per clock in overlay mode), activities as arcs
 * (periods) or markers (single dates). Supports click-to-create, select,
 * drag (move / resize, snapped to days), hover tooltips and month zoom.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { addDays, diffDays, type ISODate } from "@/lib/dates";
import {
  TAU,
  angleToDate,
  arcPath,
  assignLanes,
  clipToYear,
  dateEndToAngle,
  dateToAngle,
  monthsOfYear,
  polar,
  sectorPath,
  toPolar,
  weeksOfYear,
  yearSpan,
  type YearSpan,
} from "@/lib/wheel/geometry";
import type { Occurrence } from "@/lib/domain";
import { formatDateRange, monthName, t } from "@/lib/i18n";
import { StatusBadge } from "./status-badge";

export interface WheelBand {
  id: string;
  label: string;
  color: string;
  clockId: string;
  /** ring that receives new activities created by clicking this band */
  ringId: string;
  items: Occurrence[];
}

export interface WheelProps {
  year: number;
  today: ISODate;
  bands: WheelBand[];
  title: string;
  colorBy: "ring" | "status";
  colorFor: (o: Occurrence) => string;
  selectedKey: string | null;
  canEdit: (clockId: string) => boolean;
  personName: (id: string | null) => string;
  onSelect: (o: Occurrence) => void;
  onCreate: (band: WheelBand, date: ISODate) => void;
  onDragCommit: (o: Occurrence, start: ISODate, end: ISODate | null) => void;
  zoomMonth: number | null;
  onZoomMonth: (m: number | null) => void;
}

const SIZE = 1000;
const C = SIZE / 2;
const R_OUT = 488;
const MONTH_IN = 446;
const WEEK_IN = 420;
const RING_OUT = 412;
const RING_IN = 150;
const BAND_GAP = 4;
const MARKER_FOOTPRINT_DAYS = 4;

type Geom =
  | { kind: "arc"; r0: number; r1: number; a0: number; a1: number; clippedStart: boolean; clippedEnd: boolean }
  | { kind: "marker"; r: number; a: number; size: number };

interface Placed {
  occ: Occurrence;
  band: WheelBand;
  geom: Geom;
  laneR0: number;
  laneR1: number;
}

interface DragState {
  key: string;
  mode: "move" | "start" | "end";
  startAngle: number;
  deltaDays: number;
  moved: boolean;
  pointerId: number;
}

function normAngleDiff(d: number) {
  let x = d % TAU;
  if (x > Math.PI) x -= TAU;
  if (x < -Math.PI) x += TAU;
  return x;
}

function geomFor(
  occ: Occurrence,
  span: YearSpan,
  laneR0: number,
  laneR1: number,
  start: ISODate = occ.date,
  end: ISODate | null = occ.endDate,
): Geom | null {
  const clip = clipToYear(start, end, span);
  if (!clip) return null;
  if (end && end !== start) {
    return {
      kind: "arc",
      r0: laneR0 + 1.5,
      r1: laneR1 - 1.5,
      a0: dateToAngle(clip.start, span),
      a1: dateEndToAngle(clip.end, span),
      clippedStart: clip.clippedStart,
      clippedEnd: clip.clippedEnd,
    };
  }
  const mid = (dateToAngle(clip.start, span) + dateEndToAngle(clip.start, span)) / 2;
  return { kind: "marker", r: (laneR0 + laneR1) / 2, a: mid, size: Math.max(3.5, Math.min(8, (laneR1 - laneR0) / 2.6)) };
}

function viewBoxForMonth(month: number | null, span: YearSpan): [number, number, number, number] {
  if (!month) return [0, 0, SIZE, SIZE];
  const m = monthsOfYear(span)[month - 1];
  const a0 = dateToAngle(m.start, span);
  const a1 = dateEndToAngle(m.end, span);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i <= 12; i++) {
    const a = a0 + ((a1 - a0) * i) / 12;
    for (const r of [RING_IN - 10, R_OUT]) {
      const [x, y] = polar(C, C, r, a);
      xs.push(x);
      ys.push(y);
    }
  }
  const pad = 24;
  const x0 = Math.min(...xs) - pad;
  const y0 = Math.min(...ys) - pad;
  const w = Math.max(...xs) - x0 + pad;
  const h = Math.max(...ys) - y0 + pad;
  const s = Math.max(w, h);
  return [x0 - (s - w) / 2, y0 - (s - h) / 2, s, s];
}

function useAnimatedViewBox(target: [number, number, number, number]) {
  const [vb, setVb] = useState(target);
  const cur = useRef(target);
  useEffect(() => {
    const from = cur.current;
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      cur.current = target;
      setVb(target);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / 320);
      const e = 1 - Math.pow(1 - p, 3);
      const next = from.map((v, i) => v + (target[i] - v) * e) as [number, number, number, number];
      cur.current = next;
      setVb(next);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.join(",")]);
  return vb;
}

export function Wheel(props: WheelProps) {
  const { year, today, bands, colorFor, selectedKey, canEdit, onSelect, onCreate, onDragCommit, zoomMonth, onZoomMonth } = props;
  const span = useMemo(() => yearSpan(year), [year]);
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [hover, setHover] = useState<{ occ: Occurrence; x: number; y: number } | null>(null);
  const [createHint, setCreateHint] = useState<{ x: number; y: number; date: ISODate } | null>(null);

  const months = useMemo(() => monthsOfYear(span), [span]);
  const weeks = useMemo(() => weeksOfYear(span), [span]);

  // Band radii: first band outermost (next to the months).
  const bandLayout = useMemo(() => {
    const n = Math.max(1, bands.length);
    const thick = (RING_OUT - RING_IN - BAND_GAP * (n - 1)) / n;
    return bands.map((b, i) => {
      const r1 = RING_OUT - i * (thick + BAND_GAP);
      return { band: b, r0: r1 - thick, r1 };
    });
  }, [bands]);

  // Place items into lanes inside each band.
  const placed = useMemo(() => {
    const out: Placed[] = [];
    for (const { band, r0, r1 } of bandLayout) {
      const visible = band.items
        .map((occ) => ({ occ, clip: clipToYear(occ.date, occ.endDate, span) }))
        .filter((x): x is { occ: Occurrence; clip: NonNullable<typeof x.clip> } => !!x.clip);
      const footprints = visible.map(({ occ, clip }) => ({
        start: clip.start,
        end: occ.endDate && occ.endDate !== occ.date ? clip.end : addDays(clip.start, MARKER_FOOTPRINT_DAYS),
      }));
      const { lanes, count } = assignLanes(footprints);
      const laneH = (r1 - r0) / count;
      visible.forEach(({ occ }, i) => {
        const laneR1 = r1 - lanes[i] * laneH;
        const laneR0 = laneR1 - laneH;
        const geom = geomFor(occ, span, laneR0, laneR1);
        if (geom) out.push({ occ, band, geom, laneR0, laneR1 });
      });
    }
    return out;
  }, [bandLayout, span]);

  const placedByKey = useMemo(() => new Map(placed.map((p) => [p.occ.key, p])), [placed]);

  // Dependency connectors for the selected item.
  const connectors = useMemo(() => {
    if (!selectedKey) return [];
    const sel = placedByKey.get(selectedKey);
    if (!sel) return [];
    const res: Array<{ from: Placed; to: Placed }> = [];
    const find = (activityId: string, near: ISODate) =>
      placed
        .filter((p) => p.occ.activity.id === activityId)
        .sort((a, b) => Math.abs(diffDays(a.occ.date, near)) - Math.abs(diffDays(b.occ.date, near)))[0];
    if (sel.occ.activity.predecessor_id) {
      const pred = find(sel.occ.activity.predecessor_id, sel.occ.date);
      if (pred) res.push({ from: pred, to: sel });
    }
    for (const p of placed) {
      if (p.occ.activity.predecessor_id === sel.occ.activity.id && p.occ.date >= sel.occ.date) {
        res.push({ from: sel, to: p });
        break;
      }
    }
    return res;
  }, [selectedKey, placed, placedByKey]);

  const toSvgPoint = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return toPolar(p.x, p.y, C, C);
  }, []);

  const relPos = (clientX: number, clientY: number) => {
    const r = containerRef.current?.getBoundingClientRect();
    return r ? { x: clientX - r.left, y: clientY - r.top } : { x: 0, y: 0 };
  };

  // ----- drag -----
  const onItemPointerDown = (e: React.PointerEvent, p: Placed, mode: DragState["mode"]) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (!canEdit(p.band.clockId) || p.occ.status === "cancelled") {
      return;
    }
    const pt = toSvgPoint(e.clientX, e.clientY);
    if (!pt) return;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setDrag({ key: p.occ.key, mode, startAngle: pt.angle, deltaDays: 0, moved: false, pointerId: e.pointerId });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (drag && e.pointerId === drag.pointerId) {
      const pt = toSvgPoint(e.clientX, e.clientY);
      if (!pt) return;
      const delta = Math.round((normAngleDiff(pt.angle - drag.startAngle) / TAU) * span.days);
      if (delta !== drag.deltaDays || (!drag.moved && delta !== 0)) {
        setDrag({ ...drag, deltaDays: delta, moved: drag.moved || delta !== 0 });
        setHover(null);
      }
    }
  };

  const previewDates = (p: Placed, d: DragState): { start: ISODate; end: ISODate | null } => {
    const { date, endDate } = p.occ;
    if (d.mode === "move") return { start: addDays(date, d.deltaDays), end: endDate ? addDays(endDate, d.deltaDays) : null };
    if (d.mode === "start") {
      const s = addDays(date, d.deltaDays);
      return { start: endDate && s > endDate ? endDate : s, end: endDate };
    }
    const en = addDays(endDate ?? date, d.deltaDays);
    return { start: date, end: en < date ? date : en };
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const p = placedByKey.get(drag.key);
    setDrag(null);
    if (!p) return;
    if (!drag.moved || drag.deltaDays === 0) {
      onSelect(p.occ);
      return;
    }
    const { start, end } = previewDates(p, drag);
    onDragCommit(p.occ, start, end);
  };

  // ----- click on empty band -----
  const onBandClick = (e: React.MouseEvent, band: WheelBand) => {
    if (!canEdit(band.clockId)) return;
    const pt = toSvgPoint(e.clientX, e.clientY);
    if (!pt) return;
    onCreate(band, angleToDate(pt.angle, span));
  };

  const onBandMove = (e: React.PointerEvent, band: WheelBand) => {
    if (drag || !canEdit(band.clockId)) return;
    const pt = toSvgPoint(e.clientX, e.clientY);
    if (!pt) return;
    setCreateHint({ ...relPos(e.clientX, e.clientY), date: angleToDate(pt.angle, span) });
  };

  const target = useMemo(() => viewBoxForMonth(zoomMonth, span), [zoomMonth, span]);
  const vb = useAnimatedViewBox(target);
  const zoomed = zoomMonth !== null;

  const todayInYear = today >= span.start && today <= span.end;
  const todayAngle = todayInYear ? (dateToAngle(today, span) + dateEndToAngle(today, span)) / 2 : 0;
  const itemCount = bands.reduce((n, b) => n + b.items.length, 0);

  return (
    <div ref={containerRef} className="relative mx-auto w-full max-w-[min(100%,82vh)] select-none">
      <svg
        ref={svgRef}
        viewBox={vb.join(" ")}
        className="h-auto w-full touch-none"
        role="group"
        aria-label={t("clock.wheelLabel", { name: props.title, year, count: itemCount })}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDrag(null)}
        onPointerLeave={() => setCreateHint(null)}
      >
        <defs>
          {months.map((m, i) => {
            const a0 = dateToAngle(m.start, span);
            const a1 = dateEndToAngle(m.end, span);
            const r = (MONTH_IN + R_OUT) / 2 - 6;
            const bottom = (a0 + a1) / 2 > Math.PI / 2 && (a0 + a1) / 2 < (3 * Math.PI) / 2;
            // bottom half: draw the text path counter-clockwise so labels are not upside down
            const d = bottom
              ? (() => {
                  const [x0, y0] = polar(C, C, r + 12, a1);
                  const [x1, y1] = polar(C, C, r + 12, a0);
                  return `M${x0},${y0}A${r + 12},${r + 12} 0 0 0 ${x1},${y1}`;
                })()
              : arcPath(C, C, r, a0, a1);
            return <path key={i} id={`mlabel-${year}-${i}`} d={d} fill="none" />;
          })}
        </defs>

        {/* canvas */}
        <circle cx={C} cy={C} r={R_OUT} fill="var(--color-surface)" stroke="var(--color-border)" />

        {/* month band */}
        <g aria-label="Months">
          {months.map((m, i) => {
            const a0 = dateToAngle(m.start, span);
            const a1 = dateEndToAngle(m.end, span);
            const active = zoomMonth === m.month;
            return (
              <g
                key={m.month}
                role="button"
                tabIndex={0}
                aria-label={zoomed && active ? t("clock.resetZoom") : t("clock.zoomMonth", { month: monthName(m.month) })}
                aria-pressed={active}
                className="cursor-pointer outline-none [&:focus-visible>path]:stroke-primary [&:focus-visible>path]:stroke-2"
                onClick={() => onZoomMonth(active ? null : m.month)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onZoomMonth(active ? null : m.month);
                  }
                }}
              >
                <path
                  d={sectorPath(C, C, MONTH_IN, R_OUT, a0, a1)}
                  fill={active ? "var(--color-teal-5)" : i % 2 ? "#EEF2F5" : "#F6F8FA"}
                  stroke="#FFFFFF"
                  strokeWidth={1}
                />
                <text fontSize={zoomed ? 13 : 15} fill="var(--color-ink)" fontWeight={500}>
                  <textPath href={`#mlabel-${year}-${i}`} startOffset="50%" textAnchor="middle">
                    {monthName(m.month).toUpperCase()}
                  </textPath>
                </text>
              </g>
            );
          })}
        </g>

        {/* week band */}
        <g aria-hidden>
          <path d={sectorPath(C, C, WEEK_IN, MONTH_IN, 0, TAU)} fill="#FBFCFD" />
          {weeks.map((w) => {
            const a = dateToAngle(w.start, span);
            const [x0, y0] = polar(C, C, WEEK_IN, a);
            const [x1, y1] = polar(C, C, MONTH_IN, a);
            const mid = Math.min(a + (3.5 / span.days) * TAU, TAU - 0.001);
            const [tx, ty] = polar(C, C, (WEEK_IN + MONTH_IN) / 2, mid);
            return (
              <g key={`${w.week}-${w.start}`}>
                <line x1={x0} y1={y0} x2={x1} y2={y1} stroke="#D9E0E6" strokeWidth={0.8} />
                <text x={tx} y={ty} fontSize={zoomed ? 7 : 9.5} fill="var(--color-muted)" textAnchor="middle" dominantBaseline="central">
                  {w.week}
                </text>
              </g>
            );
          })}
        </g>

        {/* ring bands (empty area is clickable to create) */}
        {bandLayout.map(({ band, r0, r1 }, i) => (
          <g key={band.id}>
            <path
              d={sectorPath(C, C, r0, r1, 0, TAU)}
              fill={band.color}
              fillOpacity={i % 2 ? 0.07 : 0.12}
              className={canEdit(band.clockId) ? "cursor-copy" : undefined}
              onClick={(e) => onBandClick(e, band)}
              onPointerMove={(e) => onBandMove(e, band)}
              onPointerLeave={() => setCreateHint(null)}
            >
              <title>{band.label}</title>
            </path>
          </g>
        ))}

        {/* month dividers across the rings */}
        <g aria-hidden pointerEvents="none">
          {months.map((m) => {
            const a = dateToAngle(m.start, span);
            const [x0, y0] = polar(C, C, RING_IN, a);
            const [x1, y1] = polar(C, C, MONTH_IN, a);
            return <line key={m.month} x1={x0} y1={y0} x2={x1} y2={y1} stroke="#C8D1D9" strokeWidth={1} />;
          })}
        </g>

        {/* band labels at the start of the year (just right of 12 o'clock, inside each band) */}
        <g aria-hidden pointerEvents="none">
          {bandLayout.map(({ band, r0, r1 }) => {
            const [x, y] = polar(C, C, (r0 + r1) / 2, -0.012);
            return (
              <text
                key={band.id}
                x={x}
                y={y}
                fontSize={Math.min(11, (r1 - r0) / 2.2)}
                fill="var(--color-muted)"
                textAnchor="end"
                dominantBaseline="central"
              >
                {band.label}
              </text>
            );
          })}
        </g>

        {/* activities */}
        <g>
          {placed.map((p) => {
            const dragging = drag?.key === p.occ.key && drag.moved;
            let geom = p.geom;
            if (dragging && drag) {
              const { start, end } = previewDates(p, drag);
              geom = geomFor(p.occ, span, p.laneR0, p.laneR1, start, end) ?? geom;
            }
            return (
              <WheelItem
                key={p.occ.key}
                placed={p}
                geom={geom}
                color={colorFor(p.occ)}
                selected={selectedKey === p.occ.key}
                dragging={dragging}
                editable={canEdit(p.band.clockId)}
                onPointerDown={onItemPointerDown}
                onHover={(occ, e) => (occ && !drag ? setHover({ occ, ...relPos(e.clientX, e.clientY) }) : setHover(null))}
                onActivate={onSelect}
              />
            );
          })}
        </g>

        {/* dependency connectors */}
        <g pointerEvents="none" aria-hidden>
          {connectors.map(({ from, to }, i) => {
            const pa = anchorOf(from.geom, "end");
            const pb = anchorOf(to.geom, "start");
            const [x0, y0] = polar(C, C, pa.r, pa.a);
            const [x1, y1] = polar(C, C, pb.r, pb.a);
            const [cx, cy] = polar(C, C, Math.min(pa.r, pb.r) * 0.55, (pa.a + pb.a) / 2 + (Math.abs(pb.a - pa.a) > Math.PI ? Math.PI : 0));
            return (
              <path
                key={i}
                d={`M${x0},${y0} Q${cx},${cy} ${x1},${y1}`}
                fill="none"
                stroke="var(--color-steel)"
                strokeWidth={1.5}
                strokeDasharray="4 3"
                markerEnd="url(#arrow)"
              />
            );
          })}
          <defs>
            <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" fill="var(--color-steel)" />
            </marker>
          </defs>
        </g>

        {/* today marker */}
        {todayInYear && (
          <g pointerEvents="none" aria-label={`${t("clock.today")}`}>
            {(() => {
              const [x0, y0] = polar(C, C, RING_IN - 6, todayAngle);
              const [x1, y1] = polar(C, C, MONTH_IN, todayAngle);
              const [tx, ty] = polar(C, C, R_OUT + 1, todayAngle);
              const [lx, ly] = polar(C, C, R_OUT - 8, todayAngle - 0.012);
              const [rx, ry] = polar(C, C, R_OUT - 8, todayAngle + 0.012);
              return (
                <>
                  <line x1={x0} y1={y0} x2={x1} y2={y1} stroke="var(--color-brand)" strokeWidth={2.5} />
                  <path d={`M${tx},${ty} L${lx},${ly} L${rx},${ry} Z`} fill="var(--color-brand)" />
                </>
              );
            })()}
          </g>
        )}

        {/* hub */}
        <g pointerEvents="none">
          <circle cx={C} cy={C} r={RING_IN - 10} fill="var(--color-canvas)" stroke="var(--color-border)" />
          <text x={C} y={C - 8} textAnchor="middle" fontSize={44} fontWeight={500} fill="var(--color-ink)">
            {year}
          </text>
          <text x={C} y={C + 24} textAnchor="middle" fontSize={14} fill="var(--color-muted)">
            {props.title.length > 26 ? `${props.title.slice(0, 25)}…` : props.title}
          </text>
          <rect x={C - 18} y={C + 38} width={36} height={3} rx={1.5} fill="var(--color-brand)" />
        </g>
      </svg>

      {hover && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-20 max-w-64 rounded-md border border-border bg-surface px-3 py-2 text-xs shadow-lg"
          style={{ left: Math.min(hover.x + 14, (containerRef.current?.clientWidth ?? 600) - 260), top: hover.y + 14 }}
        >
          <div className="font-medium text-ink">{hover.occ.activity.title}</div>
          <div className="text-muted">{formatDateRange(hover.occ.date, hover.occ.endDate)}</div>
          <div className="text-muted">
            {t("clock.owner")}: {props.personName(hover.occ.activity.owner_id)}
          </div>
          <div className="mt-1 flex gap-2">
            <StatusBadge occ={hover.occ} />
            {hover.occ.recurring && <span className="text-muted">↻ {t("clock.recurring")}</span>}
          </div>
        </div>
      )}
      {createHint && !hover && !drag && (
        <div
          aria-hidden
          className="pointer-events-none absolute z-10 rounded bg-header px-2 py-0.5 text-[11px] text-header-foreground"
          style={{ left: createHint.x + 12, top: createHint.y - 26 }}
        >
          + {createHint.date}
        </div>
      )}
    </div>
  );
}

function anchorOf(g: Geom, which: "start" | "end") {
  if (g.kind === "marker") return { r: g.r, a: g.a };
  return { r: (g.r0 + g.r1) / 2, a: which === "start" ? g.a0 : g.a1 };
}

interface ItemProps {
  placed: Placed;
  geom: Geom;
  color: string;
  selected: boolean;
  dragging: boolean;
  editable: boolean;
  onPointerDown: (e: React.PointerEvent, p: Placed, mode: DragState["mode"]) => void;
  onHover: (occ: Occurrence | null, e: React.PointerEvent) => void;
  onActivate: (o: Occurrence) => void;
}

const WheelItem = memo(function WheelItem({ placed, geom, color, selected, dragging, editable, onPointerDown, onHover, onActivate }: ItemProps) {
  const { occ } = placed;
  const done = occ.status === "done";
  const cancelled = occ.status === "cancelled";
  const overdue = occ.overdue;
  const label = `${occ.activity.title}, ${formatDateRange(occ.date, occ.endDate)}${overdue ? `, ${t("activity.statuses.overdue")}` : `, ${t(`activity.statuses.${occ.status}`)}`}`;
  const common = {
    role: "button" as const,
    tabIndex: 0,
    "aria-label": label,
    "aria-pressed": selected,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onActivate(occ);
      }
    },
    onPointerEnter: (e: React.PointerEvent) => onHover(occ, e),
    onPointerMove: (e: React.PointerEvent) => onHover(occ, e),
    onPointerLeave: (e: React.PointerEvent) => onHover(null, e),
    className: "outline-none [&:focus-visible>.shape]:stroke-[var(--color-primary)] [&:focus-visible>.shape]:stroke-[3]",
    style: { cursor: editable ? (dragging ? "grabbing" : "grab") : "pointer" } as React.CSSProperties,
  };
  const opacity = done ? 0.38 : cancelled ? 0.3 : 1;
  const stroke = selected ? "var(--color-ink)" : overdue ? "var(--color-danger)" : "#FFFFFF";
  const strokeWidth = selected ? 2.5 : overdue ? 2 : 1;

  if (geom.kind === "marker") {
    const [x, y] = polar(C, C, geom.r, geom.a);
    const s = geom.size;
    const milestone = occ.activity.type === "milestone";
    return (
      <g {...common} onPointerDown={(e) => onPointerDown(e, placed, "move")}>
        {milestone ? (
          <path
            className="shape"
            d={`M${x},${y - s * 1.25} L${x + s * 1.25},${y} L${x},${y + s * 1.25} L${x - s * 1.25},${y} Z`}
            fill={color}
            fillOpacity={opacity}
            stroke={stroke}
            strokeWidth={strokeWidth}
          />
        ) : (
          <circle className="shape" cx={x} cy={y} r={s} fill={color} fillOpacity={opacity} stroke={stroke} strokeWidth={strokeWidth} />
        )}
        {done && <CheckGlyph x={x} y={y} s={s} />}
        {overdue && (
          <text x={x} y={y} fontSize={s * 1.5} fill="#fff" fontWeight={700} textAnchor="middle" dominantBaseline="central" pointerEvents="none">
            !
          </text>
        )}
        {/* larger invisible hit area */}
        <circle cx={x} cy={y} r={s + 5} fill="transparent" />
      </g>
    );
  }

  const handleDays = 0.012;
  const midA = (geom.a0 + geom.a1) / 2;
  const [mx, my] = polar(C, C, (geom.r0 + geom.r1) / 2, midA);
  const wide = geom.a1 - geom.a0 > 0.05;
  return (
    <g {...common}>
      <path
        className="shape"
        d={sectorPath(C, C, geom.r0, geom.r1, geom.a0, geom.a1)}
        fill={color}
        fillOpacity={opacity * (cancelled ? 1 : 0.9)}
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeDasharray={cancelled ? "4 3" : undefined}
        onPointerDown={(e) => onPointerDown(e, placed, "move")}
      />
      {done && wide && <CheckGlyph x={mx} y={my} s={Math.min(7, (geom.r1 - geom.r0) / 2.5)} />}
      {editable && wide && (
        <>
          <path
            d={sectorPath(C, C, geom.r0, geom.r1, geom.a0, geom.a0 + handleDays)}
            fill="transparent"
            style={{ cursor: "ew-resize" }}
            onPointerDown={(e) => onPointerDown(e, placed, "start")}
          />
          <path
            d={sectorPath(C, C, geom.r0, geom.r1, geom.a1 - handleDays, geom.a1)}
            fill="transparent"
            style={{ cursor: "ew-resize" }}
            onPointerDown={(e) => onPointerDown(e, placed, "end")}
          />
        </>
      )}
      {(geom.clippedStart || geom.clippedEnd) && (
        <ClipNotches geom={geom} />
      )}
    </g>
  );
});

function CheckGlyph({ x, y, s }: { x: number; y: number; s: number }) {
  return (
    <path
      d={`M${x - s * 0.55},${y} L${x - s * 0.1},${y + s * 0.45} L${x + s * 0.6},${y - s * 0.45}`}
      fill="none"
      stroke="var(--color-ink)"
      strokeWidth={Math.max(1.4, s * 0.28)}
      strokeLinecap="round"
      strokeLinejoin="round"
      pointerEvents="none"
    />
  );
}

/** Small chevrons showing an arc continues into the previous/next year. */
function ClipNotches({ geom }: { geom: Extract<Geom, { kind: "arc" }> }) {
  const rm = (geom.r0 + geom.r1) / 2;
  const h = (geom.r1 - geom.r0) / 2;
  const mk = (a: number, dir: 1 | -1) => {
    const [x, y] = polar(C, C, rm, a);
    const [x0, y0] = polar(C, C, rm + h * 0.6, a - dir * 0.01);
    const [x1, y1] = polar(C, C, rm - h * 0.6, a - dir * 0.01);
    return <path d={`M${x0},${y0} L${x},${y} L${x1},${y1}`} fill="none" stroke="#fff" strokeWidth={1.5} pointerEvents="none" />;
  };
  return (
    <>
      {geom.clippedStart && mk(geom.a0 + 0.012, -1)}
      {geom.clippedEnd && mk(geom.a1 - 0.012, 1)}
    </>
  );
}
