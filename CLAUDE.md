# CLAUDE.md

Read **[AGENTS.md](AGENTS.md)** first — it is the complete handover (product, current state,
non-negotiable rules, repo map, Azure task list, env vars, gotchas, acceptance criteria).
The step-by-step Azure build is in [docs/azure-runbook.md](docs/azure-runbook.md).

Quick commands:

```bash
npm test                                   # unit + notification + calendar + RLS tests (no Docker)
npm run typecheck
NEXT_DIST_DIR=.next-build npm run build    # build without clobbering a running dev server
npm run notify:dry-run                     # what the scheduler would send now
```

Rules in one line each: authorization is Postgres RLS via `withUser()`; business logic in `/lib`
as plain TS; vendors behind interfaces in `lib/providers` / `lib/calendar`; Zod on every input;
new schema = new SQL migration with RLS + tests; dates are ISO strings.
