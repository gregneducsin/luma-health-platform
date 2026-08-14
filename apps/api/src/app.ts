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

  // Populate req.user from the session cookie before any route that needs it.
  app.use(sessionMiddleware);

  // Cookie-authenticated browser routes. Individual mutating routes within
  // this family apply CSRF protection themselves (see auth.routes.ts) —
  // deliberately not a blanket router-level CSRF gate, so safe GET routes
  // (csrf-token, me) are never accidentally blocked by it. A future
  // /webhooks/* router (Phase 5) is authenticated by shared-secret header
  // instead and must never have CSRF applied to it.
  app.use("/api/app/auth", createAuthRouter());

  app.use(errorHandler);

  return app;
}
