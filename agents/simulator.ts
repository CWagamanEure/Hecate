/**
 * Hecate demo simulator CLI.
 *
 * Usage:
 *   tsx agents/simulator.ts [options]
 *
 * Options:
 *   --base-url <url>            HTTP base URL (default: http://127.0.0.1:8787)
 *   --code-digest <digest>      must match server's CODE_DIGEST (default: sha256:dev-local)
 *   --reset-demo-state          delete demo state files in --data-dir
 *   --data-dir <path>           required iff --reset-demo-state
 *   --save-bundle <path>        write the close-batch bundle to disk for replay
 *   --verbose                   extra output
 *   --help                      show this help
 *
 * For deterministic demo output, run the server with a fresh DATA_DIR or run:
 *   npm run simulate -- --reset-demo-state --data-dir ./data
 */

import { runDemo, type RunDemoOptions } from "./runDemo";

function printHelp(): void {
  console.log(`Hecate demo simulator

Usage: tsx agents/simulator.ts [options]

Options:
  --base-url <url>            HTTP base URL (default: http://127.0.0.1:8787)
  --code-digest <digest>      must match server's CODE_DIGEST (default: sha256:dev-local)
  --reset-demo-state          delete demo state files in --data-dir
  --data-dir <path>           required iff --reset-demo-state
  --save-bundle <path>        write the close-batch bundle (VerifyFullBatchRequest shape)
                              to <path> after settlement; consumed by \`npm run verify\`
  --allow-digest-mismatch     do not exit on engine_code_digest != --code-digest
                              (default: hard-fail; mismatched digests break mock encryption
                              and produce MALFORMED_PAYLOAD on every intent)
  --verbose                   extra output
  --help                      show this help

For deterministic demo output, run the server with a fresh DATA_DIR or run:
  npm run simulate -- --reset-demo-state --data-dir ./data
`);
}

function parseArgs(argv: string[]): RunDemoOptions | { help: true } {
  let baseUrl = "http://127.0.0.1:8787";
  let codeDigest = "sha256:dev-local";
  let reset = false;
  let dataDir: string | undefined;
  let verbose = false;
  let saveBundle: string | undefined;
  let allowDigestMismatch = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--help":
      case "-h":
        return { help: true };
      case "--base-url":
        baseUrl = argv[++i] ?? baseUrl;
        break;
      case "--code-digest":
        codeDigest = argv[++i] ?? codeDigest;
        break;
      case "--reset-demo-state":
        reset = true;
        break;
      case "--data-dir":
        dataDir = argv[++i];
        break;
      case "--save-bundle":
        saveBundle = argv[++i];
        break;
      case "--allow-digest-mismatch":
        allowDigestMismatch = true;
        break;
      case "--verbose":
        verbose = true;
        break;
      default:
        throw new Error(`unknown option: ${a}`);
    }
  }

  if (reset && !dataDir) {
    throw new Error("--reset-demo-state requires --data-dir");
  }

  return { baseUrl, codeDigest, reset, dataDir, verbose, saveBundle, allowDigestMismatch };
}

function main(): void {
  let opts: RunDemoOptions | { help: true };
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`Error: ${(e as Error).message}\n`);
    printHelp();
    process.exit(2);
    return;
  }
  if ("help" in opts) {
    printHelp();
    return;
  }
  runDemo(opts)
    .then((r) => {
      process.exit(r.ok ? 0 : 1);
    })
    .catch((e) => {
      console.error(`\nError: ${(e as Error).message}`);
      process.exit(1);
    });
}

main();
