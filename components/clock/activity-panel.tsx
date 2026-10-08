"use client";

import { dependencyConflict, type Occurrence } from "@/lib/domain";
import type { ISODate } from "@/lib/dates";
import { formatDate, formatDateRange, t } from "@/lib/i18n";
import { describeRRule } from "@/lib/recurrence";
import { Button } from "@/components/ui/button";
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
  onSaved: () => void;
}

export function ActivityPanel({ state, data, personName, onClose }: Props) {
  return (
    <aside
      aria-label="Activity details"
      className="rounded-lg border border-border bg-surface p-4 xl:sticky xl:top-4 xl:max-h-[calc(100dvh-2rem)] xl:self-start xl:overflow-y-auto"
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <h2 className="text-lg">{state.kind === "create" ? t("clock.newActivity") : "occ" in state ? state.occ.activity.title : ""}</h2>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label={t("common.close")}>
          ✕
        </Button>
      </div>
      {state.kind === "view" && <Details occ={state.occ} data={data} personName={personName} />}
      {state.kind !== "view" && <p className="text-sm text-muted">Editing is not available yet.</p>}
    </aside>
  );
}

function Details({ occ, data, personName }: { occ: Occurrence; data: WorkspaceData; personName: (id: string | null) => string }) {
  const a = occ.activity;
  const ring = data.rings.find((r) => r.id === a.ring_id);
  const clock = data.clocks.find((c) => c.id === a.clock_id);
  const pred = a.predecessor_id ? data.activities.find((x) => x.id === a.predecessor_id) : undefined;
  const conflict = dependencyConflict(a, pred);
  return (
    <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-sm">
      <dt className="text-muted">{t("clock.columns.date")}</dt>
      <dd>{formatDateRange(occ.date, occ.endDate)}</dd>
      <dt className="text-muted">{t("clock.columns.status")}</dt>
      <dd>
        <StatusBadge occ={occ} />
        {occ.completedAt && <span className="ml-2 text-xs text-muted">{formatDate(occ.completedAt.slice(0, 10))}</span>}
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
          <dt className="text-muted">Assignees</dt>
          <dd>{a.assignee_ids.map((id) => personName(id)).join(", ")}</dd>
        </>
      )}
      <dt className="text-muted">{t("clock.columns.repeats")}</dt>
      <dd>{describeRRule(a.rrule)}</dd>
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
          <dt className="text-muted">Tags</dt>
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
          <dt className="text-muted">Description</dt>
          <dd className="whitespace-pre-wrap">{a.description}</dd>
        </>
      )}
      {a.links.length > 0 && (
        <>
          <dt className="text-muted">Links</dt>
          <dd>
            <ul>
              {a.links.map((l) => (
                <li key={l.url}>
                  <a href={l.url} target="_blank" rel="noopener noreferrer" className="text-primary underline">
                    {l.label || l.url}
                  </a>
                </li>
              ))}
            </ul>
          </dd>
        </>
      )}
    </dl>
  );
}
