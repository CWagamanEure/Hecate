/**
 * Static asset route for the demo verifier panel.
 *
 * Serves a single HTML file at GET /. The file is read once at first request
 * and cached in memory. The panel is a thin client over /attestation,
 * /receipts/verify, and /receipts/tamper-verify; it makes no other calls.
 */

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_HTML_PATH = join(HERE, "..", "static", "panel.html");

let cachedHtml: string | null = null;

export async function staticRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async (_req, reply) => {
    if (cachedHtml === null) {
      cachedHtml = await readFile(PANEL_HTML_PATH, "utf-8");
    }
    reply.type("text/html; charset=utf-8");
    return cachedHtml;
  });
}
