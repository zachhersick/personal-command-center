// Pieces the Stats tab and the artist view share: artwork, the listening
// chart and the ranked lists.
import { useState } from "preact/hooks";
import { html } from "../html.js";
import { Bar, Skeleton } from "../ui.js";
import { minutes, openArtist } from "./state.js";

export function artistOf(track) {
  if (!track) return "";
  return Array.isArray(track.artists) && track.artists.length ? track.artists.join(", ") : track.artist || "";
}

// Album art or an artist photo, with the first letter when there's none.
export function Art({ src, name, size = 40, round = false }) {
  const [failed, setFailed] = useState(false);
  const style = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px`;
  const shape = round ? "is-round" : "";
  if (src && !failed) return html`<img class=${`music-art ${shape}`} style=${style} src=${src} alt="" loading="lazy" referrerpolicy="no-referrer" onError=${() => setFailed(true)} />`;
  return html`<span class=${`music-art is-blank ${shape}`} style=${style} aria-hidden="true">${(String(name || "?").trim()[0] || "?").toUpperCase()}</span>`;
}

// An artist's name that opens their stats. The lead artist gets the credit,
// so the link goes to them even when the label lists featured artists too.
export function ArtistLink({ name, artistKey, class: className = "" }) {
  if (!artistKey) return html`<span class=${className}>${name}</span>`;
  return html`<button type="button" class=${`music-artist-link ${className}`} title=${`Your stats for ${name}`} onClick=${(event) => { event.stopPropagation(); openArtist(artistKey); }}>${name}</button>`;
}

// data: { unit, buckets } from the server, or null while it loads.
export function Timeline({ data }) {
  const [hover, setHover] = useState(null);
  if (!data) return html`<${Skeleton} lines=${3} />`;
  const buckets = data.buckets;
  if (!buckets.length || !buckets.some((row) => row.ms)) return html`<p class="muted small">No listening in this period.</p>`;
  const most = Math.max(...buckets.map((row) => row.ms)) || 1;
  const width = 1000;
  const height = 140;
  const step = width / buckets.length;
  const gap = Math.min(step * 0.25, 4);
  const label = (row) => {
    const date = new Date(`${row.start}T00:00:00`);
    if (data.unit === "month") return date.toLocaleDateString(undefined, { month: "short", year: "numeric" });
    if (data.unit === "week") return `Week of ${date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
    return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  };
  const shown = hover !== null ? buckets[hover] : null;
  const pointAt = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const index = Math.floor(((event.clientX - rect.left) / rect.width) * buckets.length);
    setHover(Math.max(0, Math.min(buckets.length - 1, index)));
  };
  const ticks = [0, Math.floor((buckets.length - 1) / 2), buckets.length - 1].filter((value, index, list) => list.indexOf(value) === index);
  return html`<div class="music-timeline">
    <div class="music-timeline-read small">${shown ? html`<strong>${minutes(shown.ms)} min</strong> <span class="muted">${label(shown)} · ${shown.plays.toLocaleString()} plays</span>` : html`<span class="muted">Peak ${minutes(most)} min a ${data.unit}. Point at a bar for details.</span>`}</div>
    <svg viewBox=${`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label=${`Minutes listened per ${data.unit}`}
      onPointerMove=${pointAt} onPointerDown=${pointAt} onPointerLeave=${() => setHover(null)}>
      ${buckets.map((row, index) => {
        const h = row.ms ? Math.max(2, (row.ms / most) * (height - 4)) : 0;
        return html`<rect key=${row.start} class=${index === hover ? "is-hover" : ""} x=${index * step + gap / 2} y=${height - h} width=${Math.max(1, step - gap)} height=${h} rx=${Math.min(2, step / 4)}><title>${label(row)}: ${minutes(row.ms)} min</title></rect>`;
      })}
    </svg>
    <div class="music-timeline-axis small muted">${ticks.map((index) => html`<span key=${index}>${label(buckets[index]).replace(/^Week of /, "")}</span>`)}</div>
  </div>`;
}

// kind: track, artist or genre. onPick makes each row a button; a song's
// artist links to that artist unless noArtistLinks (the artist's own view).
export function RankList({ items, kind, onPick, noArtistLinks = false, pickLabel = (title) => `Show only ${title}` }) {
  if (!items.length) return html`<p class="muted small">${kind === "genre" ? "No genres known for this period yet." : "No plays in this period."}</p>`;
  const most = items[0].ms || 1;
  return html`<ol class=${`music-rank is-${kind}`}>
    ${items.map((item, index) => {
      const title = kind === "track" ? item.title : item.name;
      const body = html`<span class="music-rank-n">${index + 1}</span>
        ${kind !== "genre" ? html`<${Art} src=${item.image} name=${title} size=${40} round=${kind === "artist"} />` : null}
        <div class="music-rank-body">
          <strong title=${title}>${title}</strong>
          ${kind === "track" ? html`<span class="muted small music-rank-sub" title=${item.artist}>${noArtistLinks ? item.artist : html`<${ArtistLink} name=${item.artist} artistKey=${item.artistKey} />`}${item.versions > 1 ? ` · ${item.versions} versions` : ""}</span>` : null}
          <${Bar} value=${item.ms / most} />
        </div>
        <span class="music-rank-plays"><strong>${minutes(item.ms)}</strong><span class="muted">min · ${item.plays.toLocaleString()}×</span></span>`;
      return html`<li key=${item.key}>${onPick ? html`<button type="button" class="music-rank-pick" onClick=${() => onPick(item)} title=${pickLabel(title)}>${body}</button>` : body}</li>`;
    })}
  </ol>`;
}
