import type { FastifyInstance } from "fastify";
import { VerifyFullBatchRequest } from "@shared/schemas";
import { verifyFullBatch } from "@shared/verify";

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
    return verifyFullBatch(parse.data);
  });
}
