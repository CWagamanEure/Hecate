import { bootstrap } from "./runtime";
import { buildApp } from "./buildApp";

async function main(): Promise<void> {
  const state = await bootstrap();
  const app = buildApp({ state, logger: true });
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? "127.0.0.1";
  await app.listen({ port, host });
  // eslint-disable-next-line no-console
  console.log(
    `hecate listening on ${host}:${port} (runtime=${state.runtime.runtime_mode})`
  );
  if (state.runtime.runtime_mode === "LOCAL_MOCK") {
    // eslint-disable-next-line no-console
    console.log(
      "⚠ LOCAL_MOCK — payload encryption is architectural, not security."
    );
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("startup failed:", e);
  process.exit(1);
});
