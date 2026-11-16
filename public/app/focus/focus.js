import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { html } from "../html.js";
import { Icon } from "../icons.js";
import { Button, IconButton, Modal } from "../ui.js";
import { SpotifyPlayer } from "../spotify.js";
import { can, isWeb } from "../platform.js";
import { get, post, ApiError } from "../api.js";
import { categoryColor, CATEGORY_META, clock, formatDate, formatMinutes, timer } from "../format.js";
import { day, focusState, focusTarget, loadDay, navigate, refresh, reportError, storage, todayKey, toast } from "../store.js";
import { renderMarkdown } from "../task-sheet.js";
import { board, loadWebBoard } from "../agents/state.js";
import { agentSummary, summaryLabel } from "../agents/summary.js";
import { runScene, sceneById, SCENES } from "./scenes.js";
import { AMBIENT, chime, playAmbient, setAmbientVolume, stopAmbient } from "./sound.js";

const HOLD_MS = 2000;
const POMODORO = { "25/5": { work: 25, rest: 5 }, "50/10": { work: 50, rest: 10 } };
const EXIT_REASONS = ["Interrupted", "Finished early", "Lost focus", "Something urgent", "Wrong task"];
// Phones have no Escape key, so the hints talk about the on-screen button instead.
const touchFirst = () => window.matchMedia?.("(pointer: coarse)").matches === true;

// ---------- preferences ----------
function usePref(key, fallback) {
  const [value, setValue] = useState(() => {
    const raw = storage.get(`jarvis-focus-${key}`);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  });
  const update = (next) => {
    setValue(next);
    storage.set(`jarvis-focus-${key}`, JSON.stringify(next));
  };
  return [value, update];
}

// ---------- background ----------
function Backdrop({ sceneId, wallpaper, dim }) {
  const canvas = useRef(null);
  useEffect(() => {
    if (wallpaper || !canvas.current) return undefined;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    return runScene(canvas.current, sceneById(sceneId), { reducedMotion: reduced });
  }, [sceneId, wallpaper?.url]);
  return html`<div class="focus-backdrop" aria-hidden="true">
    ${wallpaper
      ? wallpaper.kind === "video"
        ? html`<video key=${wallpaper.url} src=${wallpaper.url} autoplay muted loop playsinline></video>`
        : html`<img key=${wallpaper.url} src=${wallpaper.url} alt="" />`
      : html`<canvas ref=${canvas}></canvas>`}
    <div class="focus-dim" style=${{ opacity: dim }}></div>
    <div class="focus-vignette"></div>
    <div class="focus-grain"></div>
  </div>`;
}

function WallpaperSwatch({ item, active, onPick }) {
  return html`<button type="button" class=${`scene-swatch ${active ? "is-active" : ""}`} onClick=${() => onPick(item)}>
    ${item.preview
      ? html`<img src=${item.preview} alt="" loading="lazy" />`
      : item.kind === "image"
        ? html`<img src=${item.url} alt="" loading="lazy" />`
        : html`<div class="scene-video"><${Icon} name="play" size=${16} /></div>`}
    <span>${item.name.replace(/\.[^.]+$/, "")}</span>
  </button>`;
}

function ScenePicker({ sceneId, wallpaperId, wallpapers, engine, dim, onScene, onWallpaper, onDim, onClose }) {
  return html`<div class="focus-pop" role="dialog" aria-label="Background">
    <div class="focus-pop-head"><strong>Background</strong><${IconButton} icon="x" label="Close" size=${15} onClick=${onClose} /></div>
    <div class="scene-scroll">
      <div class="scene-grid">
        ${SCENES.map((scene) => html`<button type="button" class=${`scene-swatch ${!wallpaperId && scene.id === sceneId ? "is-active" : ""}`}
          style=${{ background: scene.swatch }} onClick=${() => { onWallpaper(null); onScene(scene.id); }}><span>${scene.label}</span></button>`)}
        ${wallpapers.map((item) => html`<${WallpaperSwatch} key=${item.id} item=${item} active=${wallpaperId === item.id} onPick=${() => onWallpaper(item.id)} />`)}
      </div>
      ${engine?.items.length ? html`<div class="scene-group">
        <span class="scene-group-label">From Wallpaper Engine</span>
        <div class="scene-grid">
          ${engine.items.map((item) => html`<${WallpaperSwatch} key=${item.id} item=${item} active=${wallpaperId === item.id} onPick=${() => onWallpaper(item.id)} />`)}
        </div>
      </div>` : null}
      ${engine?.hidden ? html`<p class="scene-note">${engine.hidden} Wallpaper Engine ${engine.hidden === 1 ? "wallpaper is a" : "wallpapers are"} scene or web type, such as Fall and Christmas. Those only play inside Wallpaper Engine.</p>` : null}
    </div>
    <label class="focus-slider"><span>Dim</span><input type="range" min="0" max="0.75" step="0.05" value=${dim} onInput=${(event) => onDim(Number(event.currentTarget.value))} /></label>
    <button type="button" class="link small" onClick=${async () => {
      try {
        const result = await post("/api/focus/wallpapers/open-folder");
        toast(`Drop images or videos into ${result.folder}`);
      } catch (error) {
        reportError(error);
      }
    }}><${Icon} name="image" size=${14} /> Add your own wallpapers…</button>
  </div>`;
}

function AmbientPicker({ kind, volume, onKind, onVolume, onClose }) {
  return html`<div class="focus-pop" role="dialog" aria-label="Ambient sound">
    <div class="focus-pop-head"><strong>Ambient sound</strong><${IconButton} icon="x" label="Close" size=${15} onClick=${onClose} /></div>
    <div class="seg">
      ${AMBIENT.map((option) => html`<button type="button" class=${option.id === kind ? "is-active" : ""} onClick=${() => onKind(option.id)}>${option.label}</button>`)}
    </div>
    <label class="focus-slider"><span>Volume</span><input type="range" min="0" max="1" step="0.05" value=${volume} onInput=${(event) => onVolume(Number(event.currentTarget.value))} /></label>
  </div>`;
}

// ---------- helpers ----------
// Keep the phone's screen on during a session (iOS 16.4+, Chrome, Edge).
let wakeLock = null;
// Running agents at a glance, without leaving lock-in. The desktop's board is
// live; the phone reads the copy the desktop last synced.
function AgentsGlance({ open, onToggle }) {
  useEffect(() => {
    if (!isWeb.value) return undefined;
    loadWebBoard();
    const timer = setInterval(loadWebBoard, 30_000);
    return () => clearInterval(timer);
  }, []);
  const summary = agentSummary(board.value);
  if (!summary.total) return null;
  return html`<div class="menu-anchor">
    <button type="button" class=${`focus-agents ${summary.needsYou ? "needs-you" : ""} ${open ? "is-on" : ""}`} aria-haspopup="dialog" aria-expanded=${open ? "true" : "false"} onClick=${onToggle}>
      <${Icon} name="bot" size=${14} /><span class="focus-agents-long">${summaryLabel(summary)}</span><span class="focus-agents-short" aria-label=${summaryLabel(summary)}>${summary.total}</span>
    </button>
    ${open ? html`<div class="focus-pop" role="dialog" aria-label="Running agents">
      <div class="focus-pop-head"><strong>Agents</strong><${IconButton} icon="x" label="Close" size=${15} onClick=${onToggle} /></div>
      <ul class="focus-agent-list">
        ${summary.shown.map((session) => html`<li class=${`status-${session.status}`}>
          <span class=${`prov prov-${session.provider}`}>${session.provider === "codex" ? "Codex" : "Claude"}</span>
          <strong title=${session.title}>${session.title}</strong>
          <span class="focus-agent-line">${session.status === "needs-you" ? session.waitingFor || "Waiting for you" : session.status === "queued" ? session.waitingFor || "Queued" : session.current || "Working…"}</span>
        </li>`)}
      </ul>
      ${summary.more ? html`<p class="muted small">+${summary.more} more on the Agents page.</p>` : null}
    </div>` : null}
  </div>`;
}

async function keepAwake(on) {
  try {
    if (on && "wakeLock" in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    wakeLock = null;
  }
}

// A home-screen app on a phone is already full screen.
const standalone = () => window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;

async function setWindow(on) {
  if (isWeb.value) {
    await keepAwake(on);
    if (standalone() || "ontouchstart" in window) return false;
  }
  try {
    // Only the desktop app can pin the window; a browser falls back to fullscreen.
    if (focusState.value && !focusState.value.desktopAvailable) throw new ApiError("Browser mode", 409);
    const { window: status } = await post("/api/focus/window", { on });
    // Other windows on this monitor were moved so nothing is stuck behind Jarvis.
    if (on && status?.movedWindows) toast(`Moved ${status.movedWindows} window${status.movedWindows === 1 ? "" : "s"} to your other monitor. They come back when you leave.`);
    else if (on && status?.windowNote && status.moveOtherWindows) toast(status.windowNote);
    return true;
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 409) console.error(error);
    try {
      if (on && !document.fullscreenElement) await document.documentElement.requestFullscreen?.();
      if (!on && document.fullscreenElement) await document.exitFullscreen?.();
    } catch {
      // Fullscreen can be refused by the browser; focus mode still works.
    }
    return false;
  }
}

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function candidatesFrom(data) {
  if (!data) return [];
  const seen = new Set();
  const ordered = [
    ...data.blocks.filter((block) => block.kind === "task").map((block) => ({ ...block.task, slot: block.start })),
    ...data.unscheduled,
    ...data.carried
  ];
  return ordered.filter((task) => !task.done && !task.skipped && !seen.has(task.id) && seen.add(task.id));
}

// Meals aren't tasks, but you can still put a timer on one. They run as a
// labelled session, like "Something else" with the name filled in.
function mealsFrom(data) {
  return (data?.blocks || [])
    .filter((block) => block.kind === "meal")
    .map((block) => ({ id: `meal:${block.id}`, title: block.title, minutes: block.end - block.start, slot: block.start, meal: true, kind: "break" }));
}

// ---------- setup ----------
function Setup({ onStart, prefs }) {
  const today = todayKey.value;
  const [data, setData] = useState(day.value?.date === today ? day.value : null);
  useEffect(() => {
    if (!data) loadDay(today).then(setData).catch(reportError);
  }, []);
  const candidates = useMemo(() => [...candidatesFrom(data), ...mealsFrom(data)], [data]);
  const target = focusTarget.value;
  // A target without an id (a meal, say) starts a labelled session.
  const freeTarget = target && !target.id ? target : null;
  const [taskId, setTaskId] = useState(target?.id || null);
  useEffect(() => {
    if (!taskId && !freeTarget && candidates.length) setTaskId(candidates[0].id);
  }, [candidates.length]);
  const task = candidates.find((entry) => entry.id === taskId) || (target && target.id === taskId ? target : null);
  const [mode, setMode] = useState(prefs.mode);
  const [minutes, setMinutes] = useState(freeTarget?.minutes || null);
  const [label, setLabel] = useState(freeTarget?.title || "");
  const length = minutes || (mode === "pomodoro" ? POMODORO[prefs.pomodoro].work * 2 : task?.minutes || 50);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    try {
      // A meal has no task to credit the time to, so it carries its name
      // instead, and counts as a break rather than focused work.
      const chosen = task?.meal ? null : taskId;
      const kind = task?.meal || freeTarget?.kind === "break" ? "break" : "work";
      await onStart({ taskId: chosen || null, plannedMinutes: length, mode, kind, label: chosen ? "" : (task?.meal ? task.title : label) || "Free focus" });
    } finally {
      setBusy(false);
    }
  };

  return html`<div class="focus-setup">
    <div class="focus-setup-card glass">
      <div class="eyebrow">Focus</div>
      <h1>What are you locking in on?</h1>
      <div class="focus-task-list" role="listbox" aria-label="Choose a task">
        ${[...candidates.filter((entry) => !entry.meal).slice(0, 7), ...candidates.filter((entry) => entry.meal)].map((entry) => html`<button type="button" role="option" aria-selected=${entry.id === taskId ? "true" : "false"}
          class=${`focus-task-option ${entry.id === taskId ? "is-active" : ""}`} style=${{ "--cat": categoryColor(entry.category) }}
          onClick=${() => { setTaskId(entry.id); setMinutes(null); }}>
          <span class="dot" style=${{ background: "var(--cat)" }}></span>
          <span class="focus-task-title">${entry.title}</span>
          <span class="muted">${entry.slot !== undefined ? clock(entry.slot) : entry.date < today ? "carried" : "unplaced"} · ${formatMinutes(entry.minutes)}</span>
        </button>`)}
        <button type="button" role="option" aria-selected=${taskId === null ? "true" : "false"} class=${`focus-task-option ${taskId === null ? "is-active" : ""}`} onClick=${() => setTaskId(null)}>
          <span class="dot" style=${{ background: "var(--muted)" }}></span><span class="focus-task-title">Something else</span><span class="muted">free session</span>
        </button>
      </div>
      ${taskId === null ? html`<input class="input" placeholder="What's the session for?" value=${label} onInput=${(event) => setLabel(event.currentTarget.value)} />` : null}

      <div class="focus-setup-row">
        <div class="seg" role="radiogroup" aria-label="Timer mode">
          ${[["countdown", "Countdown"], ["pomodoro", "Pomodoro"], ["stopwatch", "Stopwatch"]].map(([id, text]) => html`<button type="button" role="radio" aria-checked=${mode === id ? "true" : "false"} class=${mode === id ? "is-active" : ""} onClick=${() => { setMode(id); setMinutes(null); prefs.setMode(id); }}>${text}</button>`)}
        </div>
        ${mode === "pomodoro" ? html`<div class="seg">${Object.keys(POMODORO).map((key) => html`<button type="button" class=${prefs.pomodoro === key ? "is-active" : ""} onClick=${() => { prefs.setPomodoro(key); setMinutes(null); }}>${key}</button>`)}</div>` : null}
      </div>
      ${mode !== "stopwatch" ? html`<div class="chips">
        ${[...new Set([task?.minutes, freeTarget?.minutes, 25, 50, 90].filter(Boolean))].map((value) => html`<button type="button" class=${`chip ${length === value ? "is-active" : ""}`} onClick=${() => setMinutes(value)}>${formatMinutes(value)}</button>`)}
        <label class="chip chip-input">
          <input type="number" min="5" max="300" step="5" value=${length} aria-label="Minutes" onChange=${(event) => setMinutes(Math.max(5, Math.min(300, Number(event.currentTarget.value) || 25)))} /> min
        </label>
      </div>` : null}
      <div class="scene-row" role="radiogroup" aria-label="Background">
        ${SCENES.map((entry) => html`<button type="button" role="radio" aria-checked=${!prefs.wallpaper && prefs.scene === entry.id ? "true" : "false"}
          class=${`scene-dot ${!prefs.wallpaper && prefs.scene === entry.id ? "is-active" : ""}`} style=${{ background: entry.swatch }} title=${entry.label}
          onClick=${() => { prefs.setWallpaper(null); prefs.setScene(entry.id); }}><span class="sr-only">${entry.label}</span></button>`)}
        <span class="muted small">${prefs.wallpaper ? "Your wallpaper" : sceneById(prefs.scene).label}</span>
      </div>
      <div class="focus-setup-foot">
        <button type="button" class="link" onClick=${() => navigate("today")}><${Icon} name="left" size=${14} /> Back to Today</button>
        <${Button} variant="primary" size="lg" icon="focus" disabled=${busy} onClick=${start}>Lock in${mode !== "stopwatch" ? ` for ${formatMinutes(length)}` : ""}</${Button}>
      </div>
      ${touchFirst()
        ? html`<p class="muted small center">Keeps your screen on. Press and hold <strong>Leave</strong> for 2 seconds to end early.</p>`
        : html`<p class="muted small center">${isWeb.value ? "Fullscreen while it runs." : "Fullscreen and always on top."} Hold <kbd class="kbd">Esc</kbd> for 2 seconds to leave early.</p>`}
    </div>
  </div>`;
}

// ---------- active session ----------
function useSessionClock(session) {
  const base = useRef({ elapsed: 0, at: performance.now(), running: false });
  const [, force] = useState(0);
  useEffect(() => {
    base.current = { elapsed: session?.elapsedSeconds || 0, at: performance.now(), running: session?.status === "active" };
  }, [session?.id, session?.elapsedSeconds, session?.status]);
  useEffect(() => {
    const id = setInterval(() => force((value) => value + 1), 250);
    return () => clearInterval(id);
  }, []);
  const { elapsed, at, running } = base.current;
  return elapsed + (running ? (performance.now() - at) / 1000 : 0);
}

function TaskPanel({ session, task, onNotes, notes, upNext }) {
  return html`<aside class="focus-panel glass">
    ${task ? html`
      ${task.doneWhen ? html`<section><h4><${Icon} name="flag" size=${13} /> Done when</h4><p>${task.doneWhen}</p></section>` : null}
      ${task.detail ? html`<section><h4>Plan</h4><p class="prose">${task.detail}</p></section>` : null}
      ${task.resources?.length ? html`<section><h4>Resources</h4>
        ${task.resources.map((resource) => html`<a class="focus-resource" href=${resource.url} target="_blank" rel="noreferrer">
          <span><strong>${resource.title}</strong>${resource.assignment ? html`<em>${resource.assignment}</em>` : null}</span><${Icon} name="external" size=${13} />
        </a>`)}
      </section>` : null}
      ${task.auditItems?.length ? html`<section><h4>Audit items</h4>
        ${task.auditItems.map((item) => html`<details class="audit-item"><summary><span class="audit-id">${item.id}</span><span>${item.title}</span></summary>
          <div class="prose md" dangerouslySetInnerHTML=${{ __html: renderMarkdown(item.detail) }}></div></details>`)}
      </section>` : null}` : null}
    <section>
      <h4><${Icon} name="note" size=${13} /> Session notes</h4>
      <textarea class="focus-notes" rows="7" placeholder=${task ? "Scratchpad. Saved to the task when you finish." : "Scratchpad. Saved with this session."} value=${notes} onInput=${(event) => onNotes(event.currentTarget.value)}></textarea>
    </section>
    ${upNext.length ? html`<section><h4>Up next</h4>${upNext.map((entry) => html`<div class="focus-next" style=${{ "--cat": categoryColor(entry.category) }}><span class="dot" style=${{ background: "var(--cat)" }}></span><span>${entry.title}</span><em>${formatMinutes(entry.minutes)}</em></div>`)}</section>` : null}
    <p class="muted small">${session.mode === "pomodoro" ? "Pomodoro" : session.mode === "stopwatch" ? "Stopwatch" : "Countdown"} · started ${new Date(session.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</p>
  </aside>`;
}

function Active({ prefs, onLeave, onDone }) {
  const state = focusState.value;
  const session = state.session;
  const elapsed = useSessionClock(session);
  const now = useClock();
  const [task, setTask] = useState(null);
  const [notes, setNotes] = useState(session.notes || "");
  // On a phone the details panel would cover the timer, so it starts closed there.
  const [panel, setPanel] = useState(() => !window.matchMedia?.("(max-width: 720px)").matches);
  const [pop, setPop] = useState(null);
  const [hold, setHold] = useState(0);
  const [restUntil, setRestUntil] = useState(null);
  const [finishedFor, setFinishedFor] = useState(null);
  const notesTimer = useRef(null);
  const holdRef = useRef(null);
  const pomodorosDone = useRef(null);
  const [wallpapers, setWallpapers] = useState([]);
  const [engine, setEngine] = useState(null);

  useEffect(() => {
    if (session.taskId) get(`/api/plan/task?id=${encodeURIComponent(session.taskId)}`).then((data) => setTask(data.task)).catch(() => setTask(null));
    else setTask(null);
    setNotes(session.notes || "");
  }, [session.id]);
  useEffect(() => {
    get("/api/focus/wallpapers").then((data) => {
      setWallpapers(data.wallpapers);
      setEngine(data.engine || null);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!isWeb.value) return undefined;
    const onVisible = () => document.visibilityState === "visible" && keepAwake(true);
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // Heartbeat so the server keeps counting only while this screen is alive.
  useEffect(() => {
    if (session.status !== "active") return undefined;
    const beat = () => post("/api/focus/heartbeat").then((data) => { focusState.value = data; }).catch(() => {});
    const id = setInterval(beat, 30_000);
    return () => clearInterval(id);
  }, [session.id, session.status]);

  const planned = session.plannedMinutes * 60;
  const pomo = POMODORO[prefs.pomodoro];
  const remaining = planned - elapsed;
  const overtime = session.mode !== "stopwatch" && remaining <= 0;

  // Countdown end and Pomodoro breaks.
  useEffect(() => {
    if (session.mode === "stopwatch" || session.status !== "active") return;
    if (overtime && finishedFor !== session.id) {
      setFinishedFor(session.id);
      chime();
      if ("Notification" in window && Notification.permission === "granted") new Notification("Focus block complete", { body: session.label || task?.title || "Nice work." });
      return;
    }
    if (session.mode === "pomodoro" && !overtime && !restUntil) {
      const block = pomo.work * 60;
      const done = Math.floor(elapsed / block);
      // Coming back to a session mid-way shouldn't trigger a past break.
      if (pomodorosDone.current === null) pomodorosDone.current = done;
      if (done > pomodorosDone.current && elapsed < planned - 30) {
        pomodorosDone.current = done;
        chime();
        post("/api/focus/pause").then((data) => { focusState.value = data; }).catch(reportError);
        setRestUntil(Date.now() + pomo.rest * 60_000);
      }
    }
  });
  useEffect(() => {
    if (!restUntil) return undefined;
    const id = setInterval(() => {
      if (Date.now() >= restUntil) {
        chime();
        setRestUntil(0);
      }
    }, 500);
    return () => clearInterval(id);
  }, [restUntil]);

  const togglePause = async () => {
    try {
      focusState.value = await post(session.status === "active" ? "/api/focus/pause" : "/api/focus/resume");
      if (restUntil !== null) setRestUntil(null);
    } catch (error) {
      reportError(error);
    }
  };

  const saveNotes = (value) => {
    setNotes(value);
    clearTimeout(notesTimer.current);
    notesTimer.current = setTimeout(() => post("/api/focus/notes", { notes: value }).catch(() => {}), 700);
  };

  // Hold Escape (or the on-screen button) to leave.
  const beginHold = () => {
    if (holdRef.current) return;
    const started = performance.now();
    const step = () => {
      const progress = Math.min(1, (performance.now() - started) / HOLD_MS);
      setHold(progress);
      if (progress >= 1) {
        holdRef.current = null;
        setHold(0);
        onLeave({ early: !overtime && session.mode !== "stopwatch", heldMs: Math.round(performance.now() - started), elapsed });
        return;
      }
      holdRef.current = requestAnimationFrame(step);
    };
    holdRef.current = requestAnimationFrame(step);
  };
  const endHold = () => {
    if (holdRef.current) cancelAnimationFrame(holdRef.current);
    holdRef.current = null;
    setHold(0);
  };
  useEffect(() => {
    const down = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!event.repeat) beginHold();
      }
      if (event.code === "Space" && !["TEXTAREA", "INPUT", "BUTTON"].includes(event.target.tagName)) {
        event.preventDefault();
        togglePause();
      }
    };
    const up = (event) => event.key === "Escape" && endHold();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", endHold);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", endHold);
    };
  });

  const upNext = candidatesFrom(day.value).filter((entry) => entry.id !== session.taskId).slice(0, 3);
  // Choices used to be stored by file name; fall back to that for an old one.
  const choices = [...wallpapers, ...(engine?.items || [])];
  const wallpaper = choices.find((item) => item.id === prefs.wallpaper) || choices.find((item) => item.name === prefs.wallpaper) || null;
  const title = task?.title || session.label || "Focus session";
  const category = task?.category;
  const display = session.mode === "stopwatch" ? elapsed : overtime ? -remaining : remaining;
  const progress = session.mode === "stopwatch" ? (elapsed % 3600) / 3600 : Math.min(1, elapsed / planned);
  const resting = restUntil && restUntil > Date.now();

  return html`<div class=${`focus-stage ${panel ? "has-panel" : ""}`}>
    <${Backdrop} sceneId=${prefs.scene} wallpaper=${wallpaper} dim=${prefs.dim} />
    <header class="focus-top">
      <div class="focus-clock"><strong>${now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</strong><span>${formatDate(todayKey.value, { weekday: "long", month: "long", day: "numeric" })}</span></div>
      <div class="focus-top-tools">
        <span class="focus-stat"><${Icon} name="timer" size=${14} />${formatMinutes(((state.today?.seconds || 0) + 0) / 60)} today</span>
        <${AgentsGlance} open=${pop === "agents"} onToggle=${() => setPop(pop === "agents" ? null : "agents")} />
        <div class="menu-anchor">
          <${IconButton} icon="wave" label="Ambient sound" class=${prefs.ambient !== "off" ? "is-on" : ""} onClick=${() => setPop(pop === "ambient" ? null : "ambient")} />
          ${pop === "ambient" ? html`<${AmbientPicker} kind=${prefs.ambient} volume=${prefs.volume} onClose=${() => setPop(null)}
            onKind=${(kind) => { prefs.setAmbient(kind); playAmbient(kind, prefs.volume); }}
            onVolume=${(value) => { prefs.setVolume(value); setAmbientVolume(value); }} />` : null}
        </div>
        <div class="menu-anchor">
          <${IconButton} icon="image" label="Background" onClick=${() => setPop(pop === "scene" ? null : "scene")} />
          ${pop === "scene" ? html`<${ScenePicker} sceneId=${prefs.scene} wallpaperId=${wallpaper?.id || null} wallpapers=${wallpapers} engine=${engine} dim=${prefs.dim}
            onScene=${prefs.setScene} onWallpaper=${prefs.setWallpaper} onDim=${prefs.setDim} onClose=${() => setPop(null)} />` : null}
        </div>
        <${IconButton} icon="list" label=${panel ? "Hide details" : "Show details"} class=${panel ? "is-on" : ""} onClick=${() => setPanel(!panel)} />
      </div>
    </header>

    <main class="focus-center">
      <div class="focus-eyebrow" style=${{ "--cat": category ? categoryColor(category) : "var(--accent)" }}>
        <span class="dot" style=${{ background: "var(--cat)" }}></span>${category ? CATEGORY_META[category]?.label : "Focus"}
        ${session.mode === "pomodoro" ? html`<span class="sep"></span>Pomodoro ${prefs.pomodoro}` : null}
      </div>
      <h1 class="focus-title">${title}</h1>
      <div class=${`focus-timer ${session.status !== "active" ? "is-paused" : ""} ${overtime ? "is-over" : ""}`} role="timer" aria-live="off">
        ${overtime ? html`<span class="focus-plus">+</span>` : null}${timer(display)}
      </div>
      <div class="focus-progress" aria-hidden="true"><span style=${{ width: `${progress * 100}%` }}></span></div>
      <div class="focus-sub">
        ${resting ? html`<span>Break · back in ${timer((restUntil - Date.now()) / 1000)}</span>`
          : restUntil === 0 ? html`<span>Break's over.</span>`
          : session.status !== "active" ? html`<span>Paused${session.autoPaused ? " while you were away" : ""}</span>`
          : overtime ? html`<span>Block complete. Keep going or wrap it up.</span>`
          : session.mode === "stopwatch" ? html`<span>${formatMinutes(elapsed / 60)} in</span>`
          : html`<span>of ${formatMinutes(session.plannedMinutes)} · ends ${new Date(Date.now() + remaining * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>`}
      </div>
      <div class="focus-controls">
        <button type="button" class="focus-ctl" onClick=${togglePause} aria-label=${session.status === "active" ? "Pause" : "Resume"}>
          <${Icon} name=${session.status === "active" ? "pause" : "play"} size=${20} />
        </button>
        ${session.mode !== "stopwatch" ? html`<button type="button" class="focus-ctl focus-ctl-text" onClick=${async () => {
          try {
            focusState.value = await post("/api/focus/extend", { minutes: overtime ? 10 : 5 });
            if (overtime) setFinishedFor(null);
          } catch (error) {
            reportError(error);
          }
        }}>+${overtime ? 10 : 5} min</button>` : null}
        <button type="button" class="focus-ctl focus-ctl-primary" onClick=${() => onDone(true, elapsed)}>
          <${Icon} name="check" size=${18} /><span>${session.taskId ? "Done" : "Finish"}</span>
        </button>
        ${overtime || session.mode === "stopwatch" ? html`<button type="button" class="focus-ctl focus-ctl-text" onClick=${() => onDone(false, elapsed)}>End session</button>` : null}
      </div>
    </main>

    ${panel ? html`<${TaskPanel} session=${session} task=${task} notes=${notes} onNotes=${saveNotes} upNext=${upNext} />` : null}

    <footer class="focus-dock">
      <div class="glass focus-dock-inner">${can.value.spotify
        ? html`<${SpotifyPlayer} variant="dock" interval=${10000} />`
        : html`<a class="spotify-link" href="spotify:"><${Icon} name="music" size=${18} /><span>Open Spotify</span></a>`}</div>
      <button type="button" class="focus-leave" onPointerDown=${beginHold} onPointerUp=${endHold} onPointerLeave=${endHold} onPointerCancel=${endHold}
        onContextMenu=${(event) => event.preventDefault()} aria-label="Hold to leave focus mode">
        <svg viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15" class="track"></circle><circle cx="18" cy="18" r="15" class="fill" style=${{ strokeDashoffset: `${94.25 * (1 - hold)}` }}></circle></svg>
        ${touchFirst() ? html`<span>Hold to leave</span>` : html`<span>Hold <kbd class="kbd">Esc</kbd> to leave</span>`}
      </button>
    </footer>
    ${hold > 0 ? html`<div class="focus-hold" aria-live="polite"><div class="focus-hold-ring" style=${{ "--p": hold }}></div><span>${overtime || session.mode === "stopwatch" ? "Ending session…" : "Leaving early…"}</span></div>` : null}
  </div>`;
}

// ---------- summary after a session ----------
function Summary({ result, onNext, onBreak, onExit }) {
  const next = candidatesFrom(day.value)[0];
  return html`<div class="focus-setup">
    <div class="focus-setup-card glass center">
      <div class="summary-badge"><${Icon} name="check" size=${26} /></div>
      <h1>${result.done ? "Session complete" : "Session saved"}</h1>
      <p class="muted">${formatMinutes(result.seconds / 60)} on ${result.title}${result.done ? ", marked done" : ""}.</p>
      ${next ? html`<div class="summary-next" style=${{ "--cat": categoryColor(next.category) }}>
        <div class="eyebrow">Up next</div><strong>${next.title}</strong><span class="muted">${formatMinutes(next.minutes)}</span>
      </div>` : null}
      <div class="row gap-2 center wrap">
        ${next ? html`<${Button} variant="primary" icon="play" onClick=${() => onNext(next)}>Start next</${Button}>` : null}
        <${Button} icon="clock" onClick=${onBreak}>Take a 10 min break</${Button}>
        <${Button} variant="ghost" onClick=${onExit}>Back to Today</${Button}>
      </div>
    </div>
  </div>`;
}

function BreakScreen({ until, onEnd }) {
  const now = useClock();
  const left = Math.max(0, (until - now.getTime()) / 1000);
  useEffect(() => {
    if (left <= 0) chime();
  }, [left <= 0]);
  return html`<div class="focus-setup">
    <div class="focus-setup-card glass center">
      <div class="eyebrow">Break</div>
      <div class="focus-timer small">${timer(left)}</div>
      <p class="muted">${left > 0 ? "Stand up, drink water, look at something far away." : "Break's over."}</p>
      <div class="row gap-2 center"><${Button} variant="primary" icon="focus" onClick=${onEnd}>${left > 0 ? "Skip break" : "Pick the next task"}</${Button}></div>
    </div>
  </div>`;
}

// ---------- page ----------
export function FocusPage() {
  const [scene, setScene] = usePref("scene", "aurora");
  const [wallpaper, setWallpaper] = usePref("wallpaper", null);
  const [dim, setDim] = usePref("dim", 0.25);
  const [ambient, setAmbient] = usePref("ambient", "off");
  const [volume, setVolume] = usePref("volume", 0.5);
  const [mode, setMode] = usePref("mode", "countdown");
  const [pomodoro, setPomodoro] = usePref("pomodoro", "50/10");
  const prefs = { scene, setScene, wallpaper, setWallpaper, dim, setDim, ambient, setAmbient, volume, setVolume, mode, setMode, pomodoro, setPomodoro };
  const [summary, setSummary] = useState(null);
  const [breakUntil, setBreakUntil] = useState(null);
  const [leaving, setLeaving] = useState(null);
  const session = focusState.value?.session;

  useEffect(() => {
    document.body.classList.add("is-focus");
    return () => {
      document.body.classList.remove("is-focus");
      stopAmbient();
    };
  }, []);
  // Resume ambient sound and fullscreen when coming back to a running session.
  useEffect(() => {
    if (!session) return;
    if (ambient !== "off") playAmbient(ambient, volume);
    setWindow(true);
  }, [session?.id]);

  const start = async (body) => {
    try {
      if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
      focusState.value = await post("/api/focus/start", body);
      focusTarget.value = null;
      setSummary(null);
      setBreakUntil(null);
      await setWindow(true);
    } catch (error) {
      reportError(error);
    }
  };

  const exitFocus = async () => {
    stopAmbient();
    await setWindow(false);
    refresh();
    navigate("today");
  };

  const done = async (markDone, elapsed = 0) => {
    const current = focusState.value?.session;
    if (!current) return;
    const title = current.label || day.value?.tasks.find((task) => task.id === current.taskId)?.title || "this task";
    try {
      const state = await post("/api/focus/stop", { markDone: Boolean(markDone && current.taskId) });
      focusState.value = state;
      setSummary({ done: Boolean(markDone && current.taskId), title, seconds: elapsed || current.elapsedSeconds });
      await loadDay(todayKey.value);
      refresh();
    } catch (error) {
      reportError(error);
    }
  };

  const leave = async ({ early, heldMs, elapsed }) => {
    if (!early) {
      await done(false, elapsed);
      await exitFocus();
      return;
    }
    setLeaving({ heldMs, reason: "" });
  };

  const confirmLeave = async () => {
    try {
      focusState.value = await post("/api/focus/exit-early", { reason: leaving.reason, heldMs: leaving.heldMs, source: "hold-escape" });
    } catch (error) {
      reportError(error);
    }
    setLeaving(null);
    await exitFocus();
  };

  let body;
  if (session) body = html`<${Active} prefs=${prefs} onLeave=${leave} onDone=${done} />`;
  else if (breakUntil) body = html`<${BreakScreen} until=${breakUntil} onEnd=${() => setBreakUntil(null)} />`;
  else if (summary) {
    body = html`<${Summary} result=${summary}
      onNext=${(next) => start({ taskId: next.id, plannedMinutes: next.minutes, mode: mode === "stopwatch" ? "countdown" : mode })}
      onBreak=${() => { setSummary(null); setBreakUntil(Date.now() + 10 * 60_000); }}
      onExit=${exitFocus} />`;
  } else body = html`<${Setup} prefs=${prefs} onStart=${start} />`;

  return html`<div class="focus-root">
    ${!session ? html`<${Backdrop} sceneId=${scene} wallpaper=${null} dim=${Math.max(dim, 0.35)} />` : null}
    ${body}
    <${Modal} open=${Boolean(leaving)} onClose=${() => setLeaving(null)} title="Leave this session early?" class="modal-glass">
      ${leaving ? html`<div class="modal-body">
        <p class="muted">The time you put in is saved to the task. Leaving early is noted on the session.</p>
        <div class="chips">${EXIT_REASONS.map((reason) => html`<button type="button" class=${`chip ${leaving.reason === reason ? "is-active" : ""}`} onClick=${() => setLeaving({ ...leaving, reason })}>${reason}</button>`)}</div>
        <input class="input" placeholder="Or say why (optional)" value=${EXIT_REASONS.includes(leaving.reason) ? "" : leaving.reason} onInput=${(event) => setLeaving({ ...leaving, reason: event.currentTarget.value })} />
      </div>
      <footer class="modal-foot">
        <${Button} variant="primary" autofocus onClick=${() => setLeaving(null)}>Stay focused</${Button}>
        <${Button} variant="ghost" onClick=${confirmLeave}>Leave</${Button}>
      </footer>` : null}
    </${Modal}>
  </div>`;
}
