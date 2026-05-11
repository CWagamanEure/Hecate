/**
 * Hecate end-to-end demo.
 *
 * Drives the running HTTP server through the full 4-agent flow, fetches
 * owner-gated artifacts via signed challenges, runs the cross-agent privacy
 * assertion, and self-validates against expected_outcome in each fixture.
 *
 * Critical-path side effects go through HTTP. Shared module imports are
 * limited to client-side cryptographic construction:
 *   - signEnvelope, hashPayload, mockEncryptPayload, deriveMockEnclaveKey
 *   - privateKeyToAddress, signHash, keccak256Hex, canonicalJson
 *   - the FILES filename constants for --reset-demo-state
 *
 * No matcher / settlement / receipt / verify / vault / persistence-mutation
 * imports.
 */

import { readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  signEnvelope,
  hashPayload,
  mockEncryptPayload,
  deriveMockEnclaveKey,
  privateKeyToAddress,
  signHash,
  keccak256Hex,
  canonicalJson
} from "@shared/crypto";
import { FILES } from "@shared/persistence";
import {
  AgentFixture,
  type AgentExpectedOutcome
} from "./types";
import { loadDemoWallets, type DemoWalletFile } from "./demoWallets";
import type {
  PrivatePayload,
  PublicEnvelope,
  PublicEnvelopeUnsigned,
  Hex32,
  Hex65,
  HexAddress,
  HexBytes,
  FillReceipt
} from "@shared/schemas";

const FIXTURE_FILES = [
  "agentA.json",
  "agentB.json",
  "agentC.json",
  "agentD.json"
] as const;

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(HERE, "examples");

export type RunDemoOptions = {
  baseUrl: string;
  codeDigest: string;
  reset: boolean;
  dataDir: string | undefined;
  verbose: boolean;
  saveBundle: string | undefined;
  allowDigestMismatch: boolean;
  includeFailureFixture: boolean;
  includeAdversary: boolean;
  /**
   * If true, the canonical 4-agent fixtures (A/B/C/D) get their
   * `private_key` replaced with the corresponding wallet from
   * `.demo-wallets.json`. Failure / adversary fixtures keep their
   * hardcoded dev keys. Use this for Sepolia demos where the engine
   * needs to see intents signed by real on-chain addresses; leave it
   * false (the default) for local-only / CI / soak runs that don't
   * care about real wallets.
   */
  useDemoWallets: boolean;
};

export type RunDemoResult = { ok: true } | { ok: false; error: string };

class DemoMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoMismatch";
  }
}

// ---- HTTP helpers ----------------------------------------------------------

async function fetchJson(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const r = await safeFetch(baseUrl, method, path, body);
  if (r.status >= 400) {
    throw new Error(
      `HTTP ${r.status} ${method} ${path}: ${JSON.stringify(r.body)}`
    );
  }
  return r.body;
}

async function fetchJsonNoThrow(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: any }> {
  return safeFetch(baseUrl, method, path, body);
}

async function safeFetch(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: any }> {
  let res: Response;
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  try {
    res = await fetch(baseUrl + path, init);
  } catch (e) {
    throw new Error(
      `could not reach Hecate server at ${baseUrl} (${(e as Error).message}). Is \`npm run dev\` running?`
    );
  }
  const text = await res.text();
  let parsed: any = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed };
}

// ---- challenge signing -----------------------------------------------------

function signChallenge(
  action: "GET_FILL_RECEIPT" | "GET_INTENT_STATUS",
  intent_id: string,
  pk: Hex32
): { requester: HexAddress; timestamp_ms: number; signature: Hex65 } {
  const ts = Date.now();
  const json = canonicalJson({
    action,
    intent_id,
    timestamp_ms: ts
  });
  const hash = keccak256Hex(json);
  return {
    requester: privateKeyToAddress(pk),
    timestamp_ms: ts,
    signature: signHash(hash, pk)
  };
}

// ---- fixture loading -------------------------------------------------------

const CANONICAL_FIXTURE_SLOT: Record<
  (typeof FIXTURE_FILES)[number],
  "A" | "B" | "C" | "D"
> = {
  "agentA.json": "A",
  "agentB.json": "B",
  "agentC.json": "C",
  "agentD.json": "D"
};

/**
 * Pure helper: take an array of canonical fixtures (parsed from
 * `agents/examples/agent[A-D].json` in fixture-file order) and a wallet
 * file, return a new array where each fixture's `private_key` is replaced
 * by the matching wallet's pk. Failure / adversary fixtures are not
 * touched by this function.
 *
 * Exported so the wallet-injection logic can be tested without a server
 * or filesystem state.
 */
export function injectDemoWalletsIntoFixtures(
  fixturesInFileOrder: AgentFixture[],
  wallets: DemoWalletFile
): AgentFixture[] {
  if (fixturesInFileOrder.length !== FIXTURE_FILES.length) {
    throw new Error(
      `injectDemoWalletsIntoFixtures: expected ${FIXTURE_FILES.length} fixtures, got ${fixturesInFileOrder.length}`
    );
  }
  return fixturesInFileOrder.map((fx, i) => {
    const file = FIXTURE_FILES[i]!;
    const slot = CANONICAL_FIXTURE_SLOT[file];
    return { ...fx, private_key: wallets[slot].pk };
  });
}

async function loadFixtures(opts?: { useDemoWallets?: boolean }): Promise<AgentFixture[]> {
  const out: AgentFixture[] = [];
  for (const f of FIXTURE_FILES) {
    const raw = await readFile(join(FIXTURE_DIR, f), "utf-8");
    const parsed = AgentFixture.parse(JSON.parse(raw));
    out.push(parsed);
  }
  if (opts?.useDemoWallets) {
    const wallets = await loadDemoWallets();
    return injectDemoWalletsIntoFixtures(out, wallets);
  }
  return out;
}

const FAILURE_FIXTURE_FILES = [
  "agentE-fail.json",
  "agentF-fail.json",
  "agentG-fail.json"
] as const;

async function loadFailureFixtures(): Promise<AgentFixture[]> {
  const out: AgentFixture[] = [];
  for (const f of FAILURE_FIXTURE_FILES) {
    const raw = await readFile(join(FIXTURE_DIR, f), "utf-8");
    out.push(AgentFixture.parse(JSON.parse(raw)));
  }
  return out;
}

const ADVERSARY_FIXTURE_FILES = [
  "adv-alice.json",
  "adv-mallory.json"
] as const;

async function loadAdversaryFixtures(): Promise<[AgentFixture, AgentFixture]> {
  const out: AgentFixture[] = [];
  for (const f of ADVERSARY_FIXTURE_FILES) {
    const raw = await readFile(join(FIXTURE_DIR, f), "utf-8");
    out.push(AgentFixture.parse(JSON.parse(raw)));
  }
  return [out[0]!, out[1]!];
}

// ---- output helpers --------------------------------------------------------

function header(text: string): void {
  const bar = "============================================================";
  console.log(`\n${bar}\n${text}\n${bar}`);
}
function section(title: string): void {
  console.log(`\n${title}:`);
}
function ok(msg: string): void {
  console.log(`  ✓ ${msg}`);
}
function bad(msg: string): void {
  console.log(`  × ${msg}`);
}
function info(msg: string): void {
  console.log(`  ${msg}`);
}

// ---- reset -----------------------------------------------------------------

async function resetDemoState(dataDir: string): Promise<void> {
  const files: string[] = [
    FILES.intents,
    FILES.rejections,
    FILES.batches,
    FILES.receipts,
    FILES.vault,
    FILES.reservations
  ];
  for (const f of files) {
    await rm(join(dataDir, f), { force: true });
  }
}

// ---- core flow -------------------------------------------------------------

type Submission = {
  fixture: AgentFixture;
  agent_id: HexAddress;
  intent_id: string;
  payload: PrivatePayload;
  envelope: PublicEnvelope;
  response: { status: number; body: any };
};

export async function runDemo(opts: RunDemoOptions): Promise<RunDemoResult> {
  try {
    header(
      "Hecate demo\nLOCAL_MOCK demo only. No real funds. Mock encryption is architectural, not confidentiality."
    );

    if (opts.reset) {
      if (!opts.dataDir) {
        throw new DemoMismatch("--reset-demo-state requires --data-dir");
      }
      await resetDemoState(opts.dataDir);
      info(`reset demo state in ${opts.dataDir}`);
    } else if (opts.useDemoWallets) {
      // State-mixing UX trap: vault.json keys are agent addresses. If a
      // previous run used dev keys in this data dir, those entries are
      // orphaned when we switch to wallet addresses, and the new agents
      // start with empty balances. Warn explicitly so the user knows to
      // re-run with --reset-demo-state if they see INSUFFICIENT_FUNDS.
      console.log(
        "\n  ! --use-demo-wallets without --reset-demo-state: any existing\n" +
        "    vault state in --data-dir is keyed by the previous run's agent\n" +
        "    addresses. Pass --reset-demo-state --data-dir <path> on a fresh\n" +
        "    run if you see INSUFFICIENT_FUNDS for canonical agents."
      );
    }

    // Attestation.
    const att = (await fetchJson(opts.baseUrl, "GET", "/attestation")) as {
      runtime: { runtime_mode: string; engine_code_digest: string };
      engine_address: HexAddress;
      matching_rule: string;
      markets: string[];
      warning: string | null;
      signer: { mode: string; note: string };
    };
    section("Attestation");
    info(`runtime_mode:       ${att.runtime.runtime_mode}`);
    info(`engine_address:     ${att.engine_address}`);
    info(`engine_code_digest: ${att.runtime.engine_code_digest}`);
    info(`signer.mode:        ${att.signer.mode}`);
    info(`matching_rule:      ${att.matching_rule}`);
    info(`market:             ${att.markets.join(", ")}`);
    if (att.warning) info(`warning:            ${att.warning}`);

    if (att.runtime.engine_code_digest !== opts.codeDigest) {
      if (!opts.allowDigestMismatch) {
        throw new DemoMismatch(
          `simulator --code-digest=${opts.codeDigest} != server engine_code_digest=${att.runtime.engine_code_digest}; ` +
            `payload encryption keys will not agree (every intent would reject as MALFORMED_PAYLOAD). ` +
            `Re-run with --code-digest ${att.runtime.engine_code_digest}, or pass --allow-digest-mismatch to override.`
        );
      }
      console.log(
        `\n  ! code-digest mismatch (server=${att.runtime.engine_code_digest}, simulator=${opts.codeDigest})`
      );
      console.log(
        `  ! --allow-digest-mismatch was set; continuing — expect MALFORMED_PAYLOAD rejections`
      );
    }

    // Load fixtures.
    const fixtures = await loadFixtures({ useDemoWallets: opts.useDemoWallets });

    // Stale-state warning.
    let stale = false;
    for (const fx of fixtures) {
      const addr = privateKeyToAddress(fx.private_key);
      const r = (await fetchJson(
        opts.baseUrl,
        "GET",
        `/vault/${addr}`
      )) as { vault: { balances: { ETH: string; USDC: string } } };
      if (
        r.vault.balances.ETH !== "0" ||
        r.vault.balances.USDC !== "0"
      ) {
        stale = true;
      }
    }
    if (stale) {
      console.log(
        "\n  ! Existing demo balances detected. The simulator's --reset-demo-state only"
      );
      console.log(
        "    deletes disk files; if the server is still running with the previous in-memory"
      );
      console.log(
        "    state, balances will accumulate. Restart `npm run dev` for a fully fresh run."
      );
    }

    // Deposits.
    section("Deposits");
    for (const fx of fixtures) {
      const addr = privateKeyToAddress(fx.private_key);
      for (const dep of fx.deposits) {
        await fetchJson(opts.baseUrl, "POST", "/vault/mock-deposit", {
          agent_id: addr,
          asset: dep.asset,
          amount: dep.amount
        });
      }
      ok(
        `deposited ${fx.deposits
          .map((d) => `${d.amount} ${d.asset}`)
          .join(", ")} for ${fx.name} (${addr})`
      );
    }

    // Submit intents.
    section("Intent submissions");
    const enclaveKey = deriveMockEnclaveKey(opts.codeDigest);
    const submissions: Submission[] = [];
    const runId = Date.now();

    for (const [i, fx] of fixtures.entries()) {
      const addr = privateKeyToAddress(fx.private_key);
      const intent_id = `intent_${fx.name.replace(/\s+/g, "_")}_${runId}_${i}`;
      const nonce = `${runId}_${i}`;
      const payload: PrivatePayload = { ...fx.intent, nonce };
      const ciphertext: HexBytes = mockEncryptPayload(payload, enclaveKey);
      const unsigned: PublicEnvelopeUnsigned = {
        intent_id,
        agent_id: addr,
        market: "ETH/USDC",
        expiry_ms: Date.now() + 5 * 60_000,
        payload_commitment: hashPayload(payload),
        payload_ciphertext: ciphertext,
        nonce
      };
      const envelope = signEnvelope(unsigned, fx.private_key);
      const r = await fetchJsonNoThrow(opts.baseUrl, "POST", "/intents", envelope);
      submissions.push({
        fixture: fx,
        agent_id: addr,
        intent_id,
        payload,
        envelope,
        response: r
      });

      if (r.status === 200 && r.body?.ok) {
        ok(`${fx.name} accepted (intent_id=${intent_id})`);
      } else {
        bad(
          `${fx.name} rejected: ${r.body?.error?.code} ${r.body?.error?.detail ?? ""}`
        );
      }
    }

    // Self-validate accepted/rejected against expected_outcome.
    for (const sub of submissions) {
      const accepted = sub.response.status === 200 && sub.response.body?.ok === true;
      const exp = sub.fixture.expected_outcome;
      if (accepted !== exp.accepted) {
        throw new DemoMismatch(
          `${sub.fixture.name}: expected accepted=${exp.accepted}, got ${accepted}`
        );
      }
      if (!accepted && exp.reject_reason !== sub.response.body?.error?.code) {
        throw new DemoMismatch(
          `${sub.fixture.name}: expected reject_reason=${exp.reject_reason}, got ${sub.response.body?.error?.code}`
        );
      }
    }

    // Close batch.
    const close = (await fetchJson(opts.baseUrl, "POST", "/batches/close", {
      batch_id: `batch_${runId}`
    })) as {
      ok: boolean;
      closed: boolean;
      batch_receipt: { batch_id: string; clearing_price: string; num_matched: number };
      fill_receipts: FillReceipt[];
      batch: unknown;
      fill_plan: unknown;
      settlement: unknown;
      vault_state_before_settlement: unknown;
      vault_state_after_settlement: unknown;
      reservation_book_before_settlement: unknown;
      reservation_book_after_settlement: unknown;
    };
    section("Batch close");
    if (!close.closed) {
      throw new DemoMismatch("expected batch.closed=true");
    }
    ok(
      `batch closed: clearing_price=${close.batch_receipt.clearing_price}, num_matched=${close.batch_receipt.num_matched}`
    );
    for (const fr of close.fill_receipts) {
      info(
        `${fr.intent_id} ${fr.status} filled_base=${fr.filled_base} reserved_released=${JSON.stringify(fr.reserved_released)}`
      );
    }

    // Build the verify payload (matches VerifyFullBatchRequest shape).
    const verifyPayload = {
      batchReceipt: close.batch_receipt,
      fillReceipts: close.fill_receipts,
      batch: close.batch,
      fillPlan: close.fill_plan,
      settlement: close.settlement,
      vaultStateBeforeSettlement: close.vault_state_before_settlement,
      vaultStateAfterSettlement: close.vault_state_after_settlement,
      reservationBookBeforeSettlement: close.reservation_book_before_settlement,
      reservationBookAfterSettlement: close.reservation_book_after_settlement,
      expectedEngineAddress: att.engine_address
    };

    // bundle_id = keccak256(canonicalJson(verifyPayload)). Stable across runs of
    // the same bundle; lets a presenter say a short hash aloud and have an
    // audience member verify the same artifact independently.
    const bundle_id = keccak256Hex(canonicalJson(verifyPayload));
    info(`bundle_id:        ${bundle_id}`);

    // Optionally save the bundle to disk for replay-CLI consumption.
    if (opts.saveBundle) {
      await mkdir(dirname(opts.saveBundle), { recursive: true });
      await writeFile(opts.saveBundle, JSON.stringify(verifyPayload, null, 2), "utf-8");
      // Sibling .id.txt so a verifier can compare the bundle_id without
      // recomputing canonical JSON. Bundle JSON shape is unchanged.
      await writeFile(`${opts.saveBundle}.id.txt`, bundle_id + "\n", "utf-8");
      info(`saved bundle to ${opts.saveBundle}`);
    }

    // Verify the bundle.
    section("Verification");
    const verify = (await fetchJson(
      opts.baseUrl,
      "POST",
      "/receipts/verify",
      verifyPayload
    )) as { ok: boolean; failures?: unknown[] };
    if (!verify.ok) {
      throw new DemoMismatch(
        `verify failed: ${JSON.stringify(verify.failures)}`
      );
    }
    ok("full-bundle verification: ok");

    // Per-agent fill receipts via signed challenge + status check.
    section("Owner-gated access");
    const acceptedSubs = submissions.filter(
      (s) => s.response.status === 200 && s.response.body?.ok === true
    );
    const fillReceiptByIntent = new Map<string, FillReceipt>(
      close.fill_receipts.map((fr) => [fr.intent_id, fr])
    );

    for (const sub of acceptedSubs) {
      const challenge = signChallenge(
        "GET_FILL_RECEIPT",
        sub.intent_id,
        sub.fixture.private_key
      );
      const r = (await fetchJson(
        opts.baseUrl,
        "POST",
        `/intents/${sub.intent_id}/fill-receipt`,
        challenge
      )) as { ok: boolean; fill_receipt: FillReceipt };
      if (!r.ok || r.fill_receipt.intent_id !== sub.intent_id) {
        throw new DemoMismatch(
          `${sub.fixture.name}: owner fetch returned wrong receipt`
        );
      }
      ok(`${sub.fixture.name} fetched their own fill receipt`);

      // Also probe owner-gated status.
      const statusChallenge = signChallenge(
        "GET_INTENT_STATUS",
        sub.intent_id,
        sub.fixture.private_key
      );
      const sr = (await fetchJson(
        opts.baseUrl,
        "POST",
        `/intents/${sub.intent_id}/status`,
        statusChallenge
      )) as { ok: boolean; status: string };
      const fr = fillReceiptByIntent.get(sub.intent_id)!;
      if (sr.status !== fr.status) {
        throw new DemoMismatch(
          `${sub.fixture.name}: GET_INTENT_STATUS returned ${sr.status}, fill receipt says ${fr.status}`
        );
      }
      ok(`${sub.fixture.name} status (${sr.status}) matches fill receipt`);
    }

    // Cross-agent privacy assertions. Three distinct rejection paths exercise
    // the three independent guards in server/auth.ts: (1) recovered-signer ==
    // requester, (2) action+intent_id binding via the canonical-JSON preimage,
    // (3) ±60s freshness window.
    if (acceptedSubs.length >= 2) {
      const victim = acceptedSubs[0]!;
      const attacker = acceptedSubs[1]!;

      // (1) Wrong owner: attacker signs a valid GET_FILL_RECEIPT challenge for
      // victim's intent. Recovered signer != receipt owner -> NOT_RECEIPT_OWNER.
      const wrongOwnerChallenge = signChallenge(
        "GET_FILL_RECEIPT",
        victim.intent_id,
        attacker.fixture.private_key
      );
      const r1 = await fetchJsonNoThrow(
        opts.baseUrl,
        "POST",
        `/intents/${victim.intent_id}/fill-receipt`,
        wrongOwnerChallenge
      );
      if (r1.status !== 403 || r1.body?.error?.code !== "NOT_RECEIPT_OWNER") {
        throw new DemoMismatch(
          `expected wrong-owner -> 403 NOT_RECEIPT_OWNER, got ${r1.status} ${r1.body?.error?.code}`
        );
      }
      ok(
        `cross-agent fetch correctly rejected (${attacker.fixture.name} -> ${victim.fixture.name}'s receipt) -> NOT_RECEIPT_OWNER`
      );

      // (2) Wrong action: attacker signs a GET_INTENT_STATUS challenge but
      // submits it to /fill-receipt. The verifier hashes with action=
      // GET_FILL_RECEIPT, recovery yields a different address, so the request
      // is rejected as INVALID_REQUEST_SIGNATURE.
      const wrongActionChallenge = signChallenge(
        "GET_INTENT_STATUS",
        victim.intent_id,
        attacker.fixture.private_key
      );
      const r2 = await fetchJsonNoThrow(
        opts.baseUrl,
        "POST",
        `/intents/${victim.intent_id}/fill-receipt`,
        wrongActionChallenge
      );
      if (r2.status !== 401 || r2.body?.error?.code !== "INVALID_REQUEST_SIGNATURE") {
        throw new DemoMismatch(
          `expected wrong-action -> 401 INVALID_REQUEST_SIGNATURE, got ${r2.status} ${r2.body?.error?.code}`
        );
      }
      ok(
        `wrong-action challenge correctly rejected (GET_INTENT_STATUS sig replayed at /fill-receipt) -> INVALID_REQUEST_SIGNATURE`
      );

      // (3) Stale timestamp: attacker signs a fresh-looking but 90s-old
      // challenge as themselves for their own intent. The freshness window is
      // ±60s, so the server rejects with STALE_REQUEST before even attempting
      // signature recovery against the receipt owner.
      const ownIntentId = attacker.intent_id;
      const staleTs = Date.now() - 90_000;
      const staleJson = canonicalJson({
        action: "GET_FILL_RECEIPT",
        intent_id: ownIntentId,
        timestamp_ms: staleTs
      });
      const staleHash = keccak256Hex(staleJson);
      const staleChallenge = {
        requester: privateKeyToAddress(attacker.fixture.private_key),
        timestamp_ms: staleTs,
        signature: signHash(staleHash, attacker.fixture.private_key)
      };
      const r3 = await fetchJsonNoThrow(
        opts.baseUrl,
        "POST",
        `/intents/${ownIntentId}/fill-receipt`,
        staleChallenge
      );
      if (r3.status !== 401 || r3.body?.error?.code !== "STALE_REQUEST") {
        throw new DemoMismatch(
          `expected stale-timestamp -> 401 STALE_REQUEST, got ${r3.status} ${r3.body?.error?.code}`
        );
      }
      ok(
        `stale-timestamp challenge correctly rejected (90s-old signed challenge) -> STALE_REQUEST`
      );
    }

    // Final balances + per-agent expected_outcome cross-check.
    section("Final balances");
    for (const fx of fixtures) {
      const addr = privateKeyToAddress(fx.private_key);
      const r = (await fetchJson(
        opts.baseUrl,
        "GET",
        `/vault/${addr}`
      )) as { vault: { balances: { ETH: string; USDC: string } } };
      info(
        `${fx.name}: ETH=${r.vault.balances.ETH}, USDC=${r.vault.balances.USDC}`
      );
      assertExpectedBalances(fx.name, r.vault.balances, fx.expected_outcome);
    }

    // Final fill receipt status / filled_base check for accepted intents.
    for (const sub of acceptedSubs) {
      const fr = fillReceiptByIntent.get(sub.intent_id);
      const exp = sub.fixture.expected_outcome;
      if (!fr) {
        throw new DemoMismatch(
          `${sub.fixture.name}: no fill receipt for accepted intent`
        );
      }
      if (exp.final_status !== null && fr.status !== exp.final_status) {
        throw new DemoMismatch(
          `${sub.fixture.name}: expected status=${exp.final_status}, got ${fr.status}`
        );
      }
      if (exp.final_filled_base !== null && fr.filled_base !== exp.final_filled_base) {
        throw new DemoMismatch(
          `${sub.fixture.name}: expected filled_base=${exp.final_filled_base}, got ${fr.filled_base}`
        );
      }
    }

    if (opts.includeFailureFixture) {
      await runFailureModeBatch({
        baseUrl: opts.baseUrl,
        enclaveKey,
        engineAddress: att.engine_address,
        runId
      });
    }

    if (opts.includeAdversary) {
      await runAdversaryBatch({
        baseUrl: opts.baseUrl,
        enclaveKey,
        engineAddress: att.engine_address,
        runId
      });
    }

    console.log("\n✓ demo complete: every expected outcome matched\n");
    return { ok: true };
  } catch (e) {
    const msg = (e as Error).message;
    console.log(`\n× ${msg}\n`);
    return { ok: false, error: msg };
  }
}

/**
 * Optional failure-mode batch. Runs after the canonical demo. Three new
 * fixtures (E, F, G) are designed to mix MIN_FILL_NOT_MET (when the
 * matcher's allocation can't satisfy an active intent's min) with
 * INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT (when an intent's limit doesn't
 * cross any candidate price).
 *
 * The batch closes successfully — the matcher correctly refused to match —
 * and the resulting bundle still verifies. The point is to demonstrate the
 * engine's per-intent failure-reason discrimination, not engine misbehavior.
 */
async function runFailureModeBatch(args: {
  baseUrl: string;
  enclaveKey: Uint8Array;
  engineAddress: HexAddress;
  runId: number;
}): Promise<void> {
  const { baseUrl, enclaveKey, engineAddress, runId } = args;
  const fixtures = await loadFailureFixtures();

  section("Failure-mode batch (optional)");
  info(
    "three fixtures crafted to exercise the matcher's per-intent unfilled-reason discrimination"
  );

  // Deposits.
  for (const fx of fixtures) {
    const addr = privateKeyToAddress(fx.private_key);
    for (const dep of fx.deposits) {
      await fetchJson(baseUrl, "POST", "/vault/mock-deposit", {
        agent_id: addr,
        asset: dep.asset,
        amount: dep.amount
      });
    }
    ok(
      `deposited ${fx.deposits
        .map((d) => `${d.amount} ${d.asset}`)
        .join(", ")} for ${fx.name} (${addr})`
    );
  }

  // Submissions.
  const submissions: Submission[] = [];
  for (const [i, fx] of fixtures.entries()) {
    const addr = privateKeyToAddress(fx.private_key);
    const intent_id = `intent_${fx.name.replace(/[^A-Za-z0-9_-]/g, "_")}_${runId}_${i}`;
    const nonce = `${runId}_fail_${i}`;
    const payload: PrivatePayload = { ...fx.intent, nonce };
    const ciphertext: HexBytes = mockEncryptPayload(payload, enclaveKey);
    const unsigned: PublicEnvelopeUnsigned = {
      intent_id,
      agent_id: addr,
      market: "ETH/USDC",
      expiry_ms: Date.now() + 5 * 60_000,
      payload_commitment: hashPayload(payload),
      payload_ciphertext: ciphertext,
      nonce
    };
    const envelope = signEnvelope(unsigned, fx.private_key);
    const r = await fetchJsonNoThrow(baseUrl, "POST", "/intents", envelope);
    submissions.push({
      fixture: fx,
      agent_id: addr,
      intent_id,
      payload,
      envelope,
      response: r
    });
    if (r.status !== 200 || r.body?.ok !== true) {
      throw new DemoMismatch(
        `failure-mode: ${fx.name} expected accepted, got ${r.status} ${r.body?.error?.code}`
      );
    }
    ok(`${fx.name} accepted (intent_id=${intent_id})`);
  }

  // Close the failure-mode batch.
  const close = (await fetchJson(baseUrl, "POST", "/batches/close", {
    batch_id: `batch_${runId}_failure`
  })) as {
    ok: boolean;
    closed: boolean;
    batch_receipt: {
      batch_id: string;
      clearing_price: string;
      num_matched: number;
    };
    fill_receipts: FillReceipt[];
    batch: unknown;
    fill_plan: unknown;
    settlement: unknown;
    vault_state_before_settlement: unknown;
    vault_state_after_settlement: unknown;
    reservation_book_before_settlement: unknown;
    reservation_book_after_settlement: unknown;
  };
  if (!close.closed) {
    throw new DemoMismatch("failure-mode: expected batch.closed=true");
  }
  ok(
    `failure-mode batch closed: clearing_price=${close.batch_receipt.clearing_price}, num_matched=${close.batch_receipt.num_matched}`
  );
  if (close.batch_receipt.num_matched !== 0) {
    throw new DemoMismatch(
      `failure-mode: expected num_matched=0, got ${close.batch_receipt.num_matched}`
    );
  }

  const frByIntent = new Map<string, FillReceipt>(
    close.fill_receipts.map((fr) => [fr.intent_id, fr])
  );
  for (const sub of submissions) {
    const fr = frByIntent.get(sub.intent_id);
    if (!fr) {
      throw new DemoMismatch(
        `failure-mode: ${sub.fixture.name}: no fill receipt`
      );
    }
    const exp = sub.fixture.expected_outcome;
    if (exp.final_status !== null && fr.status !== exp.final_status) {
      throw new DemoMismatch(
        `failure-mode: ${sub.fixture.name}: expected status=${exp.final_status}, got ${fr.status}`
      );
    }
    if (exp.final_filled_base !== null && fr.filled_base !== exp.final_filled_base) {
      throw new DemoMismatch(
        `failure-mode: ${sub.fixture.name}: expected filled_base=${exp.final_filled_base}, got ${fr.filled_base}`
      );
    }
    if (
      exp.expected_unfilled_reason !== undefined &&
      exp.expected_unfilled_reason !== null &&
      fr.unfilled_reason !== exp.expected_unfilled_reason
    ) {
      throw new DemoMismatch(
        `failure-mode: ${sub.fixture.name}: expected unfilled_reason=${exp.expected_unfilled_reason}, got ${fr.unfilled_reason}`
      );
    }
    info(
      `${sub.intent_id} ${fr.status} unfilled_reason=${fr.unfilled_reason}`
    );
  }

  // Verify the failure-mode bundle. A correctly-failed batch still produces a
  // signed receipt that verifies — the integrity story is independent of the
  // matcher's match/no-match verdict.
  const verifyPayload = {
    batchReceipt: close.batch_receipt,
    fillReceipts: close.fill_receipts,
    batch: close.batch,
    fillPlan: close.fill_plan,
    settlement: close.settlement,
    vaultStateBeforeSettlement: close.vault_state_before_settlement,
    vaultStateAfterSettlement: close.vault_state_after_settlement,
    reservationBookBeforeSettlement: close.reservation_book_before_settlement,
    reservationBookAfterSettlement: close.reservation_book_after_settlement,
    expectedEngineAddress: engineAddress
  };
  const verify = (await fetchJson(
    baseUrl,
    "POST",
    "/receipts/verify",
    verifyPayload
  )) as { ok: boolean; failures?: unknown[]; bundle_id: string };
  if (!verify.ok) {
    throw new DemoMismatch(
      `failure-mode bundle verification failed: ${JSON.stringify(verify.failures)}`
    );
  }
  ok(`failure-mode bundle verified (bundle_id=${verify.bundle_id})`);

  // Final-balance assertions: reservations were RELEASED on a failed batch,
  // so every fixture's balances should equal exactly what they deposited.
  section("Failure-mode final balances");
  for (const fx of fixtures) {
    const addr = privateKeyToAddress(fx.private_key);
    const r = (await fetchJson(baseUrl, "GET", `/vault/${addr}`)) as {
      vault: { balances: { ETH: string; USDC: string } };
    };
    info(
      `${fx.name}: ETH=${r.vault.balances.ETH}, USDC=${r.vault.balances.USDC}`
    );
    assertExpectedBalances(fx.name, r.vault.balances, fx.expected_outcome);
  }
}

/**
 * Optional adversary segment. Runs after the canonical demo (and after the
 * failure-mode batch if --include-failure-fixture is also set). Two new
 * fixtures cross cleanly in their own batch: Alice (SELL 2 ETH @ 3580) and
 * Mallory (BUY 2 ETH @ 3600). After settlement, Mallory plays the matched-
 * counterparty adversary role from THREAT_MODEL §5.3:
 *
 *   ✓ reads her own fill receipt              (matched participant access)
 *   ✓ reads the public batch receipt          (aggregate public info)
 *   ✗ tries to read Alice's fill receipt      → NOT_RECEIPT_OWNER
 *   ✗ tries to read Alice's intent status     → NOT_INTENT_OWNER
 *   ✗ tries to submit an envelope forged with agent_id=Alice
 *                                              → INVALID_SIGNATURE (at submission)
 *   ✗ tampers the `requester` field of an otherwise-valid challenge
 *                                              → INVALID_REQUEST_SIGNATURE
 */
async function runAdversaryBatch(args: {
  baseUrl: string;
  enclaveKey: Uint8Array;
  engineAddress: HexAddress;
  runId: number;
}): Promise<void> {
  const { baseUrl, enclaveKey, engineAddress, runId } = args;
  const [alice, mallory] = await loadAdversaryFixtures();

  section("Adversary scenarios (optional)");
  info(
    "isolated batch between Alice (victim) and Mallory (matched counterparty, THREAT_MODEL §5.3)"
  );

  // Deposits.
  for (const fx of [alice, mallory]) {
    const addr = privateKeyToAddress(fx.private_key);
    for (const dep of fx.deposits) {
      await fetchJson(baseUrl, "POST", "/vault/mock-deposit", {
        agent_id: addr,
        asset: dep.asset,
        amount: dep.amount
      });
    }
    ok(
      `deposited ${fx.deposits.map((d) => `${d.amount} ${d.asset}`).join(", ")} for ${fx.name} (${addr})`
    );
  }

  // Submissions: Alice first, then Mallory. Both legitimate.
  const subs: Array<{
    fx: AgentFixture;
    addr: HexAddress;
    intent_id: string;
    nonce: string;
  }> = [];
  for (const [i, fx] of [alice, mallory].entries()) {
    const addr = privateKeyToAddress(fx.private_key);
    const intent_id = `intent_adv_${fx.name.startsWith("Alice") ? "alice" : "mallory"}_${runId}`;
    const nonce = `${runId}_adv_${i}`;
    const payload: PrivatePayload = { ...fx.intent, nonce };
    const ciphertext: HexBytes = mockEncryptPayload(payload, enclaveKey);
    const unsigned: PublicEnvelopeUnsigned = {
      intent_id,
      agent_id: addr,
      market: "ETH/USDC",
      expiry_ms: Date.now() + 5 * 60_000,
      payload_commitment: hashPayload(payload),
      payload_ciphertext: ciphertext,
      nonce
    };
    const envelope = signEnvelope(unsigned, fx.private_key);
    const r = await fetchJsonNoThrow(baseUrl, "POST", "/intents", envelope);
    if (r.status !== 200 || r.body?.ok !== true) {
      throw new DemoMismatch(
        `adversary: ${fx.name} expected accepted, got ${r.status} ${r.body?.error?.code}`
      );
    }
    ok(`${fx.name} accepted (intent_id=${intent_id})`);
    subs.push({ fx, addr, intent_id, nonce });
  }
  const [aliceSub, mallorySub] = subs as [(typeof subs)[0], (typeof subs)[0]];

  // Close the adversary batch.
  const batch_id = `batch_${runId}_adversary`;
  const close = (await fetchJson(baseUrl, "POST", "/batches/close", {
    batch_id
  })) as {
    ok: boolean;
    closed: boolean;
    batch_receipt: {
      batch_id: string;
      clearing_price: string;
      num_matched: number;
    };
    fill_receipts: FillReceipt[];
    batch: unknown;
    fill_plan: unknown;
    settlement: unknown;
    vault_state_before_settlement: unknown;
    vault_state_after_settlement: unknown;
    reservation_book_before_settlement: unknown;
    reservation_book_after_settlement: unknown;
  };
  if (!close.closed) throw new DemoMismatch("adversary: batch not closed");
  if (close.batch_receipt.num_matched !== 2) {
    throw new DemoMismatch(
      `adversary: expected num_matched=2, got ${close.batch_receipt.num_matched}`
    );
  }
  ok(
    `adversary batch closed: clearing_price=${close.batch_receipt.clearing_price}, num_matched=2`
  );

  // Verify the adversary bundle.
  const verifyPayload = {
    batchReceipt: close.batch_receipt,
    fillReceipts: close.fill_receipts,
    batch: close.batch,
    fillPlan: close.fill_plan,
    settlement: close.settlement,
    vaultStateBeforeSettlement: close.vault_state_before_settlement,
    vaultStateAfterSettlement: close.vault_state_after_settlement,
    reservationBookBeforeSettlement: close.reservation_book_before_settlement,
    reservationBookAfterSettlement: close.reservation_book_after_settlement,
    expectedEngineAddress: engineAddress
  };
  const verify = (await fetchJson(
    baseUrl,
    "POST",
    "/receipts/verify",
    verifyPayload
  )) as { ok: boolean; failures?: unknown[]; bundle_id: string };
  if (!verify.ok) {
    throw new DemoMismatch(
      `adversary bundle verification failed: ${JSON.stringify(verify.failures)}`
    );
  }
  ok(`adversary bundle verified (bundle_id=${verify.bundle_id})`);

  // ATTEMPT 1: Mallory reads her own fill receipt — SUCCESS.
  section("Mallory's attempts");
  const ownChallenge = signChallenge(
    "GET_FILL_RECEIPT",
    mallorySub.intent_id,
    mallorySub.fx.private_key
  );
  const a1 = await fetchJsonNoThrow(
    baseUrl,
    "POST",
    `/intents/${mallorySub.intent_id}/fill-receipt`,
    ownChallenge
  );
  if (a1.status !== 200 || a1.body?.ok !== true) {
    throw new DemoMismatch(
      `adversary attempt 1: expected own fill-receipt read to succeed, got ${a1.status} ${a1.body?.error?.code}`
    );
  }
  ok("[1] Mallory reads her own fill receipt → 200 (matched participants have full access to own data)");

  // ATTEMPT 2: Public batch receipt — SUCCESS, reveals only public fields.
  const a2 = await fetchJsonNoThrow(
    baseUrl,
    "GET",
    `/batches/${batch_id}/receipt`
  );
  if (a2.status !== 200 || a2.body?.ok !== true) {
    throw new DemoMismatch(
      `adversary attempt 2: expected public batch receipt to be readable, got ${a2.status}`
    );
  }
  if (a2.body.batch_receipt?.batch_id !== batch_id) {
    throw new DemoMismatch(
      "adversary attempt 2: public batch receipt returned wrong batch"
    );
  }
  if ("fill_receipts" in (a2.body as object)) {
    throw new DemoMismatch(
      "adversary attempt 2: public batch receipt response contained per-agent fill_receipts (privacy regression)"
    );
  }
  ok(
    `[2] Mallory reads public batch receipt → 200 (clearing_price=${a2.body.batch_receipt.clearing_price}, num_matched=${a2.body.batch_receipt.num_matched}; no per-agent fills exposed)`
  );

  // ATTEMPT 3: Mallory tries to read Alice's fill receipt → 403 NOT_RECEIPT_OWNER.
  const a3Challenge = signChallenge(
    "GET_FILL_RECEIPT",
    aliceSub.intent_id,
    mallorySub.fx.private_key
  );
  const a3 = await fetchJsonNoThrow(
    baseUrl,
    "POST",
    `/intents/${aliceSub.intent_id}/fill-receipt`,
    a3Challenge
  );
  if (a3.status !== 403 || a3.body?.error?.code !== "NOT_RECEIPT_OWNER") {
    throw new DemoMismatch(
      `adversary attempt 3: expected 403 NOT_RECEIPT_OWNER, got ${a3.status} ${a3.body?.error?.code}`
    );
  }
  ok("[3] Mallory tries to fetch Alice's fill receipt → 403 NOT_RECEIPT_OWNER");

  // ATTEMPT 4: Mallory tries to read Alice's intent status → 403 NOT_INTENT_OWNER.
  const a4Challenge = signChallenge(
    "GET_INTENT_STATUS",
    aliceSub.intent_id,
    mallorySub.fx.private_key
  );
  const a4 = await fetchJsonNoThrow(
    baseUrl,
    "POST",
    `/intents/${aliceSub.intent_id}/status`,
    a4Challenge
  );
  if (a4.status !== 403 || a4.body?.error?.code !== "NOT_INTENT_OWNER") {
    throw new DemoMismatch(
      `adversary attempt 4: expected 403 NOT_INTENT_OWNER, got ${a4.status} ${a4.body?.error?.code}`
    );
  }
  ok("[4] Mallory tries to fetch Alice's intent status → 403 NOT_INTENT_OWNER");

  // ATTEMPT 5: Forged envelope — Mallory crafts an envelope with agent_id=Alice
  // signed by her own key. Submission-boundary signature recovery catches it.
  const forgedPayload: PrivatePayload = {
    ...mallory.intent,
    nonce: `${runId}_adv_forged`
  };
  const forgedCiphertext: HexBytes = mockEncryptPayload(forgedPayload, enclaveKey);
  const forgedUnsigned: PublicEnvelopeUnsigned = {
    intent_id: `intent_adv_forged_${runId}`,
    agent_id: aliceSub.addr, // claim Alice's identity
    market: "ETH/USDC",
    expiry_ms: Date.now() + 5 * 60_000,
    payload_commitment: hashPayload(forgedPayload),
    payload_ciphertext: forgedCiphertext,
    nonce: forgedPayload.nonce
  };
  const forgedEnvelope = signEnvelope(forgedUnsigned, mallorySub.fx.private_key);
  const a5 = await fetchJsonNoThrow(
    baseUrl,
    "POST",
    "/intents",
    forgedEnvelope
  );
  if (a5.status !== 400 || a5.body?.error?.code !== "INVALID_SIGNATURE") {
    throw new DemoMismatch(
      `adversary attempt 5: expected 400 INVALID_SIGNATURE, got ${a5.status} ${a5.body?.error?.code}`
    );
  }
  ok("[5] Mallory submits envelope with agent_id=Alice (signed by Mallory) → 400 INVALID_SIGNATURE");

  // ATTEMPT 6: Mallory signs a valid challenge for her own intent_id as herself,
  // then tampers the requester field to Alice's address. Signature recovery
  // returns Mallory's address; claimed = Alice; mismatch.
  const a6BaseChallenge = signChallenge(
    "GET_FILL_RECEIPT",
    mallorySub.intent_id,
    mallorySub.fx.private_key
  );
  const a6Tampered = { ...a6BaseChallenge, requester: aliceSub.addr };
  const a6 = await fetchJsonNoThrow(
    baseUrl,
    "POST",
    `/intents/${mallorySub.intent_id}/fill-receipt`,
    a6Tampered
  );
  if (a6.status !== 401 || a6.body?.error?.code !== "INVALID_REQUEST_SIGNATURE") {
    throw new DemoMismatch(
      `adversary attempt 6: expected 401 INVALID_REQUEST_SIGNATURE, got ${a6.status} ${a6.body?.error?.code}`
    );
  }
  ok("[6] Mallory tampers challenge.requester to Alice's address → 401 INVALID_REQUEST_SIGNATURE");

  // Final-balance assertions: clean cross, both fully filled.
  section("Adversary-batch final balances");
  for (const fx of [alice, mallory]) {
    const addr = privateKeyToAddress(fx.private_key);
    const r = (await fetchJson(baseUrl, "GET", `/vault/${addr}`)) as {
      vault: { balances: { ETH: string; USDC: string } };
    };
    info(`${fx.name}: ETH=${r.vault.balances.ETH}, USDC=${r.vault.balances.USDC}`);
    assertExpectedBalances(fx.name, r.vault.balances, fx.expected_outcome);
  }
}

function assertExpectedBalances(
  name: string,
  balances: { ETH: string; USDC: string },
  exp: AgentExpectedOutcome
): void {
  if (exp.final_balance_eth !== null && balances.ETH !== exp.final_balance_eth) {
    throw new DemoMismatch(
      `${name}: expected ETH=${exp.final_balance_eth}, got ${balances.ETH}`
    );
  }
  if (
    exp.final_balance_usdc !== null &&
    balances.USDC !== exp.final_balance_usdc
  ) {
    throw new DemoMismatch(
      `${name}: expected USDC=${exp.final_balance_usdc}, got ${balances.USDC}`
    );
  }
}
