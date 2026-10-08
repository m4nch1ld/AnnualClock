"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export function NavLinks({ links }: { links: Array<{ href: string; label: string }> }) {
  const path = usePathname();
  return (
    <ul className="flex gap-1">
      {links.map((l) => {
        const active = path === l.href || path.startsWith(`${l.href}/`);
        return (
          <li key={l.href}>
            <Link
              href={l.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "rounded px-3 py-1.5 text-sm text-white/80 hover:bg-white/10 hover:text-white",
                active && "bg-white/10 text-white",
              )}
            >
              {l.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
