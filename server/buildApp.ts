import Fastify, { type FastifyInstance } from "fastify";
import { Mutex, type ServerState } from "./state";
import { publicRoutes } from "./routes/public";
import { vaultRoutes } from "./routes/vault";
import { intentsRoutes } from "./routes/intents";
import { batchesRoutes } from "./routes/batches";
import { verifyRoutes } from "./routes/verify";
import { staticRoutes } from "./routes/static";

export type BuildAppOptions = {
  state: ServerState;
  mutex?: Mutex;
  logger?: boolean;
};

export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 10 * 1024 * 1024 // 10MB for verify endpoint payloads
  });
  const mutex = opts.mutex ?? new Mutex();

  app.register(staticRoutes);
  app.register(publicRoutes, { state: opts.state });
  app.register(vaultRoutes, { state: opts.state, mutex });
  app.register(intentsRoutes, { state: opts.state, mutex });
  app.register(batchesRoutes, { state: opts.state, mutex });
  app.register(verifyRoutes);

  app.setErrorHandler((err, _req, reply) => {
    reply
      .code(err.statusCode ?? 500)
      .send({
        ok: false,
        error: { code: "INTERNAL_ERROR", detail: err.message }
      });
  });

  return app;
}
