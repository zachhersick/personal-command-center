// Desktop side of the music cloud link. Pushes imported history and the plays
// this computer recorded to the Jarvis cloud, and pulls the plays the cloud
// (or another computer) recorded while this one was off, and the imports
// another computer made, so every desktop has the same history.
//
// Sent: per play only its time, track URI and listening time, plus each
// track's name, artist and album and what Spotify said about tracks and
// artists (length, artwork, genres). Nothing else from the exports (no IP
// addresses, devices or countries) leaves this computer.

const BATCH = 5000;
const ENRICH_BATCH = 2000;
const SOURCE_CODES = { spotify: "s", apple: "a" };

function trackPayload(ref, track) {
  const extra = {};
  if (track?.durationMs) extra.durationMs = track.durationMs;
  if (track?.image) extra.image = track.image;
  return [ref, track?.name || "", Array.isArray(track?.artists) && track.artists.length ? track.artists : track?.artist || "", track?.album || "", track?.isrc || "", extra];
}

export function createCloudLink({ history, settings, fetchImpl = fetch }) {
  async function call(path, { method = "GET", body } = {}) {
    const { url, token } = settings();
    const response = await fetchImpl(`${url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw Object.assign(new Error(data.error || `Music cloud sync failed (${response.status}).`), { status: response.status });
    return data;
  }

  async function pushExport(source, record) {
    const code = source === "spotify" ? "s" : "a";
    const sent = new Set();
    for (let at = 0, first = true; first || at < record.plays.length; at += BATCH, first = false) {
      const slice = record.plays.slice(at, at + BATCH);
      const tracks = [];
      for (const [, index] of slice) {
        const row = record.tracks[index];
        if (sent.has(row[0])) continue;
        sent.add(row[0]);
        tracks.push(trackPayload(row[0], { name: row[1], artist: row[2], album: row[3] }));
      }
      await call("/api/music/push", {
        method: "POST",
        body: {
          src: code,
          reset: first,
          // The cloud drops its recorded plays only where this import is new.
          range: first ? { from: record.from, to: record.to, importedAt: record.importedAt, replaceFrom: record.lastImport?.from ?? record.from, replaceTo: record.lastImport?.to ?? record.to } : undefined,
          done: at + BATCH >= record.plays.length,
          tracks,
          plays: slice.map(([sec, index, ms]) => [sec, record.tracks[index][0], ms || 0])
        }
      });
    }
  }

  async function pushLive(live) {
    const plays = await history.livePlays({ after: live.cloud.livePushedThrough ?? -Infinity, src: "l" });
    for (let at = 0; at < plays.length; at += BATCH) {
      const slice = plays.slice(at, at + BATCH);
      const refs = [...new Set(slice.map(([, ref]) => ref))];
      const known = await history.liveTracks(refs);
      const catalog = await history.catalog(refs);
      await call("/api/music/push", {
        method: "POST",
        body: { src: "l", tracks: refs.map((ref) => trackPayload(ref, { ...catalog.get(ref), ...known[ref] })), plays: slice.map(([sec, ref, , ms]) => [sec, ref, ms || 0]) }
      });
      await history.updateLive({ cloud: { livePushedThrough: slice[slice.length - 1][0] } });
    }
  }

  async function pull(live) {
    let after = live.cloud.pulledSeq ?? 0;
    let added = 0;
    for (let page = 0; page < 50; page += 1) {
      const data = await call(`/api/music/plays?after=${after}&limit=${BATCH}`);
      if (!data.plays?.length) break;
      // Stored as cloud plays, so they aren't pushed back up as this computer's.
      added += await history.addPlays(data.plays.map(([, sec, ref, , heard]) => ({ ms: sec * 1000, ref, src: "c", heard: heard || 0 })), data.tracks || {});
      after = data.plays[data.plays.length - 1][0];
      await history.updateLive({ cloud: { pulledSeq: after } });
      if (data.plays.length < BATCH) break;
    }
    return added;
  }

  // An import pushed by another computer, when this one has none or an older
  // one. Downloaded whole and kept only if the cloud's import didn't change
  // meanwhile; marked as pushed so it never goes back up.
  async function pullExports(live) {
    const cloud = await call("/api/music/exports");
    const pulled = {};
    for (const [source, code] of Object.entries(SOURCE_CODES)) {
      const remote = cloud[source];
      const pushedKey = `${source}Pushed`;
      if (!remote?.complete || !remote.importedAt || live.cloud[pushedKey] === remote.importedAt) continue;
      const local = await history.exportRecord(source);
      if (local && Date.parse(local.importedAt) >= Date.parse(remote.importedAt)) continue;
      const tracks = [];
      const at = new Map();
      const plays = [];
      for (let after = 0; ;) {
        const data = await call(`/api/music/plays?src=${code}&after=${after}&limit=${BATCH}`);
        for (const [, sec, ref, , ms] of data.plays || []) {
          let index = at.get(ref);
          if (index === undefined) {
            const info = data.tracks?.[ref] || {};
            index = tracks.length;
            at.set(ref, index);
            tracks.push([ref, info.name || "", info.artist || info.artists?.[0] || "", info.album || ""]);
          }
          plays.push([sec, index, ms || 0]);
        }
        if (!data.plays?.length || data.plays.length < BATCH) break;
        after = data.plays[data.plays.length - 1][0];
      }
      const check = (await call("/api/music/exports"))[source];
      if (check?.importedAt !== remote.importedAt || !check.complete) continue;
      plays.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      await history.replaceExport(source, { importedAt: remote.importedAt, from: remote.from, to: remote.to, tracks, plays });
      await history.updateLive({ cloud: { [pushedKey]: remote.importedAt } });
      pulled[source] = plays.length;
    }
    return pulled;
  }

  // Track lengths and artwork, and artist genres and photos, looked up since
  // the last push.
  async function pushEnrichment() {
    const live = await history.liveState();
    const since = live.cloud.enrichPushedAt || 0;
    const { tracks, artists } = await history.enrichedSince(since);
    const trackRows = Object.entries(tracks).filter(([, value]) => !value.missing);
    const artistRows = Object.entries(artists);
    let newest = since;
    for (const [, value] of [...trackRows, ...artistRows]) newest = Math.max(newest, value.checkedAt || 0);
    for (let at = 0; at < Math.max(trackRows.length, artistRows.length); at += ENRICH_BATCH) {
      await call("/api/music/push", {
        method: "POST",
        body: {
          src: "l",
          plays: [],
          tracks: trackRows.slice(at, at + ENRICH_BATCH).map(([ref, value]) => [ref, "", value.artists || "", "", "", { durationMs: value.durationMs, image: value.image }]),
          artists: artistRows.slice(at, at + ENRICH_BATCH).map(([key, value]) => [key, value])
        }
      });
    }
    if (newest > since) await history.updateLive({ cloud: { enrichPushedAt: newest } });
    return { tracks: trackRows.length, artists: artistRows.length };
  }

  return {
    pushEnrichment,
    // One full exchange. Imports go up once per import; plays both ways.
    async exchange() {
      if (!settings()) return { skipped: true };
      let live = await history.liveState();
      for (const source of ["apple", "spotify"]) {
        const record = await history.exportRecord(source);
        const pushedKey = `${source}Pushed`;
        if (record && live.cloud[pushedKey] !== record.importedAt) {
          await pushExport(source, record);
          await history.updateLive({ cloud: { [pushedKey]: record.importedAt } });
          live = await history.liveState();
        }
      }
      const imports = await pullExports(live);
      await pushLive(await history.liveState());
      await pushEnrichment();
      const pulled = await pull(await history.liveState());
      await history.updateLive({ cloud: { lastExchangeAt: new Date().toISOString(), lastError: "" } });
      return { pulled, imports };
    },
    async fail(error) {
      await history.updateLive({ cloud: { lastError: error.message } });
    }
  };
}
