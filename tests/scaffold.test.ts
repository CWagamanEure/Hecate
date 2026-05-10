import { describe, it, expect } from "vitest";

describe("scaffold", () => {
  it("vitest is wired up", () => {
    expect(1 + 1).toBe(2);
  });

  it("tsconfig path aliases resolve at test time", async () => {
    const mod = await import("@shared/schemas");
    expect(mod).toBeDefined();
  });
});
