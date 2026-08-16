import { env } from "./lib/env.js";
import { logger } from "./lib/logger.js";
import { createApp } from "./app.js";
import { sweepFollowUpJobs } from "./services/follow-up-jobs.service.js";
import { sweepAbandonedCartTriggers } from "./services/abandoned-cart.service.js";

// Migrations are applied as a discrete step before this process starts (see
// packages/db/src/migrate.ts's docstring, the Dockerfile entrypoint, and the
// CI workflow) — never opportunistically here.

const app = createApp();

app.listen(env.port, () => {
  logger.info({ port: env.port, nodeEnv: env.nodeEnv }, "Server listening");
});

// Follow-up job sweep: in-process interval, single-instance only (same
// simplification already accepted for rate limiting — revisit together if
// multi-instance hosting is ever chosen). A missed or overlapping tick is
// harmless: sweepFollowUpJobs() only ever touches jobs still `pending`, so a
// slow tick just gets picked up by the next one.
const FOLLOW_UP_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
setInterval(() => {
  sweepFollowUpJobs().catch((err) => {
    logger.error({ err }, "follow-up job sweep failed");
  });
}, FOLLOW_UP_SWEEP_INTERVAL_MS);

// Shorter interval than the follow-up sweep above — the opener promise is
// "10 minutes after abandonment," a much tighter window than the hour-plus
// delays in the follow-up sequence, so it needs a finer-grained tick.
const ABANDONED_CART_SWEEP_INTERVAL_MS = 2 * 60 * 1000;
setInterval(() => {
  sweepAbandonedCartTriggers().catch((err) => {
    logger.error({ err }, "abandoned-cart opener sweep failed");
  });
}, ABANDONED_CART_SWEEP_INTERVAL_MS);
