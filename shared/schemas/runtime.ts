import { z } from "zod";
import { RuntimeMode } from "./enums";

// Eigen fields are NULLABLE, never optional. Receipts have one stable shape
// across LOCAL_MOCK and EIGEN_TEE; LOCAL_MOCK stamps these as null.
//
// NOTE: A receipt with runtime_mode=EIGEN_TEE and any null eigen field is
// schema-valid but coherence-invalid. The verifier (Ticket 14) rejects it with
// a specific failure code; this is intentional so receipts produced under either
// mode parse identically and the coherence check is centralized.
export const RuntimeMetadata = z
  .object({
    runtime_mode: RuntimeMode,
    engine_code_digest: z.string().min(1),
    eigencompute_app_id: z.string().nullable(),
    eigencompute_image_digest: z.string().nullable(),
    eigencompute_attestation_id: z.string().nullable()
  })
  .strict();
export type RuntimeMetadata = z.infer<typeof RuntimeMetadata>;
