"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createClock, inviteUser, runJobNow, setClockArchived, updateUser } from "./actions";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/card";

type Result = { ok: true; message?: string } | { ok: false; error: string };

function useRun() {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<Result | null>(null);
  const router = useRouter();
  return {
    pending,
    result,
    run: (fn: () => Promise<Result>) =>
      start(async () => {
        const r = await fn();
        setResult(r);
        router.refresh();
      }),
  };
}

function Feedback({ result }: { result: Result | null }) {
  if (!result) return <span aria-live="polite" />;
  return (
    <span role={result.ok ? "status" : "alert"} className={`text-sm ${result.ok ? "text-success" : "text-danger"}`}>
      {result.ok ? (result.message ?? "Done.") : result.error}
    </span>
  );
}

export function JobButtons() {
  const { pending, result, run } = useRun();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" disabled={pending} onClick={() => run(() => runJobNow({ dryRun: true }))}>
        Dry run now
      </Button>
      <Button disabled={pending} onClick={() => confirm("Run the notification job now? Due notifications will be sent.") && run(() => runJobNow({ dryRun: false }))}>
        Run now
      </Button>
      <Feedback result={result} />
    </div>
  );
}

interface UserRowData {
  id: string;
  email: string;
  full_name: string | null;
  global_role: "user" | "super_admin";
  all_clocks_viewer: boolean;
  is_active: boolean;
  is_demo: boolean;
  clocks: string | null;
}

export function UserRow({ user, self }: { user: UserRowData; self: boolean }) {
  const { pending, result, run } = useRun();
  const toggle = (patch: Partial<Pick<UserRowData, "is_active" | "all_clocks_viewer" | "global_role">>) => run(() => updateUser({ id: user.id, ...patch }));
  const label = user.full_name ?? user.email;
  return (
    <tr className={`border-t border-border align-top ${user.is_active ? "" : "text-muted"}`}>
      <td className="py-2 pr-3">
        <div className="font-medium">
          {label} {user.is_demo && <Badge>demo</Badge>} {!user.is_active && <Badge tone="danger">inactive</Badge>}
        </div>
        <div className="text-xs text-muted">{user.email}</div>
        {result && !result.ok && <Feedback result={result} />}
      </td>
      <td className="py-2 pr-3 text-xs">{user.clocks ?? "—"}</td>
      <td className="py-2 pr-3">
        <input
          type="checkbox"
          aria-label={`General management read access for ${label}`}
          checked={user.all_clocks_viewer}
          disabled={pending}
          onChange={(e) => toggle({ all_clocks_viewer: e.target.checked })}
          className="accent-[var(--color-primary)]"
        />
      </td>
      <td className="py-2 pr-3">
        <input
          type="checkbox"
          aria-label={`Super admin: ${label}`}
          checked={user.global_role === "super_admin"}
          disabled={pending || self}
          onChange={(e) => toggle({ global_role: e.target.checked ? "super_admin" : "user" })}
          className="accent-[var(--color-primary)]"
        />
      </td>
      <td className="py-2">
        <Button size="sm" variant="outline" disabled={pending || self} onClick={() => toggle({ is_active: !user.is_active })}>
          {user.is_active ? "Deactivate" : "Reactivate"}
        </Button>
      </td>
    </tr>
  );
}

export function InviteUserForm() {
  const { pending, result, run } = useRun();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [gm, setGm] = useState(false);
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          const r = await inviteUser({ email, full_name: name, all_clocks_viewer: gm });
          if (r.ok) {
            setEmail("");
            setName("");
          }
          return r;
        });
      }}
    >
      <Field label="Invite user (email)" htmlFor="u-email">
        <Input id="u-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="w-64" />
      </Field>
      <Field label="Name" htmlFor="u-name">
        <Input id="u-name" value={name} onChange={(e) => setName(e.target.value)} className="w-52" />
      </Field>
      <label className="flex h-9 items-center gap-2 text-sm">
        <input type="checkbox" checked={gm} onChange={(e) => setGm(e.target.checked)} className="accent-[var(--color-primary)]" />
        General management (read all clocks)
      </label>
      <Button type="submit" disabled={pending}>
        Invite
      </Button>
      <Feedback result={result} />
    </form>
  );
}

export function ClockAdminRow({ clock }: { clock: { id: string; name: string; slug: string; color: string; archived_at: string | null; members: number; activities: number } }) {
  const { pending, result, run } = useRun();
  return (
    <li className="flex flex-wrap items-center gap-3 py-2 text-sm">
      <span className="size-3 rounded-full" style={{ background: clock.color }} aria-hidden />
      <Link href={`/clocks/${clock.slug}/settings`} className="font-medium hover:underline">
        {clock.name}
      </Link>
      <span className="text-muted">
        {clock.members} members · {clock.activities} activities
      </span>
      {clock.archived_at && <Badge>archived</Badge>}
      <Button
        size="sm"
        variant="ghost"
        className="ml-auto"
        disabled={pending}
        onClick={() => run(() => setClockArchived({ id: clock.id, archived: !clock.archived_at }))}
      >
        {clock.archived_at ? "Restore" : "Archive"}
      </Button>
      <Feedback result={result} />
    </li>
  );
}

export function CreateClockForm() {
  const { pending, result, run } = useRun();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [color, setColor] = useState("#16A082");
  const [rings, setRings] = useState("Regulatory, Internal, Reporting");
  return (
    <form
      className="flex flex-wrap items-end gap-2 border-t border-border pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(() =>
          createClock({
            name,
            slug: slug || name.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
            color,
            rings: rings.split(",").map((s) => s.trim()).filter(Boolean),
          }),
        );
      }}
    >
      <Field label="New clock" htmlFor="c-name">
        <Input id="c-name" required value={name} onChange={(e) => setName(e.target.value)} className="w-52" />
      </Field>
      <Field label="Slug (URL)" htmlFor="c-slug">
        <Input id="c-slug" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="auto" className="w-40" />
      </Field>
      <Input type="color" aria-label="Clock color" value={color} onChange={(e) => setColor(e.target.value)} className="h-9 w-14 p-1" />
      <Field label="Rings (comma-separated)" htmlFor="c-rings">
        <Input id="c-rings" value={rings} onChange={(e) => setRings(e.target.value)} className="w-72" />
      </Field>
      <Button type="submit" disabled={pending}>
        Create clock
      </Button>
      <Feedback result={result} />
    </form>
  );
}
