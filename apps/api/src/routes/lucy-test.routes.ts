import { Router, type Router as RouterType } from "express";
import { lucyTurnRequestSchema } from "@luma/shared";
import { runLucyTurn } from "../services/lucy-conversation.service.js";
import * as customersService from "../services/customers.service.js";
import { requireRole } from "../middleware/requireAuth.js";
import { requireCsrf } from "../middleware/csrf.js";
import { createLucyTestLimiter } from "../middleware/rateLimit.js";

/**
 * Internal test surface for the Lucy conversation loop — lets staff run a
 * simulated back-and-forth against the real guardrails (pre-check, Claude,
 * post-check) without any SMS provider wired up. Not the production
 * messaging endpoint; there isn't one yet.
 */
export function createLucyTestRouter(): RouterType {
  const router: RouterType = Router();
  const limiter = createLucyTestLimiter();

  router.post("/turn", limiter, requireRole("admin", "manager"), requireCsrf, async (req, res, next) => {
    try {
      const parsed = lucyTurnRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request.", details: parsed.error.issues });
        return;
      }

      const customer = await customersService.getCustomer(parsed.data.customerId);
      if (!customer) {
        res.status(404).json({ error: "Customer not found." });
        return;
      }

      const { customerId: _customerId, ...body } = parsed.data;
      const result = await runLucyTurn(customer.id, body);

      if (!result.ok && result.code === "PROVIDER_NOT_CONFIGURED") {
        res.status(503).json({ error: "The Lucy conversation loop isn't configured yet." });
        return;
      }

      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
