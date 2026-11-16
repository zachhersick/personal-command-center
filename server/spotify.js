import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const AUTH_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const API_URL = "https://api.spotify.com/v1";
// The music tab needs the last 50 plays and the user's own playlists, and
// playlist syncs search for playable versions, which Spotify only allows with
// user-read-private ("Insufficient client scope" without it). Spotify grants
// scopes per sign-in, so adding these asks for one reconnect.
export const MUSIC_SCOPES = ["user-read-recently-played", "playlist-read-private", "playlist-modify-private", "playlist-modify-public", "user-read-private"];
export const SCOPES = ["user-read-currently-playing", "user-read-playback-state", "user-modify-playback-state", ...MUSIC_SCOPES];
// Spotify ends refresh tokens six months after sign-in (since July 2026).
export const GRANT_LIFETIME_MS = 182 * 86_400_000;
const pending = new Map();

function base64url(value) {
  return value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function pkcePair() {
  const verifier = base64url(randomBytes(48));
  return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
}

export function spotifyAuthorizeUrl({ clientId, redirectUri, state, challenge }) {
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: SCOPES.join(" "),
    redirect_uri: redirectUri,
    state,
    code_challenge_method: "S256",
    code_challenge: challenge
  }).toString();
  return url.toString();
}

// Exchanges an authorization code. Returns the stored-auth shape.
export async function exchangeSpotifyCode({ clientId, code, redirectUri, verifier }, fetchFn = fetch, now = Date.now()) {
  const tokens = await tokenRequest({ client_id: clientId, grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier }, fetchFn);
  if (!tokens.refresh_token) throw new Error("Spotify did not return a refresh token. Reconnect and grant access.");
  return {
    clientId,
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    scopes: String(tokens.scope || SCOPES.join(" ")).split(/\s+/).filter(Boolean),
    expiresAt: now + Number(tokens.expires_in || 3600) * 1000,
    authorizedAt: new Date(now).toISOString()
  };
}

export function missingMusicScopes(auth) {
  return MUSIC_SCOPES.filter((scope) => !auth?.scopes?.includes(scope));
}

// When the grant runs out. Grants from before this field existed count from
// the time Jarvis first sees them, which errs on the late side; Spotify's own
// "invalid_grant" answer is what finally asks for a reconnect.
export function grantExpiresAt(auth) {
  return auth?.authorizedAt ? new Date(Date.parse(auth.authorizedAt) + GRANT_LIFETIME_MS).toISOString() : null;
}

async function readJson(path, fallback = {}) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function spotifyError(response, result = {}) {
  const message = result.error_description || result.error?.message || (typeof result.error === "string" ? result.error : "") || `Spotify request failed (${response.status}).`;
  const error = new Error(message);
  error.status = response.status;
  // The sign-in lacks a permission the request needs; only a reconnect fixes it.
  if (response.status === 403 && /insufficient client scope/i.test(message)) {
    error.reconnect = true;
    error.message = "Spotify needs more access for this. Reconnect Spotify in Settings.";
  }
  error.retryAfterMs = Math.max(0, Number(response.headers.get("retry-after") || 0) * 1000);
  return error;
}

async function tokenRequest(body, fetchFn) {
  const response = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = spotifyError(response, result);
    if (result.error === "invalid_grant") {
      error.status = 401;
      error.reconnect = true;
      error.message = "Spotify sign-in expired (Spotify ends them after six months). Reconnect Spotify.";
    }
    throw error;
  }
  return result;
}

// Spotify Web API calls over any token store: a local file on the desktop, a
// database document in the cloud. saveAuth receives the whole auth record.
export function createSpotifyApi({ loadAuth, saveAuth, fetch: fetchFn = fetch, now = () => Date.now() }) {
  async function accessToken(force = false) {
    const auth = (await loadAuth()) || {};
    if (!auth.clientId || !auth.refreshToken) {
      const error = new Error("Spotify is not connected.");
      error.status = 409;
      throw error;
    }
    if (!force && auth.accessToken && Number(auth.expiresAt || 0) > now() + 60000) return auth.accessToken;
    const tokens = await tokenRequest({ client_id: auth.clientId, grant_type: "refresh_token", refresh_token: auth.refreshToken }, fetchFn);
    await saveAuth({
      ...auth,
      refreshToken: tokens.refresh_token || auth.refreshToken,
      accessToken: tokens.access_token,
      scopes: tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : auth.scopes,
      expiresAt: now() + Number(tokens.expires_in || 3600) * 1000
    });
    return tokens.access_token;
  }

  async function request(path, init = {}) {
    const send = async (force = false) => fetchFn(path.startsWith("https://") ? path : `${API_URL}${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${await accessToken(force)}` }
    });
    let response = await send();
    if (response.status === 401) response = await send(true);
    // A short rate-limit pause is worth waiting out; a long one is reported.
    const wait = Number(response.headers.get("retry-after") || 0);
    if (response.status === 429 && wait > 0 && wait <= 5) {
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      response = await send();
    }
    if (!response.ok) throw spotifyError(response, await response.json().catch(() => ({})));
    return response;
  }

  async function json(path, init = {}) {
    const body = init.body && typeof init.body !== "string" ? JSON.stringify(init.body) : init.body;
    const response = await request(path, { ...init, body, headers: body ? { "content-type": "application/json", ...init.headers } : init.headers });
    if (response.status === 204) return null;
    return response.json().catch(() => null);
  }

  return { accessToken, request, json };
}

export function fileSpotifyApi(rootDir, options = {}) {
  const path = spotifyPaths(rootDir).auth;
  return createSpotifyApi({ loadAuth: () => readJson(path), saveAuth: (auth) => writeJson(path, auth), fetch: options.fetch || fetch, now: options.nowMs });
}

export async function readSpotifyAuth(rootDir) {
  return readJson(spotifyPaths(rootDir).auth);
}

export function spotifyPaths(rootDir) {
  return { auth: join(rootDir, "config", "spotify-oauth.local.json") };
}

export async function beginSpotifyConnect(rootDir, { clientId, redirectUri }, options = {}) {
  const path = spotifyPaths(rootDir).auth;
  const existing = await readJson(path);
  const id = String(clientId || existing.clientId || "").trim();
  if (!id || !/^[A-Za-z0-9]+$/.test(id)) throw new Error("A valid Spotify client ID is required.");
  const state = base64url(randomBytes(24));
  const { verifier, challenge } = pkcePair();
  pending.set(state, { clientId: id, verifier, redirectUri, expiresAt: Date.now() + 10 * 60 * 1000 });
  await writeJson(path, existing.clientId && existing.clientId !== id ? { clientId: id } : { ...existing, clientId: id });
  return spotifyAuthorizeUrl({ clientId: id, redirectUri, state, challenge });
}

export async function finishSpotifyConnect(rootDir, { state, code, redirectUri }, options = {}) {
  const flow = pending.get(String(state || ""));
  pending.delete(String(state || ""));
  if (!flow || flow.expiresAt < Date.now() || flow.redirectUri !== redirectUri) throw new Error("Spotify connection expired. Start again.");
  if (!code) throw new Error("Spotify did not return an authorization code.");
  const auth = await exchangeSpotifyCode({ clientId: flow.clientId, code, redirectUri, verifier: flow.verifier }, options.fetch || fetch);
  await writeJson(spotifyPaths(rootDir).auth, auth);
  return spotifyStatus(rootDir, options);
}

async function spotifyApi(rootDir, path, init = {}, options = {}) {
  return fileSpotifyApi(rootDir, options).request(path, init);
}

export function normalizeSpotifyPlayback(value, fetchedAt = Date.now()) {
  const item = value?.item;
  if (!item) return null;
  const episode = item.type === "episode";
  const artists = episode ? [] : (item.artists || []).map((artist) => artist.name).filter(Boolean);
  const subtitle = episode ? item.show?.publisher || item.show?.name || "Podcast" : artists.join(", ") || "Unknown artist";
  const context = episode ? item.show?.name || "Podcast" : item.album?.name || "Spotify";
  const images = episode ? item.images || item.show?.images || [] : item.album?.images || [];
  const disallows = value.actions?.disallows || {};
  const volume = Number(value.device?.volume_percent);
  const volumePercent = Number.isFinite(volume) ? Math.min(100, Math.max(0, Math.round(volume))) : null;
  return {
    type: episode ? "episode" : "track",
    title: item.name || "Unknown title",
    subtitle,
    context,
    imageUrl: images[0]?.url || "",
    spotifyUrl: item.external_urls?.spotify || value.context?.external_urls?.spotify || "https://open.spotify.com/",
    isPlaying: Boolean(value.is_playing),
    progressMs: Math.max(0, Number(value.progress_ms || 0)),
    durationMs: Math.max(0, Number(item.duration_ms || 0)),
    fetchedAt,
    canPlay: !disallows.resuming,
    canPause: !disallows.pausing,
    canPrevious: !disallows.skipping_prev,
    canNext: !disallows.skipping_next,
    volumePercent,
    canSetVolume: volumePercent !== null && Boolean(value.device?.supports_volume) && !value.device?.is_restricted,
    device: value.device?.id ? { id: value.device.id, name: value.device.name || "Unknown device", type: value.device.type || "" } : null
  };
}

export async function currentSpotifyPlayback(rootDir, options = {}) {
  const auth = await readJson(spotifyPaths(rootDir).auth);
  const path = auth.scopes?.includes("user-read-playback-state")
    ? "/me/player?additional_types=track,episode"
    : "/me/player/currently-playing?additional_types=track,episode";
  const response = await spotifyApi(rootDir, path, {}, options);
  if (response.status === 204) return null;
  return normalizeSpotifyPlayback(await response.json(), options.now?.() || Date.now());
}

export async function spotifyStatus(rootDir, options = {}) {
  const auth = await readJson(spotifyPaths(rootDir).auth);
  const status = {
    configured: Boolean(auth.clientId),
    connected: Boolean(auth.refreshToken),
    requiresReconnect: Boolean(auth.refreshToken) && !auth.scopes?.includes("user-read-playback-state"),
    // Playback keeps working without these; only the music tab needs them.
    musicReconnect: Boolean(auth.refreshToken) && missingMusicScopes(auth).length > 0,
    grantExpiresAt: grantExpiresAt(auth),
    playback: null,
    error: "",
    retryAfterMs: 0
  };
  if (!status.connected) return status;
  try {
    status.playback = await currentSpotifyPlayback(rootDir, options);
  } catch (error) {
    status.error = error.status === 401 ? "Spotify authorization expired. Reconnect Spotify." : error.message;
    status.retryAfterMs = error.retryAfterMs || 0;
  }
  return status;
}

export async function controlSpotifyPlayback(rootDir, action, options = {}) {
  const routes = {
    play: { method: "PUT", path: "/me/player/play" },
    pause: { method: "PUT", path: "/me/player/pause" },
    previous: { method: "POST", path: "/me/player/previous" },
    next: { method: "POST", path: "/me/player/next" }
  };
  const route = routes[action];
  if (!route) {
    const error = new Error("Spotify action must be previous, play, pause, or next.");
    error.status = 400;
    throw error;
  }
  await spotifyApi(rootDir, route.path, { method: route.method }, options);
  return currentSpotifyPlayback(rootDir, options);
}

export async function setSpotifyVolume(rootDir, volumePercent, options = {}) {
  const volume = volumePercent;
  if (typeof volume !== "number" || !Number.isInteger(volume) || volume < 0 || volume > 100) {
    const error = new Error("Spotify volume must be an integer from 0 to 100.");
    error.status = 400;
    throw error;
  }
  await spotifyApi(rootDir, `/me/player/volume?volume_percent=${volume}`, { method: "PUT" }, options);
  return currentSpotifyPlayback(rootDir, options);
}

// Spotify Connect devices: this computer, phones, speakers, TVs. A device
// Spotify gives no id for (a private session, say) can't be picked.
export async function listSpotifyDevices(rootDir, options = {}) {
  const response = await spotifyApi(rootDir, "/me/player/devices", {}, options);
  const { devices = [] } = await response.json().catch(() => ({}));
  return devices.filter((device) => device?.id).map((device) => ({
    id: device.id,
    name: device.name || "Unknown device",
    type: device.type || "",
    active: Boolean(device.is_active),
    restricted: Boolean(device.is_restricted)
  }));
}

// Moves playback to another device. `play: false` tells Spotify to keep the
// current state, so a paused track stays paused.
export async function transferSpotifyPlayback(rootDir, deviceId, options = {}) {
  if (typeof deviceId !== "string" || !/^[A-Za-z0-9]{1,128}$/.test(deviceId)) {
    const error = new Error("Choose a Spotify device.");
    error.status = 400;
    throw error;
  }
  await spotifyApi(rootDir, "/me/player", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_ids: [deviceId], play: false })
  }, options);
  // Spotify reports the old device for a moment after a transfer.
  const settle = options.settleMs ?? 700;
  if (settle) await new Promise((resolve) => setTimeout(resolve, settle));
  return currentSpotifyPlayback(rootDir, options);
}

export async function disconnectSpotify(rootDir) {
  await rm(spotifyPaths(rootDir).auth, { force: true });
  pending.clear();
  return { configured: false, connected: false, requiresReconnect: false, musicReconnect: false, grantExpiresAt: null, playback: null, error: "", retryAfterMs: 0 };
}
