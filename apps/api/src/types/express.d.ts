import type { AuthUser } from "@luma/shared";

declare global {
  namespace Express {
    interface Request {
      /** Populated by the session middleware. Null when unauthenticated. */
      user: AuthUser | null;
      /** The app_users session row id, when authenticated. */
      sessionId: string | null;
    }
  }
}

export {};
