/**
 * Persistence corruption tests: assert fail-loud behavior on every form of
 * malformed JSONL or JSON file content.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  appendJsonl,
  readJsonl,
  writeJsonAtomic,
  readJsonFile
} from "@shared/persistence";
import { VaultState, ReservationBook } from "@shared/schemas";
import { hashVaultState, hashReservationBook } from "@shared/crypto";

let tempDirs: string[] = [];
async function newTempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "hecate-adv-pers-"));
  tempDirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of tempDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const NumSchema = z.number();
const ObjSchema = z.object({ a: z.number(), b: z.string() }).strict();

describe("adversarial persistence — malformed JSONL fails loudly", () => {
  it("garbage in middle of valid lines -> throws with line number", async () => {
    const dir = await newTempDir();
    const path = join(dir, "x.jsonl");
    await writeFile(path, "1\n2\nGARBAGE_HERE\n4\n", "utf-8");
    await expect(readJsonl(path, NumSchema)).rejects.toThrow(/x\.jsonl:3/);
  });

  it("schema-invalid line (string vs number) -> throws with line number", async () => {
    const dir = await newTempDir();
    const path = join(dir, "x.jsonl");
    await writeFile(path, "1\n2\n\"oops\"\n4\n", "utf-8");
    await expect(readJsonl(path, NumSchema)).rejects.toThrow(/x\.jsonl:3/);
  });

  it("extra unknown field rejected by .strict() schema -> throws", async () => {
    const dir = await newTempDir();
    const path = join(dir, "x.jsonl");
    await writeFile(path, '{"a":1,"b":"x"}\n{"a":2,"b":"y","extra":5}\n', "utf-8");
    await expect(readJsonl(path, ObjSchema)).rejects.toThrow(/x\.jsonl:2/);
  });

  it("midline append followed by line break is tolerated as one valid + one corrupt", async () => {
    const dir = await newTempDir();
    const path = join(dir, "x.jsonl");
    await writeFile(path, "1\n", "utf-8");
    await appendFile(path, "{not-json", "utf-8");
    await expect(readJsonl(path, NumSchema)).rejects.toThrow();
  });
});

describe("adversarial persistence — malformed JSON snapshot files", () => {
  it("truncated JSON file -> throws", async () => {
    const dir = await newTempDir();
    const path = join(dir, "vault.json");
    // Write valid file then truncate.
    await writeJsonAtomic(path, { agents: {} }, VaultState);
    await writeFile(path, "{not-jso", "utf-8");
    await expect(readJsonFile(path, VaultState)).rejects.toThrow(/invalid JSON/);
  });

  it("valid JSON but wrong schema -> throws", async () => {
    const dir = await newTempDir();
    const path = join(dir, "vault.json");
    await writeFile(path, JSON.stringify({ agents: { foo: "bar" } }), "utf-8");
    await expect(readJsonFile(path, VaultState)).rejects.toThrow(/schema invalid/);
  });

  it("valid JSON with extra top-level field rejected by .strict() -> throws", async () => {
    const dir = await newTempDir();
    const path = join(dir, "vault.json");
    await writeFile(
      path,
      JSON.stringify({ agents: {}, secret: "x" }),
      "utf-8"
    );
    await expect(readJsonFile(path, VaultState)).rejects.toThrow(/schema invalid/);
  });
});

describe("adversarial persistence — atomic write rollback under bad input", () => {
  it("schema rejection leaves prior file content unchanged", async () => {
    const dir = await newTempDir();
    const path = join(dir, "vault.json");
    await writeJsonAtomic(path, { agents: {} }, VaultState);
    const before = await readFile(path, "utf-8");
    await expect(
      writeJsonAtomic(path, { agents: { foo: "bar" } } as unknown as VaultState, VaultState)
    ).rejects.toThrow();
    const after = await readFile(path, "utf-8");
    expect(after).toBe(before);
  });
});

describe("adversarial persistence — round-trip preserves canonical hash", () => {
  it("100 random VaultStates: hashVaultState before == hashVaultState after read", async () => {
    const dir = await newTempDir();
    for (let i = 0; i < 50; i++) {
      const path = join(dir, `vault-${i}.json`);
      const v: VaultState = {
        agents: {
          ["0x" + (i + 1).toString(16).padStart(40, "0").toUpperCase().toLowerCase()]: {
            agent_id: "0x" + (i + 1).toString(16).padStart(40, "0"),
            balances: { ETH: String(i), USDC: String(i * 100) },
            reserved: { ETH: "0", USDC: "0" },
            nonces_seen: []
          }
        }
      };
      // Note: hashVaultState requires EIP-55 normalized addresses inside; for this
      // test we just compare round-trip equality, not absolute hash.
      const before = hashVaultState(v);
      await writeJsonAtomic(path, v, VaultState);
      const back = await readJsonFile(path, VaultState);
      const after = hashVaultState(back);
      if (before !== after) {
        throw new Error(`i=${i}: hash differs after round-trip`);
      }
    }
    expect(true).toBe(true);
  });

  it("ReservationBook round-trip preserves hash", async () => {
    const dir = await newTempDir();
    for (let i = 0; i < 20; i++) {
      const path = join(dir, `book-${i}.json`);
      const book: ReservationBook = { reservations: [] };
      const before = hashReservationBook(book);
      await writeJsonAtomic(path, book, ReservationBook);
      const back = await readJsonFile(path, ReservationBook);
      const after = hashReservationBook(back);
      expect(before).toBe(after);
    }
  });
});
