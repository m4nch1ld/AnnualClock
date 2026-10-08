import type { Occurrence } from "@/lib/domain";

/** Status palette (used for "color by status" and status text). */
export const STATUS_COLORS = {
  overdue: "#B42318",
  planned: "#39978F",
  in_progress: "#B7791F",
  done: "#7A8691",
  cancelled: "#A9B3BC",
} as const;

export function statusColor(o: Occurrence): string {
  if (o.overdue) return STATUS_COLORS.overdue;
  return STATUS_COLORS[o.status];
}
