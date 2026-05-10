import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 5_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["shared/**", "server/**", "agents/**"]
    }
  },
  resolve: {
    alias: {
      "@shared": r("./shared"),
      "@server": r("./server"),
      "@agents": r("./agents")
    }
  }
});
