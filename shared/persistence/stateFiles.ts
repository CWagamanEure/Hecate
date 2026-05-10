/**
 * Atomic JSON snapshot writes for mutable state files (vault.json,
 * reservations.json).
 *
 * v1 concurrency model: single-process server. Concurrent mutation from
 * multiple writers is not supported. Production would require transactional
 * storage (DB) or file locking.
 */

import { open, readFile, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { canonicalJson } from "@shared/crypto";
import { ensureParentDir } from "./paths";
import type { z } from "zod";

/**
 * Atomically write a canonical-JSON snapshot.
 *
 * Pattern: write to `${path}.${rand}.tmp`, fsync the file handle, close it,
 * rename to `path`. Same-directory rename is atomic on POSIX filesystems.
 *
 * If `schema` is provided, `value` is validated BEFORE creating any tmp file,
 * so a schema failure has zero side effects on disk.
 *
 * On any failure between tmp creation and rename, the tmp file is removed
 * (best-effort).
 */
export async function writeJsonAtomic<T>(
  path: string,
  value: T,
  schema?: z.ZodType<T>
): Promise<void> {
  if (schema) schema.parse(value);
  await ensureParentDir(path);
  const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const json = canonicalJson(value);

  let renamed = false;
  try {
    const fh = await open(tmp, "w");
    try {
      await fh.writeFile(json, "utf-8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
    renamed = true;
  } finally {
    if (!renamed) {
      // best-effort cleanup; ignore "doesn't exist" if rename already happened
      await unlink(tmp).catch(() => {});
    }
  }
}

/**
 * Read a JSON file and Zod-validate. Missing file returns `opts.fallback` iff
 * the key is present in `opts` (use {} to require the file to exist).
 *
 * Schema-invalid input always throws.
 */
export async function readJsonFile<T>(
  path: string,
  schema: z.ZodType<T>,
  opts: { fallback?: T } = {}
): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (e) {
    if (
      "fallback" in opts &&
      (e as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return opts.fallback as T;
    }
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `readJsonFile ${path}: invalid JSON (${(e as Error).message})`
    );
  }
  const r = schema.safeParse(parsed);
  if (!r.success) {
    throw new Error(
      `readJsonFile ${path}: schema invalid: ${r.error.message}`
    );
  }
  return r.data;
}
