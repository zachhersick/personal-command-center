// An in-memory Spotify for music tests and the local sandbox: a fetch that
// answers the token endpoint and the Web API routes Jarvis's music code uses.
// No real account or token is involved.

// Artist IDs are derived from the name, so the same artist on two tracks has one ID.
export function fakeArtistId(name) {
  let hash = 0;
  for (const ch of String(name)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `a${String(hash).padStart(21, "0")}`.slice(0, 22);
}

const image = (seed, width) => ({ url: `https://i.scdn.co/image/${seed}${width}`, width, height: width });

export function fakeTrack(n, name, artists = ["Artist"], extra = {}) {
  const id = String(n).padStart(22, "0");
  return {
    id,
    uri: `spotify:track:${id}`,
    name,
    artists: artists.map((artist) => ({ id: fakeArtistId(artist), name: artist })),
    album: { name: extra.album || "Album", images: [image(`al${n}x`, 640), image(`al${n}x`, 300), image(`al${n}x`, 64)] },
    external_ids: { isrc: extra.isrc || "" },
    duration_ms: extra.durationMs || 200000,
    is_playable: extra.playable !== false,
    ...(extra.restricted ? { restrictions: { reason: "market" } } : {})
  };
}

// genres: { "Artist name": ["deep house", ...] }
export const FAKE_SCOPES = ["user-read-recently-played", "playlist-read-private", "playlist-modify-private", "playlist-modify-public", "user-read-private", "user-read-playback-state", "user-read-currently-playing", "user-modify-playback-state"];

// scopes: what the fake grants on sign-in and refresh. Search answers 403
// "Insufficient client scope" without user-read-private, as Spotify does.
export function createFakeSpotify({ tracks = [], recent = [], userId = "zach", genres = {}, scopes = FAKE_SCOPES } = {}) {
  const artists = new Map();
  for (const track of tracks) for (const artist of track.artists) artists.set(artist.id, { id: artist.id, name: artist.name, genres: genres[artist.name] || [], images: [image(`ar${artist.id}x`, 320), image(`ar${artist.id}x`, 160)] });
  for (const name of Object.keys(genres)) if (!artists.has(fakeArtistId(name))) artists.set(fakeArtistId(name), { id: fakeArtistId(name), name, genres: genres[name], images: [] });
  const state = {
    artists,
    tracks: new Map(tracks.map((track) => [track.id, track])),
    recent: [...recent],
    playlists: new Map(),
    calls: [],
    nextPlaylist: 1,
    tokenRefreshes: 0,
    failNext: null
  };
  const json = (body, status = 200, headers = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  async function fetch(input, init = {}) {
    const url = new URL(String(input));
    const method = init.method || "GET";
    const body = init.body && typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : null;
    if (url.hostname === "accounts.spotify.com") {
      state.tokenRefreshes += 1;
      const form = new URLSearchParams(String(init.body || ""));
      const code = form.get("grant_type") === "authorization_code";
      return json({
        access_token: `fake-access-${state.tokenRefreshes}`,
        ...(code ? { refresh_token: "fake-refresh-from-code" } : {}),
        expires_in: 3600,
        scope: scopes.join(" ")
      });
    }
    const path = url.pathname.replace(/^\/v1/, "");
    state.calls.push(`${method} ${path}`);
    if (state.failNext && state.failNext.match.test(`${method} ${path}`)) {
      const failure = state.failNext;
      state.failNext = null;
      return json({ error: { message: failure.message || "fail" } }, failure.status, failure.headers);
    }
    if (path === "/me/player" || path === "/me/player/currently-playing") return json(null, 204);
    if (path === "/me/player/recently-played") {
      const limit = Number(url.searchParams.get("limit") || 20);
      return json({ items: [...state.recent].sort((a, b) => Date.parse(b.played_at) - Date.parse(a.played_at)).slice(0, limit) });
    }
    let match = /^\/tracks\/([A-Za-z0-9]+)$/.exec(path);
    if (match) {
      const track = state.tracks.get(match[1]);
      return track ? json(track) : json({ error: { message: "Not found" } }, 404);
    }
    match = /^\/artists\/([A-Za-z0-9]+)$/.exec(path);
    if (match) {
      const artist = state.artists.get(match[1]);
      return artist ? json(artist) : json({ error: { message: "Not found" } }, 404);
    }
    if (path === "/search" && !scopes.includes("user-read-private")) return json({ error: { status: 403, message: "Insufficient client scope" } }, 403);
    if (path === "/search" && url.searchParams.get("type") === "artist") {
      const name = /artist:(.*)$/.exec(url.searchParams.get("q") || "")?.[1]?.trim().toLowerCase() || "";
      return json({ artists: { items: [...state.artists.values()].filter((artist) => artist.name.toLowerCase().includes(name)).slice(0, 10) } });
    }
    if (path === "/search") {
      const query = url.searchParams.get("q") || "";
      const title = /track:(.*?)(?: artist:|$)/.exec(query)?.[1]?.trim().toLowerCase() || "";
      const items = [...state.tracks.values()].filter((track) => track.name.toLowerCase().replace(/[^a-z0-9 ]/g, "").includes(title)).slice(0, 10);
      return json({ tracks: { items } });
    }
    if (path === "/me/playlists" && method === "GET") {
      const items = [...state.playlists.values()].map(({ uris, ...playlist }) => playlist);
      return json({ items, next: null });
    }
    if (path === "/me/playlists" && method === "POST") {
      const id = `pl${state.nextPlaylist++}`;
      state.playlists.set(id, { id, name: body.name, description: body.description || "", public: body.public, owner: { id: userId }, uris: [] });
      return json(state.playlists.get(id), 201);
    }
    match = /^\/playlists\/([A-Za-z0-9]+)(\/items)?$/.exec(path);
    if (match) {
      const playlist = state.playlists.get(match[1]);
      if (!playlist) return json({ error: { message: "Not found" } }, 404);
      if (!match[2] && method === "PUT") {
        Object.assign(playlist, { name: body.name ?? playlist.name, description: body.description ?? playlist.description });
        return json(null, 200);
      }
      if (match[2] && method === "GET") {
        const offset = Number(url.searchParams.get("offset") || 0);
        const limit = Number(url.searchParams.get("limit") || 20);
        const page = playlist.uris.slice(offset, offset + limit).map((uri) => ({ item: { uri } }));
        const next = offset + limit < playlist.uris.length ? `https://api.spotify.com/v1/playlists/${playlist.id}/items?offset=${offset + limit}&limit=${limit}` : null;
        return json({ items: page, next });
      }
      if (match[2] && method === "PUT") {
        if ((body.uris || []).length > 100) return json({ error: { message: "Too many" } }, 400);
        playlist.uris = [...body.uris];
        return json({ snapshot_id: "s" }, 200);
      }
      if (match[2] && method === "POST") {
        if ((body.uris || []).length > 100) return json({ error: { message: "Too many" } }, 400);
        playlist.uris.push(...body.uris);
        return json({ snapshot_id: "s" }, 201);
      }
    }
    return json({ error: { message: `Fake Spotify has no ${method} ${path}` } }, 404);
  }

  return { state, fetch };
}

export const FAKE_AUTH = { clientId: "fakeclient", refreshToken: "fake-refresh", accessToken: "", expiresAt: 0, scopes: FAKE_SCOPES, authorizedAt: "2026-11-01T00:00:00.000Z" };
