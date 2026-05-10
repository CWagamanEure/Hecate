import { z } from "zod";
import { HexAddress } from "./hex";
import { Asset } from "./enums";
import { DecimalString } from "./decimal";

export const ReservationStatus = z.enum(["RESERVED", "RELEASED", "SETTLED"]);
export type ReservationStatus = z.infer<typeof ReservationStatus>;

export const Reservation = z
  .object({
    intent_id: z.string(),
    agent_id: HexAddress,
    asset: Asset,
    amount: DecimalString,
    status: ReservationStatus,
    created_ms: z.number().int().positive()
  })
  .strict();
export type Reservation = z.infer<typeof Reservation>;

// reservations are kept sorted by intent_id after every mutation; hashing
// (Ticket 4 / Ticket 7) sorts defensively before serialization.
export const ReservationBook = z
  .object({
    reservations: z.array(Reservation)
  })
  .strict();
export type ReservationBook = z.infer<typeof ReservationBook>;
