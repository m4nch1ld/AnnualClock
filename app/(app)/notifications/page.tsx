import Link from "next/link";
import { listInApp } from "./actions";
import { MarkAllRead } from "./mark-all-read";
import { cn } from "@/lib/utils";

export const metadata = { title: "Notifications" };

export default async function NotificationsPage() {
  const items = await listInApp(100);
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-end justify-between">
        <h1 className="accent-bar text-2xl">Notifications</h1>
        {items.some((i) => !i.read_at) && <MarkAllRead />}
      </div>
      {items.length === 0 ? (
        <p className="text-muted">No notifications yet. Reminders appear here and are emailed according to your settings.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
          {items.map((n) => (
            <li key={n.id} className={cn("px-4 py-3", !n.read_at && "bg-teal-5/15")}>
              <Link href={n.link ?? "/clocks"} className="block hover:underline">
                <span className={cn("text-sm font-medium", n.kind === "escalation" && "text-danger")}>{n.title}</span>
              </Link>
              {n.body && <p className="text-sm text-muted">{n.body}</p>}
              <p className="text-xs text-muted">
                {new Date(n.created_at).toLocaleString("en-GB", { timeZone: "Europe/Helsinki" })}
                {!n.read_at && " · unread"}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
