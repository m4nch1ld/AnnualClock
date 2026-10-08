"use client";

import { useState, useTransition } from "react";
import { createIcsFeed, revokeIcsFeed, savePrefs, updateProfile } from "./actions";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/card";

function Saved({ show }: { show: boolean }) {
  return (
    <span role="status" aria-live="polite" className="text-sm text-success">
      {show ? "Saved." : ""}
    </span>
  );
}

export function ProfileForm({ fullName, email, weeklyDigest }: { fullName: string; email: string; weeklyDigest: boolean }) {
  const [name, setName] = useState(fullName);
  const [digest, setDigest] = useState(weeklyDigest);
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);
  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        setSaved(false);
        start(async () => {
          await updateProfile({ full_name: name, weekly_digest: digest });
          setSaved(true);
        });
      }}
    >
      <Field label="Name" htmlFor="p-name">
        <Input id="p-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
      </Field>
      <Field label="Email" htmlFor="p-email">
        <Input id="p-email" value={email} disabled />
      </Field>
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input type="checkbox" checked={digest} onChange={(e) => setDigest(e.target.checked)} className="accent-[var(--color-primary)]" />
        Weekly digest email on Monday morning: next 30 days across my clocks, plus overdue items
      </label>
      <div className="flex items-center gap-3 sm:col-span-2">
        <Button type="submit" disabled={pending}>
          Save
        </Button>
        <Saved show={saved} />
      </div>
    </form>
  );
}

type Prefs = { enabled: boolean; channels: string[]; subscribe_all: boolean; delivery: "individual" | "digest" };

export function PrefsForm({ clockId, clockName, color, initial }: { clockId: string; clockName: string; color: string; initial: Prefs }) {
  const [p, setP] = useState<Prefs>(initial);
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);
  const toggleChannel = (ch: string, on: boolean) => setP((x) => ({ ...x, channels: on ? [...new Set([...x.channels, ch])] : x.channels.filter((c) => c !== ch) }));
  return (
    <form
      className="rounded-md border border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        setSaved(false);
        start(async () => {
          await savePrefs({ clock_id: clockId, ...p, channels: p.channels.filter((c) => c === "email" || c === "in_app") });
          setSaved(true);
        });
      }}
    >
      <fieldset className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        <legend className="mb-2 flex items-center gap-2 font-medium">
          <span className="size-3 rounded-full" style={{ background: color }} aria-hidden />
          {clockName}
        </legend>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={p.enabled} onChange={(e) => setP({ ...p, enabled: e.target.checked })} className="accent-[var(--color-primary)]" />
          Notifications on
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" disabled={!p.enabled} checked={p.channels.includes("email")} onChange={(e) => toggleChannel("email", e.target.checked)} className="accent-[var(--color-primary)]" />
          Email
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" disabled={!p.enabled} checked={p.channels.includes("in_app")} onChange={(e) => toggleChannel("in_app", e.target.checked)} className="accent-[var(--color-primary)]" />
          In-app
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" disabled={!p.enabled} checked={p.subscribe_all} onChange={(e) => setP({ ...p, subscribe_all: e.target.checked })} className="accent-[var(--color-primary)]" />
          All activities in this clock
        </label>
        <label className="flex items-center gap-2">
          Email as
          <Select value={p.delivery} disabled={!p.enabled} onChange={(e) => setP({ ...p, delivery: e.target.value as Prefs["delivery"] })} className="w-auto">
            <option value="individual">individual reminders</option>
            <option value="digest">weekly digest only</option>
          </Select>
        </label>
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          Save
        </Button>
        <Saved show={saved} />
      </fieldset>
    </form>
  );
}

interface Feed {
  id: string;
  clock_id: string | null;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export function IcsFeeds({ clocks, feeds }: { clocks: Array<{ id: string; name: string }>; feeds: Feed[] }) {
  const [clockId, setClockId] = useState<string>("");
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();
  const name = (id: string | null) => (id ? (clocks.find((c) => c.id === id)?.name ?? "Unknown clock") : "All my clocks");
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Feed for" htmlFor="ics-clock">
          <Select id="ics-clock" value={clockId} onChange={(e) => setClockId(e.target.value)} className="w-56">
            <option value="">All my clocks (combined)</option>
            {clocks.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Button
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await createIcsFeed(clockId || null);
              setCreated(r.url);
              setCopied(false);
            })
          }
        >
          Create subscription URL
        </Button>
      </div>
      {created && (
        <div className="rounded-md border border-primary/40 bg-teal-5/20 p-3 text-sm">
          <p className="mb-2 font-medium">Copy this URL now — it is shown only once.</p>
          <div className="flex gap-2">
            <Input readOnly value={created} onFocus={(e) => e.target.select()} aria-label="Calendar subscription URL" />
            <Button
              variant="outline"
              onClick={async () => {
                await navigator.clipboard.writeText(created);
                setCopied(true);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      )}
      {feeds.length > 0 && (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="py-1 font-medium">Feed</th>
              <th className="py-1 font-medium">Created</th>
              <th className="py-1 font-medium">Last used</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {feeds.map((f) => (
              <tr key={f.id} className="border-t border-border">
                <td className="py-2">
                  {name(f.clock_id)} <span className="text-xs text-muted">{f.label}</span>
                </td>
                <td className="py-2">{new Date(f.created_at).toLocaleDateString("en-GB")}</td>
                <td className="py-2">{f.last_used_at ? new Date(f.last_used_at).toLocaleString("en-GB") : "—"}</td>
                <td className="py-2 text-right">
                  {f.revoked_at ? (
                    <Badge>Revoked</Badge>
                  ) : (
                    <Button variant="link" className="text-danger" disabled={pending} onClick={() => start(async () => void (await revokeIcsFeed(f.id)))}>
                      Revoke
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
