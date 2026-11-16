// Cloud storage for jarvis.example.com.
// Versioned JSON documents (the plan, the agents board, music settings),
// desktop device tokens, and listening history (plays and tracks).
// MemoryStore mirrors NeonStore for tests and local runs.
import { bucketStart, localDay } from "../music/rank.js";

export const SCHEMA = `
create table if not exists jarvis_state (
  id text primary key,
  doc jsonb not null,
  version bigint not null default 1,
  updated_at timestamptz not null default now()
);
create table if not exists jarvis_devices (
  id text primary key,
  name text not null,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);
create table if not exists jarvis_music_plays (
  seq bigserial primary key,
  ts bigint not null,
  ref text not null,
  src text not null,
  unique (ts, ref)
);
create index if not exists jarvis_music_plays_ts on jarvis_music_plays (ts);
create table if not exists jarvis_music_tracks (
  ref text primary key,
  info jsonb not null
);
alter table jarvis_music_plays add column if not exists ms integer;
create table if not exists jarvis_music_artists (
  key text primary key,
  info jsonb not null
);
`;

// Listening history: one row per counted play (seconds, track URI, where it
// came from: s Spotify export, a Apple export, l a desktop, c the cloud, and
// the ms heard when known), one row per track with its name, artists, length
// and artwork, and one per artist with genres and photo.
function inRange(ts, from, to) {
  return (from === null || ts >= from) && (to === null || ts <= to);
}

// A play without its listening time counts the track's length.
export const PLAY_MS_SQL = "coalesce(nullif(p.ms, 0), (t.info->>'durationMs')::int, 0)";

export class MemoryStore {
  constructor() {
    this.docs = new Map();
    this.devices = new Map();
    this.plays = new Map();
    this.tracks = new Map();
    this.artists = new Map();
    this.seq = 0;
  }

  heard(play) {
    return play.ms || Number(this.tracks.get(play.ref)?.durationMs) || 0;
  }

  async musicInsertPlays(rows) {
    let added = 0;
    for (const { ts, ref, src, ms = null } of rows) {
      const key = `${ts}|${ref}`;
      if (this.plays.has(key)) continue;
      this.plays.set(key, { seq: ++this.seq, ts, ref, src, ms });
      added += 1;
    }
    return added;
  }

  async musicUpsertTracks(rows) {
    for (const { ref, info } of rows) this.tracks.set(ref, { ...this.tracks.get(ref), ...info });
  }

  async musicUpsertArtists(rows) {
    for (const { key, info } of rows) this.artists.set(key, { ...this.artists.get(key), ...info });
  }

  async musicArtists(keys) {
    return keys.filter((key) => this.artists.has(key)).map((key) => ({ key, info: structuredClone(this.artists.get(key)) }));
  }

  async musicDeletePlays({ srcs, from = null, to = null }) {
    for (const [key, play] of this.plays) if (srcs.includes(play.src) && inRange(play.ts, from, to)) this.plays.delete(key);
  }

  // Recorded plays just after an export ends that repeat one of its streams.
  async musicDeleteEdgeRepeats({ to, window }) {
    const exported = [...this.plays.values()].filter((play) => play.src === "s" && play.ts >= to - window);
    for (const [key, play] of this.plays) {
      if (!["l", "c"].includes(play.src) || play.ts <= to || play.ts > to + window) continue;
      if (exported.some((other) => other.ref === play.ref && Math.abs(other.ts - play.ts) <= window)) this.plays.delete(key);
    }
  }

  async musicCounts({ from = null, to = null }) {
    const counts = new Map();
    for (const play of this.plays.values()) {
      if (!inRange(play.ts, from, to)) continue;
      const entry = counts.get(play.ref) || { ref: play.ref, plays: 0, ms: 0, untimed: 0, first: play.ts, last: 0 };
      const heard = this.heard(play);
      entry.plays += 1;
      entry.ms += heard;
      if (!heard) entry.untimed += 1;
      entry.first = Math.min(entry.first, play.ts);
      entry.last = Math.max(entry.last, play.ts);
      counts.set(play.ref, entry);
    }
    return [...counts.values()];
  }

  async musicTimeline({ from = null, to = null, unit, timeZone, refs = null }) {
    const only = refs ? new Set(refs) : null;
    const days = new Map();
    const buckets = new Map();
    for (const play of this.plays.values()) {
      if (!inRange(play.ts, from, to) || (only && !only.has(play.ref))) continue;
      const start = bucketStart(localDay(play.ts * 1000, timeZone, days), unit);
      const entry = buckets.get(start) || { start, ms: 0, plays: 0 };
      entry.ms += this.heard(play);
      entry.plays += 1;
      buckets.set(start, entry);
    }
    return [...buckets.values()];
  }

  async musicTracks(refs) {
    return refs.filter((ref) => this.tracks.has(ref)).map((ref) => ({ ref, info: structuredClone(this.tracks.get(ref)) }));
  }

  async musicRecent(limit) {
    return [...this.plays.values()].sort((a, b) => b.ts - a.ts).slice(0, limit).map((play) => ({ ts: play.ts, ref: play.ref, ms: this.heard(play) }));
  }

  async musicSummary() {
    let first = null;
    let last = null;
    for (const { ts } of this.plays.values()) {
      if (first === null || ts < first) first = ts;
      if (last === null || ts > last) last = ts;
    }
    return { plays: this.plays.size, first, last };
  }

  async musicPlaysAfter(seq, limit, srcs) {
    return [...this.plays.values()].filter((play) => play.seq > seq && srcs.includes(play.src)).sort((a, b) => a.seq - b.seq).slice(0, limit).map((play) => ({ ...play }));
  }

  async getDoc(id) {
    const row = this.docs.get(id);
    return row ? { doc: structuredClone(row.doc), version: row.version } : { doc: null, version: 0 };
  }

  // Writes only if nobody else wrote since `version`. Returns the new version or 0.
  async putDoc(id, doc, version) {
    const current = this.docs.get(id);
    if ((current?.version || 0) !== version) return 0;
    const next = version + 1;
    this.docs.set(id, { doc: structuredClone(doc), version: next });
    return next;
  }

  async createDevice({ id, name, tokenHash }) {
    this.devices.set(id, { id, name, token_hash: tokenHash, created_at: new Date().toISOString(), last_seen_at: null, revoked_at: null });
  }

  async listDevices() {
    return [...this.devices.values()].filter((device) => !device.revoked_at).map(({ token_hash, ...device }) => device);
  }

  async findDevice(tokenHash) {
    return [...this.devices.values()].find((device) => device.token_hash === tokenHash && !device.revoked_at) || null;
  }

  async touchDevice(id) {
    const device = this.devices.get(id);
    if (device) device.last_seen_at = new Date().toISOString();
  }

  async revokeDevice(id) {
    const device = this.devices.get(id);
    if (!device || device.revoked_at) return false;
    device.revoked_at = new Date().toISOString();
    return true;
  }
}

export class NeonStore {
  constructor(url, { neon } = {}) {
    this.url = url;
    this.neonFactory = neon;
    this.sql = null;
    this.ready = null;
  }

  async init() {
    if (!this.ready) {
      this.ready = (async () => {
        const factory = this.neonFactory || (await import("@neondatabase/serverless")).neon;
        this.sql = factory(this.url);
        for (const statement of SCHEMA.split(";").map((part) => part.trim()).filter(Boolean)) await this.sql.query(statement);
      })().catch((error) => {
        this.ready = null;
        throw error;
      });
    }
    return this.ready;
  }

  async query(text, params = []) {
    await this.init();
    return this.sql.query(text, params);
  }

  async getDoc(id) {
    const rows = await this.query("select doc, version from jarvis_state where id = $1", [id]);
    return rows[0] ? { doc: rows[0].doc, version: Number(rows[0].version) } : { doc: null, version: 0 };
  }

  async putDoc(id, doc, version) {
    const json = JSON.stringify(doc);
    const rows = version === 0
      ? await this.query("insert into jarvis_state (id, doc, version) values ($1, $2::jsonb, 1) on conflict (id) do nothing returning version", [id, json])
      : await this.query("update jarvis_state set doc = $2::jsonb, version = version + 1, updated_at = now() where id = $1 and version = $3 returning version", [id, json, version]);
    return rows[0] ? Number(rows[0].version) : 0;
  }

  async createDevice({ id, name, tokenHash }) {
    await this.query("insert into jarvis_devices (id, name, token_hash) values ($1, $2, $3)", [id, name, tokenHash]);
  }

  async listDevices() {
    return this.query("select id, name, created_at, last_seen_at from jarvis_devices where revoked_at is null order by created_at");
  }

  async findDevice(tokenHash) {
    const rows = await this.query("select id, name from jarvis_devices where token_hash = $1 and revoked_at is null", [tokenHash]);
    return rows[0] || null;
  }

  async touchDevice(id) {
    await this.query("update jarvis_devices set last_seen_at = now() where id = $1", [id]);
  }

  async revokeDevice(id) {
    const rows = await this.query("update jarvis_devices set revoked_at = now() where id = $1 and revoked_at is null returning id", [id]);
    return rows.length > 0;
  }

  async musicInsertPlays(rows) {
    if (!rows.length) return 0;
    const inserted = await this.query(
      "insert into jarvis_music_plays (ts, ref, src, ms) select * from unnest($1::bigint[], $2::text[], $3::text[], $4::int[]) on conflict (ts, ref) do nothing returning seq",
      [rows.map((row) => row.ts), rows.map((row) => row.ref), rows.map((row) => row.src), rows.map((row) => row.ms || null)]
    );
    return inserted.length;
  }

  async musicUpsertArtists(rows) {
    if (!rows.length) return;
    await this.query(
      "insert into jarvis_music_artists (key, info) select k, i::jsonb from unnest($1::text[], $2::text[]) as t(k, i) on conflict (key) do update set info = jarvis_music_artists.info || excluded.info",
      [rows.map((row) => row.key), rows.map((row) => JSON.stringify(row.info))]
    );
  }

  async musicArtists(keys) {
    if (!keys.length) return [];
    return this.query("select key, info from jarvis_music_artists where key = any($1::text[])", [keys]);
  }

  async musicDeleteEdgeRepeats({ to, window }) {
    await this.query(
      "delete from jarvis_music_plays p where p.src in ('l', 'c') and p.ts > $1 and p.ts <= $1 + $2 and exists (select 1 from jarvis_music_plays e where e.src = 's' and e.ref = p.ref and abs(e.ts - p.ts) <= $2)",
      [to, window]
    );
  }

  async musicTimeline({ from = null, to = null, unit, timeZone, refs = null }) {
    if (!["day", "week", "month"].includes(unit)) throw new Error("Unknown timeline unit.");
    const rows = await this.query(
      `select to_char(date_trunc($3, to_timestamp(p.ts) at time zone $4), 'YYYY-MM-DD') as start, count(*)::int as plays, sum(${PLAY_MS_SQL})::bigint as ms
       from jarvis_music_plays p left join jarvis_music_tracks t on t.ref = p.ref
       where ($1::bigint is null or p.ts >= $1) and ($2::bigint is null or p.ts <= $2) and ($5::text[] is null or p.ref = any($5::text[]))
       group by 1`,
      [from, to, unit, timeZone, refs]
    );
    return rows.map((row) => ({ start: row.start, plays: Number(row.plays), ms: Number(row.ms) }));
  }

  // Later details add to earlier ones: Spotify's own metadata (all artists,
  // ISRC) isn't lost when an export with less detail is pushed again.
  async musicUpsertTracks(rows) {
    if (!rows.length) return;
    await this.query(
      "insert into jarvis_music_tracks (ref, info) select r, i::jsonb from unnest($1::text[], $2::text[]) as t(r, i) on conflict (ref) do update set info = jarvis_music_tracks.info || excluded.info",
      [rows.map((row) => row.ref), rows.map((row) => JSON.stringify(row.info))]
    );
  }

  async musicDeletePlays({ srcs, from = null, to = null }) {
    await this.query(
      "delete from jarvis_music_plays where src = any($1::text[]) and ($2::bigint is null or ts >= $2) and ($3::bigint is null or ts <= $3)",
      [srcs, from, to]
    );
  }

  async musicCounts({ from = null, to = null }) {
    const rows = await this.query(
      `select p.ref, count(*)::int as plays, sum(${PLAY_MS_SQL})::bigint as ms, count(*) filter (where ${PLAY_MS_SQL} = 0)::int as untimed, min(p.ts) as first, max(p.ts) as last
       from jarvis_music_plays p left join jarvis_music_tracks t on t.ref = p.ref
       where ($1::bigint is null or p.ts >= $1) and ($2::bigint is null or p.ts <= $2) group by p.ref`,
      [from, to]
    );
    return rows.map((row) => ({ ref: row.ref, plays: Number(row.plays), ms: Number(row.ms), untimed: Number(row.untimed || 0), first: Number(row.first ?? row.last), last: Number(row.last) }));
  }

  async musicTracks(refs) {
    if (!refs.length) return [];
    return this.query("select ref, info from jarvis_music_tracks where ref = any($1::text[])", [refs]);
  }

  async musicRecent(limit) {
    const rows = await this.query(`select p.ts, p.ref, ${PLAY_MS_SQL} as ms from jarvis_music_plays p left join jarvis_music_tracks t on t.ref = p.ref order by p.ts desc limit $1`, [limit]);
    return rows.map((row) => ({ ts: Number(row.ts), ref: row.ref, ms: Number(row.ms) }));
  }

  async musicSummary() {
    const [row] = await this.query("select count(*)::int as plays, min(ts) as first, max(ts) as last from jarvis_music_plays");
    return { plays: Number(row?.plays || 0), first: row?.first == null ? null : Number(row.first), last: row?.last == null ? null : Number(row.last) };
  }

  async musicPlaysAfter(seq, limit, srcs) {
    const rows = await this.query("select seq, ts, ref, src, ms from jarvis_music_plays where seq > $1 and src = any($3::text[]) order by seq limit $2", [seq, limit, srcs]);
    return rows.map((row) => ({ seq: Number(row.seq), ts: Number(row.ts), ref: row.ref, src: row.src, ms: row.ms == null ? 0 : Number(row.ms) }));
  }
}
