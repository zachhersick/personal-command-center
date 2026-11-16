// Playlist syncs come first on Spotify's rate limit; looking up artwork and
// song details only uses what's left. Spotify's limit is per app and shared by
// every computer and the cloud, and a burst of lookups once earned an 11-hour
// Retry-After that held up every sync. So lookups are budgeted, keep clear of
// syncs that are about to run, and wait much longer than Spotify asks after
// any push back, while syncs wait exactly as long as Spotify says.

const HOUR_MS = 60 * 60_000;
// Lookups wait at least this long after a 429, or twice Spotify's wait.
export const LOOKUP_BACKOFF_MS = 6 * HOUR_MS;
// Spotify lookups allowed in any hour on one computer. The cloud gets a
// smaller share per hourly check (see server/cloud/music.js).
export const LOOKUPS_PER_HOUR = 60;
// No lookups start this close to a playlist's next sync.
export const SYNC_QUIET_MS = 15 * 60_000;
const DEFAULT_RETRY_MS = 60_000;

// What the two pauses are, from the stored enrichment state. Records from
// before the split have one pausedUntil, which holds back both.
export function pausesFrom(state = {}) {
  const legacy = Number(state.pausedUntil) || 0;
  return {
    spotify: Math.max(legacy, Number(state.spotifyPausedUntil) || 0),
    lookups: Math.max(legacy, Number(state.spotifyPausedUntil) || 0, Number(state.lookupsPausedUntil) || 0)
  };
}

// The pauses to save after Spotify answered 429, whoever was asking. A
// pause already running longer is kept; a new answer only extends one.
export function pausesAfterLimit(retryAfterMs, now, current = {}) {
  const wait = retryAfterMs > 0 ? retryAfterMs : DEFAULT_RETRY_MS;
  const running = pausesFrom(current);
  return {
    spotifyPausedUntil: Math.max(running.spotify, now + wait),
    lookupsPausedUntil: Math.max(running.lookups, now + Math.max(LOOKUP_BACKOFF_MS, wait * 2))
  };
}

// Counts Spotify lookups over a rolling hour. take() says whether one more
// is allowed and records it when it is.
export function createLookupBudget({ perHour = LOOKUPS_PER_HOUR, clock = () => Date.now() } = {}) {
  let calls = [];
  const trim = () => {
    const since = clock() - HOUR_MS;
    calls = calls.filter((at) => at > since);
  };
  return {
    take() {
      trim();
      if (calls.length >= perHour) return false;
      calls.push(clock());
      return true;
    },
    left() {
      trim();
      return Math.max(0, perHour - calls.length);
    }
  };
}
