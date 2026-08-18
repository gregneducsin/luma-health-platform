import { randomBytes } from "node:crypto";
import { Router, type Router as RouterType } from "express";
import { google } from "googleapis";

const DEFAULT_REDIRECT_URI =
  "https://heartfelt-connection-production-d572.up.railway.app/auth/google/callback";

function createOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI ?? DEFAULT_REDIRECT_URI;

  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth environment variables are missing.");
  }

  return new google.auth.OAuth2(
    clientId,
    clientSecret,
    redirectUri,
  );
}

export function createGmailOAuthRouter(): RouterType {
  const router: RouterType = Router();

  router.get("/", (_req, res, next) => {
    try {
      const state = randomBytes(32).toString("hex");

      res.cookie("google_oauth_state", state, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 10 * 60 * 1000,
        path: "/auth/google",
      });

      const authorizationUrl = createOAuthClient().generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        state,
        scope: [
          "https://www.googleapis.com/auth/gmail.modify",
        ],
      });

      res.redirect(authorizationUrl);
    } catch (error) {
      next(error);
    }
  });

  router.get("/callback", async (req, res, next) => {
    try {
      const code =
        typeof req.query.code === "string"
          ? req.query.code
          : "";

      const state =
        typeof req.query.state === "string"
          ? req.query.state
          : "";

      const expectedState = req.cookies.google_oauth_state;

      if (
        !code ||
        !state ||
        !expectedState ||
        state !== expectedState
      ) {
        res
          .status(400)
          .send("Invalid Google authorization response.");
        return;
      }

      res.clearCookie("google_oauth_state", {
        path: "/auth/google",
      });

      const { tokens } =
        await createOAuthClient().getToken(code);

      if (!tokens.refresh_token) {
        res
          .status(400)
          .send(
            "Google did not provide a refresh token. Revoke access and try again.",
          );
        return;
      }

      res
  .status(200)
  .send("Google Workspace connected successfully. You may close this page.");
    } catch (error) {
      next(error);
    }
  });

  return router;
}