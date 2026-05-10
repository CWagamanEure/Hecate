import { z } from "zod";

export const VerifyFailure = z
  .object({
    code: z.string(),
    path: z.string().nullable(),
    detail: z.string().nullable()
  })
  .strict();
export type VerifyFailure = z.infer<typeof VerifyFailure>;

export const VerifyResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }).strict(),
  z
    .object({
      ok: z.literal(false),
      failures: z.array(VerifyFailure).min(1)
    })
    .strict()
]);
export type VerifyResult = z.infer<typeof VerifyResult>;
