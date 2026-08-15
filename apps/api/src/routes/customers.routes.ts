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
import { requireRole } from "../middleware/requireAuth.js";
import { requireCsrf } from "../middleware/csrf.js";

export function createCustomersRouter(): RouterType {
  const router: RouterType = Router();

  router.get("/", requireRole("admin", "manager"), async (req, res, next) => {
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
  router.get("/summary", requireRole("admin", "manager"), async (req, res, next) => {
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
  router.get("/lead-types", requireRole("admin", "manager"), async (_req, res, next) => {
    try {
      res.json({ leadTypes: await customersService.listDistinctLeadTypes() });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id", requireRole("admin", "manager"), async (req, res, next) => {
    try {
      const customer = await customersService.getCustomer(req.params.id as string);
      if (!customer) {
        res.status(404).json({ error: "Customer not found." });
        return;
      }
      const purchases = await purchasesService.listPurchasesForCustomer(customer.id);
      res.json({ customer, purchases });
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
