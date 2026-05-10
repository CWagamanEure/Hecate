import type {
  VaultState,
  ReservationBook,
  RuntimeMetadata,
  HexAddress
} from "@shared/schemas";
import type { ReadyIntent } from "@shared/matching";

export type ServerState = {
  dataDir: string;
  runtime: RuntimeMetadata;
  engineKey: Uint8Array;
  engineAddress: HexAddress;
  mockEnclaveKey: Uint8Array;
  vault: VaultState;
  reservationBook: ReservationBook;
  readyPool: Map<string, ReadyIntent>;
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
