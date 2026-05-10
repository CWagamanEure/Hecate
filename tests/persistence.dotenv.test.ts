/**
 * Tests for the minimal dotenv loader. Confirms file behavior matches
 * standard dotenv semantics: shell wins over file, missing file is a
 * no-op, comments / blank lines are ignored, surrounding quotes are
 * stripped.
 */

import { afterEach, describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDotenv } from "@shared/persistence";

const TEST_KEYS = [
  "HECATE_TEST_A",
  "HECATE_TEST_B",
  "HECATE_TEST_C",
  "HECATE_TEST_D",
  "HECATE_TEST_E",
  "HECATE_TEST_F",
  "HECATE_TEST_G",
  "HECATE_TEST_SHELL_WINS"
];

afterEach(() => {
  for (const k of TEST_KEYS) delete process.env[k];
});

function tmpEnv(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "hecate-dotenv-"));
  const path = join(dir, ".env");
  writeFileSync(path, contents, "utf-8");
  return path;
}

describe("loadDotenv", () => {
  it("missing file is a silent no-op", () => {
    expect(() => loadDotenv("/tmp/definitely-does-not-exist-abc123")).not.toThrow();
  });

  it("loads basic KEY=value pairs", () => {
    const path = tmpEnv("HECATE_TEST_A=alpha\nHECATE_TEST_B=beta\n");
    loadDotenv(path);
    expect(process.env.HECATE_TEST_A).toBe("alpha");
    expect(process.env.HECATE_TEST_B).toBe("beta");
  });

  it("strips matching surrounding single and double quotes", () => {
    const path = tmpEnv(`HECATE_TEST_C="quoted double"\nHECATE_TEST_D='quoted single'\n`);
    loadDotenv(path);
    expect(process.env.HECATE_TEST_C).toBe("quoted double");
    expect(process.env.HECATE_TEST_D).toBe("quoted single");
  });

  it("ignores comments, blank lines, and lines without =", () => {
    const path = tmpEnv("# leading comment\n\nHECATE_TEST_E=present\n# tail comment\nnotakeyvalueline\n");
    loadDotenv(path);
    expect(process.env.HECATE_TEST_E).toBe("present");
  });

  it("does not override an existing process.env value (shell wins)", () => {
    process.env.HECATE_TEST_SHELL_WINS = "from-shell";
    const path = tmpEnv("HECATE_TEST_SHELL_WINS=from-file\n");
    loadDotenv(path);
    expect(process.env.HECATE_TEST_SHELL_WINS).toBe("from-shell");
  });

  it("preserves '=' inside values (e.g. URLs with query strings)", () => {
    const path = tmpEnv("HECATE_TEST_F=https://example.com/?k=v&k2=v2\n");
    loadDotenv(path);
    expect(process.env.HECATE_TEST_F).toBe("https://example.com/?k=v&k2=v2");
  });

  it("skips lines with empty keys", () => {
    const path = tmpEnv("=ignored\nHECATE_TEST_G=ok\n");
    loadDotenv(path);
    expect(process.env.HECATE_TEST_G).toBe("ok");
  });
});
