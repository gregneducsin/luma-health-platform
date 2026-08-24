import { Router, type Router as RouterType } from "express";
import {
  createCustomerRequestSchema,
  updateCustomerRequestSchema,
  listCustomersQuerySchema,
  customersSummaryQuerySchema,
  createPurchaseRequestSchema,
} from "@luma/shared";
import * as customersService from "../services/customers.service.js";
import * as purchasesService from "../services/purchases.service.js";
import { createIntakeLink } from "../services/intake-links.service.js";
import { getUpcomingTrigger } from "../services/scheduled-triggers.service.js";
import { requireRole } from "../middleware/requireAuth.js";
import { requireCsrf } from "../middleware/csrf.js";

export function createCustomersRouter(): RouterType {
  const router: RouterType = Router();

  router.get("/", requireRole("admin"), async (req, res, next) => {
    try {
      const parsed = listCustomersQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid query.", details: parsed.error.issues });
        return;
      }
      const result = await customersService.listCustomers(parsed.data);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // Must be registered before "/:id" — otherwise "summary" would be
  // captured as the :id param instead of matching this route.
  router.get("/summary", requireRole("admin"), async (req, res, next) => {
    try {
      const parsed = customersSummaryQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid query.", details: parsed.error.issues });
        return;
      }
      const summary = await customersService.getCustomersSummary(parsed.data);
      res.json(summary);
    } catch (err) {
      next(err);
    }
  });

  // Same registration-order note as "/summary" above.
  router.get("/lead-types", requireRole("admin"), async (_req, res, next) => {
    try {
      res.json({ leadTypes: await customersService.listDistinctLeadTypes() });
    } catch (err) {
      next(err);
    }
  });

  // Same registration-order note as "/summary" above.
  router.get("/questionnaire-ids", requireRole("admin"), async (_req, res, next) => {
    try {
      res.json({ questionnaireIds: await customersService.listDistinctQuestionnaireIds() });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id", requireRole("admin"), async (req, res, next) => {
    try {
      const customer = await customersService.getCustomer(req.params.id as string);
      if (!customer) {
        res.status(404).json({ error: "Customer not found." });
        return;
      }
      const purchases = await purchasesService.listPurchasesForCustomer(customer.id);
      const questionnaireEvents = await customersService.listQuestionnaireEventsForCustomer(customer.id);
      res.json({ customer, purchases, questionnaireEvents });
    } catch (err) {
      next(err);
    }
  });

  // Mint an intake trigger link for this lead. Deliberately a staff-initiated
  // action, not automatic — the link should go out only once the lead has
  // actually agreed to fill out the form, which today means a staff member
  // clicked this after hearing "yes" (no automated agreement-detection yet).
  router.post("/:id/intake-link", requireRole("admin"), requireCsrf, async (req, res, next) => {
    try {
      const customer = await customersService.getCustomer(req.params.id as string);
      if (!customer) {
        res.status(404).json({ error: "Customer not found." });
        return;
      }
      const { url, expiresAt } = await createIntakeLink(customer.id);
      res.status(201).json({ url, expiresAt: expiresAt.toISOString() });
    } catch (err) {
      next(err);
    }
  });

  // Soonest still-scheduled automated message across every trigger table
  // (follow-up jobs, abandoned-cart/lead-checkin/objection-reengagement SMS,
  // abandoned-cart/meta-lead email, review requests) for this person, or
  // null if nothing's armed — surfaced on the conversation detail page so
  // staff can see "there's a text/email due Thursday" without having to ask.
  router.get("/:id/upcoming-trigger", requireRole("admin"), async (req, res, next) => {
    try {
      const trigger = await getUpcomingTrigger(req.params.id as string);
      res.json({ trigger: trigger ? { ...trigger, dueAt: trigger.dueAt.toISOString() } : null });
    } catch (err) {
      next(err);
    }
  });

  router.post("/", requireRole("admin"), requireCsrf, async (req, res, next) => {
    try {
      const parsed = createCustomerRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request.", details: parsed.error.issues });
        return;
      }
      const customer = await customersService.createCustomer(parsed.data);
      res.status(201).json({ customer });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/:id", requireRole("admin"), requireCsrf, async (req, res, next) => {
    try {
      const parsed = updateCustomerRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request.", details: parsed.error.issues });
        return;
      }
      const customer = await customersService.updateCustomer(req.params.id as string, parsed.data);
      if (!customer) {
        res.status(404).json({ error: "Customer not found." });
        return;
      }
      res.json({ customer });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/purchases", requireRole("admin"), requireCsrf, async (req, res, next) => {
    try {
      const parsed = createPurchaseRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request.", details: parsed.error.issues });
        return;
      }
      const customer = await customersService.getCustomer(req.params.id as string);
      if (!customer) {
        res.status(404).json({ error: "Customer not found." });
        return;
      }
      const purchase = await purchasesService.createPurchase(customer.id, parsed.data);
      res.status(201).json({ purchase });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
