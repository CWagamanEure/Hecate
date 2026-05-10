/**
 * Hecate verifier replay CLI.
 *
 * Loads a saved bundle (the JSON shape produced by `npm run simulate -- --save-bundle`),
 * optionally applies one tamper scenario, calls verifyFullBatch, and pretty-
 * prints the result.
 *
 * Imports verifyFullBatch verbatim from @shared/verify — no semantic changes.
 *
 * Exit codes:
 *   0  honest bundle verified, OR rejected with --expect-fail
 *   1  rejected without --expect-fail, OR runtime error
 *   2  argument error / --help
 */

import { readFile } from "node:fs/promises";
import { VerifyFullBatchRequest } from "@shared/schemas";
import { verifyFullBatch } from "@shared/verify";
import { TAMPERS, SCENARIO_NAMES } from "./replayTampers";

type Args = {
  bundlePath: string | undefined;
  scenario: string | undefined;
  expectFail: boolean;
  verbose: boolean;
  help: boolean;
};

function parseArgs(argv: string[]): Args {
  const out: Args = {
    bundlePath: undefined,
    scenario: undefined,
    expectFail: false,
    verbose: false,
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") {
      out.help = true;
      continue;
    }
    if (a === "--scenario") {
      out.scenario = argv[++i];
      continue;
    }
    if (a === "--expect-fail") {
      out.expectFail = true;
      continue;
    }
    if (a === "--verbose") {
      out.verbose = true;
      continue;
    }
    if (a.startsWith("--")) {
      throw new Error(`unknown option: ${a}`);
    }
    if (!out.bundlePath) {
      out.bundlePath = a;
      continue;
    }
    throw new Error(`unexpected positional argument: ${a}`);
  }
  return out;
}

function printHelp(): void {
  console.log(`Hecate verifier replay

Usage: tsx agents/replay.ts <bundle-path> [options]
       tsx agents/replay.ts --scenario list

Options:
  --scenario <name>       run a built-in tamper scenario
  --scenario list         list all available scenarios
  --expect-fail           exit 0 if verification rejects (for CI)
  --verbose               include full failure objects in output
  --help                  show this help

Examples:
  npm run verify -- ./data/last-bundle.json
  npm run verify -- ./data/last-bundle.json --scenario clearing-price
  npm run verify -- ./data/last-bundle.json --scenario wrong-key --expect-fail
`);
}

function printScenarios(): void {
  console.log("Available tamper scenarios:");
  for (const name of SCENARIO_NAMES) {
    console.log(`  ${name}`);
  }
}

const BAR = "============================================================";

function printHeader(
  bundlePath: string,
  batchId: string,
  scenario: string | undefined,
  mutation: string
): void {
  console.log(BAR);
  console.log("Hecate verifier replay");
  console.log(BAR);
  console.log(`  bundle:    ${bundlePath}`);
  console.log(`  batch_id:  ${batchId}`);
  console.log(`  mode:      ${scenario ? `TAMPER  scenario=${scenario}` : "HONEST"}`);
  if (mutation) console.log(`  mutation:  ${mutation}`);
  console.log("");
}

function printResult(
  ok: boolean,
  failures: { code: string; path: string | null; detail: string | null }[],
  scenario: { name: string; demonstrates: string } | null,
  verbose: boolean
): void {
  if (ok) {
    console.log("Result: VERIFIED ✓");
    console.log("");
    return;
  }
  console.log("Result: REJECTED ✗");
  console.log("");
  console.log(`${failures.length} failure${failures.length === 1 ? "" : "s"}:`);
  for (const f of failures) {
    const path = f.path ?? "<no path>";
    console.log(`  [${f.code}]  ${path}`);
    if (f.detail) console.log(`    ${f.detail}`);
  }
  if (verbose) {
    console.log("");
    console.log("Full failures:");
    console.log(JSON.stringify(failures, null, 2));
  }
  if (scenario) {
    console.log("");
    console.log("What this demonstrates:");
    console.log(`  ${scenario.demonstrates}`);
  }
  console.log("");
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`Error: ${(e as Error).message}\n`);
    printHelp();
    process.exit(2);
    return;
  }

  if (args.help) {
    printHelp();
    process.exit(0);
    return;
  }

  if (args.scenario === "list") {
    printScenarios();
    process.exit(0);
    return;
  }

  if (!args.bundlePath) {
    console.error("Error: bundle path is required\n");
    printHelp();
    process.exit(2);
    return;
  }

  // Load bundle.
  let raw: string;
  try {
    raw = await readFile(args.bundlePath, "utf-8");
  } catch (e) {
    console.error(`Could not read bundle from ${args.bundlePath}: ${(e as Error).message}`);
    process.exit(1);
    return;
  }

  let bundle;
  try {
    bundle = VerifyFullBatchRequest.parse(JSON.parse(raw));
  } catch (e) {
    console.error(
      `Bundle does not match VerifyFullBatchRequest schema: ${(e as Error).message}`
    );
    process.exit(1);
    return;
  }

  // Apply tamper if requested.
  let mutation = "";
  let demonstrates = "";
  let mutated = bundle;
  if (args.scenario) {
    const tamper = TAMPERS[args.scenario];
    if (!tamper) {
      console.error(
        `Unknown scenario: ${args.scenario}\nRun with --scenario list to see all scenarios.`
      );
      process.exit(2);
      return;
    }
    try {
      const r = tamper(bundle);
      mutated = r.bundle;
      mutation = r.description;
      demonstrates = r.demonstrates;
    } catch (e) {
      console.error(
        `Scenario ${args.scenario} could not be applied to this bundle: ${(e as Error).message}`
      );
      process.exit(1);
      return;
    }
  }

  printHeader(args.bundlePath, bundle.batchReceipt.batch_id, args.scenario, mutation);

  const result = verifyFullBatch(mutated);

  if (result.ok) {
    printResult(true, [], null, args.verbose);
  } else {
    printResult(
      false,
      result.failures,
      args.scenario ? { name: args.scenario, demonstrates } : null,
      args.verbose
    );
  }

  // Exit code logic.
  if (result.ok) {
    process.exit(0);
  } else if (args.expectFail) {
    console.log("(--expect-fail set; exiting 0 because verification correctly rejected)");
    process.exit(0);
  } else {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`\nUnexpected error: ${(e as Error).message}`);
  process.exit(1);
});
