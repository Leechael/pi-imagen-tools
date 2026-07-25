import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/oauth";

const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const XAI_DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;

type JsonObject = Record<string, unknown>;

function requiredString(body: JsonObject, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid xAI OAuth response field: ${field}`);
  }
  return value;
}

function positiveNumber(body: JsonObject, field: string): number {
  const value = body[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid xAI OAuth response field: ${field}`);
  }
  return value;
}

function validateVerificationUri(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:") {
    throw new Error("Untrusted verification URI in xAI OAuth response");
  }
  return url.href;
}

async function postForm(
  fetchImpl: typeof fetch,
  url: string,
  fields: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; body: JsonObject }> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields),
    signal,
  });
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new Error(`xAI OAuth returned invalid JSON (HTTP ${response.status})`);
  }
  return {
    ok: response.ok,
    status: response.status,
    body: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : {},
  };
}

function requestFailure(action: string, response: { status: number; body: JsonObject }): Error {
  const error = typeof response.body.error === "string" ? response.body.error : undefined;
  const description =
    typeof response.body.error_description === "string"
      ? response.body.error_description
      : undefined;
  const detail = [error, description].filter(Boolean).join(": ");
  return new Error(
    `xAI OAuth ${action} failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
  );
}

function credentialsFromTokenResponse(
  body: JsonObject,
  previousRefreshToken?: string,
): OAuthCredentials {
  const access = requiredString(body, "access_token");
  const refresh =
    body.refresh_token === undefined && previousRefreshToken
      ? previousRefreshToken
      : requiredString(body, "refresh_token");
  const expiresInSeconds =
    body.expires_in === undefined
      ? DEFAULT_TOKEN_LIFETIME_SECONDS
      : positiveNumber(body, "expires_in");
  return {
    access,
    refresh,
    expires: Date.now() + expiresInSeconds * 1000 - REFRESH_SKEW_MS,
  };
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Login cancelled"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Login cancelled"));
      },
      { once: true },
    );
  });
}

export function createXaiOAuth(fetchImpl: typeof fetch = fetch) {
  return {
    name: "xAI (Grok/X subscription)",
    async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
      const deviceResponse = await postForm(
        fetchImpl,
        XAI_DEVICE_CODE_URL,
        { client_id: XAI_CLIENT_ID, scope: XAI_SCOPE, referrer: "pi" },
        callbacks.signal,
      );
      if (!deviceResponse.ok) throw requestFailure("device authorization", deviceResponse);

      const deviceCode = requiredString(deviceResponse.body, "device_code");
      const userCode = requiredString(deviceResponse.body, "user_code");
      const verificationUri = validateVerificationUri(
        requiredString(deviceResponse.body, "verification_uri"),
      );
      const complete = deviceResponse.body.verification_uri_complete;
      const expiresInSeconds = positiveNumber(deviceResponse.body, "expires_in");
      let intervalSeconds =
        typeof deviceResponse.body.interval === "number" && deviceResponse.body.interval > 0
          ? deviceResponse.body.interval
          : 5;

      callbacks.onDeviceCode({
        userCode,
        verificationUri:
          typeof complete === "string" && complete.length > 0
            ? validateVerificationUri(complete)
            : verificationUri,
        intervalSeconds,
        expiresInSeconds,
      });

      const deadline = Date.now() + expiresInSeconds * 1000;
      while (Date.now() < deadline) {
        await wait(intervalSeconds * 1000, callbacks.signal);
        const tokenResponse = await postForm(
          fetchImpl,
          XAI_TOKEN_URL,
          {
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            client_id: XAI_CLIENT_ID,
            device_code: deviceCode,
          },
          callbacks.signal,
        );
        if (tokenResponse.ok) return credentialsFromTokenResponse(tokenResponse.body);
        const error = tokenResponse.body.error;
        if (error === "authorization_pending") continue;
        if (error === "slow_down") {
          intervalSeconds += 5;
          continue;
        }
        if (error === "access_denied" || error === "authorization_denied") {
          throw new Error("xAI device authorization was denied");
        }
        if (error === "expired_token") throw new Error("xAI device code expired");
        throw requestFailure("device token polling", tokenResponse);
      }
      throw new Error("xAI device code expired");
    },
    async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
      const response = await postForm(fetchImpl, XAI_TOKEN_URL, {
        grant_type: "refresh_token",
        client_id: XAI_CLIENT_ID,
        refresh_token: credentials.refresh,
      });
      if (!response.ok) throw requestFailure("token refresh", response);
      return credentialsFromTokenResponse(response.body, credentials.refresh);
    },
    getApiKey(credentials: OAuthCredentials): string {
      return credentials.access;
    },
  };
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  if (typeof token !== "string" || !token.includes(".")) return null;
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    let b64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    b64 += "=".repeat((4 - (b64.length % 4)) % 4);
    const parsed = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function extractCodexAccountId(accessToken: string): string | undefined {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return undefined;
  const auth = payload["https://api.openai.com/auth"];
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return undefined;
  const accountId = (auth as { chatgpt_account_id?: unknown }).chatgpt_account_id;
  return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
}
