import express, { type Express, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import { security } from "./middleware/security.js";
import { corsMiddleware } from "./middleware/cors.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { sessionMiddleware } from "./middleware/session.js";
import { createGeneralLimiter } from "./middleware/rateLimit.js";
import { errorHandler } from "./middleware/errorHandler.js";
import healthRouter from "./routes/health.routes.js";
import { createAuthRouter } from "./routes/auth.routes.js";
import { createCustomersRouter } from "./routes/customers.routes.js";
import { createPurchasesRouter } from "./routes/purchases.routes.js";
import { createQuestionnairesRouter } from "./routes/questionnaires.routes.js";
import { createAiAssistantRouter } from "./routes/ai-assistant.routes.js";
import { createLucyTestRouter } from "./routes/lucy-test.routes.js";
import { createConversationsRouter } from "./routes/conversations.routes.js";
import { createEmployeesRouter } from "./routes/payroll/employees.routes.js";
import { createPayrollWeeksRouter } from "./routes/payroll/weeks.routes.js";
import { createMarketingSpendRouter } from "./routes/payroll/marketing-spend.routes.js";
import { createIntakeLinksRouter } from "./routes/intake-links.routes.js";
import { createGhlLeadWebhookRouter } from "./routes/webhooks/ghl-lead.routes.js";
import { createBaskOrderWebhookRouter } from "./routes/webhooks/bask-order.routes.js";
import { createBaskQuestionnaireWebhookRouter } from "./routes/webhooks/bask-questionnaire.routes.js";
import { createBaskPaymentFailedWebhookRouter } from "./routes/webhooks/bask-payment-failed.routes.js";

export function createApp(): Express {
  const app = express();

  app.set("trust proxy", 1);

  app.use(security);
  app.use(requestLogger);
  app.use(corsMiddleware);
  app.use(express.json());
  app.use(cookieParser());

  // Never cache API responses.
  app.use("/api", (_req: Request, res: Response, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  app.use("/api", healthRouter);
  app.use(createGeneralLimiter());

  // Public, unauthenticated redirect — the destination of a trigger link
  // sent to a lead (e.g. an abandoned-questionnaire nudge). No session
  // cookie, no CSRF token, no webhook secret: it's a customer's browser
  // following a link, not a call from our dashboard or from Bask/GHL.
  app.use("/go", createIntakeLinksRouter());

  // Populate req.user from the session cookie before any route that needs it.
  app.use(sessionMiddleware);

  // Cookie-authenticated browser routes. Individual mutating routes within
  // this family apply CSRF protection themselves (see auth.routes.ts) —
  // deliberately not a blanket router-level CSRF gate, so safe GET routes
  // (csrf-token, me) are never accidentally blocked by it.
  app.use("/api/app/auth", createAuthRouter());
  app.use("/api/app/customers", createCustomersRouter());
  app.use("/api/app/purchases", createPurchasesRouter());
  app.use("/api/app/questionnaires", createQuestionnairesRouter());
  app.use("/api/app/ai-assistant", createAiAssistantRouter());
  app.use("/api/app/lucy-test", createLucyTestRouter());
  app.use("/api/app/conversations", createConversationsRouter());
  app.use("/api/app/payroll/employees", createEmployeesRouter());
  app.use("/api/app/payroll/weeks", createPayrollWeeksRouter());
  app.use("/api/app/payroll/marketing-spend", createMarketingSpendRouter());

  // Webhook routes: shared-secret header auth (see webhookAuth.ts), never
  // session- or CSRF-authenticated — these callers aren't browsers and carry
  // neither a session cookie nor a CSRF token. Kept on a physically separate
  // path prefix from /api/app/* so there's no route where the wrong auth
  // mechanism, or neither, could apply by accident.
  app.use("/api/webhooks/ghl-lead", createGhlLeadWebhookRouter());
  app.use("/api/webhooks/bask-order", createBaskOrderWebhookRouter());
  app.use("/api/webhooks/bask-questionnaire", createBaskQuestionnaireWebhookRouter());
  app.use("/api/webhooks/bask-payment-failed", createBaskPaymentFailedWebhookRouter());

  app.use(errorHandler);

  return app;
}
