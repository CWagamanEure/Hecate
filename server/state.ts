import type {
  VaultState,
  ReservationBook,
  RuntimeMetadata,
  HexAddress
} from "@shared/schemas";
import type { ReadyIntent } from "@shared/matching";

export type VaultBackend = "mock" | "onchain";

export type ServerState = {
  dataDir: string;
  runtime: RuntimeMetadata;
  engineKey: Uint8Array;
  engineAddress: HexAddress;
  mockEnclaveKey: Uint8Array;
  vault: VaultState;
  reservationBook: ReservationBook;
  readyPool: Map<string, ReadyIntent>;
  /**
   * V6b: when "onchain", state.vault is seeded from HecateVault on Sepolia
   * at startup and the mock-deposit / mock-withdraw routes return 400.
   * When "mock" (default), behavior is unchanged from v1.
   */
  vaultBackend: VaultBackend;
};

/** Single-process FIFO mutex for serializing state-mutating handlers. */
export class Mutex {
  private chain: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }
}
