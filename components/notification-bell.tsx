"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { listInApp, markRead, type InAppItem } from "@/app/(app)/notifications/actions";
import { cn } from "@/lib/utils";

/** Bell icon with unread count and a small popover of recent in-app notifications. */
export function NotificationBell({ unread }: { unread: number }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<InAppItem[] | null>(null);
  const [count, setCount] = useState(unread);
  const [, start] = useTransition();
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => setCount(unread), [unread]);
  useEffect(() => {
    if (!open) return;
    start(async () => setItems(await listInApp(10)));
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={count ? `Notifications, ${count} unread` : "Notifications"}
        className="relative rounded p-1.5 text-white/85 hover:bg-white/10 hover:text-white"
      >
        <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {count > 0 && (
          <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-brand px-1 text-center text-[10px] font-semibold leading-4 text-white">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>
      {open && (
        <div role="dialog" aria-label="Notifications" className="absolute right-0 z-50 mt-2 w-80 rounded-lg border border-border bg-surface text-ink shadow-xl">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-sm font-medium">Notifications</span>
            {count > 0 && (
              <button
                type="button"
                className="text-xs text-primary hover:underline"
                onClick={() =>
                  start(async () => {
                    await markRead();
                    setCount(0);
                    setItems((xs) => xs?.map((x) => ({ ...x, read_at: x.read_at ?? new Date().toISOString() })) ?? null);
                    router.refresh();
                  })
                }
              >
                Mark all read
              </button>
            )}
          </div>
          <ul className="max-h-96 overflow-y-auto">
            {items === null && <li className="p-3 text-sm text-muted">Loading…</li>}
            {items?.length === 0 && <li className="p-3 text-sm text-muted">No notifications yet.</li>}
            {items?.map((n) => (
              <li key={n.id} className={cn("border-b border-border/60 last:border-0", !n.read_at && "bg-teal-5/20")}>
                <Link
                  href={n.link ?? "/clocks"}
                  className="block px-3 py-2 hover:bg-canvas"
                  onClick={() => {
                    setOpen(false);
                    if (!n.read_at) {
                      setCount((c) => Math.max(0, c - 1));
                      void markRead(n.id);
                    }
                  }}
                >
                  <span className={cn("block text-sm", n.kind === "escalation" && "text-danger")}>
                    {n.kind === "escalation" ? "⚠ " : ""}
                    {n.title}
                  </span>
                  {n.body && <span className="block text-xs text-muted">{n.body}</span>}
                  <span className="block text-[11px] text-muted">{new Date(n.created_at).toLocaleString("en-GB", { timeZone: "Europe/Helsinki" })}</span>
                </Link>
              </li>
            ))}
          </ul>
          <Link href="/notifications" onClick={() => setOpen(false)} className="block border-t border-border px-3 py-2 text-center text-xs text-primary hover:underline">
            See all
          </Link>
        </div>
      )}
    </div>
  );
}
