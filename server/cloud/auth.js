// Sign-in for the cloud Jarvis: GitHub OAuth limited to one GitHub account,
// a signed session cookie, and hashed per-device tokens for desktop sync.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "jarvis_session";
export const STATE_COOKIE = "jarvis_oauth_state";
const SESSION_DAYS = 30;

const b64url = (buffer) => Buffer.from(buffer).toString("base64url");

export function sign(value, secret) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createSession(user, secret, now = Date.now()) {
  const payload = b64url(JSON.stringify({ sub: String(user.id), login: user.login, exp: now + SESSION_DAYS * 86_400_000 }));
  return `${payload}.${sign(payload, secret)}`;
}

export function readSession(token, secret, now = Date.now()) {
  if (!token || !secret) return null;
  const [payload, signature] = String(token).split(".");
  if (!payload || !signature || !safeEqual(signature, sign(payload, secret))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return data.exp > now ? data : null;
  } catch {
    return null;
  }
}

export function parseCookies(header = "") {
  const cookies = {};
  for (const part of String(header).split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

export function cookie(name, value, { maxAge, path = "/" } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, "HttpOnly", "Secure", "SameSite=Lax"];
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  return parts.join("; ");
}

export function sessionCookie(token) {
  return cookie(SESSION_COOKIE, token, { maxAge: SESSION_DAYS * 86_400 });
}

export function clearCookie(name) {
  return cookie(name, "", { maxAge: 0 });
}

// ---------- OAuth ----------
export function newOAuthState(secret) {
  const nonce = b64url(randomBytes(18));
  return { nonce, cookieValue: `${nonce}.${sign(nonce, secret)}` };
}

export function checkOAuthState(cookieValue, returned, secret) {
  const [nonce, signature] = String(cookieValue || "").split(".");
  return Boolean(nonce && signature && returned && safeEqual(signature, sign(nonce, secret)) && safeEqual(nonce, returned));
}

export function githubAuthorizeUrl({ clientId, redirectUri, state }) {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, state, allow_signup: "false" }).toString();
  return url.toString();
}

// Exchanges the code and returns the GitHub user. The access token is used
// once to read the profile and then dropped.
export async function githubUser({ code, clientId, clientSecret, redirectUri, fetchImpl = fetch }) {
  const tokenResponse = await fetchImpl("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri })
  });
  const token = await tokenResponse.json();
  if (!token.access_token) throw Object.assign(new Error("GitHub sign-in failed."), { status: 401 });
  const userResponse = await fetchImpl("https://api.github.com/user", {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token.access_token}`, "user-agent": "jarvis-web" }
  });
  if (!userResponse.ok) throw Object.assign(new Error("Couldn't read your GitHub profile."), { status: 401 });
  const user = await userResponse.json();
  return { id: user.id, login: user.login, avatar: user.avatar_url || "" };
}

// ---------- device tokens ----------
export function newDeviceToken() {
  return `jvs_${b64url(randomBytes(32))}`;
}

export function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

export function bearerToken(req) {
  const match = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ""));
  return match ? match[1] : "";
}
