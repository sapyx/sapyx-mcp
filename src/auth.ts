// ============================================================
// Pinterest OAuth 2.0 — Auth Flow, Token Storage & Refresh
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import open from "open";

import type { OAuthTokenResponse, StoredTokens } from "./types.js";

// --------------- Configuration ---------------

const OAUTH_CALLBACK_PORT = 3333;
const OAUTH_REDIRECT_URI = `http://localhost:${OAUTH_CALLBACK_PORT}/callback`;
const OAUTH_SCOPES = "boards:read,boards:write,pins:read,pins:write,user_accounts:read";
const PINTEREST_AUTH_URL = "https://www.pinterest.com/oauth/";
const PINTEREST_TOKEN_URL = "https://api.pinterest.com/v5/oauth/token";
const TOKEN_EXPIRY_BUFFER_MS = 60_000; // Refresh 60s before actual expiry
const OAUTH_TIMEOUT_MS = 120_000; // 2 minutes to complete OAuth

// --------------- Environment ---------------

function getAppId(): string {
  const id = process.env.PINTEREST_APP_ID;
  if (!id) throw new Error("PINTEREST_APP_ID environment variable is not set.");
  return id;
}

function getAppSecret(): string {
  const secret = process.env.PINTEREST_APP_SECRET;
  if (!secret) throw new Error("PINTEREST_APP_SECRET environment variable is not set.");
  return secret;
}

function getBasicAuthHeader(): string {
  const credentials = Buffer.from(`${getAppId()}:${getAppSecret()}`).toString("base64");
  return `Basic ${credentials}`;
}

// --------------- Token Storage ---------------

function getTokenDir(): string {
  return path.join(homedir(), ".mcp-credentials");
}

function getTokenPath(): string {
  return path.join(getTokenDir(), "pinterest-tokens.json");
}

export function loadTokens(): StoredTokens | null {
  // Check for direct access token from environment first
  const envToken = process.env.PINTEREST_ACCESS_TOKEN;
  if (envToken) {
    return {
      access_token: envToken,
      refresh_token: "",
      expires_at: Date.now() + 24 * 60 * 60 * 1000, // Assume 24h validity
      refresh_token_expires_at: 0,
      scope: "pins:read,boards:read,user_accounts:read,ads:read,catalogs:read",
    };
  }

  try {
    const data = fs.readFileSync(getTokenPath(), "utf-8");
    const parsed = JSON.parse(data) as StoredTokens;
    // Basic validation
    if (!parsed.access_token) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveTokens(tokens: StoredTokens): void {
  const dir = getTokenDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(getTokenPath(), JSON.stringify(tokens, null, 2), { mode: 0o600 });
  console.error("[auth] Tokens saved to", getTokenPath());
}

// --------------- OAuth Flow ---------------

/**
 * Starts a temporary HTTP server, opens the browser for Pinterest OAuth,
 * and waits for the callback with the authorization code.
 */
async function waitForAuthorizationCode(state: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const sockets = new Set<import("node:net").Socket>();
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${OAUTH_CALLBACK_PORT}`);

      if (url.pathname !== "/callback") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");

      if (returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h1>Error: state mismatch. Possible CSRF attack.</h1>");
        cleanup();
        reject(new Error("OAuth state mismatch."));
        return;
      }

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h1>Error: no authorization code received.</h1>");
        cleanup();
        reject(new Error("No authorization code in callback."));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`
        <html>
          <body style="font-family: system-ui; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
            <div style="text-align: center;">
              <h1 style="color: #E60023;">✓ Pinterest Connected!</h1>
              <p>You can close this tab and return to Claude.</p>
            </div>
          </body>
        </html>
      `);
      cleanup();
      resolve(code);
    });

    // Track sockets so we can force-close the server
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("OAuth timeout: no callback received within 2 minutes."));
    }, OAUTH_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      for (const socket of sockets) {
        socket.destroy();
      }
      server.close();
    }

    server.listen(OAUTH_CALLBACK_PORT, () => {
      console.error(`[auth] OAuth callback server listening on port ${OAUTH_CALLBACK_PORT}`);
    });

    server.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to start OAuth callback server: ${err.message}`));
    });
  });
}

/**
 * Exchanges an authorization code for access + refresh tokens.
 */
async function exchangeCodeForTokens(code: string): Promise<StoredTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: OAUTH_REDIRECT_URI,
  });

  const response = await fetch(PINTEREST_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: getBasicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as OAuthTokenResponse;

  const tokens: StoredTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    refresh_token_expires_at: data.refresh_token_expires_at * 1000, // API returns seconds
    scope: data.scope,
  };

  return tokens;
}

/**
 * Full OAuth authorization code flow:
 * 1. Start callback server
 * 2. Open browser
 * 3. Wait for code
 * 4. Exchange for tokens
 * 5. Save tokens
 */
export async function startOAuthFlow(): Promise<string> {
  const state = randomUUID();

  const authUrl = new URL(PINTEREST_AUTH_URL);
  authUrl.searchParams.set("consumer_id", getAppId());
  authUrl.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("refreshable", "true");
  authUrl.searchParams.set("scope", OAUTH_SCOPES);
  authUrl.searchParams.set("state", state);

  console.error("[auth] Starting OAuth flow...");
  console.error("[auth] Authorization URL:", authUrl.toString());

  // Start waiting for callback before opening browser
  const codePromise = waitForAuthorizationCode(state);

  // Open browser
  await open(authUrl.toString());
  console.error("[auth] Browser opened. Waiting for authorization...");

  // Wait for the user to authorize
  const code = await codePromise;
  console.error("[auth] Authorization code received. Exchanging for tokens...");

  // Exchange code for tokens
  const tokens = await exchangeCodeForTokens(code);
  saveTokens(tokens);

  console.error("[auth] OAuth flow completed successfully.");
  return "Successfully authenticated with Pinterest!";
}

// --------------- Token Refresh ---------------

async function refreshAccessToken(): Promise<StoredTokens> {
  const tokens = loadTokens();
  if (!tokens?.refresh_token) {
    throw new Error("No refresh token available. Please re-authenticate using pinterest_auth.");
  }

  console.error("[auth] Refreshing access token...");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
  });

  const response = await fetch(PINTEREST_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: getBasicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as OAuthTokenResponse;

  const newTokens: StoredTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? tokens.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    refresh_token_expires_at: data.refresh_token_expires_at
      ? data.refresh_token_expires_at * 1000
      : tokens.refresh_token_expires_at,
    scope: data.scope ?? tokens.scope,
  };

  saveTokens(newTokens);
  console.error("[auth] Access token refreshed successfully.");
  return newTokens;
}

// --------------- Public API ---------------

/**
 * Returns a valid access token, refreshing if necessary.
 * Throws if not authenticated or refresh token has expired.
 */
export async function getValidAccessToken(): Promise<string> {
  // Direct token from environment — no refresh needed
  if (process.env.PINTEREST_ACCESS_TOKEN) {
    return process.env.PINTEREST_ACCESS_TOKEN;
  }

  const tokens = loadTokens();

  if (!tokens) {
    throw new Error("Not authenticated. Use the pinterest_auth tool first, or set PINTEREST_ACCESS_TOKEN env var.");
  }

  // Check if access token is still valid (with buffer)
  if (tokens.expires_at > Date.now() + TOKEN_EXPIRY_BUFFER_MS) {
    return tokens.access_token;
  }

  // No refresh token — can't refresh
  if (!tokens.refresh_token) {
    throw new Error("Access token expired and no refresh token available. Generate a new token or use pinterest_auth.");
  }

  // Access token expired — check refresh token
  if (tokens.refresh_token_expires_at < Date.now()) {
    throw new Error("Refresh token has expired. Please re-authenticate using pinterest_auth.");
  }

  // Refresh the access token
  const newTokens = await refreshAccessToken();
  return newTokens.access_token;
}

/**
 * Returns the current authentication status.
 */
export function getAuthStatus(): {
  authenticated: boolean;
  accessTokenValid: boolean;
  refreshTokenValid: boolean;
  expiresAt: string | null;
  refreshExpiresAt: string | null;
  scopes: string | null;
} {
  const tokens = loadTokens();

  if (!tokens) {
    return {
      authenticated: false,
      accessTokenValid: false,
      refreshTokenValid: false,
      expiresAt: null,
      refreshExpiresAt: null,
      scopes: null,
    };
  }

  const now = Date.now();
  return {
    authenticated: true,
    accessTokenValid: tokens.expires_at > now,
    refreshTokenValid: tokens.refresh_token_expires_at > now,
    expiresAt: new Date(tokens.expires_at).toISOString(),
    refreshExpiresAt: new Date(tokens.refresh_token_expires_at).toISOString(),
    scopes: tokens.scope,
  };
}
