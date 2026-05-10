import { describe, it, expect } from "vitest";
import {
  RuntimeMetadata,
  BatchReceipt,
  FillReceipt,
  SettlementObject
} from "@shared/schemas";

const hex32 = "0x" + "0".repeat(64);
const hex65 = "0x" + "0".repeat(130);
const addr = "0x" + "a".repeat(40);

const localMockRuntime = {
  runtime_mode: "LOCAL_MOCK" as const,
  engine_code_digest: "sha256:dev-local",
  eigencompute_app_id: null,
  eigencompute_image_digest: null,
  eigencompute_attestation_id: null
};

const eigenRuntime = {
  runtime_mode: "EIGEN_TEE" as const,
  engine_code_digest: "sha256:abc",
  eigencompute_app_id: "app-1",
  eigencompute_image_digest: "sha256:img",
  eigencompute_attestation_id: "att-1"
};

const validBatchReceipt = {
  batch_id: "batch_001",
  market: "ETH/USDC" as const,
  matching_rule: "UNIFORM_CLEARING_PRICE_V1" as const,
  intent_envelope_root: hex32,
  private_payload_commitment_root: hex32,
  vault_state_before_hash: hex32,
  vault_state_after_hash: hex32,
  reservation_book_before_hash: hex32,
  reservation_book_after_hash: hex32,
  settlement_hash: hex32,
  num_intents: 3,
  num_matched: 2,
  clearing_price: "3590.00",
  timestamp_ms: 1770000000000,
  runtime: localMockRuntime,
  engine_signature: hex65
};

const validFillReceipt = {
  intent_id: "intent_001",
  batch_id: "batch_001",
  agent_id: addr,
  status: "FILLED" as const,
  filled_base: "6.0",
  filled_quote: "21540.00",
  clearing_price: "3590.00",
  constraints_satisfied: true,
  unfilled_reason: null,
  payload_commitment: hex32,
  reserved_released: { ETH: "0.0", USDC: "80.0" },
  runtime: localMockRuntime,
  engine_signature: hex65
};

describe("RuntimeMetadata", () => {
  it("parses LOCAL_MOCK with null eigen fields", () => {
    expect(RuntimeMetadata.parse(localMockRuntime)).toBeDefined();
  });

  it("parses EIGEN_TEE with populated eigen fields", () => {
    expect(RuntimeMetadata.parse(eigenRuntime)).toBeDefined();
  });

  // Coherence (EIGEN_TEE with null eigen fields) is NOT enforced at the schema
  // level. The verifier (Ticket 14) is responsible for catching this.
  it("parses EIGEN_TEE with null eigen fields (coherence is verifier's job — Ticket 14)", () => {
    expect(
      RuntimeMetadata.parse({ ...eigenRuntime, eigencompute_app_id: null })
    ).toBeDefined();
  });

  it("rejects unknown runtime_mode", () => {
    expect(() =>
      RuntimeMetadata.parse({ ...localMockRuntime, runtime_mode: "OTHER" })
    ).toThrow();
  });

  it("rejects empty engine_code_digest", () => {
    expect(() =>
      RuntimeMetadata.parse({ ...localMockRuntime, engine_code_digest: "" })
    ).toThrow();
  });
});

describe("BatchReceipt", () => {
  it("parses a valid receipt", () => {
    expect(BatchReceipt.parse(validBatchReceipt)).toBeDefined();
  });

  it("rejects missing engine_signature", () => {
    const { engine_signature: _s, ...rest } = validBatchReceipt;
    expect(() => BatchReceipt.parse(rest)).toThrow();
  });

  it("rejects bad clearing_price", () => {
    expect(() =>
      BatchReceipt.parse({ ...validBatchReceipt, clearing_price: "-1.0" })
    ).toThrow();
  });

  it("rejects extra fields (strict)", () => {
    expect(() =>
      BatchReceipt.parse({ ...validBatchReceipt, extra: 1 } as unknown)
    ).toThrow();
  });

  it("rejects bad matching_rule literal", () => {
    expect(() =>
      BatchReceipt.parse({
        ...validBatchReceipt,
        matching_rule: "OTHER" as unknown as "UNIFORM_CLEARING_PRICE_V1"
      })
    ).toThrow();
  });
});

describe("FillReceipt", () => {
  it("parses a valid receipt", () => {
    expect(FillReceipt.parse(validFillReceipt)).toBeDefined();
  });

  it("parses a partially-filled receipt with unfilled_reason", () => {
    expect(
      FillReceipt.parse({
        ...validFillReceipt,
        status: "PARTIALLY_FILLED",
        unfilled_reason: "INSUFFICIENT_OPPOSITE_FLOW_WITHIN_LIMIT"
      })
    ).toBeDefined();
  });

  it("rejects missing agent_id", () => {
    const { agent_id: _a, ...rest } = validFillReceipt;
    expect(() => FillReceipt.parse(rest)).toThrow();
  });

  it("rejects malformed reserved_released", () => {
    expect(() =>
      FillReceipt.parse({
        ...validFillReceipt,
        reserved_released: { ETH: "0.0" }
      })
    ).toThrow();
  });

  it("rejects bad unfilled_reason value", () => {
    expect(() =>
      FillReceipt.parse({ ...validFillReceipt, unfilled_reason: "WHATEVER" })
    ).toThrow();
  });
});

describe("SettlementObject", () => {
  const settlement = {
    batch_id: "batch_001",
    market: "ETH/USDC" as const,
    clearing_price: "3590.00",
    fills: [
      {
        intent_id: "intent_001",
        agent_id: addr,
        base_delta: "-10.0",
        quote_delta: "35900.00"
      }
    ],
    vault_deltas: [
      { agent_id: addr, asset: "ETH" as const, delta: "-10.0" },
      { agent_id: addr, asset: "USDC" as const, delta: "35900.00" }
    ]
  };

  it("parses a valid settlement", () => {
    expect(SettlementObject.parse(settlement)).toBeDefined();
  });

  it("accepts negative deltas", () => {
    expect(
      SettlementObject.parse({
        ...settlement,
        vault_deltas: [
          { agent_id: addr, asset: "ETH", delta: "-10.000000000000000001" }
        ]
      })
    ).toBeDefined();
  });

  it("rejects negative clearing_price", () => {
    expect(() =>
      SettlementObject.parse({ ...settlement, clearing_price: "-1.0" })
    ).toThrow();
  });

  it("rejects malformed delta", () => {
    expect(() =>
      SettlementObject.parse({
        ...settlement,
        vault_deltas: [
          { agent_id: addr, asset: "ETH", delta: "not-a-number" }
        ]
      })
    ).toThrow();
  });
});
