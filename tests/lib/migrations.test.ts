import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { splitBatches } from "../../scripts/migrate";

const dir = join(process.cwd(), "database", "migrations");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

describe("migration batch splitter", () => {
  test("splits the real migration files quickly (no regex backtracking)", () => {
    for (const f of files) {
      const t0 = performance.now();
      const batches = splitBatches(readFileSync(join(dir, f), "utf8"), "annual_clock");
      expect(performance.now() - t0).toBeLessThan(200);
      expect(batches.length).toBeGreaterThan(0);
      for (const b of batches) {
        expect(b).not.toMatch(/^\s*GO\s*$/im); // GO never reaches the server
        expect(b).not.toContain("$(SCHEMA)"); // schema substituted
      }
    }
  });

  test("drops comment-only batches, keeps SQL with leading comments, survives dash rulers", () => {
    const ruler = `-- ${"-".repeat(200)}`;
    const text = `${ruler}\n-- header only\nGO\n${ruler}\n-- explains\nCREATE TABLE [$(SCHEMA)].t (id int);\nGO\n\nGO\n`;
    const t0 = performance.now();
    const batches = splitBatches(text, "s1");
    expect(performance.now() - t0).toBeLessThan(50);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toContain("CREATE TABLE [s1].t");
  });

  test("CREATE FUNCTION / TRIGGER / SECURITY POLICY each start their own batch", () => {
    for (const f of files) {
      for (const b of splitBatches(readFileSync(join(dir, f), "utf8"), "annual_clock")) {
        const sql = b
          .split("\n")
          .filter((l) => !l.trim().startsWith("--"))
          .join("\n")
          .trim();
        const creates = sql.match(/^\s*CREATE\s+(FUNCTION|TRIGGER|SECURITY POLICY|PROCEDURE|VIEW)\b/gim) ?? [];
        if (creates.length) {
          expect(creates.length, `${f}: one module per batch`).toBe(1);
          expect(sql, `${f}: module must be first statement in its batch`).toMatch(/^CREATE\s+(FUNCTION|TRIGGER|SECURITY POLICY|PROCEDURE|VIEW)\b/i);
        }
      }
    }
  });
});
