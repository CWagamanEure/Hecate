/**
 * JSONL append-only logs.
 *
 * v1 concurrency model: single-process server. Concurrent appends from multiple
 * writers are not safe across all filesystems. Concurrent mutation of vault.json
 * or reservations.json from multiple writers can corrupt state. Production would
 * require transactional storage (DB) or file locking.
 *
 * No log rotation in v1. Files grow unboundedly.
 */

import { appendFile, readFile } from "node:fs/promises";
import { canonicalJson } from "@shared/crypto";
import type { z } from "zod";

/**
 * Append one canonical-JSON line to a JSONL file. If `schema` is provided,
 * `value` is validated BEFORE the write so corrupt lines never enter the log.
 * v1 callers should pass schema unless there is a specific reason not to.
 *
 * Format: each line is `canonicalJson(value) + "\n"` (LF, never CRLF).
 */
export async function appendJsonl<T>(
  path: string,
  value: T,
  schema?: z.ZodType<T>
): Promise<void> {
  if (schema) schema.parse(value);
  const line = canonicalJson(value) + "\n";
  await appendFile(path, line, "utf-8");
}

/**
 * Read and Zod-validate every line. Fails loudly on any malformed JSON or
 * schema-invalid line, with the 1-based line number in the error.
 *
 * Trailing empty lines are skipped (handles files with or without a trailing
 * newline). Missing file: returns [] iff `opts.allowMissing`, otherwise throws.
 */
export async function readJsonl<T>(
  path: string,
  schema: z.ZodType<T>,
  opts: { allowMissing?: boolean } = {}
): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (e) {
    if (
      opts.allowMissing &&
      (e as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return [];
    }
    throw e;
  }

  const lines = raw.split("\n");
  const out: T[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      throw new Error(
        `readJsonl ${path}:${i + 1}: invalid JSON (${(e as Error).message})`
      );
    }
    const r = schema.safeParse(parsed);
    if (!r.success) {
      throw new Error(
        `readJsonl ${path}:${i + 1}: schema invalid: ${r.error.message}`
      );
    }
    out.push(r.data);
  }
  return out;
}
