"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { ACTIVITY_STATUSES, ACTIVITY_TYPES, dependencyConflict, type Activity, type Occurrence } from "@/lib/domain";
import { addDays, diffDays, type ISODate } from "@/lib/dates";
import { formatDate, formatDateRange, t } from "@/lib/i18n";
import { describeRRule, recurrenceKindOf, rruleForKind, type RecurrenceKind } from "@/lib/recurrence";
import { Button } from "@/components/ui/button";
import { Field, Input, Label, Select, Textarea } from "@/components/ui/input";
import {
  deleteActivity,
  getActivityHistory,
  moveActivity,
  saveActivity,
  setOccurrenceStatus,
  snoozeOccurrence,
  type ActionResult,
  type HistoryEntry,
} from "@/app/(app)/clocks/actions";
import { StatusBadge } from "./status-badge";
import type { WorkspaceData } from "./types";

export type PanelState =
  | { kind: "view"; occ: Occurrence }
  | { kind: "edit"; occ: Occurrence }
  | { kind: "create"; clockId: string; ringId: string; date: ISODate }
  | { kind: "move"; occ: Occurrence; start: ISODate; end: ISODate | null };

interface Props {
  state: PanelState;
  data: WorkspaceData;
  allOccurrences: Occurrence[];
  personName: (id: string | null) => string;
  onClose: () => void;
  onChange: (s: PanelState) => void;
  onSaved: (message?: string) => void;
}

export function ActivityPanel({ state, data, personName, onClose, onChange, onSaved }: Props) {
  const heading =
    state.kind === "create" ? t("clock.newActivity") : state.kind === "move" ? t("activity.moveTitle") : state.occ.activity.title;
  return (
    <aside
      aria-label={heading}
      className="rounded-lg border border-border bg-surface p-4 xl:sticky xl:top-4 xl:max-h-[calc(100dvh-2rem)] xl:self-start xl:overflow-y-auto"
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <h2 className="text-lg leading-snug">{heading}</h2>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label={t("common.close")}>
          ✕
        </Button>
      </div>
      {state.kind === "view" && (
        <ViewMode key={state.occ.key} occ={state.occ} data={data} personName={personName} onEdit={() => onChange({ kind: "edit", occ: state.occ })} onSaved={onSaved} />
      )}
      {state.kind === "edit" && (
        <ActivityForm key={state.occ.key} data={data} occ={state.occ} clockId={state.occ.activity.clock_id} onCancel={() => onChange({ kind: "view", occ: state.occ })} onSaved={onSaved} />
      )}
      {state.kind === "create" && (
        <ActivityForm key={`${state.ringId}-${state.date}`} data={data} clockId={state.clockId} initialRing={state.ringId} initialDate={state.date} onCancel={onClose} onSaved={onSaved} />
      )}
      {state.kind === "move" && <MoveConfirm state={state} onCancel={onClose} onSaved={onSaved} />}
    </aside>
  );
}

function ErrorBox({ result }: { result: ActionResult | null }) {
  if (!result || result.ok) return null;
  return (
    <div role="alert" className="rounded-md bg-danger-soft p-2 text-sm text-danger">
      {result.error}
      {result.fieldErrors && (
        <ul className="mt-1 list-disc pl-5 text-xs">
          {Object.entries(result.fieldErrors).map(([k, v]) => (
            <li key={k}>
              {k}: {v}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// View mode
// ---------------------------------------------------------------------------
function ViewMode({
  occ,
  data,
  personName,
  onEdit,
  onSaved,
}: {
  occ: Occurrence;
  data: WorkspaceData;
  personName: (id: string | null) => string;
  onEdit: () => void;
  onSaved: (m?: string) => void;
}) {
  const a = occ.activity;
  const canEdit = !!data.perms[a.clock_id]?.canEdit;
  const ring = data.rings.find((r) => r.id === a.ring_id);
  const clock = data.clocks.find((c) => c.id === a.clock_id);
  const pred = a.predecessor_id ? data.activities.find((x) => x.id === a.predecessor_id) : undefined;
  const conflict = dependencyConflict(a, pred);
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [snoozeUntil, setSnoozeUntil] = useState<ISODate>(addDays(data.today, 7) < occ.dueDate ? addDays(data.today, 7) : occ.dueDate);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);

  const run = (fn: () => Promise<ActionResult>, msg?: string) =>
    start(async () => {
      const r = await fn();
      setResult(r);
      if (r.ok) onSaved(msg ?? t("activity.saved"));
    });
  const setStatus = (status: Activity["status"]) =>
    run(() => setOccurrenceStatus({ activity_id: a.id, occurrence_date: occ.date, status }));

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-sm">
        <dt className="text-muted">{t("clock.columns.date")}</dt>
        <dd>
          {formatDateRange(occ.date, occ.endDate)}
          {!a.all_day && a.start_time && (
            <span className="ml-1 text-muted">
              {a.start_time}
              {a.end_time && `–${a.end_time}`}
            </span>
          )}
        </dd>
        <dt className="text-muted">{t("clock.columns.status")}</dt>
        <dd className="flex flex-wrap items-center gap-2">
          <StatusBadge occ={occ} />
          {occ.completedAt && <span className="text-xs text-muted">{formatDate(occ.completedAt.slice(0, 10))}</span>}
          {occ.snoozedUntil && <span className="text-xs text-muted">{t("activity.snoozedUntil", { date: formatDate(occ.snoozedUntil) })}</span>}
        </dd>
        {data.mode === "overlay" && (
          <>
            <dt className="text-muted">{t("clock.columns.clock")}</dt>
            <dd>{clock?.name}</dd>
          </>
        )}
        <dt className="text-muted">{t("clock.columns.ring")}</dt>
        <dd>{ring?.name}</dd>
        <dt className="text-muted">{t("clock.columns.type")}</dt>
        <dd>{t(`activity.types.${a.type}`)}</dd>
        <dt className="text-muted">{t("clock.columns.owner")}</dt>
        <dd>{personName(a.owner_id)}</dd>
        {a.assignee_ids.length > 0 && (
          <>
            <dt className="text-muted">{t("activity.assignees")}</dt>
            <dd>{a.assignee_ids.map((id) => personName(id)).join(", ")}</dd>
          </>
        )}
        <dt className="text-muted">{t("clock.columns.repeats")}</dt>
        <dd>{describeRRule(a.rrule)}</dd>
        <dt className="text-muted">{t("activity.reminders")}</dt>
        <dd>{(a.reminder_offsets ?? clock?.default_reminder_offsets ?? []).join(", ") || "—"}</dd>
        {pred && (
          <>
            <dt className="text-muted">{t("clock.dependsOn")}</dt>
            <dd>
              {pred.title}
              {conflict && <p className="mt-1 text-xs text-danger">⚠ {conflict}</p>}
            </dd>
          </>
        )}
        {a.tags.length > 0 && (
          <>
            <dt className="text-muted">{t("activity.tags")}</dt>
            <dd className="flex flex-wrap gap-1">
              {a.tags.map((tag) => (
                <span key={tag} className="rounded bg-canvas px-1.5 py-0.5 text-xs">
                  {tag}
                </span>
              ))}
            </dd>
          </>
        )}
        {a.description && (
          <>
            <dt className="text-muted">{t("activity.description")}</dt>
            <dd className="whitespace-pre-wrap">{a.description}</dd>
          </>
        )}
        {a.links.length > 0 && (
          <>
            <dt className="text-muted">{t("activity.links")}</dt>
            <dd>
              <ul>
                {a.links.map((l) => (
                  <li key={l.url}>
                    <a href={l.url} target="_blank" rel="noopener noreferrer" className="break-all text-primary underline">
                      {l.label || l.url}
                    </a>
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
      </dl>

      <ErrorBox result={result} />

      {canEdit && (
        <div className="space-y-3 border-t border-border pt-3">
          {occ.recurring && <p className="text-xs text-muted">{t("activity.occurrenceNote")}</p>}
          <div className="flex flex-wrap gap-2">
            {occ.status !== "done" ? (
              <Button disabled={pending} onClick={() => setStatus("done")}>
                ✓ {occ.recurring ? t("activity.markDone") : t("activity.markDoneOne")}
              </Button>
            ) : (
              <Button variant="outline" disabled={pending} onClick={() => setStatus("planned")}>
                {t("activity.reopen")}
              </Button>
            )}
            {occ.status === "planned" && (
              <Button variant="outline" disabled={pending} onClick={() => setStatus("in_progress")}>
                {t("activity.startWork")}
              </Button>
            )}
            <Button variant="outline" disabled={pending} onClick={onEdit}>
              {t("common.edit")}
            </Button>
          </div>
          {occ.status !== "done" && occ.status !== "cancelled" && (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                run(() => snoozeOccurrence({ activity_id: a.id, occurrence_date: occ.date, until: snoozeUntil }));
              }}
            >
              <div>
                <Label htmlFor="snooze">{t("activity.snooze")}</Label>
                <Input id="snooze" type="date" value={snoozeUntil} min={data.today} onChange={(e) => setSnoozeUntil(e.target.value)} className="w-auto" />
              </div>
              <Button type="submit" variant="outline" disabled={pending}>
                {t("activity.snoozeButton")}
              </Button>
            </form>
          )}
          <Button
            variant="link"
            className="px-0 text-danger"
            disabled={pending}
            onClick={() => {
              if (confirm(t("activity.deleteConfirm"))) run(() => deleteActivity(a.id));
            }}
          >
            {t("activity.delete")}
          </Button>
        </div>
      )}

      <div className="border-t border-border pt-3">
        {history === null ? (
          <Button variant="link" className="px-0" onClick={async () => setHistory(await getActivityHistory(a.id))}>
            {t("activity.showHistory")}
          </Button>
        ) : (
          <section aria-label={t("activity.history")}>
            <h3 className="mb-2 text-sm font-medium">{t("activity.history")}</h3>
            {history.length === 0 ? (
              <p className="text-sm text-muted">{t("activity.noHistory")}</p>
            ) : (
              <ol className="space-y-1.5 text-xs">
                {history.map((h) => (
                  <li key={h.id}>
                    <span className="text-muted">{new Date(h.created_at).toLocaleString("en-GB", { timeZone: "Europe/Helsinki" })}</span>{" "}
                    <strong className="font-medium">{h.actor ?? "System"}</strong>{" "}
                    {h.summary ?? `${h.action.replace("_", " ")}${h.fields.length ? `: ${h.fields.join(", ")}` : ""}`}
                  </li>
                ))}
              </ol>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create / edit form
// ---------------------------------------------------------------------------
function ActivityForm({
  data,
  occ,
  clockId,
  initialRing,
  initialDate,
  onCancel,
  onSaved,
}: {
  data: WorkspaceData;
  occ?: Occurrence;
  clockId: string;
  initialRing?: string;
  initialDate?: ISODate;
  onCancel: () => void;
  onSaved: (m?: string) => void;
}) {
  const a = occ?.activity;
  const clock = data.clocks.find((c) => c.id === clockId)!;
  const rings = data.rings.filter((r) => r.clock_id === clockId);
  const members = useMemo(
    () => data.people.filter((p) => (data.memberIds[clockId] ?? []).includes(p.id)),
    [data.people, data.memberIds, clockId],
  );
  const predecessors = data.activities.filter((x) => x.clock_id === clockId && x.id !== a?.id);
  const defaultOwner = members.some((m) => m.id === data.currentUserId) ? data.currentUserId : "";

  const [title, setTitle] = useState(a?.title ?? "");
  const [description, setDescription] = useState(a?.description ?? "");
  const [ringId, setRingId] = useState(a?.ring_id ?? initialRing ?? rings[0]?.id ?? "");
  const [type, setType] = useState<Activity["type"]>(a?.type ?? "deadline");
  const [startDate, setStartDate] = useState<ISODate>(occ?.date ?? initialDate ?? data.today);
  const [endDate, setEndDate] = useState<ISODate>(occ?.endDate ?? "");
  const [allDay, setAllDay] = useState(a?.all_day ?? true);
  const [startTime, setStartTime] = useState(a?.start_time ?? "");
  const [endTime, setEndTime] = useState(a?.end_time ?? "");
  const [ownerId, setOwnerId] = useState(a ? (a.owner_id ?? "") : defaultOwner);
  const [assignees, setAssignees] = useState<string[]>(a?.assignee_ids ?? []);
  const [status, setStatus] = useState<Activity["status"]>(a?.status ?? "planned");
  const [recKind, setRecKind] = useState<RecurrenceKind>(recurrenceKindOf(a?.rrule));
  const [customRule, setCustomRule] = useState(recurrenceKindOf(a?.rrule) === "custom" ? (a?.rrule ?? "") : "");
  const [predecessorId, setPredecessorId] = useState(a?.predecessor_id ?? "");
  const [useDefaultReminders, setUseDefaultReminders] = useState(a ? a.reminder_offsets === null : true);
  const [reminders, setReminders] = useState((a?.reminder_offsets ?? clock.default_reminder_offsets).join(", "));
  const [tags, setTags] = useState((a?.tags ?? []).join(", "));
  const [links, setLinks] = useState((a?.links ?? []).map((l) => (l.label ? `${l.label} | ${l.url}` : l.url)).join("\n"));
  const [scope, setScope] = useState<"all" | "future">("all");
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (type === "period" && !endDate) setEndDate(addDays(startDate, 6));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);

  const showScope = !!(a?.rrule && occ && occ.date !== a.start_date);
  const predecessor = predecessors.find((p) => p.id === predecessorId);
  const conflict = predecessor && dependencyConflict({ ...(a ?? ({} as Activity)), start_date: startDate } as Activity, predecessor);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsedReminders = reminders
      .split(/[,\s]+/)
      .filter(Boolean)
      .map(Number);
    const parsedLinks = links
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [label, url] = l.includes("|") ? l.split("|").map((s) => s.trim()) : ["", l];
        return { label: label || undefined, url };
      });
    start(async () => {
      const r = await saveActivity({
        id: a?.id,
        clock_id: clockId,
        ring_id: ringId,
        title,
        description,
        type,
        start_date: startDate,
        end_date: type === "period" || endDate ? endDate || null : null,
        all_day: allDay,
        start_time: allDay ? null : startTime || null,
        end_time: allDay ? null : endTime || null,
        rrule: rruleForKind(recKind, customRule) ?? (recKind === "custom" ? customRule : null),
        owner_id: ownerId || null,
        assignee_ids: assignees,
        status,
        predecessor_id: predecessorId || null,
        reminder_offsets: useDefaultReminders ? null : parsedReminders,
        tags: tags
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        links: parsedLinks,
        scope,
        occurrence_date: occ?.date,
      });
      setResult(r);
      if (r.ok) onSaved(t("activity.saved"));
    });
  };

  const fe = result && !result.ok ? result.fieldErrors : undefined;

  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <Field label={t("activity.title")} htmlFor="f-title">
        <Input id="f-title" required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} aria-invalid={!!fe?.title} autoFocus />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("activity.ring")} htmlFor="f-ring">
          <Select id="f-ring" value={ringId} onChange={(e) => setRingId(e.target.value)}>
            {rings.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("activity.type")} htmlFor="f-type">
          <Select id="f-type" value={type} onChange={(e) => setType(e.target.value as Activity["type"])}>
            {ACTIVITY_TYPES.map((x) => (
              <option key={x} value={x}>
                {t(`activity.types.${x}`)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label={type === "period" ? t("activity.startDate") : t("activity.date")} htmlFor="f-start">
          <Input id="f-start" type="date" required value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </Field>
        <Field label={t("activity.endDate")} htmlFor="f-end">
          <Input
            id="f-end"
            type="date"
            value={endDate}
            min={startDate}
            onChange={(e) => setEndDate(e.target.value)}
            aria-invalid={!!fe?.end_date}
            required={type === "period"}
          />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} className="accent-[var(--color-primary)]" />
        {t("activity.allDay")}
      </label>
      {!allDay && (
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("activity.startTime")} htmlFor="f-st">
            <Input id="f-st" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
          </Field>
          <Field label={t("activity.endTime")} htmlFor="f-et">
            <Input id="f-et" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
          </Field>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("activity.recurrence")} htmlFor="f-rec">
          <Select id="f-rec" value={recKind} onChange={(e) => setRecKind(e.target.value as RecurrenceKind)}>
            <option value="none">{t("common.none")}</option>
            <option value="yearly">Yearly</option>
            <option value="quarterly">Quarterly</option>
            <option value="monthly">Monthly</option>
            <option value="weekly">Weekly</option>
            <option value="custom">Custom…</option>
          </Select>
        </Field>
        <Field label={t("activity.status")} htmlFor="f-status">
          <Select id="f-status" value={status} onChange={(e) => setStatus(e.target.value as Activity["status"])}>
            {ACTIVITY_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`activity.statuses.${s}`)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {recKind === "custom" && (
        <Field label={t("activity.customRule")} htmlFor="f-rrule" hint={t("activity.customRuleHint")}>
          <Input id="f-rrule" value={customRule} onChange={(e) => setCustomRule(e.target.value)} aria-invalid={!!fe?.rrule} />
        </Field>
      )}
      <Field label={t("activity.owner")} htmlFor="f-owner">
        <Select id="f-owner" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
          <option value="">{t("activity.noOwner")}</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.full_name ?? m.email}
            </option>
          ))}
        </Select>
      </Field>
      <fieldset>
        <legend className="mb-1 text-xs font-medium text-muted">{t("activity.assignees")}</legend>
        <div className="max-h-28 space-y-0.5 overflow-y-auto rounded-md border border-border p-2">
          {members
            .filter((m) => m.id !== ownerId)
            .map((m) => (
              <label key={m.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="accent-[var(--color-primary)]"
                  checked={assignees.includes(m.id)}
                  onChange={(e) => setAssignees((s) => (e.target.checked ? [...s, m.id] : s.filter((x) => x !== m.id)))}
                />
                {m.full_name ?? m.email}
              </label>
            ))}
        </div>
      </fieldset>
      <Field label={t("activity.predecessor")} htmlFor="f-pred">
        <Select id="f-pred" value={predecessorId} onChange={(e) => setPredecessorId(e.target.value)}>
          <option value="">{t("activity.noPredecessor")}</option>
          {predecessors.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </Select>
      </Field>
      {conflict && <p className="text-xs text-danger">⚠ {t("clock.dependencyWarning")}: {conflict}</p>}
      <fieldset className="space-y-1">
        <legend className="mb-1 text-xs font-medium text-muted">{t("activity.reminders")}</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="accent-[var(--color-primary)]"
            checked={useDefaultReminders}
            onChange={(e) => setUseDefaultReminders(e.target.checked)}
          />
          {t("activity.useClockDefault", { offsets: clock.default_reminder_offsets.join(", ") })}
        </label>
        {!useDefaultReminders && (
          <>
            <Input aria-label={t("activity.reminders")} value={reminders} onChange={(e) => setReminders(e.target.value)} aria-invalid={!!fe?.reminder_offsets} />
            <p className="text-xs text-muted">{t("activity.remindersHint")}</p>
          </>
        )}
      </fieldset>
      <Field label={t("activity.description")} htmlFor="f-desc">
        <Textarea id="f-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} />
      </Field>
      <Field label={t("activity.tags")} htmlFor="f-tags" hint={t("activity.tagsHint")}>
        <Input id="f-tags" value={tags} onChange={(e) => setTags(e.target.value)} />
      </Field>
      <Field label={t("activity.links")} htmlFor="f-links" hint={t("activity.linksHint")}>
        <Textarea id="f-links" value={links} onChange={(e) => setLinks(e.target.value)} className="min-h-14" />
      </Field>
      {showScope && (
        <fieldset className="rounded-md border border-border p-2">
          <legend className="px-1 text-xs font-medium text-muted">{t("activity.scope")}</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="scope" checked={scope === "all"} onChange={() => setScope("all")} />
            {t("activity.scopeAll")}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="scope" checked={scope === "future"} onChange={() => setScope("future")} />
            {t("activity.scopeFuture")}
          </label>
        </fieldset>
      )}
      <ErrorBox result={result} />
      <div className="flex gap-2">
        <Button type="submit" disabled={pending || !title.trim()}>
          {pending ? t("common.loading") : a ? t("common.save") : t("common.create")}
        </Button>
        <Button variant="outline" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Drag confirmation (recurring activities: choose scope)
// ---------------------------------------------------------------------------
function MoveConfirm({
  state,
  onCancel,
  onSaved,
}: {
  state: Extract<PanelState, { kind: "move" }>;
  onCancel: () => void;
  onSaved: (m?: string) => void;
}) {
  const { occ } = state;
  const firstOccurrence = occ.date === occ.activity.start_date;
  const [scope, setScope] = useState<"all" | "future">("all");
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const shift = diffDays(occ.date, state.start);
  return (
    <div className="space-y-3 text-sm">
      <p>{t("activity.moveQuestion", { title: occ.activity.title, dates: formatDateRange(state.start, state.end) })}</p>
      <p className="text-xs text-muted">
        {formatDateRange(occ.date, occ.endDate)} → {formatDateRange(state.start, state.end)} ({shift >= 0 ? "+" : ""}
        {shift} d)
      </p>
      {occ.recurring && !firstOccurrence && (
        <fieldset className="rounded-md border border-border p-2">
          <legend className="px-1 text-xs font-medium text-muted">{t("activity.scope")}</legend>
          <label className="flex items-center gap-2">
            <input type="radio" name="mscope" checked={scope === "all"} onChange={() => setScope("all")} />
            {t("activity.scopeAll")}
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="mscope" checked={scope === "future"} onChange={() => setScope("future")} />
            {t("activity.scopeFuture")}
          </label>
        </fieldset>
      )}
      <ErrorBox result={result} />
      <div className="flex gap-2">
        <Button
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await moveActivity({
                activity_id: occ.activity.id,
                occurrence_date: occ.date,
                new_start: state.start,
                new_end: state.end,
                scope,
              });
              setResult(r);
              if (r.ok) onSaved(t("activity.moved", { title: occ.activity.title }));
            })
          }
        >
          {t("common.save")}
        </Button>
        <Button variant="outline" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
}
