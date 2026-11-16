import { useEffect, useRef, useState } from "preact/hooks";
import { html } from "../html.js";
import { Icon } from "../icons.js";
import { Bar, Button, Empty, Field, IconButton, Modal, Skeleton, Tabs } from "../ui.js";
import { post } from "../api.js";
import { reportError, settingsOpen, toast } from "../store.js";
import { isWeb } from "../platform.js";
import {
  ago, customRange, dayRange, describeInterval, describePeriod, describeWindow, editing, genre, genres, hours, INTERVALS, loadGenres, loadMusic, loadRecent,
  loadTimeline, loadTop, localDay, minutes, music, musicAction, openArtist, period, PERIODS, recent, shortDate, tab, timeline, top, until
} from "./state.js";
import { Art, ArtistLink, artistOf, RankList, Timeline } from "./charts.js";
import { ArtistSheet } from "./artist.js";

const TABS = [
  { id: "stats", label: "Stats", icon: "wave" },
  { id: "playlists", label: "Synced playlists", icon: "list" },
  { id: "setup", label: "Setup", icon: "settings" }
];

function openSpotifySetup() {
  if (isWeb.value) tab.value = "setup";
  else settingsOpen.value = true;
}

function StatusLine() {
  const status = music.value?.status;
  if (!status) return null;
  const { spotify, history } = status;
  const gaps = history.tracked?.gaps?.length || 0;
  const since = history.first ? ` since ${shortDate(history.first)}` : "";
  return html`<p class="muted music-status">
    <span>${history.plays.toLocaleString()} plays${since}</span>
    ${spotify.ready ? html`<span><${Icon} name="wave" size=${14} /> Recording · checked ${ago(history.tracked?.lastPollAt)}</span>`
      : spotify.reconnect ? html`<button type="button" class="link warn" onClick=${openSpotifySetup}>Reconnect Spotify to record plays and sync playlists</button>`
        : html`<button type="button" class="link" onClick=${openSpotifySetup}>Connect Spotify to record plays</button>`}
    ${gaps ? html`<button type="button" class="link warn" onClick=${() => { tab.value = "setup"; }}>${gaps} gap${gaps === 1 ? "" : "s"} in tracking</button>` : null}
    ${history.tracked?.lastError ? html`<span class="danger">${history.tracked.lastError}</span>` : null}
  </p>`;
}

// ---------- filters ----------
// A popover closes on a tap outside it or Escape.
function useDismiss(open, close, box) {
  useEffect(() => {
    if (!open) return undefined;
    const away = (event) => { if (box.current && !box.current.contains(event.target)) close(); };
    const escape = (event) => { if (event.key === "Escape") close(); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
}

function PeriodControl() {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useDismiss(open, () => setOpen(false), box);
  const range = customRange.value;
  const thisYear = Boolean(range?.year);
  const custom = Boolean(range) && !thisYear;
  const year = new Date().getFullYear();
  const [draft, setDraft] = useState(() => (custom ? range : { fromDay: localDay(new Date(Date.now() - 30 * 86_400_000)), toDay: localDay() }));
  const choose = (days) => {
    customRange.value = null;
    period.value = days;
    setOpen(false);
  };
  const apply = (event) => {
    event.preventDefault();
    if (!draft.fromDay || !draft.toDay || draft.fromDay > draft.toDay) return toast("Pick a start date on or before the end date.", { tone: "danger" });
    customRange.value = { fromDay: draft.fromDay, toDay: draft.toDay };
    setOpen(false);
  };
  const chooseYear = () => {
    customRange.value = { year: true };
    setOpen(false);
  };
  return html`<div class="music-period" ref=${box}>
    <div class="music-periods" role="group" aria-label="Period">
      ${PERIODS.map((entry) => {
        const active = !range && entry.days === period.value;
        return html`<button type="button" class=${`chip ${active ? "is-active" : ""}`} aria-pressed=${active ? "true" : "false"} onClick=${() => choose(entry.days)}>${entry.label}</button>`;
      })}
      <button type="button" class=${`chip ${thisYear ? "is-active" : ""}`} aria-pressed=${thisYear ? "true" : "false"} title=${`Your ${year} so far`} onClick=${chooseYear}>${year}</button>
      <button type="button" class=${`chip ${custom ? "is-active" : ""}`} aria-pressed=${custom ? "true" : "false"} aria-expanded=${open ? "true" : "false"} onClick=${() => setOpen(!open)}>
        <${Icon} name="calendar" size=${14} /> ${custom ? describePeriod() : "Custom"}
      </button>
    </div>
    ${open ? html`<form class="music-popover music-dates" onSubmit=${apply}>
      <label><span class="small muted">From</span><input class="input" type="date" required value=${draft.fromDay} max=${draft.toDay || undefined} onInput=${(event) => setDraft({ ...draft, fromDay: event.currentTarget.value })} /></label>
      <label><span class="small muted">To</span><input class="input" type="date" required value=${draft.toDay} min=${draft.fromDay || undefined} onInput=${(event) => setDraft({ ...draft, toDay: event.currentTarget.value })} /></label>
      <div class="row gap-2"><${Button} size="sm" variant="ghost" onClick=${() => setOpen(false)}>Cancel</${Button}><${Button} size="sm" variant="primary" type="submit">Show</${Button}></div>
    </form>` : null}
  </div>`;
}

// Genre picker: the genres in your history, or any words ("house" covers
// deep house, tech house and the rest).
function GenrePicker({ value, onChange, placeholder = "Any genre", id }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const box = useRef(null);
  const input = useRef(null);
  useDismiss(open, () => setOpen(false), box);
  useEffect(() => {
    if (open && !genres.value) loadGenres();
    if (open) input.current?.focus();
  }, [open]);
  const query = text.trim().toLowerCase();
  // Words that start with what was typed, the way the filter itself matches.
  const starts = (name) => query.split(/\s+/).every((part) => name.split(/[\s-]+/).some((word) => word.startsWith(part)));
  const list = (genres.value?.genres || []).filter((entry) => !query || starts(entry.name)).slice(0, 40);
  const pick = (name) => {
    onChange(name);
    setText("");
    setOpen(false);
  };
  return html`<div class="music-genre" ref=${box}>
    ${value ? html`<span class="chip is-active music-genre-chip">
        <button type="button" class="link" onClick=${() => setOpen(!open)} aria-haspopup="listbox" id=${id}>${value}</button>
        <button type="button" class="music-chip-x" aria-label=${`Clear genre ${value}`} onClick=${() => onChange("")}><${Icon} name="x" size=${13} /></button>
      </span>`
      : html`<button type="button" class="chip" id=${id} aria-haspopup="listbox" aria-expanded=${open ? "true" : "false"} onClick=${() => setOpen(!open)}><${Icon} name="music" size=${14} /> ${placeholder}</button>`}
    ${open ? html`<div class="music-popover music-genre-pop">
      <form onSubmit=${(event) => { event.preventDefault(); if (query) pick(query); }}>
        <input class="input" ref=${input} placeholder="house, deep house, indie…" aria-label="Genre" value=${text} onInput=${(event) => setText(event.currentTarget.value)} />
      </form>
      ${query ? html`<button type="button" class="music-genre-option is-free" onClick=${() => pick(query)}>Everything matching “${query}”</button>` : null}
      <div class="music-genre-list" role="listbox">
        ${!genres.value ? html`<span class="small muted">Loading genres…</span>`
          : !list.length ? html`<span class="small muted">${genres.value.genres.length ? "No genre with that name yet." : "Genres appear as Jarvis looks up your artists."}</span>`
            : list.map((entry) => html`<button type="button" role="option" class="music-genre-option" onClick=${() => pick(entry.name)}><span>${entry.name}</span><span class="muted small">${hours(entry.ms)} h</span></button>`)}
      </div>
    </div>` : null}
  </div>`;
}

// ---------- stats ----------
// onOpen makes the whole card a button (the top artist opens their stats).
function Feature({ label, title, sub, image, round, ms, onOpen }) {
  const inner = html`<${Art} src=${image} name=${title} size=${72} round=${round} />
    <div>
      <span class="card-eyebrow">${label}</span>
      <strong title=${title}>${title || "—"}</strong>
      <span class="muted small">${sub}</span>
      ${ms ? html`<span class="small">${minutes(ms)} min</span>` : null}
    </div>`;
  if (onOpen) return html`<button type="button" class="card music-feature is-link" title=${`Your stats for ${title}`} onClick=${onOpen}>${inner}</button>`;
  return html`<section class="card music-feature">${inner}</section>`;
}

function Stats() {
  const data = top.value;
  const [show, setShow] = useState(10);
  const key = `${period.value}|${customRange.value?.year ? "year" : ""}|${customRange.value?.fromDay || ""}|${customRange.value?.toDay || ""}|${genre.value}`;
  // Fresh numbers each time the tab opens or the period or genre changes.
  useEffect(() => {
    top.value = null;
    timeline.value = null;
    setShow(10);
    loadTop();
    loadTimeline();
  }, [key]);
  const known = data?.genresKnown ?? 0;
  return html`
    <div class="music-filters">
      <${PeriodControl} />
      <${GenrePicker} value=${genre.value} onChange=${(value) => { genre.value = value; }} />
    </div>
    ${!data ? html`<${Skeleton} lines=${8} />` : html`
      ${data.untimed ? html`<div class="jobs-banner jobs-banner-warn" role="status">
        <${Icon} name="flag" size=${18} />
        <div><strong>Minutes are missing for ${data.untimed.toLocaleString()} of ${data.plays.toLocaleString()} plays</strong><span class="muted small">They come from an export imported before Jarvis counted minutes, so totals and rankings here are too low. ${isWeb.value ? "Import the export again in Jarvis on your computer." : "Import it again to fix it."}</span></div>
        ${isWeb.value ? null : html`<${Button} size="sm" onClick=${() => { tab.value = "setup"; }}>Import again</${Button}>`}
      </div>` : null}
      <div class="music-hero">
        <section class="card music-total">
          <span class="card-eyebrow">${genre.value ? `${genre.value} · ` : ""}${describePeriod()}</span>
          <strong>${minutes(data.ms)}</strong>
          <span>minutes listened</span>
          <div class="music-total-facts small muted">
            <span>${hours(data.ms)} hours</span><span>${data.plays.toLocaleString()} plays</span><span>${data.songs.toLocaleString()} songs</span><span>${data.artistCount.toLocaleString()} artists</span>${data.genres[0] && !genre.value ? html`<span>top genre ${data.genres[0].name}</span>` : null}
          </div>
        </section>
        <${Feature} label="Top song" title=${data.tracks[0]?.title} sub=${data.tracks[0]?.artist || "Nothing played"} image=${data.tracks[0]?.image} ms=${data.tracks[0]?.ms} />
        <${Feature} label="Top artist" title=${data.artists[0]?.name} sub=${data.artists[0] ? data.artists[0].genres?.slice(0, 2).join(", ") || " " : "Nothing played"} image=${data.artists[0]?.image} round=${true} ms=${data.artists[0]?.ms}
          onOpen=${data.artists[0] ? () => openArtist(data.artists[0].key) : null} />
      </div>
      <section class="card music-chart">
        <div class="card-head"><span class="card-eyebrow">Listening over time</span><span class="muted small">minutes per ${timeline.value?.unit || "day"}</span></div>
        <${Timeline} data=${timeline.value} />
      </section>
      <div class="music-grid">
        <section class="card">
          <div class="card-head"><span class="card-eyebrow">Top songs</span><span class="muted small">versions counted together</span></div>
          <${RankList} items=${data.tracks.slice(0, show)} kind="track" />
          ${data.tracks.length > show ? html`<button type="button" class="link small" onClick=${() => setShow(50)}>Show top 50</button>` : null}
        </section>
        <section class="card">
          <div class="card-head"><span class="card-eyebrow">Top artists</span><span class="muted small">pick one for their stats</span></div>
          <${RankList} items=${data.artists.slice(0, show)} kind="artist" onPick=${(item) => openArtist(item.key)} pickLabel=${(title) => `Your stats for ${title}`} />
        </section>
        <div class="music-stack">
          <section class="card">
            <div class="card-head"><span class="card-eyebrow">Top genres</span><span class="muted small">${known < 0.95 ? `known for ${Math.round(known * 100)}% of minutes · ` : ""}from MusicBrainz</span></div>
            <${RankList} items=${data.genres.slice(0, show)} kind="genre" onPick=${(item) => { genre.value = item.name; }} />
          </section>
          <section class="card">
            <div class="card-head"><span class="card-eyebrow">Recent plays</span></div>
            ${!recent.value ? html`<${Skeleton} lines=${4} />` : !recent.value.length ? html`<p class="muted small">Nothing recorded yet.</p>` : html`<ul class="music-recent">
              ${recent.value.slice(0, 12).map((play) => html`<li key=${`${play.at}${play.ref}`}>
                <${Art} src=${play.track?.image} name=${play.track?.name} size=${32} />
                <div><strong>${play.track?.name || "Unknown track"}</strong><span class="muted small"><${ArtistLink} name=${artistOf(play.track)} artistKey=${play.artistKey} /></span></div>
                <span class="muted small">${ago(play.at)}</span>
              </li>`)}
            </ul>`}
          </section>
        </div>
      </div>`}`;
}

// ---------- playlists ----------
function playlistUrl(id) {
  return `https://open.spotify.com/playlist/${encodeURIComponent(id)}`;
}

function rulePeriod(rule) {
  if (rule.fixedRange) return `${shortDate(`${rule.fixedRange.fromDay}T00:00:00`)} to ${shortDate(`${rule.fixedRange.toDay}T00:00:00`)}`;
  return describeWindow(rule.windowDays);
}

// "6:08 PM", or "Tue 6:08 PM" when it isn't today.
function retryTime(iso) {
  const at = new Date(iso);
  const today = at.toDateString() === new Date().toDateString();
  return at.toLocaleString([], today ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" });
}

function PlaylistCard({ rule, ready }) {
  const state = rule.state;
  const result = state?.lastResult;
  const [busy, setBusy] = useState(false);
  const sync = async () => {
    setBusy(true);
    const data = await musicAction("playlists/sync", { id: rule.id });
    setBusy(false);
    const outcome = data?.result?.lastResult;
    if (outcome?.ok) toast(outcome.changed ? `Updated ${rule.name}: ${outcome.tracks} tracks` : `${rule.name} is already up to date`);
    else if (outcome) toast(`${outcome.error}${outcome.retryAt ? ` Trying again at ${retryTime(outcome.retryAt)}.` : ""}`, { tone: "danger" });
  };
  return html`<article class="music-playlist">
    <div class="music-playlist-head">
      <div>
        <strong>${rule.name}</strong>
        <span class="muted small">Top ${rule.topK}${rule.genre ? ` ${rule.genre}` : ""} of ${rulePeriod(rule)} · ${rule.synced ? `updates ${describeInterval(rule.intervalHours)}` : rule.fixedRange ? "fixed dates, built once" : "built once, updates when you ask"}</span>
      </div>
      ${state?.spotifyPlaylistId ? html`<a class="icon-btn" href=${playlistUrl(state.spotifyPlaylistId)} target="_blank" rel="noreferrer" aria-label="Open in Spotify" title="Open in Spotify"><${Icon} name="external" size=${17} /></a>` : null}
    </div>
    ${!result ? html`<span class="muted small">${ready ? "Not built yet. It builds at the next check, or now." : "Builds once Spotify is connected with playlist access."}</span>`
      : result.ok ? html`<span class="small">
          <span class="pill pill-good">${result.tracks}/${result.wanted ?? rule.topK} tracks</span>
          <span class="muted"> Updated ${ago(state.lastSyncedAt)}${rule.synced && rule.nextSyncAt ? ` · next ${until(rule.nextSyncAt)}` : ""}</span>
        </span>`
        : html`<span class="small danger">${result.error}${result.retryAt ? ` Trying again at ${retryTime(result.retryAt)}.` : ""}</span>`}
    ${result?.ok && (result.skippedCount || result.substituted) ? html`<details class="music-skipped">
      <summary class="small muted">${[result.substituted ? `${result.substituted} played as another version` : "", result.skippedCount ? `${result.skippedCount} skipped` : ""].filter(Boolean).join(" · ")}</summary>
      <ul>${(result.skipped || []).map((song) => html`<li class="small"><strong>${song.title}</strong> <span class="muted">${song.artist} · ${song.ms ? `${minutes(song.ms)} min` : `${song.plays} plays`} · ${song.reason}</span></li>`)}</ul>
    </details>` : null}
    <div class="row gap-2 wrap">
      <${Button} size="sm" variant="primary" icon="loop" disabled=${busy || !ready} onClick=${sync}>${busy ? "Updating…" : "Update now"}</${Button}>
      <${Button} size="sm" onClick=${() => { editing.value = { ...rule }; }}>Edit</${Button}>
      ${result?.missing || state?.spotifyPlaylistId ? html`<${Button} size="sm" variant="ghost" onClick=${async () => {
        if (!window.confirm(`Make a new Spotify playlist for "${rule.name}"? The current one is left as it is, no longer updated.`)) return;
        await musicAction("playlists/recreate", { id: rule.id }, "A new playlist is made at the next update");
      }}>Recreate</${Button}>` : null}
      <${Button} size="sm" variant="ghost" icon="trash" onClick=${async () => {
        if (!window.confirm(`Stop syncing "${rule.name}"? The playlist stays in Spotify.`)) return;
        await musicAction("playlists/delete", { id: rule.id }, "Stopped syncing; the playlist stays in Spotify");
      }}>Stop syncing</${Button}>
    </div>
  </article>`;
}

function Playlists() {
  const data = music.value;
  const ready = Boolean(data?.status.spotify.ready);
  return html`
    <div class="row space-between wrap gap-2 music-toolbar">
      <p class="muted small">Jarvis makes its own private playlists and only ever changes those. Songs are ranked by minutes listened, and each appears once, in the version you play that Spotify can play.</p>
      <${Button} variant="primary" icon="plus" onClick=${() => { editing.value = { name: "", topK: 50, windowDays: 30, synced: true, intervalHours: 24 }; }}>New playlist</${Button}>
    </div>
    ${!ready ? html`<div class="jobs-banner jobs-banner-warn"><${Icon} name="flag" size=${18} /><div><strong>Playlists need Spotify playlist access</strong><span class="muted small">${isWeb.value ? "Connect Spotify for background syncing under Setup, or let your PC sync them." : "Connect or reconnect Spotify in Settings once."}</span></div><${Button} size="sm" onClick=${openSpotifySetup}>Set up</${Button}></div>` : null}
    ${!data.playlists.length ? html`<${Empty} icon="music" title="No synced playlists yet">
      Make one like stats.fm's: your top 50 songs of the last 30 days, rebuilt every day. Or your top house songs of last summer.
    </${Empty}>` : html`<div class="music-playlists">${data.playlists.map((rule) => html`<${PlaylistCard} key=${rule.id} rule=${rule} ready=${ready} />`)}</div>`}`;
}

const CUSTOM = "custom";
const DATES = "dates";

function PlaylistEditor() {
  const draft = editing.value;
  // Keyed by rule so each open starts from that rule's values.
  return draft ? html`<${EditorForm} key=${draft.id || "new"} draft=${draft} />` : null;
}

function EditorForm({ draft }) {
  const [form, setForm] = useState(() => ({
    ...draft,
    genre: draft.genre || "",
    periodChoice: draft.fixedRange ? DATES : PERIODS.some((entry) => entry.days === draft.windowDays) ? String(draft.windowDays) : CUSTOM,
    customDays: draft.windowDays || 30,
    fromDay: draft.fixedRange?.fromDay || localDay(new Date(Date.now() - 90 * 86_400_000)),
    toDay: draft.fixedRange?.toDay || localDay(),
    intervalChoice: INTERVALS.some((entry) => entry.hours === draft.intervalHours) ? String(draft.intervalHours) : CUSTOM,
    customHours: draft.intervalHours || 24
  }));
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const close = () => { editing.value = null; };
  const set = (field, value) => setForm((current) => ({ ...current, [field]: value }));
  const fixed = form.periodChoice === DATES;
  const windowDays = fixed ? null : form.periodChoice === CUSTOM ? Number(form.customDays) : form.periodChoice === "null" ? null : Number(form.periodChoice);
  const intervalHours = form.intervalChoice === CUSTOM ? Number(form.customHours) : Number(form.intervalChoice);
  const body = {
    ...(draft.id ? { id: draft.id } : {}),
    name: form.name,
    topK: Number(form.topK),
    windowDays,
    fixedRange: fixed ? { ...dayRange(form.fromDay, form.toDay), fromDay: form.fromDay, toDay: form.toDay } : null,
    genre: form.genre,
    synced: fixed ? false : form.synced,
    intervalHours
  };
  const runPreview = async () => {
    setBusy(true);
    try {
      setPreview((await post("/api/music/playlists/preview", body)).preview);
    } catch (error) {
      reportError(error);
    }
    setBusy(false);
  };
  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    const saved = await musicAction("playlists/save", body, draft.id ? "Saved" : null);
    if (saved && music.value?.status.spotify.ready) {
      close();
      const synced = await musicAction("playlists/sync", { id: saved.rule.id });
      const outcome = synced?.result?.lastResult;
      if (outcome?.ok) toast(`${saved.rule.name}: ${outcome.tracks} tracks on Spotify`);
      else if (outcome) toast(outcome.error, { tone: "danger" });
    } else if (saved) {
      close();
      if (!draft.id) toast("Saved. It's built once Spotify is connected with playlist access.");
    }
    setBusy(false);
  };
  return html`<${Modal} open=${true} onClose=${close} title=${draft.id ? "Edit synced playlist" : "New synced playlist"} wide=${Boolean(preview)}>
    <form class="modal-body form music-editor" onSubmit=${save}>
      <${Field} label="Name"><input class="input" required autofocus maxlength="100" value=${form.name} placeholder="Top 50 · last 30 days" onInput=${(event) => set("name", event.currentTarget.value)} /></${Field}>
      <div class="form-row">
        <${Field} label="Songs" hint="Your most listened, up to 500."><input class="input" type="number" min="1" max="500" step="1" required value=${form.topK} onInput=${(event) => set("topK", event.currentTarget.value)} /></${Field}>
        <${Field} label="Genre" hint="Optional. “house” includes deep house, tech house…">
          <input class="input" list="music-genre-options" maxlength="60" placeholder="Any genre" value=${form.genre} onFocus=${() => { if (!genres.value) loadGenres(); }} onInput=${(event) => set("genre", event.currentTarget.value)} />
          <datalist id="music-genre-options">${(genres.value?.genres || []).slice(0, 200).map((entry) => html`<option value=${entry.name} />`)}</datalist>
        </${Field}>
      </div>
      <div class="form-row">
        <${Field} label="Period">
          <select class="input" value=${form.periodChoice} onChange=${(event) => set("periodChoice", event.currentTarget.value)}>
            ${PERIODS.map((entry) => html`<option value=${String(entry.days)}>${entry.days ? `The last ${entry.label}` : "All time"}</option>`)}
            <option value=${CUSTOM}>A custom number of days</option>
            <option value=${DATES}>Fixed dates</option>
          </select>
        </${Field}>
        ${form.periodChoice === CUSTOM ? html`<${Field} label="Days"><input class="input" type="number" min="1" max="36500" step="1" required value=${form.customDays} onInput=${(event) => set("customDays", event.currentTarget.value)} /></${Field}>` : null}
      </div>
      ${fixed ? html`<div class="form-row">
        <${Field} label="From"><input class="input" type="date" required value=${form.fromDay} max=${form.toDay} onInput=${(event) => set("fromDay", event.currentTarget.value)} /></${Field}>
        <${Field} label="To"><input class="input" type="date" required value=${form.toDay} min=${form.fromDay} onInput=${(event) => set("toDay", event.currentTarget.value)} /></${Field}>
      </div>` : null}
      <label class="music-toggle"><input type="checkbox" checked=${!fixed && form.synced} disabled=${fixed} onChange=${(event) => set("synced", event.currentTarget.checked)} /><span>Keep it updated</span></label>
      ${fixed ? html`<p class="small muted">Fixed dates always give the same list, so it's built once.</p>` : form.synced ? html`<div class="form-row">
        <${Field} label="Update">
          <select class="input" value=${form.intervalChoice} onChange=${(event) => set("intervalChoice", event.currentTarget.value)}>
            ${INTERVALS.map((entry) => html`<option value=${String(entry.hours)}>${entry.label}</option>`)}
            <option value=${CUSTOM}>Custom number of hours</option>
          </select>
        </${Field}>
        ${form.intervalChoice === CUSTOM ? html`<${Field} label="Hours"><input class="input" type="number" min="1" max="2160" step="1" required value=${form.customHours} onInput=${(event) => set("customHours", event.currentTarget.value)} /></${Field}>` : null}
      </div>` : null}
      ${preview ? html`<div class="music-preview">
        <div class="row space-between"><strong>${preview.tracks.length} of ${body.topK} songs</strong><span class="muted small">${preview.checked ? "Checked against Spotify" : "Not checked against Spotify yet"}</span></div>
        <ol>${preview.tracks.map((track) => html`<li><${Art} src=${track.image} name=${track.title} size=${32} /><div><span>${track.title}</span><span class="muted small">${track.artist} · ${minutes(track.ms)} min${track.note ? ` · ${track.note}` : ""}</span></div></li>`)}</ol>
        ${preview.skipped.length ? html`<p class="small muted">Skipped: ${preview.skipped.slice(0, 8).map((song) => `${song.title} (${song.reason})`).join("; ")}${preview.skipped.length > 8 ? "…" : ""}</p>` : null}
        ${!preview.tracks.length && body.genre ? html`<p class="small muted">Nothing matches “${body.genre}” in this period yet. Genres fill in as Jarvis looks up your artists.</p>` : null}
      </div>` : null}
      <footer class="modal-foot flush">
        <${Button} variant="ghost" onClick=${close}>Cancel</${Button}>
        <${Button} icon="eye" disabled=${busy} onClick=${runPreview}>Preview</${Button}>
        <${Button} variant="primary" type="submit" icon="check" disabled=${busy}>${draft.id ? "Save" : "Create"}</${Button}>
      </footer>
    </form>
  </${Modal}>`;
}

// ---------- setup ----------
function CloudSpotify() {
  const status = music.value.status;
  const [clientId, setClientId] = useState("");
  const [tick, setTick] = useState(null);
  const connect = async () => {
    try {
      const data = await post("/api/music/spotify/connect", clientId ? { clientId } : {});
      window.location.assign(data.authorizationUrl);
    } catch (error) {
      reportError(error);
    }
  };
  return html`<section class="card music-setup">
    <span class="card-eyebrow">Background tracking</span>
    <p class="small muted">So plays from your phone count while the PC is off, the cloud checks Spotify every hour and keeps playlists updated. It uses its own Spotify sign-in.</p>
    ${status.spotify.ready ? html`<div class="row space-between wrap gap-2">
      <span><span class="pill pill-good">Spotify connected</span>${status.spotify.grantExpiresAt ? html` <span class="muted small">Spotify asks again by ${shortDate(status.spotify.grantExpiresAt)}</span>` : null}</span>
      <${Button} size="sm" variant="ghost" onClick=${() => musicAction("spotify/disconnect", {}, "Disconnected")}>Disconnect</${Button}>
    </div>` : html`<div class="form">
      <p class="small muted">In your Spotify app at developer.spotify.com, add <code>${location.origin}/api/music/spotify/callback</code> as a redirect URI, then connect with the same Client ID your PC uses.</p>
      <div class="row gap-2"><input class="input" placeholder="Spotify Client ID" aria-label="Spotify Client ID" value=${clientId} onInput=${(event) => setClientId(event.currentTarget.value.trim())} /><${Button} variant="primary" disabled=${!clientId} onClick=${connect}>Connect</${Button}></div>
    </div>`}
    <div class="music-tick">
      <strong class="small">Hourly check</strong>
      ${status.tick.configured ? html`<span class="small muted">Last check ${ago(status.tick.lastTickAt)}${status.tick.lastResult?.errors?.length ? html` · <span class="danger">${status.tick.lastResult.errors[0]}</span>` : ""}</span>` : html`<span class="small muted">Not set up yet.</span>`}
      ${tick ? html`<div class="token-card">
        <span class="small">Create a free job at cron-job.org that runs every hour: URL below, method POST, header <code>Authorization: Bearer</code> plus this token. It's shown once.</span>
        <code class="token">${tick.url}</code>
        <code class="token">${tick.token}</code>
      </div>` : html`<${Button} size="sm" onClick=${async () => {
        if (status.tick.configured && !window.confirm("Make a new scheduler token? The old one stops working.")) return;
        const data = await musicAction("tick-token", {});
        if (data) setTick(data);
      }}>${status.tick.configured ? "New scheduler token" : "Set up the hourly check"}</${Button}>`}
    </div>
  </section>`;
}

function DesktopSpotify() {
  const { spotify, cloud } = music.value.status;
  return html`<section class="card music-setup">
    <span class="card-eyebrow">Spotify on this PC</span>
    ${spotify.ready ? html`<span><span class="pill pill-good">Recording and syncing</span>${spotify.grantExpiresAt ? html` <span class="muted small">Spotify asks you to sign in again by ${shortDate(spotify.grantExpiresAt)}</span>` : null}</span>`
      : html`<p class="small">${spotify.reconnect ? "Reconnect Spotify once to give Jarvis access to recently played tracks and your playlists." : "Connect Spotify to record what you play and sync playlists."}</p>`}
    <div class="row gap-2 wrap">
      <${Button} size="sm" onClick=${() => { settingsOpen.value = true; }}>${spotify.ready ? "Spotify settings" : spotify.reconnect ? "Reconnect in Settings" : "Connect in Settings"}</${Button}>
      ${spotify.ready ? html`<${Button} size="sm" variant="ghost" icon="loop" onClick=${() => musicAction("poll", {}, (data) => (data.result?.added ? `Recorded ${data.result.added} new plays` : "No new plays"))}>Check now</${Button}>` : null}
    </div>
    <p class="small muted">${cloud.connected
      ? `Synced with your Jarvis cloud${cloud.lastExchangeAt ? ` ${ago(cloud.lastExchangeAt)}` : ""}. Set up background tracking from Jarvis on the web, under Music, Setup.`
      : "Connect this PC to your Jarvis cloud (Settings, Cloud sync) so your phone sees these stats and plays are recorded while the PC is off."}
      ${cloud.lastError ? html` <span class="danger">${cloud.lastError}</span>` : null}</p>
  </section>`;
}

const fmtDay = (iso) => (iso ? shortDate(iso) : "?");

function ImportSource({ name, data }) {
  if (!data) return null;
  return html`<div class="music-import-source">
    <strong class="small">${name}</strong>
    <span class="small">${fmtDay(data.from)} to ${fmtDay(data.to)} · ${data.plays.toLocaleString()} plays${data.duplicates ? ` · ${data.duplicates.toLocaleString()} repeated streams counted once` : ""}</span>
    ${data.previous ? html`<span class="small muted">Replaces ${data.replaced.toLocaleString()} plays from your earlier import in those dates and keeps ${data.kept.toLocaleString()} outside them.${data.recorded ? ` ${data.recorded.toLocaleString()} plays Jarvis recorded in that time give way to the export's exact ones.` : ""}</span>`
      : html`<span class="small muted">First import of this source.${data.recorded ? ` ${data.recorded.toLocaleString()} plays Jarvis recorded in that time give way to the export's exact ones.` : ""}</span>`}
    ${data.older ? html`<span class="small warn">This export ends ${fmtDay(data.to)}, before the one already imported (${fmtDay(data.previous.to)}). Nothing after ${fmtDay(data.to)} is lost, but check that this is the export you meant.</span>` : null}
  </div>`;
}

function ImportCard() {
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const browse = async () => {
    try {
      const data = await post("/api/music/pick-folder", {});
      if (data.folder) {
        setFolder(data.folder);
        setPreview(null);
      }
    } catch (error) {
      reportError(error);
    }
  };
  const check = async () => {
    setBusy(true);
    try {
      setPreview((await post("/api/music/import", { folder })).result);
    } catch (error) {
      reportError(error);
    }
    setBusy(false);
  };
  const apply = async () => {
    setBusy(true);
    const data = await musicAction("import", { folder, apply: true }, (result) => {
      const parts = [];
      if (result.result.spotify) parts.push(`${result.result.spotify.plays.toLocaleString()} Spotify plays`);
      if (result.result.apple) parts.push(`${result.result.apple.plays.toLocaleString()} Apple Music plays`);
      return `Imported ${parts.join(" and ")}`;
    });
    setBusy(false);
    if (data) {
      setPreview(null);
      loadTop();
      loadTimeline();
      loadRecent();
      // The import also starts a background check of Spotify; show its result.
      setTimeout(() => { loadMusic(); loadRecent(); }, 4000);
    }
  };
  return html`<section class="card music-setup">
    <span class="card-eyebrow">Import listening history</span>
    <p class="small muted">Point Jarvis at the unzipped folder with your Spotify Extended streaming history and/or Apple Music activity. A folder holding an old and a new export is fine: each stream counts once. The files stay where they are, and you see what changes before anything does.</p>
    <div class="row gap-2 wrap">
      <input class="input music-folder" placeholder="C:\\Users\\you\\Downloads\\my_spotify_data" aria-label="Export folder" value=${folder} onInput=${(event) => { setFolder(event.currentTarget.value); setPreview(null); }} />
      <${Button} onClick=${browse}>Browse…</${Button}>
      <${Button} variant=${preview ? "secondary" : "primary"} disabled=${busy || !folder.trim()} onClick=${check}>${busy && !preview ? "Reading…" : "Check"}</${Button}>
    </div>
    ${preview ? html`<div class="music-import-preview">
      <${ImportSource} name="Spotify" data=${preview.spotify} />
      <${ImportSource} name="Apple Music" data=${preview.apple} />
      <div class="row gap-2"><${Button} variant="ghost" onClick=${() => setPreview(null)}>Cancel</${Button}><${Button} variant="primary" icon="check" disabled=${busy} onClick=${apply}>${busy ? "Importing…" : "Import"}</${Button}></div>
    </div>` : null}
  </section>`;
}

function HistoryCard() {
  const { history } = music.value.status;
  const gaps = history.tracked?.gaps || [];
  const range = (source) => (source ? `${shortDate(source.from)} to ${shortDate(source.to)}${source.plays !== undefined ? ` · ${source.plays.toLocaleString()} plays` : ""}` : "not imported");
  const inexact = [history.spotifyExport, history.appleExport].some((source) => source && source.exactMinutes === false);
  return html`<section class="card music-setup">
    <span class="card-eyebrow">Your history</span>
    <dl class="music-facts">
      <dt>All plays</dt><dd>${history.plays.toLocaleString()}${history.first ? ` · ${shortDate(history.first)} to ${shortDate(history.last)}` : ""}</dd>
      <dt>Spotify export</dt><dd>${range(history.spotifyExport)}</dd>
      <dt>Apple Music export</dt><dd>${range(history.appleExport)}</dd>
      <dt>Recorded by Jarvis</dt><dd>${history.tracked?.plays !== undefined ? `${history.tracked.plays.toLocaleString()} plays · ` : ""}last check ${ago(history.tracked?.lastPollAt)}</dd>
    </dl>
    ${inexact ? html`<p class="small muted">Your export was imported before Jarvis counted minutes. Import the same folder again above to get exact minutes; until then most of those plays count as 0 minutes.</p>` : null}
    <p class="small muted">Plays Jarvis records count the song's full length, since Spotify doesn't say how much was heard. A newer export replaces them with exact times.</p>
    ${gaps.length ? html`<div class="music-gaps">
      <strong class="small warn">Plays may be missing</strong>
      <span class="small muted">Spotify only keeps your last 50 plays, and more than that happened between these checks. A fresh Spotify export fills them in.</span>
      <ul>${gaps.slice(-5).reverse().map((gap) => html`<li class="small">${new Date(gap.from).toLocaleString()} to ${new Date(gap.to).toLocaleString()}</li>`)}</ul>
    </div>` : null}
  </section>`;
}

// Playlist syncs come first on Spotify's limit, so artwork and song details
// sometimes wait; say so rather than leaving gaps unexplained.
function LookupNote() {
  const lookups = music.value?.lookups;
  if (!lookups) return null;
  const until = lookups.pausedUntil;
  const held = lookups.hold?.reason;
  if (!until && !held) return null;
  const text = until
    ? `Spotify asked Jarvis to slow down, so artwork and song details wait until ${new Date(until).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}. Playlist syncs go first and aren't held up by this.`
    : held === "budget"
      ? "Artwork and song details are catching up slowly, a little each hour, so playlist syncs always have room on Spotify."
      : "Artwork and song details are waiting for a playlist sync to finish first.";
  return html`<p class="muted small music-lookup-note">${text}</p>`;
}

function Setup() {
  const data = music.value;
  return html`<div class="music-setup-grid">
    <${LookupNote} />
    ${isWeb.value ? html`<${CloudSpotify} />` : html`<${DesktopSpotify} />`}
    ${data.canImport ? html`<${ImportCard} />` : null}
    <${HistoryCard} />
  </div>`;
}

// Back from the cloud's Spotify sign-in: /?spotify=connected#music
function takeSpotifyReturn() {
  const params = new URLSearchParams(location.search);
  const outcome = params.get("spotify");
  if (!outcome) return;
  history.replaceState(null, "", location.pathname + location.hash);
  tab.value = "setup";
  if (outcome === "connected") toast("Spotify connected for background tracking");
  else toast(outcome === "denied" ? "Spotify access wasn't granted." : "Spotify sign-in didn't finish. Try again.", { tone: "danger" });
}

export function MusicPage() {
  useEffect(() => {
    takeSpotifyReturn();
    loadMusic();
    loadRecent();
    const timer = setInterval(() => {
      loadMusic();
      loadRecent();
    }, 120_000);
    return () => clearInterval(timer);
  }, []);
  const data = music.value;
  return html`<div class="page page-music">
    <header class="page-head">
      <div>
        <div class="eyebrow">Music</div>
        <h1>What you've been playing</h1>
        <${StatusLine} />
      </div>
      <div class="agent-kpis"><${IconButton} icon="loop" label="Refresh" onClick=${() => { loadMusic(); loadRecent(); loadTop(); loadTimeline(); genres.value = null; }} /></div>
    </header>
    <${Tabs} tabs=${TABS.map((entry) => (entry.id === "playlists" && data ? { ...entry, count: data.playlists.length } : entry))} value=${tab.value} onChange=${(id) => { tab.value = id; }} />
    ${!data ? html`<${Skeleton} lines=${6} />` : tab.value === "playlists" ? html`<${Playlists} />` : tab.value === "setup" ? html`<${Setup} />` : html`<${Stats} />`}
    <${PlaylistEditor} />
    <${ArtistSheet} />
  </div>`;
}
