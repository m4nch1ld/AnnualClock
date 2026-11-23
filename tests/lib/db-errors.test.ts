import { describe, expect, test } from "vitest";
import { mapError } from "@/lib/db";

const err = (number: number, message: string, preceding: Array<{ number: number; message: string }> = []) =>
  Object.assign(new Error(message), { number, precedingErrors: preceding.map((p) => Object.assign(new Error(p.message), p)) });

const mapped = (e: unknown) => {
  try {
    mapError(e);
  } catch (x) {
    return x as Error & { code?: string };
  }
  throw new Error("mapError did not throw");
};

describe("SQL Server error mapping", () => {
  test("trigger THROW 50001 hidden behind 3616 is a permission error", () => {
    const m = mapped(err(3616, "An error was raised during trigger execution. The batch has been aborted…", [{ number: 50001, message: "permission denied: privileged profile columns…" }]));
    expect(m.code).toBe("42501");
    expect(m.message).toMatch(/permission denied/);
  });

  test("RLS block predicate (33504) is a permission error", () => {
    expect(mapped(err(33504, "The attempted operation failed because the target object has a block predicate…")).code).toBe("42501");
  });

  test("duplicate key hidden behind 3621 is 23505", () => {
    const m = mapped(err(3621, "The statement has been terminated.", [{ number: 2601, message: "Cannot insert duplicate key row in object…" }]));
    expect(m.code).toBe("23505");
  });

  test("foreign key vs check constraint (547) behind 3621", () => {
    expect(mapped(err(3621, "The statement has been terminated.", [{ number: 547, message: "The INSERT statement conflicted with the FOREIGN KEY constraint…" }])).code).toBe("23503");
    expect(mapped(err(3621, "The statement has been terminated.", [{ number: 547, message: "The INSERT statement conflicted with the CHECK constraint…" }])).code).toBe("23514");
  });

  test("anything else is rethrown unchanged", () => {
    const e = err(208, "Invalid object name 'x'.");
    expect(mapped(e)).toBe(e);
  });
});
