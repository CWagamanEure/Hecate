import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { VerifyFullBatchRequest } from "@shared/schemas";
import { verifyFullBatch, TAMPERS, SCENARIO_NAMES } from "@shared/verify";
import { canonicalJson, keccak256Hex } from "@shared/crypto";

const TamperVerifyRequest = z
  .object({
    bundle: VerifyFullBatchRequest,
    scenario: z.string()
  })
  .strict();

export async function verifyRoutes(app: FastifyInstance): Promise<void> {
  app.post("/receipts/verify", async (req, reply) => {
    const parse = VerifyFullBatchRequest.safeParse(req.body);
    if (!parse.success) {
      reply.code(400);
      return {
        ok: false,
        error: { code: "INVALID_REQUEST", detail: parse.error.message }
      };
    }
    const result = verifyFullBatch(parse.data);
    const bundle_id = keccak256Hex(canonicalJson(parse.data));
    return { ...result, bundle_id };
  });

  // Demo / panel-only convenience: apply a named tamper scenario from
  // shared/verify/tampers.ts to a bundle, then verify the mutated bundle.
  // Read-only: does not mutate server state. Same risk profile as /receipts/verify.
  app.post("/receipts/tamper-verify", async (req, reply) => {
    const parse = TamperVerifyRequest.safeParse(req.body);
    if (!parse.success) {
      reply.code(400);
      return {
        ok: false,
        error: { code: "INVALID_REQUEST", detail: parse.error.message }
      };
    }
    const tamper = TAMPERS[parse.data.scenario];
    if (!tamper) {
      reply.code(400);
      return {
        ok: false,
        error: {
          code: "UNKNOWN_SCENARIO",
          detail: `no scenario "${parse.data.scenario}"; available: ${SCENARIO_NAMES.join(", ")}`
        }
      };
    }
    let t;
    try {
      t = tamper(parse.data.bundle);
    } catch (e) {
      reply.code(400);
      return {
        ok: false,
        error: {
          code: "SCENARIO_NOT_APPLICABLE",
          detail: (e as Error).message
        }
      };
    }
    const result = verifyFullBatch(t.bundle);
    const bundle_id = keccak256Hex(canonicalJson(t.bundle));
    return {
      ...result,
      bundle_id,
      scenario: {
        name: parse.data.scenario,
        description: t.description,
        demonstrates: t.demonstrates
      }
    };
  });
}
