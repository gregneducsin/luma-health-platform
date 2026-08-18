import { Router, type Router as RouterType } from "express";
import { verifyUnsubscribeToken } from "../lib/email/unsubscribe.js";
import { setCustomerDnd } from "../services/dnd.service.js";

/**
 * Public, unauthenticated one-click unsubscribe — the destination of the
 * link every automated email carries. Same "not under /api/app or
 * /api/webhooks" reasoning as intake-links.routes.ts: it's a customer's
 * browser following a link, not a dashboard session or a webhook caller.
 */
export function createEmailUnsubscribeRouter(): RouterType {
  const router: RouterType = Router();

  router.get("/:token", async (req, res, next) => {
    try {
      const personId = verifyUnsubscribeToken(req.params.token);
      if (!personId) {
        res.status(400).send("<html><body>This unsubscribe link is invalid.</body></html>");
        return;
      }
      await setCustomerDnd(personId, true);
      res.status(200).send("<html><body>You've been unsubscribed and won't receive further messages from Luma Health.</body></html>");
    } catch (err) {
      next(err);
    }
  });

  return router;
}
