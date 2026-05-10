import { describe, it, expect } from "vitest";
import { PrivatePayload } from "@shared/schemas";

const validBuy = {
  side: "BUY" as const,
  asset_in: "USDC" as const,
  asset_out: "ETH" as const,
  max_base_amount: "4.0",
  limit_price: "3610.00",
  allow_partial_fill: true,
  min_base_fill_amount: "1.0",
  deadline_batches: 3,
  max_price_impact_bps: 20,
  fallback_after_batches: null as number | null,
  nonce: "1"
};

const validSell = {
  side: "SELL" as const,
  asset_in: "ETH" as const,
  asset_out: "USDC" as const,
  max_base_amount: "10.0",
  limit_price: "3580.00",
  allow_partial_fill: true,
  min_base_fill_amount: "3.0",
  deadline_batches: 3,
  max_price_impact_bps: 20,
  fallback_after_batches: 0,
  nonce: "1"
};

describe("PrivatePayload", () => {
  it("parses a valid BUY", () => {
    expect(PrivatePayload.parse(validBuy)).toBeDefined();
  });

  it("parses a valid SELL", () => {
    expect(PrivatePayload.parse(validSell)).toBeDefined();
  });

  it("parses fallback_after_batches=null", () => {
    expect(PrivatePayload.parse({ ...validBuy, fallback_after_batches: null }))
      .toBeDefined();
  });

  it("parses fallback_after_batches=0", () => {
    expect(PrivatePayload.parse({ ...validBuy, fallback_after_batches: 0 }))
      .toBeDefined();
  });

  it("rejects same asset_in and asset_out", () => {
    expect(() =>
      PrivatePayload.parse({ ...validSell, asset_out: "ETH" })
    ).toThrow();
  });

  it("rejects BUY with asset_in=ETH (asset direction mismatch)", () => {
    expect(() =>
      PrivatePayload.parse({
        ...validBuy,
        asset_in: "ETH",
        asset_out: "USDC"
      })
    ).toThrow();
  });

  it("rejects SELL with asset_in=USDC", () => {
    expect(() =>
      PrivatePayload.parse({
        ...validSell,
        asset_in: "USDC",
        asset_out: "ETH"
      })
    ).toThrow();
  });

  it("rejects min_base_fill_amount > max_base_amount", () => {
    expect(() =>
      PrivatePayload.parse({
        ...validBuy,
        max_base_amount: "1.0",
        min_base_fill_amount: "2.0"
      })
    ).toThrow();
  });

  it("rejects allow_partial_fill=false with min < max", () => {
    expect(() =>
      PrivatePayload.parse({
        ...validBuy,
        allow_partial_fill: false,
        max_base_amount: "5.0",
        min_base_fill_amount: "1.0"
      })
    ).toThrow();
  });

  it("accepts allow_partial_fill=false with min == max", () => {
    expect(
      PrivatePayload.parse({
        ...validBuy,
        allow_partial_fill: false,
        max_base_amount: "5.0",
        min_base_fill_amount: "5.0"
      })
    ).toBeDefined();
  });

  it("rejects max_base_amount=0", () => {
    expect(() =>
      PrivatePayload.parse({
        ...validBuy,
        max_base_amount: "0",
        min_base_fill_amount: "0"
      })
    ).toThrow();
  });

  it("rejects limit_price=0", () => {
    expect(() =>
      PrivatePayload.parse({ ...validBuy, limit_price: "0" })
    ).toThrow();
  });

  it("rejects unknown extra field (strict mode)", () => {
    expect(() =>
      PrivatePayload.parse({ ...validBuy, internal_signal: "xyz" })
    ).toThrow();
  });

  it("rejects negative deadline_batches", () => {
    expect(() =>
      PrivatePayload.parse({ ...validBuy, deadline_batches: -1 })
    ).toThrow();
  });

  it("rejects empty nonce", () => {
    expect(() => PrivatePayload.parse({ ...validBuy, nonce: "" })).toThrow();
  });

  it("rejects malformed decimal in max_base_amount", () => {
    expect(() =>
      PrivatePayload.parse({ ...validBuy, max_base_amount: "1e10" })
    ).toThrow();
  });
});
