import { Router, type Router as RouterType } from "express";
import { sendSupportConversationReplyRequestSchema } from "@luma/shared";
import * as supportConversationsService from "../services/support-conversations.service.js";
import { requireRole } from "../middleware/requireAuth.js";
import { requireCsrf } from "../middleware/csrf.js";

export function createSupportConversationsRouter(): RouterType {
  const router: RouterType = Router();

  router.get("/", requireRole("admin", "manager"), async (_req, res, next) => {
    try {
      const conversations = await supportConversationsService.listSupportConversationSummaries();
      res.json({ conversations });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id", requireRole("admin", "manager"), async (req, res, next) => {
    try {
      const detail = await supportConversationsService.getSupportConversationDetail(req.params.id as string);
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
      const detail = await supportConversationsService.getSupportConversationDetail(req.params.id as string);
      if (!detail) {
        res.status(404).json({ error: "Conversation not found." });
        return;
      }
      await supportConversationsService.clearSupportNeedsAttention(req.params.id as string);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/reply", requireRole("admin", "manager"), requireCsrf, async (req, res, next) => {
    try {
      const parsed = sendSupportConversationReplyRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid payload.", details: parsed.error.issues });
        return;
      }
      const result = await supportConversationsService.sendStaffReply(req.params.id as string, parsed.data.body);
      if (!result.sent && result.reason === "not_found") {
        res.status(404).json({ error: "Conversation not found." });
        return;
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
