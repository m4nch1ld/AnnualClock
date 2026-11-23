# CLAUDE.md

Read **[AGENTS.md](AGENTS.md)** first — it is the complete handover (product, current state,
non-negotiable rules, repo map, Azure task list, env vars, gotchas, acceptance criteria).
The step-by-step Azure build is in [docs/azure-runbook.md](docs/azure-runbook.md).

Quick commands:

```bash
npm test                                   # unit + notification + calendar tests; SQL Server RLS tests when TEST_DATABASE_URL is set (CI)
npm run typecheck
NEXT_DIST_DIR=.next-build npm run build    # build without clobbering a running dev server
npm run notify:dry-run                     # what the scheduler would send now
```

Rules in one line each: authorization is Azure SQL row-level security via `withUser()` (SESSION_CONTEXT); business logic in `/lib`
as plain TS; vendors behind interfaces in `lib/providers` / `lib/calendar`; Zod on every input;
new schema = new T-SQL migration in database/migrations with RLS predicates + tests; dates are ISO strings.
