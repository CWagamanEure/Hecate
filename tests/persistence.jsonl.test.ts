import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { appendJsonl, readJsonl } from "@shared/persistence";
import {
  PersistedIntentRecord,
  type PersistedIntentRecord as PIR
} from "@shared/schemas";

let tempDirs: string[] = [];

async function newTempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "hecate-jsonl-"));
  tempDirs.push(d);
  return d;
}

afterEach(async () => {
  for (const d of tempDirs.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
});

const sample: PIR = {
  envelope: {
    intent_id: "intent_001",
    agent_id: "0x" + "a".repeat(40),
    market: "ETH/USDC",
    expiry_ms: 1770000000000,
    payload_commitment: "0x" + "b".repeat(64),
    payload_ciphertext: "0xdeadbeef",
    nonce: "1",
    signature: ("0x" + "0".repeat(130)) as `0x${string}`
  },
  received_ms: 1700000000000
};

const NumberSchema = z.number();

describe("appendJsonl", () => {
  it("writes one canonical-JSON line ending in \\n", async () => {
    const dir = await newTempDir();
    const path = join(dir, "intents.jsonl");
    await appendJsonl(path, { b: 2, a: 1 });
    const raw = await readFile(path, "utf-8");
    expect(raw).toBe('{"a":1,"b":2}\n');
  });

  it("preserves order across multiple writes", async () => {
    const dir = await newTempDir();
    const path = join(dir, "x.jsonl");
    await appendJsonl(path, 1, NumberSchema);
    await appendJsonl(path, 2, NumberSchema);
    await appendJsonl(path, 3, NumberSchema);
    const back = await readJsonl(path, NumberSchema);
    expect(back).toEqual([1, 2, 3]);
  });

  it("schema rejection happens BEFORE write (file unchanged)", async () => {
    const dir = await newTempDir();
    const path = join(dir, "intents.jsonl");
    // Write one valid line first.
    await appendJsonl(path, sample, PersistedIntentRecord);
    const before = await readFile(path, "utf-8");
    // Now attempt to append something invalid.
    await expect(
      appendJsonl(path, { not: "a record" } as unknown as PIR, PersistedIntentRecord)
    ).rejects.toThrow();
    const after = await readFile(path, "utf-8");
    expect(after).toBe(before);
  });

  it("does not mutate the input object", async () => {
    const dir = await newTempDir();
    const path = join(dir, "intents.jsonl");
    const input = { ...sample };
    const snapshot = JSON.stringify(input);
    await appendJsonl(path, input, PersistedIntentRecord);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("readJsonl", () => {
  it("returns [] for empty file", async () => {
    const dir = await newTempDir();
    const path = join(dir, "x.jsonl");
    await writeFile(path, "", "utf-8");
    expect(await readJsonl(path, NumberSchema)).toEqual([]);
  });

  it("returns [] for missing file when allowMissing", async () => {
    const dir = await newTempDir();
    const path = join(dir, "missing.jsonl");
    expect(await readJsonl(path, NumberSchema, { allowMissing: true })).toEqual(
      []
    );
  });

  it("throws for missing file without allowMissing", async () => {
    const dir = await newTempDir();
    const path = join(dir, "missing.jsonl");
    await expect(readJsonl(path, NumberSchema)).rejects.toThrow();
  });

  it("tolerates trailing blank lines", async () => {
    const dir = await newTempDir();
    const path = join(dir, "x.jsonl");
    await writeFile(path, "1\n2\n3\n\n\n", "utf-8");
    expect(await readJsonl(path, NumberSchema)).toEqual([1, 2, 3]);
  });

  it("throws with path:line on malformed JSON", async () => {
    const dir = await newTempDir();
    const path = join(dir, "x.jsonl");
    await writeFile(path, "1\nnot-json\n3\n", "utf-8");
    await expect(readJsonl(path, NumberSchema)).rejects.toThrow(/x\.jsonl:2/);
  });

  it("throws with path:line on schema-invalid line", async () => {
    const dir = await newTempDir();
    const path = join(dir, "x.jsonl");
    await writeFile(path, "1\n\"not-a-number\"\n3\n", "utf-8");
    await expect(readJsonl(path, NumberSchema)).rejects.toThrow(/x\.jsonl:2/);
  });

  it("round-trips PersistedIntentRecord", async () => {
    const dir = await newTempDir();
    const path = join(dir, "intents.jsonl");
    await appendJsonl(path, sample, PersistedIntentRecord);
    const back = await readJsonl(path, PersistedIntentRecord);
    expect(back).toEqual([sample]);
  });
});
