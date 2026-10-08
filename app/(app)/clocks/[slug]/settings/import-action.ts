"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/server/session";
import { withUser } from "@/lib/db";
import { getActivities, getRings } from "@/lib/data/clocks";
import { csvToRecords, parseIcsEvents } from "@/lib/import-export";
import { activityInput, uuid } from "@/lib/validation";
import type { Result } from "./actions";

const MAX_BYTES = 1_000_000;
const MAX_ROWS = 2000;

/** Import activities from CSV (export format) or ICS into a clock. Runs as the user (RLS: editors/admins). */
export async function importActivities(form: FormData): Promise<Result> {
  const session = await requireSession();
  const uid = session.profile.id;
  const clockId = uuid.safeParse(form.get("clock_id"));
  const file = form.get("file");
  if (!clockId.success || !(file instanceof File)) return { ok: false, error: "Choose a file." };
  if (file.size > MAX_BYTES) return { ok: false, error: "File is too large (max 1 MB)." };
  const text = await file.text();
  const isIcs = /\.ics$/i.test(file.name) || text.includes("BEGIN:VCALENDAR");

  try {
    return await withUser(uid, async (tx) => {
      const can = await tx.one<{ ok: boolean }>(`select app.can_edit_clock($1) as ok`, [clockId.data]);
      if (!can?.ok) return { ok: false, error: "You need editor rights in this clock." } as const;
      const rings = await getRings(tx, [clockId.data]);
      if (!rings.length) return { ok: false, error: "Create a ring first." } as const;
      const members = await tx.query<{ id: string; email: string }>(
        `select p.id, lower(p.email) as email from clock_members m join profiles p on p.id = m.user_id where m.clock_id = $1`,
        [clockId.data],
      );
      const idByEmail = new Map(members.map((m) => [m.email, m.id]));
      const ringByName = new Map(rings.map((r) => [r.name.toLowerCase(), r.id]));
      const existing = await getActivities(tx, [clockId.data]);
      const titleToId = new Map(existing.map((a) => [a.title.toLowerCase(), a.id]));

      const rows = isIcs
        ? parseIcsEvents(text).map((e) => ({
            title: e.title,
            description: e.description ?? "",
            start_date: e.start_date,
            end_date: e.end_date ?? "",
            rrule: e.rrule ?? "",
            type: e.end_date ? "period" : "deadline",
          }))
        : csvToRecords(text);
      if (rows.length > MAX_ROWS) return { ok: false, error: `Too many rows (max ${MAX_ROWS}).` } as const;

      let imported = 0;
      const errors: string[] = [];
      const split = (s?: string) => (s ? s.split(";").map((x) => x.trim()).filter(Boolean) : []);
      const pendingPredecessors: Array<{ id: string; title: string }> = [];

      for (const [i, r] of rows.entries()) {
        const rec = r as Record<string, string | undefined>;
        const parsed = activityInput.safeParse({
          clock_id: clockId.data,
          ring_id: ringByName.get((rec.ring ?? "").toLowerCase()) ?? rings[0].id,
          title: rec.title,
          description: rec.description || null,
          type: rec.type || "deadline",
          start_date: rec.start_date,
          end_date: rec.end_date || null,
          all_day: rec.all_day ? rec.all_day !== "false" : true,
          start_time: rec.start_time || null,
          end_time: rec.end_time || null,
          rrule: rec.rrule || null,
          owner_id: rec.owner_email ? (idByEmail.get(rec.owner_email.toLowerCase()) ?? null) : null,
          assignee_ids: split(rec.assignee_emails)
            .map((e) => idByEmail.get(e.toLowerCase()))
            .filter(Boolean),
          status: rec.status || "planned",
          reminder_offsets: rec.reminder_offsets ? split(rec.reminder_offsets).map(Number) : null,
          tags: split(rec.tags),
          links: split(rec.links).map((l) => {
            const [label, url] = l.includes("|") ? l.split("|") : ["", l];
            return { label: label || undefined, url };
          }),
        });
        if (!parsed.success) {
          errors.push(`row ${i + 2}: ${parsed.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join(", ")}`);
          continue;
        }
        const a = parsed.data;
        const row = await tx.one<{ id: string }>(
          `insert into activities (clock_id, ring_id, title, description, type, start_date, end_date, all_day, start_time, end_time,
             rrule, owner_id, status, reminder_offsets, tags, links, created_by, updated_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17) returning id`,
          [a.clock_id, a.ring_id, a.title, a.description, a.type, a.start_date, a.end_date, a.all_day, a.start_time, a.end_time, a.rrule, a.owner_id, a.status, a.reminder_offsets, a.tags, JSON.stringify(a.links), uid],
        );
        for (const as of a.assignee_ids) {
          await tx.query(`insert into activity_assignees (activity_id, user_id) values ($1, $2) on conflict do nothing`, [row!.id, as]);
        }
        titleToId.set(a.title.toLowerCase(), row!.id);
        if (rec.predecessor_title) pendingPredecessors.push({ id: row!.id, title: rec.predecessor_title });
        imported++;
      }
      for (const p of pendingPredecessors) {
        const pred = titleToId.get(p.title.toLowerCase());
        if (pred && pred !== p.id) await tx.query(`update activities set predecessor_id = $2 where id = $1`, [p.id, pred]);
      }
      revalidatePath("/clocks", "layout");
      if (!imported && errors.length) return { ok: false, error: `Nothing imported. ${errors.slice(0, 5).join(" · ")}` } as const;
      return {
        ok: true,
        message: `Imported ${imported} activit${imported === 1 ? "y" : "ies"}.${errors.length ? ` Skipped ${errors.length}: ${errors.slice(0, 3).join(" · ")}` : ""}`,
      } as const;
    });
  } catch (e) {
    console.error(JSON.stringify({ level: "error", msg: "import failed", error: String(e) }));
    return { ok: false, error: "Import failed. Check the file format." };
  }
}
