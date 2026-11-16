import { useEffect, useState } from "preact/hooks";
import { html } from "./html.js";
import { Icon } from "./icons.js";
import { IconButton } from "./ui.js";
import { get, post } from "./api.js";
import { loadSpotify, reportError, settingsOpen, spotify } from "./store.js";

function usePolling(interval) {
  useEffect(() => {
    let timer;
    const tick = async () => {
      if (!document.hidden) await loadSpotify();
      const wait = Math.max(interval, Number(spotify.value?.retryAfterMs) || 0);
      timer = setTimeout(tick, wait);
    };
    tick();
    const onVisible = () => !document.hidden && loadSpotify();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
}

function useProgress(playback) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!playback?.isPlaying) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [playback?.isPlaying, playback?.fetchedAt]);
  if (!playback?.durationMs) return 0;
  const elapsed = playback.progressMs + (playback.isPlaying ? now - playback.fetchedAt : 0);
  return Math.min(1, elapsed / playback.durationMs);
}

async function control(action, extra = {}) {
  try {
    const data = await post("/api/integrations/spotify/playback", { action, ...extra });
    spotify.value = { ...spotify.value, playback: data.playback };
    setTimeout(loadSpotify, 900);
  } catch (error) {
    reportError(error);
  }
}

// Where Spotify plays: this computer, a phone, a speaker. These are Spotify
// Connect devices; headphones versus speakers on one computer is a setting
// in Windows or macOS, not something Spotify lets other apps change.
function OutputPicker({ playback }) {
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState(null);
  const [error, setError] = useState("");
  const [moving, setMoving] = useState("");
  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    setError("");
    get("/api/integrations/spotify/devices")
      .then((data) => live && setDevices(data.devices))
      .catch((loadError) => live && setError(loadError.message));
    const close = (event) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", close);
    return () => { live = false; window.removeEventListener("keydown", close); };
  }, [open]);
  const pick = async (device) => {
    if (device.active || moving) return;
    setMoving(device.id);
    try {
      const data = await post("/api/integrations/spotify/playback", { action: "device", deviceId: device.id });
      spotify.value = { ...spotify.value, playback: data.playback };
      setOpen(false);
      setTimeout(loadSpotify, 1500);
    } catch (pickError) {
      setError(pickError.message);
    } finally {
      setMoving("");
    }
  };
  const current = playback.device?.name || "Choose a device";
  return html`<div class="menu-anchor spotify-output">
    <button type="button" class=${`spotify-output-btn ${open ? "is-on" : ""}`} aria-haspopup="dialog" aria-expanded=${open ? "true" : "false"}
      title=${`Playing on ${current}`} onClick=${() => setOpen(!open)}>
      <${Icon} name="speaker" size=${15} /><span>${current}</span>
    </button>
    ${open ? html`<div class="focus-pop is-up" role="dialog" aria-label="Audio output">
      <div class="focus-pop-head"><strong>Play on</strong><${IconButton} icon="x" label="Close" size=${15} onClick=${() => setOpen(false)} /></div>
      ${error ? html`<p class="warn small">${error}</p>` : null}
      ${!devices && !error ? html`<p class="muted small">Looking for devices…</p>` : null}
      ${devices ? html`<div class="spotify-device-list" role="listbox" aria-label="Spotify devices">
        ${devices.map((device) => html`<button type="button" role="option" aria-selected=${device.active ? "true" : "false"}
          class=${`spotify-device ${device.active ? "is-active" : ""}`} disabled=${device.restricted || Boolean(moving)} onClick=${() => pick(device)}>
          <strong>${device.name}</strong><span>${moving === device.id ? "Switching…" : device.active ? "Playing here" : device.restricted ? "Can't be controlled" : device.type}</span>
        </button>`)}
        ${!devices.length ? html`<p class="muted small">No devices found. Open Spotify on the computer, phone or speaker you want, then try again.</p>` : null}
      </div>` : null}
      <p class="muted small">Spotify lists the apps and speakers signed in to your account. To switch between headphones and speakers on this computer, change the output in Windows sound settings.</p>
    </div>` : null}
  </div>`;
}

async function openSpotify() {
  try {
    await post("/api/integrations/spotify/open");
  } catch (error) {
    reportError(error);
  }
}

// The dock shows these in every state, including nothing playing, so they
// stay put as tracks change.
function Controls({ playback }) {
  const playing = Boolean(playback?.isPlaying);
  return html`<div class="spotify-controls">
    <${IconButton} icon="prev" label="Previous track" size=${15} disabled=${!playback?.canPrevious} onClick=${() => control("previous")} />
    <button type="button" class="spotify-play" aria-label=${playing ? "Pause" : playback ? "Play" : "Resume playback"}
      onClick=${() => control(playing ? "pause" : "play")}>
      <${Icon} name=${playing ? "pause" : "play"} size=${16} />
    </button>
    <${IconButton} icon="next" label="Next track" size=${15} disabled=${!playback?.canNext} onClick=${() => control("next")} />
  </div>`;
}

export function SpotifyPlayer({ variant = "rail", interval = 12000 }) {
  usePolling(interval);
  const status = spotify.value;
  const playback = status?.playback;
  const progress = useProgress(playback);
  const [volume, setVolume] = useState(null);
  const shownVolume = volume ?? playback?.volumePercent ?? 50;

  if (!status) return html`<div class=${`spotify spotify-${variant} is-loading`}><div class="spotify-art"></div><div class="spotify-meta"><span class="shimmer"></span></div></div>`;
  if (!status.connected || status.requiresReconnect) {
    return html`<div class=${`spotify spotify-${variant} is-empty`}>
      <div class="spotify-art spotify-art-empty"><${Icon} name="music" size=${20} /></div>
      <div class="spotify-meta">
        <strong>${status.requiresReconnect ? "Reconnect Spotify" : "Connect Spotify"}</strong>
        <span>Control your music without leaving Jarvis.</span>
      </div>
      <button type="button" class="btn btn-secondary btn-sm" onClick=${() => { settingsOpen.value = true; }}>Set up</button>
    </div>`;
  }
  if (!playback && variant === "dock") {
    return html`<div class="spotify spotify-dock is-empty">
      <div class="spotify-art spotify-art-empty"><${Icon} name="music" size=${20} /></div>
      <div class="spotify-meta"><strong>Nothing playing</strong><span title=${status.error || null}>${status.error || "Start Spotify on any device."}</span></div>
      <${Controls} playback=${null} />
      <div class="spotify-extras"><${IconButton} icon="external" label="Open Spotify" size=${16} onClick=${openSpotify} /></div>
    </div>`;
  }
  if (!playback) {
    return html`<div class=${`spotify spotify-${variant} is-empty`}>
      <div class="spotify-art spotify-art-empty"><${Icon} name="music" size=${20} /></div>
      <div class="spotify-meta"><strong>Nothing playing</strong><span>${status.error || "Start Spotify on any device."}</span></div>
      <${IconButton} icon="play" label="Resume playback" onClick=${() => control("play")} />
      <${IconButton} icon="external" label="Open Spotify" size=${16} onClick=${openSpotify} />
    </div>`;
  }
  return html`<div class=${`spotify spotify-${variant}`}>
    <a class="spotify-art" href=${playback.spotifyUrl} target="_blank" rel="noreferrer" title="Open in Spotify">
      ${playback.imageUrl ? html`<img src=${playback.imageUrl} alt="" loading="lazy" />` : html`<${Icon} name="music" size=${20} />`}
    </a>
    <div class="spotify-meta">
      <strong title=${playback.title}>${playback.title}</strong>
      <span title=${playback.subtitle}>${playback.subtitle}</span>
      <div class="spotify-progress"><span style=${{ width: `${progress * 100}%` }}></span></div>
    </div>
    <${Controls} playback=${playback} />
    ${variant === "dock" ? html`<div class="spotify-extras">
      ${playback.canSetVolume ? html`<label class="spotify-volume" title="Volume">
        <${Icon} name="volume" size=${15} />
        <input type="range" min="0" max="100" step="5" value=${shownVolume} aria-label="Spotify volume"
          onInput=${(event) => setVolume(Number(event.currentTarget.value))}
          onChange=${(event) => { control("volume", { volumePercent: Number(event.currentTarget.value) }); setTimeout(() => setVolume(null), 1500); }} />
      </label>` : null}
      <${OutputPicker} playback=${playback} />
    </div>` : null}
  </div>`;
}
