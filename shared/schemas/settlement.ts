import { z } from "zod";
import { HexAddress } from "./hex";
import { Asset, Market } from "./enums";
import { DecimalString, SignedDecimalString } from "./decimal";

export const SettlementFill = z
  .object({
    intent_id: z.string(),
    agent_id: HexAddress,
    base_delta: SignedDecimalString,
    quote_delta: SignedDecimalString
  })
  .strict();
export type SettlementFill = z.infer<typeof SettlementFill>;

export const VaultDelta = z
  .object({
    agent_id: HexAddress,
    asset: Asset,
    delta: SignedDecimalString
  })
  .strict();
export type VaultDelta = z.infer<typeof VaultDelta>;

export const SettlementObject = z
  .object({
    batch_id: z.string(),
    market: Market,
    clearing_price: DecimalString,
    fills: z.array(SettlementFill),
    vault_deltas: z.array(VaultDelta)
  })
  .strict();
export type SettlementObject = z.infer<typeof SettlementObject>;
