# ESL Annual Clock (prototype)

A circular year planner ("annual clock") for ESL Shipping departments, with
reminders that reach people even when nobody opens the app.

Stack: Next.js (App Router, TypeScript strict) · Tailwind · Supabase (Auth + Postgres with RLS) ·
plain `pg` data access · Resend email · Vercel Cron. Built to migrate cheaply to Azure
(see `docs/azure-migration.md`).

> Status: under construction, phase by phase. See "Phases" below.

## Quick start (local)

Prerequisites: Node 20+ (tested on 24), a Supabase project (free tier is fine).

```bash
npm install
cp .env.example .env.local   # fill in the values (see comments in the file)
npm run db:migrate           # applies supabase/migrations/*.sql
npm run seed                 # demo clocks, users and activities (resets demo rows)
npm run dev                  # http://localhost:3000
```

With `DEMO_LOGIN_ENABLED=true` the login page lists demo users for one-click sign-in.
Otherwise enter an email of an existing user to receive a magic link.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Next.js dev server |
| `npm run db:migrate` | Apply SQL migrations (portable runner, tracks `schema_migrations`) |
| `npm run seed` | Reset and recreate demo data (rows with `is_demo = true`) |
| `npm test` | Unit + RLS tests (Vitest; RLS runs on in-process PGlite, no Docker needed) |
| `npm run typecheck` | TypeScript |

## Project layout

```
app/                 Next.js routes (UI, server actions, API routes)
components/          React components (ui/ = shadcn-style primitives)
lib/                 Framework-independent logic
  dates.ts           ISO-date helpers (UTC arithmetic, ISO weeks)
  recurrence.ts      RRULE normalisation and expansion
  domain.ts          Types, occurrence building, reminder offsets
  wheel/             Year-wheel geometry
  tokens.ts          Signed email-action tokens, ICS tokens
  db/                pg pool: withUser() (RLS) / withService()
  data/              Read queries
  providers/         AuthProvider, EmailProvider (+ Supabase / Resend impls)
  i18n/              Message catalog + locale date formatting
supabase/migrations/ Plain SQL migrations (schema, RLS, audit)
scripts/             migrate, seed, notify
tests/               Vitest (RLS tests in tests/db)
docs/                authorization.md, azure-migration.md, backlog.md
```

## Phases

1. ✅ Foundation: migrations, RLS (+tests), auth, seed, clock list, role-aware nav
2. Clock UI (wheel, list, filters)
3. Editing, recurrence, per-occurrence completion, audit
4. Notifications (scheduler, email, reminders, escalation, in-app, ICS)
5. Teams, digests, overlay, admin, import/export
6. Hardening and docs
