import test from "node:test";
import assert from "node:assert/strict";
import { groupSongs, parseTitle, primaryArtist, songKey, splitAppleDescription } from "../server/music/identity.js";

const same = (a, b) => assert.equal(songKey(a), songKey(b), `${a.name} and ${b.name} should be one song`);
const different = (a, b) => assert.notEqual(songKey(a), songKey(b), `${a.name} and ${b.name} should stay separate`);
const t = (name, artists = ["Fleetwood Mac"]) => ({ name, artists });

test("album, single, deluxe, explicit and remastered releases are one song", () => {
  same(t("Dreams"), t("Dreams - 2004 Remaster"));
  same(t("Dreams"), t("Dreams (Remastered 2011)"));
  same(t("Dreams"), t("Dreams - Remastered Version"));
  same(t("Dreams"), t("Dreams - Single Version"));
  same(t("Dreams"), t("Dreams [Deluxe Edition]"));
  same(t("Dreams"), t("Dreams (Explicit)"));
  same(t("Dreams"), t("Dreams - Bonus Track"));
  same(t("Dreams"), t("Dreams (2011 Remastered Album Version)"));
  same(t("Dreams"), t("Dreams - Mono Version"));
  same(t("Dreams"), t("DREAMS!"));
});

test("featured credits don't make a separate song", () => {
  same(t("Señorita", ["Shawn Mendes", "Camila Cabello"]), t("Senorita (feat. Camila Cabello)", ["Shawn Mendes"]));
  same(t("Song feat. Someone", ["A"]), t("Song", ["A"]));
  same(t("Song (with B)", ["A"]), t("Song", ["A", "B"]));
});

test("live, acoustic, remix, re-recorded and sped up versions stay separate", () => {
  different(t("Dreams"), t("Dreams - Live"));
  different(t("Dreams"), t("Dreams (Live at the Forum 1977)"));
  different(t("Dreams - Live at the Forum"), t("Dreams - Live in Boston"));
  different(t("Dreams"), t("Dreams - Acoustic"));
  different(t("Dreams"), t("Dreams (Acoustic Version)"));
  different(t("Dreams"), t("Dreams - Demo"));
  different(t("Dreams"), t("Dreams - Instrumental"));
  different(t("Dreams"), t("Dreams (Sped Up)"));
  different(t("Dreams"), t("Dreams (Slowed + Reverb)"));
  different(t("Dreams"), t("Dreams - Radio Edit"));
  different(t("Love Story", ["Taylor Swift"]), t("Love Story (Taylor's Version)", ["Taylor Swift"]));
  different(t("Song", ["A"]), t("Song - B Remix", ["A"]));
  different(t("Song - B Remix", ["A"]), t("Song - C Remix", ["A"]));
});

test("a live remaster is the same live song", () => {
  same(t("Dreams - Live - Remastered 2011"), t("Dreams - Live"));
});

test("different artists or titles are different songs", () => {
  different(t("Dreams", ["Fleetwood Mac"]), t("Dreams", ["The Cranberries"]));
  different(t("Dreams"), t("Dream"));
});

test("Apple descriptions meet their Spotify twin", () => {
  const apple = splitAppleDescription("Fleetwood Mac - Dreams (2004 Remaster)");
  assert.deepEqual(apple, { artist: "Fleetwood Mac", title: "Dreams (2004 Remaster)" });
  same({ name: apple.title, artist: apple.artist }, t("Dreams"));
  const duo = splitAppleDescription("Simon & Garfunkel - The Boxer");
  same({ name: duo.title, artist: duo.artist }, t("The Boxer", ["Simon & Garfunkel"]));
  const live = splitAppleDescription("Artist - Song - Live");
  assert.deepEqual(live, { artist: "Artist", title: "Song - Live" });
});

test("primary artist ignores collaborators and a leading 'The'", () => {
  assert.equal(primaryArtist("The Weeknd, Daft Punk"), "weeknd");
  assert.equal(primaryArtist("A & B"), "a");
  assert.equal(primaryArtist("A feat. B"), "a");
  assert.equal(primaryArtist("AC/DC"), "ac dc");
});

test("titles made only of brackets still get a key", () => {
  assert.deepEqual(parseTitle("(Untitled)"), { base: "untitled", tags: [] });
  assert.ok(songKey(t("(Untitled)")));
});

test("the same ISRC merges differently spelled releases but not other versions", () => {
  const catalog = new Map([
    ["spotify:track:a", { name: "Dont Stop", artists: ["Fleetwood Mac"], isrc: "USWB10001" }],
    ["spotify:track:b", { name: "Don't Stop - 2004 Remaster", artists: ["Fleetwood Mac"], isrc: "uswb10001" }],
    ["spotify:track:c", { name: "Don't Stop (Original Mono Mix)", artists: ["Fleetwood Mac"] }],
    ["spotify:track:d", { name: "Don't Stop - Live", artists: ["Fleetwood Mac"], isrc: "USWB10001" }],
    ["spotify:track:e", { name: "Go Your Own Way", artists: ["Fleetwood Mac"] }]
  ]);
  const { groups } = groupSongs([...catalog.keys()], catalog);
  const sorted = groups.map((group) => group.sort().join(" ")).sort();
  assert.deepEqual(sorted, ["spotify:track:a spotify:track:b spotify:track:c", "spotify:track:d", "spotify:track:e"]);
});

test("tracks with no metadata stay on their own", () => {
  const catalog = new Map([["spotify:track:x", null], ["spotify:track:y", null]]);
  assert.equal(groupSongs(["spotify:track:x", "spotify:track:y"], catalog).groups.length, 2);
});
