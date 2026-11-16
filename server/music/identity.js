// Which plays are "the same song". Spotify keeps several track IDs for one
// recording (album, single, deluxe, explicit and clean, remasters), and an
// Apple Music play has to meet its Spotify twin by name. A song is the primary
// artist, the title without release noise, and every tag that marks a
// different performance or mix (live, acoustic, remix, a re-recording, sped
// up). Unknown tags keep songs apart: a false merge would hide a version Zach
// plays, while a missed merge only shows up as two similar entries.

// Words that describe a release, not the recording. A bracket or " - " part
// made only of these (plus years) is dropped.
const RELEASE_WORDS = new Set([
  "remaster", "remastered", "remasterizado", "deluxe", "expanded", "anniversary", "special", "collectors",
  "edition", "version", "bonus", "track", "tracks", "single", "album", "lp", "ep", "original", "mix",
  "explicit", "clean", "dirty", "mono", "stereo", "digital", "digitally", "the", "of", "a", "from"
]);

// Bracket parts that are credits or provenance rather than a version.
const CREDIT = /^(feat|ft|featuring|with|prod|produced by|from)\b/;

// Separators between credited artists. Applied the same way to every source,
// so "A & B" (Apple) and artists ["A", "B"] (Spotify) both give "a".
const ARTIST_SPLIT = /\s*(?:,|;|\s&\s|\sfeat\.?\s|\sft\.?\s|\sfeaturing\s|\swith\s|\sx\s|\svs\.?\s)\s*/;

export function fold(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[‘’'`]/g, "")
    .replace(/&/g, " and ")
    .replace(/\+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function primaryArtist(name) {
  const first = String(name || "").split(ARTIST_SPLIT)[0] || "";
  return fold(first).replace(/^the /, "");
}

// A release-noise part leaves nothing once release words, years and
// ordinals ("10th") are removed.
function versionTag(part) {
  const text = fold(part);
  if (!text || CREDIT.test(text)) return "";
  const words = text.split(" ").filter((word) => !RELEASE_WORDS.has(word) && !/^(19|20)\d\d$/.test(word) && !/^\d+(st|nd|rd|th)$/.test(word));
  return words.join(" ");
}

// "Song (feat. X) - Remastered 2011" -> { base: "song", tags: [] }
// "Song - Live at Wembley"           -> { base: "song", tags: ["live at wembley"] }
export function parseTitle(title) {
  let rest = String(title || "").normalize("NFKC");
  const parts = [];
  const bracket = /\s*[(\[]([^()[\]]*)[)\]]/;
  for (let match = bracket.exec(rest); match; match = bracket.exec(rest)) {
    parts.push(match[1]);
    rest = `${rest.slice(0, match.index)} ${rest.slice(match.index + match[0].length)}`;
  }
  const dashed = rest.split(/\s+[-–—]\s+/);
  let base = dashed.shift() || "";
  parts.push(...dashed);
  // A credit written into the title itself: "Song feat. X".
  base = base.replace(/\s(feat\.?|ft\.|featuring)\s.*$/i, "");
  let baseKey = fold(base);
  if (!baseKey) {
    // A title that is all brackets, such as "(Untitled)".
    baseKey = fold(parts.join(" "));
    return { base: baseKey, tags: [] };
  }
  const tags = [...new Set(parts.map(versionTag).filter(Boolean))].sort();
  return { base: baseKey, tags };
}

// Apple only exports "Artist - Title". Artist names rarely contain " - ";
// titles often do ("Song - Live"), so the first separator splits them.
export function splitAppleDescription(description) {
  const text = String(description || "");
  const at = text.indexOf(" - ");
  if (at < 0) return { artist: "", title: text.trim() };
  return { artist: text.slice(0, at).trim(), title: text.slice(at + 3).trim() };
}

export function songKey(track) {
  if (!track) return "";
  const { base, tags } = parseTitle(track.name);
  const artist = primaryArtist(Array.isArray(track.artists) ? track.artists[0] : track.artist);
  if (!base) return "";
  return `${artist}|${base}|${tags.join(",")}`;
}

function tagsOf(key) {
  return key.slice(key.lastIndexOf("|") + 1);
}

// Groups track refs into songs. Same song key, or the same ISRC with the same
// version tags (spelling differences between releases of one recording).
// catalog: Map(ref -> { name, artists|artist, isrc })
export function groupSongs(refs, catalog) {
  const parent = new Map();
  const find = (ref) => {
    let root = ref;
    while (parent.get(root) !== root) root = parent.get(root);
    for (let at = ref; parent.get(at) !== root;) {
      const next = parent.get(at);
      parent.set(at, root);
      at = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb < ra ? ra : rb, rb < ra ? rb : ra);
  };
  const keys = new Map();
  const byKey = new Map();
  const byIsrc = new Map();
  for (const ref of refs) {
    parent.set(ref, ref);
    const track = catalog.get(ref);
    const key = songKey(track) || `ref|${ref}|`;
    keys.set(ref, key);
    if (byKey.has(key)) union(ref, byKey.get(key));
    else byKey.set(key, ref);
    const isrc = String(track?.isrc || "").toUpperCase();
    if (isrc) {
      const isrcKey = `${isrc}|${tagsOf(key)}`;
      if (byIsrc.has(isrcKey)) union(ref, byIsrc.get(isrcKey));
      else byIsrc.set(isrcKey, ref);
    }
  }
  const groups = new Map();
  for (const ref of refs) {
    const root = find(ref);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(ref);
  }
  return { groups: [...groups.values()], keyOf: (ref) => keys.get(ref) };
}
