/**
 * Backwards-compatible shim. Tamper logic moved to shared/verify/tampers.ts so
 * the server-side tamper-verify route can reuse it. CLI consumers (agents/replay.ts)
 * continue to import from this file.
 */
export { TAMPERS, SCENARIO_NAMES, type Tamper, type TamperResult } from "@shared/verify/tampers";
