import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { raceWithDeadline } from "@/services/memory";

describe("memory bootstrap deadline", () => {
  it("returns null at the deadline without waiting for a slow promise", async () => {
    const startedAt = performance.now();
    const result = await raceWithDeadline(
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("late"), 100);
      }),
      10,
    );

    expect(result).toBeNull();
    expect(performance.now() - startedAt).toBeLessThan(80);
  });

  it("returns a fast promise value", async () => {
    await expect(raceWithDeadline(Promise.resolve("ready"), 100)).resolves.toBe(
      "ready",
    );
  });

  it("uses the deadline helper for bootstrap", () => {
    const source = readFileSync(resolve("src/services/memory.ts"), "utf-8");
    const start = source.indexOf("export async function bootstrapMemoryContextDetails");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(source.slice(start, start + 1800)).toContain("raceWithDeadline(");
  });
});
