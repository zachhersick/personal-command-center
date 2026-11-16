// The desktop's music service: history on disk, the Spotify grant in
// config/spotify-oauth.local.json, a ten-minute loop that records plays,
// exchanges them with the cloud and syncs due playlists.
import { isAbsolute } from "node:path";
import { ensurePlanState } from "../plan/state.js";
import { fileSpotifyApi, grantExpiresAt, missingMusicScopes, readSpotifyAuth } from "../spotify.js";
import { createCloudLink } from "./cloud-link.js";
import { createMusicEngine } from "./engine.js";
import { createFileHistory } from "./history.js";
import { importFolder as parseFolder } from "./importers.js";
import { httpError } from "../http.js";

const TICK_MS = 10 * 60_000;
const FIRST_TICK_MS = 20_000;
// Genre and artwork lookups run in the background for most of each tick, in
// short turns so polls and imports never wait long. Spotify lookups are
// spaced several seconds apart (see LOOKUP_GAP_MS), so a few thousand artists
// take most of a day of the desktop running, biggest first.
const ENRICH_MS = TICK_MS - 60_000;
const ENRICH_TURN_MS = 20_000;

export function createMusicService({ dataRoot, loadRuntimeState, saveRuntimeState, serializeTaskMutation, onChange, cloudSettings = async () => null, desktopActions = () => null, spotifyFetch, cloudFetch = fetch, clock = () => Date.now(), enrichGapMs, genreSource, enrichMs = ENRICH_MS }) {
  const history = createFileHistory(dataRoot);
  let cloud = null;
  const link = createCloudLink({ history, settings: () => cloud, fetchImpl: cloudFetch });
  let timer = null;
  let firstTimer = null;
  let retryTimer = null;
  let running = null;
  let lastTick = null;
  let enriching = null;
  let stopped = false;
  // Polls, imports and ticks write the same history files, one at a time.
  let queue = Promise.resolve();
  const serial = (work) => {
    const result = queue.then(work, work);
    queue = result.catch(() => {});
    return result;
  };

  async function spotify() {
    const auth = await readSpotifyAuth(dataRoot());
    if (!auth.refreshToken || missingMusicScopes(auth).length) return null;
    return { api: fileSpotifyApi(dataRoot(), { fetch: spotifyFetch }), source: "l" };
  }

  const engine = createMusicEngine({
    history,
    spotify,
    loadPlan: async () => ensurePlanState((await loadRuntimeState()).plan),
    updatePlan: (work) => serializeTaskMutation(async () => {
      const current = await loadRuntimeState();
      await saveRuntimeState({ ...current, plan: work(ensurePlanState(current.plan)) }, { localFirst: true });
      onChange?.();
    }),
    clock,
    enrichGapMs,
    genreSource,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  });

  async function refreshCloud() {
    const settings = await cloudSettings();
    cloud = settings?.url && settings?.token ? { url: settings.url, token: settings.token } : null;
    return cloud;
  }

  // Record, then bring in what the cloud recorded, then sync. Each step
  // failing on its own doesn't stop the others.
  async function tick() {
    if (running) return running;
    running = serial(async () => {
      const report = { at: new Date(clock()).toISOString(), errors: [] };
      try {
        report.poll = await engine.poll();
      } catch (error) {
        report.errors.push(`Spotify: ${error.message}`);
      }
      let cloudOk = true;
      if (await refreshCloud()) {
        try {
          report.cloud = await link.exchange();
        } catch (error) {
          cloudOk = false;
          await link.fail(error).catch(() => {});
          report.errors.push(`Cloud: ${error.message}`);
        }
      }
      // With the cloud unreachable this computer may be missing plays the
      // cloud recorded; the cloud syncs on its own schedule, so wait.
      if (cloudOk) {
        try {
          report.synced = (await engine.syncDue()).length;
        } catch (error) {
          report.errors.push(`Playlists: ${error.message}`);
        }
      }
      lastTick = report;
      await scheduleRetry().catch(() => {});
      enrichInBackground(cloudOk, report);
      return report;
    }).finally(() => { running = null; });
    return running;
  }

  // A sync Spotify turned away gets tried again the moment Spotify allows,
  // not up to ten minutes later at the next tick.
  async function scheduleRetry() {
    clearTimeout(retryTimer);
    retryTimer = null;
    if (stopped || !timer) return;
    const now = clock();
    const retries = (await engine.playlists())
      .map((rule) => Date.parse(rule.state?.lastResult?.retryAt || "") || 0)
      .filter((at) => at > now && at - now < TICK_MS);
    if (!retries.length) return;
    retryTimer = setTimeout(() => void tick().catch(() => {}), Math.min(...retries) - now + 2000);
    retryTimer.unref?.();
  }

  // Looks up genres and artwork until done, paused by Spotify, held back for
  // playlist syncs, stopped, or the next tick is near. Each turn waits its
  // place behind other music work.
  function enrichInBackground(cloudOk, report) {
    if (enriching) return enriching;
    const until = clock() + enrichMs;
    const total = { tracks: 0, artists: 0 };
    enriching = (async () => {
      let last = {};
      while (!stopped && clock() < until) {
        last = await serial(() => engine.enrich({ deadline: Math.min(until, clock() + ENRICH_TURN_MS) }));
        total.tracks += last.tracks || 0;
        total.artists += last.artists || 0;
        if (last.skipped || last.paused || last.held || last.done) break;
      }
      // Send what was looked up, so the phone shows the same genres and art.
      if (cloudOk && cloud && (total.tracks || total.artists)) await serial(() => link.pushEnrichment());
      report.enriched = { ...last, ...total };
    })()
      .catch((error) => { report.errors.push(`Genres and artwork: ${error.message}`); })
      .finally(() => { enriching = null; });
    return enriching;
  }

  async function status() {
    const auth = await readSpotifyAuth(dataRoot());
    const summary = await history.summary();
    const live = await history.liveState();
    return {
      spotify: {
        connected: Boolean(auth.refreshToken),
        ready: Boolean(auth.refreshToken) && !missingMusicScopes(auth).length,
        reconnect: Boolean(auth.refreshToken) && missingMusicScopes(auth).length > 0,
        grantExpiresAt: grantExpiresAt(auth),
        where: "desktop"
      },
      history: summary,
      cloud: { connected: Boolean(await refreshCloud()), lastExchangeAt: live.cloud?.lastExchangeAt || null, lastError: live.cloud?.lastError || "" },
      lastTick
    };
  }

  return {
    engine,
    history,
    status,
    tick,
    // Reads the folder and reports what importing would change; with apply,
    // merges it in. The files are read again on apply rather than kept.
    async importFolder(folder, { apply = false } = {}) {
      if (!folder || !isAbsolute(folder)) throw httpError(400, "Enter the full path of the folder with your exports.");
      const parsed = await parseFolder(folder);
      const result = { applied: apply };
      const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
      await serial(async () => {
        for (const source of ["spotify", "apple"]) {
          if (!parsed[source]) continue;
          const { tracks, plays, ...rest } = parsed[source];
          const preview = await history.previewExport(source, parsed[source]);
          if (apply) await history.setExport(source, parsed[source], new Date(clock()).toISOString());
          result[source] = {
            ...rest,
            plays: plays.length,
            tracks: tracks.length,
            from: iso(rest.from),
            to: iso(rest.to),
            previous: preview.previous ? { ...preview.previous, from: iso(preview.previous.from), to: iso(preview.previous.to) } : null,
            kept: preview.kept,
            replaced: preview.replaced,
            recorded: preview.recorded,
            older: preview.older
          };
        }
      });
      // Send it to the cloud in the background; the import itself is done.
      if (apply) void tick().catch(() => {});
      return result;
    },
    async pickFolder() {
      const actions = desktopActions();
      if (!actions?.pickFolder) throw httpError(409, "Paste the folder path instead; this Jarvis can't open a folder picker.");
      return actions.pickFolder({ title: "Choose the folder with your Spotify or Apple Music export" });
    },
    poll() {
      return serial(() => engine.poll());
    },
    start() {
      this.stop();
      stopped = false;
      timer = setInterval(() => void tick().catch(() => {}), TICK_MS);
      firstTimer = setTimeout(() => void tick().catch(() => {}), FIRST_TICK_MS);
      timer.unref?.();
      firstTimer.unref?.();
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      clearTimeout(firstTimer);
      clearTimeout(retryTimer);
      timer = null;
      firstTimer = null;
      retryTimer = null;
    }
  };
}
