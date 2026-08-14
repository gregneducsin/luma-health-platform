import { env } from "./lib/env.js";
import { logger } from "./lib/logger.js";
import { createApp } from "./app.js";

// Migrations are applied as a discrete step before this process starts (see
// packages/db/src/migrate.ts's docstring, the Dockerfile entrypoint, and the
// CI workflow) — never opportunistically here.

const app = createApp();

app.listen(env.port, () => {
  logger.info({ port: env.port, nodeEnv: env.nodeEnv }, "Server listening");
});
