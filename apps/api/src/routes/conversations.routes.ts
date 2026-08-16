import { Router, type Router as RouterType } from "express";
import * as conversationsService from "../services/conversations.service.js";
import { requireRole } from "../middleware/requireAuth.js";
import { requireCsrf } from "../middleware/csrf.js";

export function createConversationsRouter(): RouterType {
  const router: RouterType = Router();

  router.get("/", requireRole("admin", "manager"), async (_req, res, next) => {
    try {
      const conversations = await conversationsService.listConversationSummaries();
      res.json({ conversations });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id", requireRole("admin", "manager"), async (req, res, next) => {
    try {
      const detail = await conversationsService.getConversationDetail(req.params.id as string);
      if (!detail) {
        res.status(404).json({ error: "Conversation not found." });
        return;
      }
      res.json(detail);
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/clear-attention", requireRole("admin", "manager"), requireCsrf, async (req, res, next) => {
    try {
      const detail = await conversationsService.getConversationDetail(req.params.id as string);
      if (!detail) {
        res.status(404).json({ error: "Conversation not found." });
        return;
      }
      await conversationsService.clearNeedsAttention(req.params.id as string);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
