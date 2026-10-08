/**
 * Demo seed. Resets all rows marked is_demo and recreates: 8 department clocks
 * with 3 rings each, demo users (plus-aliases of DEMO_EMAIL_BASE), memberships,
 * and realistic recurring activities. ALL DATES ARE DEMO DATES, not regulatory
 * guidance — users enter the real dates.
 *
 *   npm run seed
 */
import "./load-env";
import { ensureIdentity } from "../lib/providers/supabase/admin-identity";
import { closePool, withService, type Tx } from "../lib/db";
import { expandOccurrences } from "../lib/recurrence";
import { addDays, todayInZone } from "../lib/dates";

const base = process.env.DEMO_EMAIL_BASE ?? "demo@example.test";
const alias = (tag: string) => {
  const [local, domain] = base.split("@");
  return tag ? `${local}+${tag}@${domain}` : base;
};

const USERS = [
  { key: "super", email: alias(""), name: "Eeli Friman (Super admin)", global_role: "super_admin", gm: false },
  { key: "envdir", email: alias("envdirector"), name: "Emma Environmental (Director)", global_role: "user", gm: false },
  { key: "envteam", email: alias("envteam"), name: "Erik Environmental (Team)", global_role: "user", gm: false },
  { key: "gm", email: alias("gm"), name: "Greta General Management", global_role: "user", gm: true },
  { key: "crew", email: alias("crewing"), name: "Carl Crewing (Editor)", global_role: "user", gm: false },
  { key: "viewer", email: alias("viewer"), name: "Vera Viewer", global_role: "user", gm: false },
] as const;
type UserKey = (typeof USERS)[number]["key"];

const CLOCKS: Array<{ slug: string; name: string; color: string; description: string; rings: Array<[string, string]>; gm?: boolean }> = [
  { slug: "operations", name: "Operations", color: "#2F6F9F", description: "Fleet operations, port state control and seasonal readiness.",
    rings: [["Port & PSC", "#2F6F9F"], ["Fleet operations", "#39978F"], ["Reporting", "#55BFB6"]] },
  { slug: "chartering", name: "Chartering", color: "#6B5CA5", description: "Contracts of affreightment, customer reviews and market planning.",
    rings: [["Contracts & COA", "#6B5CA5"], ["Market & budget", "#425B76"], ["Customer reviews", "#39978F"]] },
  { slug: "crewing", name: "Crewing", color: "#16A082", description: "Certificates, training and crew changes.",
    rings: [["Certificates & STCW", "#16A082"], ["Recruitment & training", "#39978F"], ["Crew changes", "#55BFB6"]] },
  { slug: "technical", name: "Technical", color: "#8A6D3B", description: "Class and statutory surveys, dry-docking and maintenance.",
    rings: [["Class & statutory surveys", "#8A6D3B"], ["Dry-docking", "#425B76"], ["Maintenance planning", "#39978F"]] },
  { slug: "environmental", name: "Environmental", color: "#138538", description: "EU ETS, MRV/DCS, environmental audits and reporting.",
    rings: [["EU ETS & regulatory", "#138538"], ["Audits & verification", "#16A082"], ["Reporting", "#55BFB6"]] },
  { slug: "safety", name: "Safety", color: "#C2410C", description: "Drills, ISM audits and safety training.",
    rings: [["Drills & exercises", "#C2410C"], ["ISM audits", "#425B76"], ["Training", "#39978F"]] },
  { slug: "shipbuilding", name: "Shipbuilding", color: "#425B76", description: "Newbuilding milestones and yard supervision.",
    rings: [["Newbuilding milestones", "#425B76"], ["Yard supervision", "#39978F"], ["Design reviews", "#55BFB6"]] },
  { slug: "general-management", name: "General management", color: "#26645F", description: "Board, budget cycle and management review.", gm: true,
    rings: [["Board & governance", "#26645F"], ["Budget cycle", "#16A082"], ["Management review", "#55BFB6"]] },
];

const MEMBERS: Array<[UserKey, string, "viewer" | "editor" | "admin"]> = [
  ["envdir", "environmental", "admin"],
  ["envdir", "safety", "editor"],
  ["envteam", "environmental", "editor"],
  ["crew", "crewing", "editor"],
  ["viewer", "operations", "viewer"],
  ["viewer", "environmental", "viewer"],
  ["gm", "general-management", "viewer"],
  ["super", "general-management", "admin"],
  ["super", "safety", "admin"],
];

interface SeedActivity {
  key: string;
  clock: string;
  ring: number;
  title: string;
  description?: string;
  type: "deadline" | "period" | "milestone" | "recurring_task";
  start: string;
  end?: string;
  rrule?: string;
  owner: UserKey;
  assignees?: UserKey[];
  reminders?: number[];
  predecessor?: string;
  tags?: string[];
  links?: Array<{ label: string; url: string }>;
  doneOccurrences?: string[];
}

const ACTIVITIES: SeedActivity[] = [
  // --- The EUA example (Environmental) ---
  { key: "eua-ver", clock: "environmental", ring: 1, title: "EUA verification due", type: "deadline", start: "2026-03-31", rrule: "FREQ=YEARLY",
    owner: "envdir", assignees: ["envteam"], reminders: [30, 14, 7, 1], tags: ["EU ETS", "verification"],
    description: "Verified emissions report for the previous year must be completed. Demo date — enter the actual date for your obligations.",
    doneOccurrences: ["2026-03-31"] },
  { key: "eua-sur", clock: "environmental", ring: 0, title: "EUA submission / surrender due", type: "deadline", start: "2026-09-30", rrule: "FREQ=YEARLY",
    owner: "envdir", assignees: ["envteam"], reminders: [30, 14, 7, 1], predecessor: "eua-ver", tags: ["EU ETS", "surrender"],
    description: "Surrender of allowances for verified emissions. Demo date — enter the actual date for your obligations.",
    doneOccurrences: ["2026-09-30"] },
  { key: "mrv-plan", clock: "environmental", ring: 0, title: "MRV monitoring plan review", type: "deadline", start: "2026-11-15", rrule: "FREQ=YEARLY",
    owner: "envdir", assignees: ["envteam"], tags: ["MRV"] },
  { key: "iso14001", clock: "environmental", ring: 1, title: "Internal environmental audit (ISO 14001)", type: "period", start: "2026-10-19", end: "2026-10-23",
    rrule: "FREQ=YEARLY", owner: "envteam", tags: ["ISO 14001", "audit"] },
  { key: "emis-q", clock: "environmental", ring: 2, title: "Quarterly emissions data review", type: "recurring_task", start: "2026-01-15",
    rrule: "FREQ=MONTHLY;INTERVAL=3", owner: "envteam", tags: ["emissions"] },
  // --- Technical ---
  { key: "class-annual", clock: "technical", ring: 0, title: "Class annual survey – Vessel A", type: "period", start: "2026-11-02", end: "2026-11-06",
    rrule: "FREQ=YEARLY", owner: "super", tags: ["class"] },
  { key: "drydock", clock: "technical", ring: 1, title: "Dry-docking window – Vessel B", type: "period", start: "2026-12-14", end: "2027-01-08",
    owner: "super", tags: ["dry-dock"], description: "Spans the year boundary (demo)." },
  { key: "pms", clock: "technical", ring: 2, title: "Planned maintenance system review", type: "recurring_task", start: "2026-02-10",
    rrule: "FREQ=MONTHLY;INTERVAL=3", owner: "super" },
  // --- Operations ---
  { key: "psc-prep", clock: "operations", ring: 0, title: "PSC inspection preparation campaign", type: "period", start: "2026-10-26", end: "2026-11-06",
    rrule: "FREQ=YEARLY", owner: "super", tags: ["PSC"] },
  { key: "winter", clock: "operations", ring: 1, title: "Winter navigation readiness confirmed", type: "deadline", start: "2026-11-30",
    rrule: "FREQ=YEARLY", owner: "super", tags: ["ice class"] },
  { key: "ops-kpi", clock: "operations", ring: 2, title: "Monthly fleet KPI report", type: "recurring_task", start: "2026-01-08", rrule: "FREQ=MONTHLY", owner: "super" },
  // --- Crewing ---
  { key: "stcw", clock: "crewing", ring: 0, title: "Crew certificate (STCW) expiry check", type: "recurring_task", start: "2026-01-05",
    rrule: "FREQ=MONTHLY", owner: "crew", tags: ["STCW"] },
  { key: "medicals", clock: "crewing", ring: 0, title: "Seafarer medical certificates review", type: "deadline", start: "2026-01-20",
    rrule: "FREQ=MONTHLY;INTERVAL=3", owner: "crew" },
  { key: "training-plan", clock: "crewing", ring: 1, title: "Annual crew training plan", type: "deadline", start: "2026-12-01", rrule: "FREQ=YEARLY", owner: "crew" },
  // --- Safety ---
  { key: "drill", clock: "safety", ring: 0, title: "Fire & abandon-ship drill", type: "recurring_task", start: "2026-01-10", rrule: "FREQ=MONTHLY",
    owner: "envdir", tags: ["SOLAS"] },
  { key: "ism-audit", clock: "safety", ring: 1, title: "ISM internal audit", type: "period", start: "2026-10-12", end: "2026-10-16", rrule: "FREQ=YEARLY",
    owner: "envdir", tags: ["ISM"] },
  { key: "sms-review", clock: "safety", ring: 1, title: "SMS annual review", type: "deadline", start: "2026-12-10", rrule: "FREQ=YEARLY", owner: "super" },
  { key: "lifeboat", clock: "safety", ring: 2, title: "Lifeboat inspection records uploaded", type: "deadline", start: "2026-10-05", owner: "envdir",
    description: "One-off demo item that is overdue, to show escalation." },
  // --- General management ---
  { key: "budget", clock: "general-management", ring: 1, title: "Budget preparation", type: "period", start: "2026-09-01", end: "2026-11-15",
    rrule: "FREQ=YEARLY", owner: "super", tags: ["budget"] },
  { key: "board-budget", clock: "general-management", ring: 0, title: "Board approval of budget", type: "milestone", start: "2026-12-03",
    rrule: "FREQ=YEARLY", owner: "super", predecessor: "budget" },
  { key: "mgmt-review", clock: "general-management", ring: 2, title: "Management review (ISO 9001/14001)", type: "milestone", start: "2026-01-28",
    rrule: "FREQ=YEARLY", owner: "super", doneOccurrences: ["2026-01-28"] },
  // --- Chartering ---
  { key: "coa", clock: "chartering", ring: 0, title: "COA renewal negotiations", type: "period", start: "2026-10-01", end: "2026-12-15", rrule: "FREQ=YEARLY", owner: "super" },
  { key: "csat", clock: "chartering", ring: 2, title: "Customer satisfaction survey", type: "deadline", start: "2026-05-15", rrule: "FREQ=YEARLY", owner: "super" },
  // --- Shipbuilding ---
  { key: "steel", clock: "shipbuilding", ring: 0, title: "Newbuilding steel-cutting milestone", type: "milestone", start: "2026-11-20", owner: "super" },
  { key: "yard", clock: "shipbuilding", ring: 1, title: "Yard progress review", type: "recurring_task", start: "2026-01-25", rrule: "FREQ=MONTHLY", owner: "super" },
];

async function main() {
  console.log(`Seeding demo data (demo email base: ${base})`);

  // 1) identities (auth provider) — done outside the DB transaction
  const ids = {} as Record<UserKey, string>;
  for (const u of USERS) {
    ids[u.key] = (await ensureIdentity(u.email)).id;
    console.log(`  user ${u.email} -> ${ids[u.key]}`);
  }

  await withService(async (tx: Tx) => {
    // 2) reset demo rows (cascades to rings, members, activities, logs)
    await tx.query(`delete from clocks where is_demo`);

    // 3) profiles
    for (const u of USERS) {
      await tx.query(
        `insert into profiles (id, email, full_name, global_role, all_clocks_viewer, is_active, is_demo, weekly_digest)
         values ($1, $2, $3, $4, $5, true, true, $6)
         on conflict (id) do update set email = excluded.email, full_name = excluded.full_name,
           global_role = excluded.global_role, all_clocks_viewer = excluded.all_clocks_viewer, is_active = true, is_demo = true`,
        [ids[u.key], u.email, u.name, u.global_role, u.gm, u.key === "gm" || u.key === "envdir"],
      );
    }

    // 4) clocks + rings
    const clockIds: Record<string, string> = {};
    const ringIds: Record<string, string[]> = {};
    for (const [i, c] of CLOCKS.entries()) {
      const row = await tx.one<{ id: string }>(
        `insert into clocks (name, slug, color, description, is_general_management, position, is_demo)
         values ($1, $2, $3, $4, $5, $6, true) returning id`,
        [c.name, c.slug, c.color, c.description, !!c.gm, i],
      );
      clockIds[c.slug] = row!.id;
      ringIds[c.slug] = [];
      for (const [j, [name, color]] of c.rings.entries()) {
        const r = await tx.one<{ id: string }>(
          `insert into rings (clock_id, name, color, position) values ($1, $2, $3, $4) returning id`,
          [row!.id, name, color, j],
        );
        ringIds[c.slug].push(r!.id);
      }
    }

    // 5) memberships + prefs
    for (const [user, slug, role] of MEMBERS) {
      await tx.query(`insert into clock_members (clock_id, user_id, role) values ($1, $2, $3)`, [clockIds[slug], ids[user], role]);
    }
    await tx.query(
      `insert into notification_prefs (user_id, clock_id, enabled, channels, subscribe_all) values ($1, $2, true, '{email,in_app}', true)`,
      [ids.envteam, clockIds.environmental],
    );

    // 6) activities
    const actIds: Record<string, string> = {};
    for (const a of ACTIVITIES) {
      const row = await tx.one<{ id: string }>(
        `insert into activities (clock_id, ring_id, title, description, type, start_date, end_date, rrule, owner_id,
           reminder_offsets, predecessor_id, tags, links, is_demo, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,$9,$9) returning id`,
        [
          clockIds[a.clock], ringIds[a.clock][a.ring], a.title, a.description ?? null, a.type, a.start, a.end ?? null,
          a.rrule ?? null, ids[a.owner], a.reminders ?? null, a.predecessor ? actIds[a.predecessor] : null,
          a.tags ?? [], JSON.stringify(a.links ?? []),
        ],
      );
      actIds[a.key] = row!.id;
      for (const as of a.assignees ?? []) {
        await tx.query(`insert into activity_assignees (activity_id, user_id) values ($1, $2)`, [row!.id, ids[as]]);
      }
      // Past occurrences of recurring demo items are marked done so only deliberate items are overdue.
      const today = todayInZone();
      const past = a.rrule
        ? expandOccurrences({ start_date: a.start, end_date: a.end ?? null, rrule: a.rrule }, a.start, addDays(today, -1))
            .filter((o) => (o.endDate ?? o.date) < today)
            .map((o) => o.date)
        : [];
      for (const occ of new Set([...(a.doneOccurrences ?? []), ...past])) {
        await tx.query(
          `insert into activity_occurrences_state (activity_id, occurrence_date, status, completed_at, completed_by, updated_by)
           values ($1, $2, 'done', now(), $3, $3)`,
          [row!.id, occ, ids[a.owner]],
        );
      }
    }
    console.log(`  ${CLOCKS.length} clocks, ${CLOCKS.length * 3} rings, ${ACTIVITIES.length} activities`);
  });
  await closePool();
  console.log("Done.");
}

main().catch(async (e) => {
  console.error(e);
  await closePool();
  process.exit(1);
});
