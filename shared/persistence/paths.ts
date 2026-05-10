import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Conventional filenames for v1 persistence. Server bootstrap composes paths
 * via `resolveDataPath(DATA_DIR, FILES.<name>)`.
 */
export const FILES = {
  intents: "intents.jsonl",
  rejections: "rejections.jsonl",
  batches: "batches.jsonl",
  receipts: "receipts.jsonl",
  vault: "vault.json",
  reservations: "reservations.json"
} as const;

export type FileKind = keyof typeof FILES;

export function resolveDataPath(dataDir: string, filename: string): string {
  return join(dataDir, filename);
}

/** Ensure the parent directory of a file path exists. Idempotent. */
export async function ensureParentDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

/** Ensure a directory itself exists. Idempotent. */
export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}
