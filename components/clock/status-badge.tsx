import type { Occurrence } from "@/lib/domain";
import { Badge } from "@/components/ui/card";
import { t } from "@/lib/i18n";

export function StatusBadge({ occ }: { occ: Occurrence }) {
  if (occ.overdue) return <Badge tone="danger">! {t("activity.statuses.overdue")}</Badge>;
  switch (occ.status) {
    case "done":
      return <Badge tone="success">✓ {t("activity.statuses.done")}</Badge>;
    case "in_progress":
      return <Badge tone="warning">{t("activity.statuses.in_progress")}</Badge>;
    case "cancelled":
      return <Badge>{t("activity.statuses.cancelled")}</Badge>;
    default:
      return <Badge tone="primary">{t("activity.statuses.planned")}</Badge>;
  }
}
