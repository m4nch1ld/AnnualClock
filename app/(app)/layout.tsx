import Image from "next/image";
import Link from "next/link";
import { requireSession } from "@/lib/server/session";
import { t } from "@/lib/i18n";
import { NavLinks } from "@/components/nav-links";
import { NotificationBell } from "@/components/notification-bell";
import { withUser } from "@/lib/db";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const { profile } = session;
  const unread = await withUser(profile.id, (tx) =>
    tx.one<{ n: number }>(`select count(*)::int as n from in_app_notifications where read_at is null`),
  );
  const multiClock = session.memberships.length > 1 || session.isAllClocksViewer || session.isSuperAdmin;

  const links = [
    { href: "/clocks", label: t("nav.clocks") },
    ...(multiClock ? [{ href: "/overview", label: t("nav.overview") }] : []),
    { href: "/settings", label: t("nav.settings") },
    ...(session.isSuperAdmin ? [{ href: "/admin", label: t("nav.admin") }] : []),
  ];

  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#main" className="sr-only-focusable absolute left-2 top-2 z-50 rounded bg-surface px-3 py-2 text-sm">
        {t("app.skipToContent")}
      </a>
      <header className="bg-header text-header-foreground">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2">
          <Link href="/clocks" className="flex items-center gap-3" aria-label={`${t("app.company")} ${t("app.name")}`}>
            <Image src="/brand/esl-horizontal-nega.png" alt="" width={110} height={24} />
            <span className="border-l border-white/30 pl-3 text-sm tracking-wide">{t("app.name")}</span>
          </Link>
          <nav aria-label="Main" className="order-3 w-full sm:order-none sm:w-auto">
            <NavLinks links={links} />
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <NotificationBell unread={unread?.n ?? 0} />
            <span className="hidden text-xs text-white/70 md:inline" title={profile.email}>
              {profile.full_name ?? profile.email}
              {session.isSuperAdmin && ` · ${t("roles.super_admin")}`}
              {!session.isSuperAdmin && session.isAllClocksViewer && ` · ${t("roles.all_clocks_viewer")}`}
            </span>
            <form action="/auth/signout" method="post">
              <button type="submit" className="rounded px-2 py-1 text-xs text-white/80 hover:bg-white/10 hover:text-white">
                {t("nav.signOut")}
              </button>
            </form>
          </div>
        </div>
        <div className="h-[3px] bg-brand" aria-hidden />
      </header>
      <main id="main" className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-5">
        {children}
      </main>
    </div>
  );
}
