"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Clock, Ring } from "@/lib/domain";
import type { MemberRow } from "@/lib/data/clocks";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import {
  deleteRing,
  inviteMember,
  moveRing,
  removeMember,
  saveGeneral,
  saveNotificationSettings,
  saveRing,
  sendTest,
  setMemberRole,
  setTeamsWebhook,
  type Result,
} from "./actions";
import { importActivities } from "./import-action";

function useAction() {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<Result | null>(null);
  const router = useRouter();
  const run = (fn: () => Promise<Result>) =>
    start(async () => {
      const r = await fn();
      setResult(r);
      if (r.ok) router.refresh();
    });
  return { pending, result, run, setResult };
}

function Feedback({ result }: { result: Result | null }) {
  if (!result) return <span aria-live="polite" />;
  return (
    <span role={result.ok ? "status" : "alert"} className={`text-sm ${result.ok ? "text-success" : "text-danger"}`}>
      {result.ok ? (result.message ?? "Done.") : result.error}
    </span>
  );
}

export function GeneralForm({ clock }: { clock: Clock }) {
  const [name, setName] = useState(clock.name);
  const [color, setColor] = useState(clock.color);
  const [description, setDescription] = useState(clock.description ?? "");
  const { pending, result, run } = useAction();
  return (
    <form
      className="grid gap-3 sm:grid-cols-[1fr_8rem]"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => saveGeneral({ clock_id: clock.id, name, color, description }));
      }}
    >
      <Field label="Name" htmlFor="g-name">
        <Input id="g-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
      </Field>
      <Field label="Color" htmlFor="g-color">
        <Input id="g-color" type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-9 p-1" />
      </Field>
      <div className="sm:col-span-2">
        <Field label="Description" htmlFor="g-desc">
          <Textarea id="g-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} className="min-h-14" />
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          Save
        </Button>
        <Feedback result={result} />
      </div>
    </form>
  );
}

export function RingsEditor({ clockId, rings }: { clockId: string; rings: Ring[] }) {
  const { pending, result, run } = useAction();
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState("#39978F");
  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {rings.map((r, i) => (
          <RingRow key={r.id} clockId={clockId} ring={r} first={i === 0} last={i === rings.length - 1} run={run} pending={pending} />
        ))}
      </ul>
      <form
        className="flex flex-wrap items-end gap-2 border-t border-border pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const r = await saveRing({ clock_id: clockId, name: newName, color: newColor, hidden: false });
            if (r.ok) setNewName("");
            return r;
          });
        }}
      >
        <Field label="New ring" htmlFor="r-new">
          <Input id="r-new" value={newName} onChange={(e) => setNewName(e.target.value)} required maxLength={60} className="w-64" />
        </Field>
        <Input type="color" aria-label="New ring color" value={newColor} onChange={(e) => setNewColor(e.target.value)} className="h-9 w-14 p-1" />
        <Button type="submit" variant="outline" disabled={pending || !newName.trim()}>
          Add ring
        </Button>
      </form>
      <Feedback result={result} />
    </div>
  );
}

function RingRow({
  clockId,
  ring,
  first,
  last,
  run,
  pending,
}: {
  clockId: string;
  ring: Ring;
  first: boolean;
  last: boolean;
  run: (fn: () => Promise<Result>) => void;
  pending: boolean;
}) {
  const [name, setName] = useState(ring.name);
  const [color, setColor] = useState(ring.color);
  const [hidden, setHidden] = useState(ring.hidden);
  const dirty = name !== ring.name || color !== ring.color || hidden !== ring.hidden;
  return (
    <li className="flex flex-wrap items-center gap-2">
      <Input type="color" aria-label={`Color of ${ring.name}`} value={color} onChange={(e) => setColor(e.target.value)} className="h-9 w-12 p-1" />
      <Input aria-label="Ring name" value={name} onChange={(e) => setName(e.target.value)} className="w-64" maxLength={60} />
      <label className="flex items-center gap-1.5 text-sm">
        <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} className="accent-[var(--color-primary)]" /> Hidden
      </label>
      <Button size="sm" variant="outline" disabled={pending || !dirty} onClick={() => run(() => saveRing({ clock_id: clockId, id: ring.id, name, color, hidden }))}>
        Save
      </Button>
      <Button size="sm" variant="ghost" aria-label={`Move ${ring.name} up`} disabled={pending || first} onClick={() => run(() => moveRing({ clock_id: clockId, id: ring.id, direction: "up" }))}>
        ↑
      </Button>
      <Button size="sm" variant="ghost" aria-label={`Move ${ring.name} down`} disabled={pending || last} onClick={() => run(() => moveRing({ clock_id: clockId, id: ring.id, direction: "down" }))}>
        ↓
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="text-danger"
        disabled={pending}
        onClick={() => confirm(`Delete ring "${ring.name}"?`) && run(() => deleteRing({ clock_id: clockId, id: ring.id }))}
      >
        Delete
      </Button>
    </li>
  );
}

export function MembersEditor({ clockId, members, currentUserId }: { clockId: string; members: MemberRow[]; currentUserId: string }) {
  const { pending, result, run } = useAction();
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<"viewer" | "editor" | "admin">("viewer");
  return (
    <div className="space-y-4">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted">
          <tr>
            <th className="py-1 font-medium">Name</th>
            <th className="py-1 font-medium">Email</th>
            <th className="py-1 font-medium">Role</th>
            <th className="py-1" />
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.id} className="border-t border-border">
              <td className="py-2">{m.full_name ?? "—"}</td>
              <td className="py-2 text-muted">{m.email}</td>
              <td className="py-2">
                <Select
                  aria-label={`Role of ${m.full_name ?? m.email}`}
                  value={m.role}
                  disabled={pending}
                  onChange={(e) => run(() => setMemberRole({ clock_id: clockId, user_id: m.id, role: e.target.value }))}
                  className="w-28"
                >
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                  <option value="admin">Admin</option>
                </Select>
              </td>
              <td className="py-2 text-right">
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-danger"
                  disabled={pending}
                  onClick={() =>
                    confirm(m.id === currentUserId ? "Remove yourself from this clock?" : `Remove ${m.email}?`) &&
                    run(() => removeMember({ clock_id: clockId, user_id: m.id }))
                  }
                >
                  Remove
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form
        className="grid gap-2 border-t border-border pt-3 sm:grid-cols-[1fr_1fr_8rem_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const r = await inviteMember({ clock_id: clockId, email, full_name: fullName, role });
            if (r.ok) {
              setEmail("");
              setFullName("");
            }
            return r;
          });
        }}
      >
        <Field label="Invite by email" htmlFor="i-email">
          <Input id="i-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="name@eslshipping.com" />
        </Field>
        <Field label="Name (optional)" htmlFor="i-name">
          <Input id="i-name" value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={120} />
        </Field>
        <Field label="Role" htmlFor="i-role">
          <Select id="i-role" value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
            <option value="viewer">Viewer</option>
            <option value="editor">Editor</option>
            <option value="admin">Admin</option>
          </Select>
        </Field>
        <Button type="submit" disabled={pending}>
          Send invite
        </Button>
      </form>
      <Feedback result={result} />
    </div>
  );
}

export function NotificationSettingsForm({ clock, hasWebhook }: { clock: Clock; hasWebhook: boolean }) {
  const [offsets, setOffsets] = useState(clock.default_reminder_offsets.join(", "));
  const [sendTime, setSendTime] = useState(clock.default_send_time);
  const [esc, setEsc] = useState(clock.escalation_config);
  const [escOffsets, setEscOffsets] = useState(clock.escalation_config.offsets_days.join(", "));
  const [teamsEnabled, setTeamsEnabled] = useState(clock.teams_enabled);
  const [webhook, setWebhook] = useState("");
  const main = useAction();
  const hook = useAction();
  const test = useAction();
  const nums = (s: string) =>
    s
      .split(/[,\s]+/)
      .filter(Boolean)
      .map(Number);
  return (
    <div className="space-y-6">
      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          main.run(() =>
            saveNotificationSettings({
              clock_id: clock.id,
              default_reminder_offsets: nums(offsets),
              default_send_time: sendTime,
              escalation_config: { ...esc, offsets_days: nums(escOffsets) },
              teams_enabled: teamsEnabled,
            }),
          );
        }}
      >
        <Field label="Default reminders (days before)" htmlFor="n-off" hint="Used when an activity does not override them. 0 = on the day.">
          <Input id="n-off" value={offsets} onChange={(e) => setOffsets(e.target.value)} />
        </Field>
        <Field label="Send time (Europe/Helsinki)" htmlFor="n-time" hint="Reminders go out at this local time.">
          <Input id="n-time" type="time" value={sendTime} onChange={(e) => setSendTime(e.target.value)} className="w-32" />
        </Field>
        <fieldset className="space-y-2 rounded-md border border-border p-3 sm:col-span-2">
          <legend className="px-1 text-sm font-medium">Escalation when overdue</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={esc.enabled} onChange={(e) => setEsc({ ...esc, enabled: e.target.checked })} className="accent-[var(--color-primary)]" />
            Escalate activities that are not marked done by their due date
          </label>
          <Field label="Days after the due date" htmlFor="n-esc">
            <Input id="n-esc" value={escOffsets} onChange={(e) => setEscOffsets(e.target.value)} disabled={!esc.enabled} className="w-48" />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" disabled={!esc.enabled} checked={esc.notify_admins} onChange={(e) => setEsc({ ...esc, notify_admins: e.target.checked })} className="accent-[var(--color-primary)]" />
            Notify the clock admins
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              disabled={!esc.enabled}
              checked={esc.notify_general_management}
              onChange={(e) => setEsc({ ...esc, notify_general_management: e.target.checked })}
              className="accent-[var(--color-primary)]"
            />
            Notify General management
          </label>
        </fieldset>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={teamsEnabled} onChange={(e) => setTeamsEnabled(e.target.checked)} className="accent-[var(--color-primary)]" />
          Post reminders and escalations to the clock&apos;s Microsoft Teams channel {hasWebhook ? "(webhook configured)" : "(configure a webhook below)"}
        </label>
        <div className="flex items-center gap-3 sm:col-span-2">
          <Button type="submit" disabled={main.pending}>
            Save notification settings
          </Button>
          <Feedback result={main.result} />
        </div>
      </form>

      <form
        className="space-y-2 border-t border-border pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          hook.run(async () => {
            const r = await setTeamsWebhook({ clock_id: clock.id, url: webhook || null });
            if (r.ok) setWebhook("");
            return r;
          });
        }}
      >
        <Field
          label={`Teams webhook URL ${hasWebhook ? "— a webhook is configured (stored server-side, not shown)" : ""}`}
          htmlFor="n-hook"
          hint="Teams channel → Workflows → “Post to a channel when a webhook request is received”, then paste the URL here. Leave empty and save to remove."
        >
          <Input id="n-hook" type="url" value={webhook} onChange={(e) => setWebhook(e.target.value)} placeholder="https://…logic.azure.com/… or …webhook.office.com/…" autoComplete="off" />
        </Field>
        <div className="flex items-center gap-3">
          <Button type="submit" variant="outline" disabled={hook.pending}>
            {webhook ? "Save webhook" : hasWebhook ? "Remove webhook" : "Save webhook"}
          </Button>
          <Feedback result={hook.result} />
        </div>
      </form>

      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
        <Button variant="outline" disabled={test.pending} onClick={() => test.run(() => sendTest({ clock_id: clock.id }))}>
          {test.pending ? "Sending…" : "Send test notification"}
        </Button>
        <span className="text-sm text-muted">Sends to you by email and in-app{hasWebhook ? ", and to the Teams channel" : ""}.</span>
        <Feedback result={test.result} />
      </div>
    </div>
  );
}

export function ImportForm({ clockId }: { clockId: string }) {
  const { pending, result, run } = useAction();
  const [file, setFile] = useState<File | null>(null);
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!file) return;
        run(async () => {
          const fd = new FormData();
          fd.set("clock_id", clockId);
          fd.set("file", file);
          return importActivities(fd);
        });
      }}
    >
      <Field label="CSV or ICS file" htmlFor="imp-file">
        <Input id="imp-file" type="file" accept=".csv,.ics,text/csv,text/calendar" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </Field>
      <Button type="submit" variant="outline" disabled={pending || !file}>
        {pending ? "Importing…" : "Import"}
      </Button>
      <Feedback result={result} />
    </form>
  );
}
