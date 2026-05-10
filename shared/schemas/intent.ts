import { z } from "zod";
import { HexAddress, Hex32, Hex65, HexBytes } from "./hex";
import { Market } from "./enums";

export const PublicEnvelope = z
  .object({
    intent_id: z.string().regex(/^intent_[A-Za-z0-9_-]{1,64}$/),
    agent_id: HexAddress,
    market: Market,
    expiry_ms: z.number().int().positive(),
    payload_commitment: Hex32,
    payload_ciphertext: HexBytes,
    nonce: z.string().min(1),
    signature: Hex65
  })
  .strict();

export type PublicEnvelope = z.infer<typeof PublicEnvelope>;

// Variant used as the signing preimage (signature field omitted).
export const PublicEnvelopeUnsigned = PublicEnvelope.omit({ signature: true });
export type PublicEnvelopeUnsigned = z.infer<typeof PublicEnvelopeUnsigned>;
