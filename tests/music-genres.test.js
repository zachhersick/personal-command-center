import test from "node:test";
import assert from "node:assert/strict";
import { createMusicBrainz, pickGenres } from "../server/music/musicbrainz.js";
import { createEnricher } from "../server/music/enrich.js";
import { rankGenres } from "../server/music/rank.js";
import { MemoryStore } from "../server/cloud/store.js";
import { createCloudHistory, receivePush } from "../server/cloud/music.js";
import { createSpotifyApi } from "../server/spotify.js";
import { createFakeSpotify, fakeTrack, FAKE_AUTH } from "./fake-spotify.js";

// A stand-in for musicbrainz.org: artists linked to Spotify IDs, a name
// search, and an optional run of "busy" answers.
function fakeMusicBrainz({ artists = [], busy = 0 } = {}) {
  const state = { calls: [], busy, userAgent: "" };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  async function fetch(url, init = {}) {
    const { pathname, searchParams } = new URL(url);
    state.calls.push(`${pathname}?${searchParams}`);
    state.userAgent = init.headers?.["user-agent"] || "";
    if (state.busy > 0) {
      state.busy -= 1;
      return json({ error: "busy" }, 503);
    }
    if (pathname === "/ws/2/url") {
      const id = /open\.spotify\.com\/artist\/([A-Za-z0-9]+)/.exec(searchParams.get("resource"))?.[1];
      const artist = artists.find((entry) => entry.spotifyId && entry.spotifyId === id);
      if (!artist) return json({ error: "Not Found" }, 404);
      return json({ relations: [{ "target-type": "artist", artist: { id: artist.mbid, name: artist.name } }] });
    }
    if (pathname === "/ws/2/artist") {
      const name = /artist:"(.+)"/.exec(searchParams.get("query"))?.[1] || "";
      const hits = artists.filter((entry) => entry.name.toLowerCase().includes(name.toLowerCase()));
      return json({ artists: hits.map((entry) => ({ id: entry.mbid, name: entry.name, score: 100 })) });
    }
    const mbid = /^\/ws\/2\/artist\/(.+)$/.exec(pathname)?.[1];
    const artist = artists.find((entry) => entry.mbid === mbid);
    if (!artist) return json({ error: "Not Found" }, 404);
    return json({ id: artist.mbid, name: artist.name, genres: artist.genres });
  }
  return { fetch, state };
}

const brainz = (fake) => createMusicBrainz({ fetchImpl: fake.fetch, gapMs: 0, sleep: async () => {} });

test("MusicBrainz genres come from the artist linked to the Spotify ID, strongest first", async () => {
  const fake = fakeMusicBrainz({ artists: [{ mbid: "mb-1", name: "Nirvana", spotifyId: "6olE6TJLqED3rqDCT0FyPh", genres: [{ name: "rock", count: 26 }, { name: "grunge", count: 68 }, { name: "punk", count: 2 }] }] });
  const found = await brainz(fake).genres({ spotifyId: "6olE6TJLqED3rqDCT0FyPh", name: "Nirvana" });
  assert.deepEqual(found, { mbid: "mb-1", genres: ["grunge", "rock"] }, "a genre with a tiny share of votes is noise");
  assert.match(fake.state.userAgent, /^JarvisMusicStats\/\S+ \(/, "MusicBrainz asks for a named client");
  assert.doesNotMatch(fake.state.userAgent, /@|github/i, "and gets no personal details");
});

test("a name search is used only when exactly one artist has that exact name", async () => {
  const fake = fakeMusicBrainz({ artists: [
    { mbid: "mb-a", name: "Nirvana", genres: [{ name: "grunge", count: 5 }] },
    { mbid: "mb-b", name: "Nirvana", genres: [{ name: "psychedelic pop", count: 5 }] },
    { mbid: "mb-c", name: "Mexican Slum Rats", genres: [{ name: "garage punk", count: 2 }] },
    { mbid: "mb-d", name: "Mexican Slum Rats Tribute", genres: [{ name: "pop", count: 9 }] }
  ] });
  const client = brainz(fake);
  assert.equal(await client.genres({ spotifyId: "", name: "Nirvana" }), null, "two exact matches: no guess");
  assert.deepEqual(await client.genres({ spotifyId: "0000000000000000000000", name: "Mexican Slum Rats" }), { mbid: "mb-c", genres: ["garage punk"] });
  assert.deepEqual(pickGenres([]), []);
});

function enrichHistory(counts, catalog, artists = {}) {
  const saved = { tracks: {}, artists: { ...artists }, pausedUntil: null };
  return {
    saved,
    async counts() { return counts; },
    async catalog(refs) { return new Map([...refs].map((ref) => [ref, { ...catalog.get(ref), ...saved.tracks[ref] }])); },
    async artists(keys) { return new Map([...keys].filter((key) => saved.artists[key]).map((key) => [key, saved.artists[key]])); },
    async enrichState() { return { pausedUntil: saved.pausedUntil }; },
    async saveEnrichment({ tracks = {}, artists: next = {}, pausedUntil }) {
      Object.assign(saved.tracks, tracks);
      Object.assign(saved.artists, next);
      if (pausedUntil !== undefined) saved.pausedUntil = pausedUntil;
    }
  };
}

function spotifyApi(fake) {
  let auth = { ...FAKE_AUTH };
  return createSpotifyApi({ loadAuth: async () => auth, saveAuth: async (next) => { auth = next; }, fetch: fake.fetch });
}

test("lookups fill genres from MusicBrainz, including artists Spotify already checked with none", async () => {
  const tracks = [fakeTrack(1, "Lithium", ["Nirvana"]), fakeTrack(2, "Breather", ["Chris Stussy"])];
  const spotify = createFakeSpotify({ tracks });
  const nirvanaId = tracks[0].artists[0].id;
  const mb = fakeMusicBrainz({ artists: [
    { mbid: "mb-n", name: "Nirvana", spotifyId: nirvanaId, genres: [{ name: "grunge", count: 10 }] },
    { mbid: "mb-s", name: "Chris Stussy", spotifyId: tracks[1].artists[0].id, genres: [{ name: "deep house", count: 4 }, { name: "house", count: 3 }] }
  ] });
  const counts = new Map([[tracks[0].uri, { plays: 5, ms: 5_000, last: 1 }], [tracks[1].uri, { plays: 1, ms: 1_000, last: 1 }]]);
  const catalog = new Map([[tracks[0].uri, { name: "Lithium", artist: "Nirvana" }], [tracks[1].uri, { name: "Breather", artist: "Chris Stussy" }]]);
  // Spotify was asked about Nirvana before, and had no genres.
  const history = enrichHistory(counts, catalog, { nirvana: { checkedAt: 5, id: nirvanaId, name: "Nirvana", genres: [], image: "https://i.scdn.co/image/n" } });
  const report = await createEnricher({ api: spotifyApi(spotify), history, gapMs: 0, clock: () => 1000, genreSource: brainz(mb) }).run();
  assert.equal(report.done, true);
  assert.deepEqual(history.saved.artists.nirvana.genres, ["grunge"]);
  assert.equal(history.saved.artists.nirvana.image, "https://i.scdn.co/image/n", "the picture stays");
  assert.ok(!spotify.state.calls.some((call) => call.includes(nirvanaId)), "Nirvana wasn't asked of Spotify again");
  assert.deepEqual(history.saved.artists["chris stussy"].genres, ["deep house", "house"]);
  assert.ok(history.saved.artists["chris stussy"].image, "Spotify still gives the picture");
  const { genres, known } = rankGenres(counts, catalog, new Map(Object.entries(history.saved.artists)));
  assert.deepEqual(genres.map((genre) => genre.name), ["grunge", "deep house", "house"]);
  assert.equal(known, 1);

  const calls = mb.state.calls.length;
  await createEnricher({ api: spotifyApi(spotify), history, gapMs: 0, clock: () => 2000, genreSource: brainz(mb) }).run();
  assert.equal(mb.state.calls.length, calls, "looked-up genres aren't asked again");
});

test("a busy MusicBrainz skips genres for the run without losing pictures", async () => {
  const tracks = [fakeTrack(1, "Song", ["Some Act"])];
  const spotify = createFakeSpotify({ tracks });
  const mb = fakeMusicBrainz({ busy: 5, artists: [{ mbid: "mb-1", name: "Some Act", spotifyId: tracks[0].artists[0].id, genres: [{ name: "indie", count: 3 }] }] });
  const counts = new Map([[tracks[0].uri, { plays: 1, ms: 100, last: 1 }]]);
  const history = enrichHistory(counts, new Map([[tracks[0].uri, { name: "Song", artist: "Some Act" }]]));
  const first = await createEnricher({ api: spotifyApi(spotify), history, gapMs: 0, clock: () => 1000, genreSource: brainz(mb) }).run();
  assert.ok(history.saved.artists["some act"].image, "the picture is saved");
  assert.equal(history.saved.artists["some act"].genresAt, undefined, "genres are still to do");
  assert.equal(first.done, false);
  mb.state.busy = 0;
  await createEnricher({ api: spotifyApi(spotify), history, gapMs: 0, clock: () => 2000, genreSource: brainz(mb) }).run();
  assert.deepEqual(history.saved.artists["some act"].genres, ["indie"]);
});

test("the cloud keeps MusicBrainz genres pushed by the desktop", async () => {
  const store = new MemoryStore();
  await receivePush(store, { src: "s", tracks: [], plays: [], artists: [["nirvana", { checkedAt: 1, genresAt: 2, mbid: "5b11f4ce-a62d-471e-81fc-a69a8278c7da", id: "6olE6TJLqED3rqDCT0FyPh", genres: ["grunge"], image: "" }]] });
  const artist = (await createCloudHistory(store).artists(["nirvana"])).get("nirvana");
  assert.deepEqual(artist.genres, ["grunge"]);
  assert.equal(artist.genresAt, 2);
});

test("genre coverage doesn't count artists Spotify checked but whose genres weren't looked up", () => {
  const counts = new Map([["spotify:track:0000000000000000000001", { plays: 1, ms: 300, last: 1 }], ["spotify:track:0000000000000000000002", { plays: 1, ms: 100, last: 1 }]]);
  const catalog = new Map([["spotify:track:0000000000000000000001", { artist: "Checked Only" }], ["spotify:track:0000000000000000000002", { artist: "Looked Up" }]]);
  const artists = new Map([["checked only", { checkedAt: 1, genres: [] }], ["looked up", { checkedAt: 1, genresAt: 2, genres: ["indie"] }]]);
  assert.equal(rankGenres(counts, catalog, artists).known, 0.25);
});
