/**
 * buildSettlementObject — pure transform from BatchInput + FillPlan into a
 * canonical SettlementObject.
 *
 * Aggregates vault_deltas by (normalized agent_id, asset). Drops zero-net
 * aggregated deltas. Sorts vault_deltas by (agent_id, asset) for deterministic
 * canonical hashing.
 *
 * Throws on:
 *   - duplicate fill intent_id
 *   - fill referencing intent_id not in batch
 *   - missing fill for a batch intent
 *   - conservation violation (sum ETH deltas != 0 OR sum USDC deltas != 0)
 *
 * v1 assumes no protocol fees. If fees are introduced later, fee-recipient
 * deltas must participate in this conservation check.
 */

import type {
  BatchInput,
  FillPlan,
  FillEntry,
  SettlementObject,
  SettlementFill,
  VaultDelta,
  HexAddress,
  Asset,
  DecimalString,
  SignedDecimalString
} from "@shared/schemas";
import {
  toScaled,
  fromScaledSigned,
  isZero
} from "@shared/math/decimal";
import { normalizeAddress } from "@shared/crypto";

function toSignedString(d: DecimalString, sign: 1 | -1): SignedDecimalString {
  return fromScaledSigned(toScaled(d) * BigInt(sign));
}

type AggEntry = { agent_id: HexAddress; asset: Asset; scaled: bigint };

function aggregate(
  acc: Map<string, AggEntry>,
  agent_id: HexAddress,
  asset: Asset,
  scaled: bigint
): void {
  const key = `${agent_id}|${asset}`;
  const existing = acc.get(key);
  if (existing) {
    existing.scaled += scaled;
  } else {
    acc.set(key, { agent_id, asset, scaled });
  }
}

export function buildSettlementObject(
  batch: BatchInput,
  fillPlan: FillPlan
): SettlementObject {
  // Index fills, validate uniqueness and one-to-one with batch.
  const fillById = new Map<string, FillEntry>();
  for (const f of fillPlan.fills) {
    if (fillById.has(f.intent_id)) {
      throw new Error(
        `buildSettlementObject: duplicate fill for intent ${f.intent_id}`
      );
    }
    fillById.set(f.intent_id, f);
  }
  const batchIds = new Set(batch.intents.map((i) => i.envelope.intent_id));
  for (const id of fillById.keys()) {
    if (!batchIds.has(id)) {
      throw new Error(
        `buildSettlementObject: fill ${id} not present in batch`
      );
    }
  }

  const fills: SettlementFill[] = [];
  const acc = new Map<string, AggEntry>();

  for (const intent of batch.intents) {
    const id = intent.envelope.intent_id;
    const fill = fillById.get(id);
    if (!fill) {
      throw new Error(
        `buildSettlementObject: missing fill for intent ${id}`
      );
    }
    if (fill.status !== "FILLED" && fill.status !== "PARTIALLY_FILLED") {
      continue;
    }
    if (isZero(fill.filled_base)) continue;

    const agent_id = normalizeAddress(intent.envelope.agent_id);
    const isBuy = intent.payload.side === "BUY";
    const baseDelta = toSignedString(fill.filled_base, isBuy ? 1 : -1);
    const quoteDelta = toSignedString(fill.filled_quote, isBuy ? -1 : 1);

    fills.push({
      intent_id: id,
      agent_id,
      base_delta: baseDelta,
      quote_delta: quoteDelta
    });

    aggregate(acc, agent_id, "ETH", toScaled(baseDelta));
    aggregate(acc, agent_id, "USDC", toScaled(quoteDelta));
  }

  // Drop zero-net entries.
  const vault_deltas: VaultDelta[] = [];
  for (const entry of acc.values()) {
    if (entry.scaled === 0n) continue;
    vault_deltas.push({
      agent_id: entry.agent_id,
      asset: entry.asset,
      delta: fromScaledSigned(entry.scaled)
    });
  }
  // Sort by (agent_id, asset) lex.
  vault_deltas.sort((a, b) => {
    if (a.agent_id !== b.agent_id) {
      return a.agent_id < b.agent_id ? -1 : 1;
    }
    return a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0;
  });

  // Conservation: sum ETH deltas = 0; sum USDC deltas = 0.
  let ethSum = 0n;
  let usdcSum = 0n;
  for (const d of vault_deltas) {
    const s = toScaled(d.delta);
    if (d.asset === "ETH") ethSum += s;
    else usdcSum += s;
  }
  if (ethSum !== 0n || usdcSum !== 0n) {
    throw new Error(
      `buildSettlementObject: conservation violation (ETH sum=${ethSum}, USDC sum=${usdcSum})`
    );
  }

  return {
    batch_id: batch.batch_id,
    market: batch.market,
    clearing_price: fillPlan.clearing_price,
    fills,
    vault_deltas
  };
}

