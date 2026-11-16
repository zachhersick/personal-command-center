// One artist's stats for the chosen period, in a sheet over the Music page.
import { useEffect } from "preact/hooks";
import { html } from "../html.js";
import { IconButton, Sheet, Skeleton } from "../ui.js";
import { artist, artistKey, closeArtist, customRange, describePeriod, hours, loadArtist, minutes, period, shortDate } from "./state.js";
import { Art, RankList, Timeline } from "./charts.js";

const ordinal = (n) => {
  const rule = new Intl.PluralRules("en", { type: "ordinal" }).select(n);
  return `${n}${{ one: "st", two: "nd", few: "rd" }[rule] || "th"}`;
};

function Fact({ label, value, sub, tone = "" }) {
  return html`<div class=${`artist-fact ${tone}`}><span>${label}</span><strong>${value}</strong>${sub ? html`<em>${sub}</em>` : null}</div>`;
}

export function ArtistSheet() {
  const key = artistKey.value;
  const data = artist.value;
  // Reload when the artist or the period changes while the sheet is open.
  const periodKey = `${period.value}|${customRange.value?.year ? "year" : ""}|${customRange.value?.fromDay || ""}|${customRange.value?.toDay || ""}`;
  useEffect(() => {
    if (!key) return;
    artist.value = null;
    loadArtist();
  }, [key, periodKey]);
  const title = data?.name || "Artist";
  const ready = data && !data.error;
  return html`<${Sheet} open=${Boolean(key)} onClose=${closeArtist} title=${`${title}: your stats`}>
    <div class="sheet-body artist-sheet">
      <header class="sheet-head">
        <div class="artist-id">
          <${Art} src=${data?.image} name=${title} size=${64} round=${true} />
          <div>
            <span class="card-eyebrow">${describePeriod()}</span>
            <h2 class="sheet-title">${data?.name || "Loading…"}</h2>
            ${data?.genres?.length ? html`<span class="muted small">${data.genres.slice(0, 3).join(", ")}</span>` : null}
          </div>
        </div>
        <${IconButton} icon="x" label="Close" onClick=${closeArtist} />
      </header>
      ${!data ? html`<${Skeleton} lines=${8} />` : null}
      ${data?.error ? html`<p class="danger">${data.error}</p>` : null}
      ${ready ? html`
        <div class="artist-facts">
          <${Fact} label="Minutes" value=${minutes(data.ms)} sub=${`${hours(data.ms)} hours`} tone="is-accent" />
          <${Fact} label="Plays" value=${data.plays.toLocaleString()} sub=${`${data.songCount} ${data.songCount === 1 ? "song" : "songs"}`} />
          <${Fact} label="Rank" value=${data.rank ? `#${data.rank}` : "—"} sub=${data.rank ? `${ordinal(data.rank)} of ${data.artistCount.toLocaleString()} artists` : "not played in this period"} tone="is-hot" />
          <${Fact} label="Share" value=${`${Math.round(data.share * 1000) / 10}%`} sub="of your listening" />
        </div>
        <dl class="artist-dates">
          <div><dt>First played</dt><dd>${data.first ? shortDate(new Date(data.first).toISOString()) : "—"}</dd><dd class="muted small">in this period</dd></div>
          <div><dt>Last played</dt><dd>${data.last ? shortDate(new Date(data.last).toISOString()) : "—"}</dd><dd class="muted small">in this period</dd></div>
          <div><dt>First ever</dt><dd>${data.firstEver ? shortDate(new Date(data.firstEver).toISOString()) : "—"}</dd><dd class="muted small">since your history starts</dd></div>
        </dl>
        <section class="sheet-section">
          <h4>Listening over time</h4>
          <${Timeline} data=${data.timeline} />
        </section>
        <section class="sheet-section">
          <h4>Top songs</h4>
          <${RankList} items=${data.songs} kind="track" noArtistLinks=${true} />
          ${data.songCount > data.songs.length ? html`<p class="muted small">${data.songCount - data.songs.length} more songs played in this period.</p>` : null}
        </section>
        <p class="muted small">Plays count toward a song's first-credited artist, the same as Top artists.</p>
      ` : null}
    </div>
  </${Sheet}>`;
}
