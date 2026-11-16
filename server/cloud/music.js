// Music in the cloud: the listening history the desktop pushes, plays the
// cloud records itself when a free scheduler calls /api/music/tick hourly,
// and playlist syncs while the PC is off.
//
// The cloud has its own Spotify sign-in (made from the web app), kept
// encrypted in the database. It never shares a refresh token with the
// desktop, because Spotify may rotate a token on use.
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { httpError, readJsonBody } from "../http.js";
import { ensurePlanState } from "../plan/state.js";
import { createMusicEngine, LOOKUP_GAP_MS } from "../music/engine.js";
import { createMusicApi } from "../music/routes.js";
import { isSpotifyTrack } from "../music/rank.js";
import { EDGE_SECONDS } from "../music/rank.js";
import { createSpotifyApi, exchangeSpotifyCode, grantExpiresAt, missingMusicScopes, pkcePair, spotifyAuthorizeUrl } from "../spotify.js";
import { bearerToken, clearCookie, cookie, hashToken, newDeviceToken, parseCookies, sign } from "./auth.js";

const PUSH_LIMIT = 4_000_000;
const MAX_ROWS = 10_000;
const TICK_BUDGET_MS = 40_000;
// The cloud's share of Spotify lookups per hourly check; each check is a
// fresh process, so this is also its hourly share. Desktops do the bulk.
const CLOUD_LOOKUPS_PER_TICK = 20;
const ENRICH_RECENT_MS = 30 * 86_400_000;
const PKCE_COOKIE = "jarvis_spotify_pkce";
const META = "musicMeta";
const AUTH = "musicSpotify";
const RESOLVE = "musicResolve";
const SOURCES = new Set(["s", "a", "l"]);

// ---------- sealed token storage ----------
function sealKey(secret) {
  return createHash("sha256").update(`jarvis-music-spotify:${secret}`).digest();
}

export function seal(value, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealKey(secret), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64url")).join(".");
}

export function unseal(sealed, secret) {
  try {
    const [iv, tag, data] = String(sealed || "").split(".").map((part) => Buffer.from(part, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", sealKey(secret), iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8"));
  } catch {
    return null;
  }
}

// Read-modify-write of a document with the store's optimistic versions.
async function updateDoc(store, id, change) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { doc, version } = await store.getDoc(id);
    const next = change(doc || {});
    if (await store.putDoc(id, next, version)) return next;
  }
  throw httpError(409, "Music settings changed too many times at once. Try again.");
}

const SPOTIFY_IMAGE = /^https:\/\/i\.scdn\.co\/image\/[A-Za-z0-9]{1,100}$/;

function cleanImage(value) {
  return SPOTIFY_IMAGE.test(String(value || "")) ? String(value) : "";
}

function trackInfo([, name, artist, album, isrc, extra]) {
  const info = {};
  if (name) info.name = String(name).slice(0, 300);
  if (Array.isArray(artist) && artist.length) info.artists = artist.map((value) => String(value).slice(0, 200)).slice(0, 20);
  else if (artist) info.artist = String(artist).slice(0, 300);
  if (album) info.album = String(album).slice(0, 300);
  if (isrc) info.isrc = String(isrc).slice(0, 20);
  const duration = Math.round(Number(extra?.durationMs));
  if (duration > 0 && duration < 24 * 3_600_000) info.durationMs = duration;
  const image = cleanImage(extra?.image);
  if (image) info.image = image;
  if (Array.isArray(extra?.artistIds)) info.artistIds = extra.artistIds.map(String).filter((id) => /^[A-Za-z0-9]{22}$/.test(id)).slice(0, 20);
  if (extra?.checkedAt) info.checkedAt = Number(extra.checkedAt) || 0;
  return info;
}

function artistInfo(value) {
  return {
    checkedAt: Number(value?.checkedAt) || Date.now(),
    id: /^[A-Za-z0-9]{22}$/.test(String(value?.id || "")) ? value.id : "",
    name: String(value?.name || "").slice(0, 200),
    genres: (Array.isArray(value?.genres) ? value.genres : []).map((genre) => String(genre).slice(0, 80)).slice(0, 30),
    image: cleanImage(value?.image),
    ...(Number(value?.genresAt) > 0 ? { genresAt: Number(value.genresAt) } : {}),
    ...(/^[0-9a-f-]{36}$/.test(String(value?.mbid || "")) ? { mbid: value.mbid } : {}),
    ...(value?.missing ? { missing: true } : {})
  };
}

const validRef = (ref) => isSpotifyTrack(ref) || /^apple:\d{1,20}$/.test(String(ref || ""));
const validKey = (key) => typeof key === "string" && key.length > 0 && key.length <= 200;
const heardOf = (value) => {
  const ms = Math.round(Number(value));
  return ms > 0 && ms < 24 * 3_600_000 ? ms : null;
};

// The history interface the engine expects, over the cloud database.
export function createCloudHistory(store) {
  const meta = async () => (await store.getDoc(META)).doc || {};
  const insideExport = (info, sec) => Boolean(info.spotifyExport && sec * 1000 >= info.spotifyExport.from && sec * 1000 <= info.spotifyExport.to);
  return {
    async counts({ from = null, to = Infinity } = {}) {
      const rows = await store.musicCounts({ from: from === null ? null : Math.floor(from / 1000), to: Number.isFinite(to) ? Math.ceil(to / 1000) : null });
      return new Map(rows.map((row) => [row.ref, { plays: row.plays, ms: row.ms || 0, untimed: row.untimed || 0, first: (row.first ?? row.last) * 1000, last: row.last * 1000 }]));
    },
    async timeline({ from = null, to = Infinity, unit = "day", timeZone = "UTC", refs = null } = {}) {
      return store.musicTimeline({ from: from === null ? null : Math.floor(from / 1000), to: Number.isFinite(to) ? Math.ceil(to / 1000) : null, unit, timeZone, refs: refs ? [...refs] : null });
    },
    async catalog(refs) {
      const list = [...refs];
      const found = new Map((await store.musicTracks(list)).map((row) => [row.ref, row.info]));
      return new Map(list.map((ref) => [ref, found.get(ref) || null]));
    },
    async artists(keys = []) {
      const list = [...keys];
      return new Map((await store.musicArtists(list)).map((row) => [row.key, row.info]));
    },
    async recent(limit = 50) {
      const rows = await store.musicRecent(limit);
      const catalog = await this.catalog(rows.map((row) => row.ref));
      return rows.map((row) => ({ at: new Date(row.ts * 1000).toISOString(), ref: row.ref, ms: row.ms || 0, track: catalog.get(row.ref) }));
    },
    async enrichState() {
      const doc = await meta();
      return { pausedUntil: doc.enrichPausedUntil || null, spotifyPausedUntil: doc.spotifyPausedUntil || null, lookupsPausedUntil: doc.lookupsPausedUntil || null };
    },
    async saveEnrichment({ tracks = {}, artists = {}, pausedUntil, spotifyPausedUntil, lookupsPausedUntil } = {}) {
      await store.musicUpsertTracks(Object.entries(tracks).filter(([ref]) => validRef(ref)).map(([ref, value]) => ({ ref, info: trackInfo([ref, "", value.artists || "", "", "", { ...value, checkedAt: value.checkedAt }]) })));
      await store.musicUpsertArtists(Object.entries(artists).filter(([key]) => validKey(key)).map(([key, value]) => ({ key, info: artistInfo(value) })));
      const pauses = {
        ...(pausedUntil !== undefined ? { enrichPausedUntil: pausedUntil } : {}),
        ...(spotifyPausedUntil !== undefined ? { spotifyPausedUntil } : {}),
        ...(lookupsPausedUntil !== undefined ? { lookupsPausedUntil } : {})
      };
      if (Object.keys(pauses).length) await updateDoc(store, META, (doc) => ({ ...doc, ...pauses }));
    },
    async summary() {
      const info = await meta();
      const totals = await store.musicSummary();
      const source = (value) => (value ? { importedAt: value.importedAt, from: new Date(value.from).toISOString(), to: new Date(value.to).toISOString() } : null);
      return {
        plays: totals.plays,
        first: totals.first === null ? null : new Date(totals.first * 1000).toISOString(),
        last: totals.last === null ? null : new Date(totals.last * 1000).toISOString(),
        spotifyExport: source(info.spotifyExport),
        appleExport: source(info.appleExport),
        tracked: { lastPollAt: info.lastPollAt || null, lastError: info.lastError || "", gaps: info.gaps || [] }
      };
    },
    async addPlays(plays, tracks = {}) {
      const info = await meta();
      const rows = plays.filter((play) => validRef(play.ref) && !insideExport(info, Math.floor(play.ms / 1000))).map((play) => ({ ts: Math.floor(play.ms / 1000), ref: play.ref, src: play.src === "l" ? "l" : "c", ms: heardOf(play.heard) }));
      await store.musicUpsertTracks(Object.entries(tracks).filter(([ref, track]) => validRef(ref) && track).map(([ref, track]) => ({ ref, info: trackInfo([ref, track.name, track.artists || track.artist, track.album, track.isrc, track]) })));
      return store.musicInsertPlays(rows);
    },
    async liveState() {
      const info = await meta();
      return { cursorMs: info.cursorMs ?? null, lastPollAt: info.lastPollAt || null, lastError: info.lastError || "", gaps: info.gaps || [], cloud: {} };
    },
    async updateLive(patch) {
      const { gap, cloud, ...rest } = patch;
      await updateDoc(store, META, (doc) => ({ ...doc, ...rest, ...(gap ? { gaps: [...(doc.gaps || []), gap].slice(-50) } : {}) }));
    },
    async readResolveCache() {
      return (await store.getDoc(RESOLVE)).doc || {};
    },
    async writeResolveCache(value) {
      // A lost race only costs a few repeated Spotify checks.
      const { version } = await store.getDoc(RESOLVE);
      await store.putDoc(RESOLVE, value, version);
    }
  };
}

// Applies one batch from a desktop. The first batch of an import replaces
// that source; a Spotify export also replaces polled plays in its range.
export async function receivePush(store, body) {
  const src = String(body.src || "");
  if (!SOURCES.has(src)) throw httpError(400, "Unknown play source.");
  const plays = Array.isArray(body.plays) ? body.plays : [];
  const tracks = Array.isArray(body.tracks) ? body.tracks : [];
  const artists = Array.isArray(body.artists) ? body.artists : [];
  if (plays.length > MAX_ROWS || tracks.length > MAX_ROWS || artists.length > MAX_ROWS) throw httpError(413, `Send at most ${MAX_ROWS} rows at a time.`);
  if (body.reset && src !== "l") {
    const range = body.range || {};
    if (!Number.isFinite(range.from) || !Number.isFinite(range.to)) throw httpError(400, "An import needs its date range.");
    // The whole source is sent again; recorded plays go only where the new
    // export has the real ones.
    const replaceFrom = Number.isFinite(range.replaceFrom) ? range.replaceFrom : range.from;
    const replaceTo = Number.isFinite(range.replaceTo) ? range.replaceTo : range.to;
    await store.musicDeletePlays({ srcs: [src] });
    if (src === "s") await store.musicDeletePlays({ srcs: ["l", "c"], from: Math.floor(replaceFrom / 1000), to: Math.ceil(replaceTo / 1000) });
    await updateDoc(store, META, (doc) => ({ ...doc, [src === "s" ? "spotifyExport" : "appleExport"]: { from: range.from, to: range.to, replaceTo, importedAt: String(range.importedAt || new Date().toISOString()), complete: false } }));
  }
  await store.musicUpsertTracks(tracks.filter((row) => Array.isArray(row) && validRef(row[0])).map((row) => ({ ref: row[0], info: trackInfo(row) })));
  await store.musicUpsertArtists(artists.filter((row) => Array.isArray(row) && validKey(row[0])).map(([key, value]) => ({ key, info: artistInfo(value) })));
  const info = (await store.getDoc(META)).doc || {};
  const rows = plays
    .filter((row) => Array.isArray(row) && Number.isInteger(row[0]) && validRef(row[1]))
    .filter(([sec]) => src !== "l" || !(info.spotifyExport && sec * 1000 >= info.spotifyExport.from && sec * 1000 <= info.spotifyExport.to))
    .map(([ts, ref, ms]) => ({ ts, ref, src, ms: heardOf(ms) }));
  const added = await store.musicInsertPlays(rows);
  if (body.done && src !== "l") {
    const doc = await updateDoc(store, META, (current) => {
      const key = src === "s" ? "spotifyExport" : "appleExport";
      return { ...current, [key]: { ...current[key], complete: true } };
    });
    if (src === "s" && Number.isFinite(doc.spotifyExport?.replaceTo)) await store.musicDeleteEdgeRepeats({ to: Math.floor(doc.spotifyExport.replaceTo / 1000), window: EDGE_SECONDS });
  }
  return { added };
}

export function createCloudMusic({ store, config, fetchImpl = fetch, sendJson, sameOrigin, savePlanDoc, clock = () => Date.now(), enrichGapMs = LOOKUP_GAP_MS }) {
  const history = createCloudHistory(store);

  async function loadAuth() {
    const { doc } = await store.getDoc(AUTH);
    return doc?.sealed ? unseal(doc.sealed, config.sessionSecret) : null;
  }

  async function saveAuth(auth) {
    await updateDoc(store, AUTH, (doc) => ({ ...doc, sealed: seal(auth, config.sessionSecret) }));
  }

  async function spotify() {
    const auth = await loadAuth();
    if (!auth?.refreshToken || missingMusicScopes(auth).length) return null;
    return { api: createSpotifyApi({ loadAuth, saveAuth, fetch: fetchImpl, now: clock }), source: "c" };
  }

  const loadPlan = async () => ensurePlanState((await store.getDoc("plan")).doc);
  const engine = createMusicEngine({
    lookupsPerHour: CLOUD_LOOKUPS_PER_TICK,
    history,
    spotify,
    loadPlan,
    updatePlan: async (work) => {
      await savePlanDoc(store, work(await loadPlan()));
    },
    clock,
    enrichGapMs,
    timeZone: config.timeZone || "UTC"
  });

  async function status() {
    const auth = await loadAuth();
    const { doc } = await store.getDoc(AUTH);
    return {
      spotify: {
        connected: Boolean(auth?.refreshToken),
        ready: Boolean(auth?.refreshToken) && !missingMusicScopes(auth).length,
        reconnect: Boolean(auth?.refreshToken) && missingMusicScopes(auth).length > 0,
        grantExpiresAt: grantExpiresAt(auth),
        where: "cloud"
      },
      history: await history.summary(),
      tick: { configured: Boolean(doc?.tickTokenHash), lastTickAt: doc?.lastTickAt || null, lastResult: doc?.lastTickResult || null }
    };
  }

  const api = createMusicApi({
    engine,
    status,
    loadRuntimeState: async () => ({ plan: (await store.getDoc("plan")).doc || undefined }),
    saveRuntimeState: async (next) => savePlanDoc(store, next.plan),
    serializeTaskMutation: (work) => work(),
    sendJson,
    allowWrite: sameOrigin,
    timeZone: config.timeZone || "UTC"
  });

  async function tick() {
    const started = clock();
    const result = { at: new Date(started).toISOString(), errors: [] };
    try {
      result.poll = await engine.poll();
    } catch (error) {
      result.errors.push(`Spotify: ${error.message}`);
    }
    try {
      result.synced = (await engine.syncDue({ deadline: started + TICK_BUDGET_MS })).map((entry) => ({ id: entry.id, ok: entry.lastResult?.ok !== false }));
    } catch (error) {
      result.errors.push(`Playlists: ${error.message}`);
    }
    // Genres and artwork for what was played lately, in the time left. The
    // desktop looks up the rest of the history and sends it here.
    if (clock() < started + TICK_BUDGET_MS - 3000) {
      try {
        result.enriched = await engine.enrich({ deadline: started + TICK_BUDGET_MS, from: clock() - ENRICH_RECENT_MS });
      } catch (error) {
        result.errors.push(`Genres and artwork: ${error.message}`);
      }
    }
    await updateDoc(store, AUTH, (doc) => ({ ...doc, lastTickAt: result.at, lastTickResult: { added: result.poll?.added || 0, synced: result.synced?.length || 0, errors: result.errors } }));
    return result;
  }

  // Routes that don't use the signed-in session: the scheduler's tick and
  // the desktop's push/pull. Returns undefined when the path isn't one.
  async function handleToken(req, res, url, device) {
    const path = url.pathname;
    if (path === "/api/music/tick" && ["GET", "POST"].includes(req.method)) {
      const token = bearerToken(req) || url.searchParams.get("token") || "";
      const { doc } = await store.getDoc(AUTH);
      if (!token || !doc?.tickTokenHash || hashToken(token) !== doc.tickTokenHash) return sendJson(res, { ok: false, error: "Unknown tick token." }, 401);
      return sendJson(res, { ok: true, ...(await tick()) });
    }
    if (path === "/api/music/push" && req.method === "POST") {
      if (!(await device(req))) return sendJson(res, { ok: false, error: "Unknown or revoked device token." }, 401);
      return sendJson(res, { ok: true, ...(await receivePush(store, await readJsonBody(req, { limit: PUSH_LIMIT }))) });
    }
    // The imports another computer pushed, so a desktop without them (a Mac
    // next to the PC that holds the export files) can download them.
    if (path === "/api/music/exports" && req.method === "GET") {
      if (!(await device(req))) return sendJson(res, { ok: false, error: "Unknown or revoked device token." }, 401);
      const info = (await store.getDoc(META)).doc || {};
      const describe = (value) => (value && Number.isFinite(value.from) ? { from: value.from, to: value.to, importedAt: value.importedAt || null, complete: Boolean(value.complete) } : null);
      return sendJson(res, { ok: true, spotify: describe(info.spotifyExport), apple: describe(info.appleExport) });
    }
    if (path === "/api/music/plays" && req.method === "GET") {
      if (!(await device(req))) return sendJson(res, { ok: false, error: "Unknown or revoked device token." }, 401);
      const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
      const limit = Math.min(MAX_ROWS, Math.max(1, Number(url.searchParams.get("limit")) || 5000));
      // Recorded plays by default; src=s or src=a pages through one import.
      const src = url.searchParams.get("src");
      const plays = await store.musicPlaysAfter(after, limit, ["s", "a"].includes(src) ? [src] : ["l", "c"]);
      const refs = [...new Set(plays.map((play) => play.ref))];
      const tracks = Object.fromEntries((await store.musicTracks(refs)).map((row) => [row.ref, row.info]));
      return sendJson(res, { ok: true, plays: plays.map((play) => [play.seq, play.ts, play.ref, play.src, play.ms || 0]), tracks });
    }
    return undefined;
  }

  // Session routes: Spotify sign-in for the cloud, the tick token, and the
  // shared music API.
  async function handleSession(req, res, url) {
    const path = url.pathname;
    const redirectUri = `${config.appUrl}/api/music/spotify/callback`;
    if (path === "/api/music/spotify/connect" && req.method === "POST") {
      const body = await readJsonBody(req);
      const current = await loadAuth();
      const clientId = String(body.clientId || current?.clientId || "").trim();
      if (!/^[A-Za-z0-9]{8,64}$/.test(clientId)) throw httpError(400, "Enter the Client ID of your Spotify app.");
      const state = randomBytes(18).toString("base64url");
      const { verifier, challenge } = pkcePair();
      const value = `${state}.${verifier}.${clientId}`;
      return sendJson(res, { ok: true, authorizationUrl: spotifyAuthorizeUrl({ clientId, redirectUri, state, challenge }), redirectUri }, 200, {
        "set-cookie": cookie(PKCE_COOKIE, `${value}.${sign(value, config.sessionSecret)}`, { maxAge: 600, path: "/api/music/spotify" })
      });
    }
    if (path === "/api/music/spotify/callback" && req.method === "GET") {
      const raw = parseCookies(req.headers.cookie)[PKCE_COOKIE] || "";
      const parts = raw.split(".");
      const [state, verifier, clientId, signature] = parts;
      const clear = { "set-cookie": clearCookie(PKCE_COOKIE) };
      const back = (outcome) => {
        res.writeHead(302, { location: `/?spotify=${outcome}#music`, "cache-control": "no-store", ...clear });
        res.end();
      };
      const expected = Buffer.from(sign(`${state}.${verifier}.${clientId}`, config.sessionSecret));
      const given = Buffer.from(String(signature || ""));
      if (parts.length !== 4 || given.length !== expected.length || !timingSafeEqual(given, expected) || state !== url.searchParams.get("state")) return back("expired");
      if (!url.searchParams.get("code")) return back("denied");
      try {
        const auth = await exchangeSpotifyCode({ clientId, code: url.searchParams.get("code"), redirectUri, verifier }, fetchImpl, clock());
        await saveAuth(auth);
        // Polling starts from now; earlier plays come from the desktop.
        await updateDoc(store, META, (doc) => ({ ...doc, cursorMs: doc.cursorMs ?? null }));
        return back("connected");
      } catch {
        return back("failed");
      }
    }
    if (path === "/api/music/spotify/disconnect" && req.method === "POST") {
      await updateDoc(store, AUTH, ({ sealed, ...doc }) => doc);
      return sendJson(res, { ok: true, status: await status() });
    }
    if (path === "/api/music/tick-token" && req.method === "POST") {
      const token = newDeviceToken().replace(/^jvs_/, "jvt_");
      await updateDoc(store, AUTH, (doc) => ({ ...doc, tickTokenHash: hashToken(token) }));
      return sendJson(res, { ok: true, token, url: `${config.appUrl}/api/music/tick` });
    }
    return api.handle(req, res, url);
  }

  return { engine, history, handleToken, handleSession, tick, status };
}
