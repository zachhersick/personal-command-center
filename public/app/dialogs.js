import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { html } from "./html.js";
import { Icon } from "./icons.js";
import { Button, Field, Kbd, Modal } from "./ui.js";
import { get, post } from "./api.js";
import { addDays, categoryColor, CATEGORY_META, formatMinutes, relativeDay } from "./format.js";
import {
  appUpdate, day, loadAppUpdate, loadDay, meta, navigate, neetcodePrompt, openTask, paletteOpen, previewSpread, refresh, reportError, setTheme, settingsOpen, startFocusOn, theme, todayKey, toast, triage, viewDate
} from "./store.js";
import { can, isWeb, webUser } from "./platform.js";
import { JobsSettings } from "./jobs/settings.js";
import { logApplication } from "./jobs/jobs.js";

// ---------- NeetCode log ----------
const RESULTS = [
  { id: "independent", label: "Solved alone", hint: "No hints" },
  { id: "hinted", label: "With hints", hint: "Needed a nudge" },
  { id: "studied", label: "Studied it", hint: "Read the answer" }
];

export function NeetcodeDialog() {
  const prompt = neetcodePrompt.value;
  const [form, setForm] = useState({ problem: "", url: "", pattern: "", result: "", notes: "" });
  useEffect(() => {
    if (prompt) setForm({ problem: prompt.review?.problem || "", url: prompt.review?.url || "", pattern: "", result: "", notes: "" });
  }, [prompt]);
  const close = () => {
    neetcodePrompt.value = null;
  };
  const submit = async (event) => {
    event.preventDefault();
    if (!form.result) return toast("Pick how it went.", { tone: "warn" });
    try {
      await post("/api/plan/neetcode/log", {
        ...form,
        taskId: prompt.taskId,
        date: todayKey.value,
        reviewOf: prompt.review?.id,
        interval: prompt.review?.interval
      });
      toast(form.result === "independent" ? "Logged. Clean solve." : `Logged. It'll come back for review in 7 days.`, { tone: "good" });
      close();
      refresh();
    } catch (error) {
      reportError(error);
    }
    return null;
  };
  return html`<${Modal} open=${Boolean(prompt)} onClose=${close} title=${prompt?.review ? prompt.title : "Log the problem"}>
    <form class="modal-body form" onSubmit=${submit}>
      ${!prompt?.review ? html`<p class="muted small">Logging each problem powers your spaced review: misses come back after 7 and 21 days.</p>` : null}
      <${Field} label="Problem"><input class="input" autofocus required value=${form.problem} placeholder="e.g. Longest Substring Without Repeating Characters" onInput=${(event) => setForm({ ...form, problem: event.currentTarget.value })} /></${Field}>
      <div class="form-row">
        <${Field} label="Link (optional)"><input class="input" type="url" value=${form.url} placeholder="https://neetcode.io/problems/…" onInput=${(event) => setForm({ ...form, url: event.currentTarget.value })} /></${Field}>
        <${Field} label="Pattern (optional)"><input class="input" value=${form.pattern} placeholder="Sliding window" onInput=${(event) => setForm({ ...form, pattern: event.currentTarget.value })} /></${Field}>
      </div>
      <div class="result-picker" role="radiogroup" aria-label="How it went">
        ${RESULTS.map((result) => html`<button type="button" role="radio" aria-checked=${form.result === result.id ? "true" : "false"}
          class=${`result-option nc-${result.id} ${form.result === result.id ? "is-active" : ""}`} onClick=${() => setForm({ ...form, result: result.id })}>
          <strong>${result.label}</strong><span>${result.hint}</span>
        </button>`)}
      </div>
      <${Field} label="Thing to remember (optional)"><textarea class="input" rows="2" value=${form.notes} onInput=${(event) => setForm({ ...form, notes: event.currentTarget.value })}></textarea></${Field}>
      <footer class="modal-foot flush"><${Button} variant="ghost" onClick=${close}>Skip</${Button}><${Button} variant="primary" type="submit" icon="check">Log it</${Button}></footer>
    </form>
  </${Modal}>`;
}

// ---------- settings ----------
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const toTime = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const fromTime = (value) => {
  const [hours, minutes] = String(value || "0:0").split(":").map(Number);
  return hours * 60 + minutes;
};

function ScheduleEditor({ settings, onSave }) {
  const [draft, setDraft] = useState(settings);
  useEffect(() => setDraft(settings), [settings]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const setClass = (dayIndex, slot, value) => {
    const classTimes = draft.classTimes.map((entry) => [...entry]);
    classTimes[dayIndex][slot] = fromTime(value);
    setDraft({ ...draft, classTimes });
  };
  const addBlock = (dayIndex) => {
    const classTimes = draft.classTimes.map((entry) => [...entry]);
    const last = classTimes[dayIndex].at(-1) || 540;
    classTimes[dayIndex].push(Math.min(1380, last + 30), Math.min(1435, last + 120));
    setDraft({ ...draft, classTimes });
  };
  const removeBlock = (dayIndex, pair) => {
    const classTimes = draft.classTimes.map((entry) => [...entry]);
    classTimes[dayIndex].splice(pair * 2, 2);
    setDraft({ ...draft, classTimes });
  };
  const breakWeek = draft.newBreak || "";
  return html`<div class="schedule-editor">
    <div class="form-row">
      <${Field} label="Day starts"><input class="input" type="time" step="300" value=${toTime(draft.dayStart)} onChange=${(event) => setDraft({ ...draft, dayStart: fromTime(event.currentTarget.value) })} /></${Field}>
      <${Field} label="Day ends"><input class="input" type="time" step="300" value=${toTime(draft.dayEnd)} onChange=${(event) => setDraft({ ...draft, dayEnd: fromTime(event.currentTarget.value) })} /></${Field}>
      <${Field} label="Capstone per week"><select class="input" value=${draft.capstoneMinutes} onChange=${(event) => setDraft({ ...draft, capstoneMinutes: Number(event.currentTarget.value) })}>
        ${[0, 60, 120, 180, 240, 300, 360].map((value) => html`<option value=${value}>${value ? formatMinutes(value) : "None"}</option>`)}
      </select></${Field}>
    </div>
    <div class="row space-between"><h4>Classes</h4><label class="toggle"><input type="checkbox" checked=${draft.classMode} onChange=${(event) => setDraft({ ...draft, classMode: event.currentTarget.checked })} /><span>School in session</span></label></div>
    <div class=${`class-grid ${draft.classMode ? "" : "is-off"}`}>
      ${WEEKDAYS.map((name, dayIndex) => {
        const times = draft.classTimes[dayIndex] || [];
        const pairs = [];
        for (let i = 0; i < times.length; i += 2) pairs.push([times[i], times[i + 1]]);
        return html`<div class="class-day">
          <strong>${name}</strong>
          ${pairs.map(([start, end], pair) => html`<div class="class-block">
            <input type="time" step="300" value=${toTime(start)} aria-label=${`${name} block ${pair + 1} start`} onChange=${(event) => setClass(dayIndex, pair * 2, event.currentTarget.value)} />
            <span>–</span>
            <input type="time" step="300" value=${toTime(end)} aria-label=${`${name} block ${pair + 1} end`} onChange=${(event) => setClass(dayIndex, pair * 2 + 1, event.currentTarget.value)} />
            <button type="button" class="icon-btn ghost" aria-label="Remove block" onClick=${() => removeBlock(dayIndex, pair)}><${Icon} name="x" size=${13} /></button>
          </div>`)}
          ${!pairs.length ? html`<span class="muted small">No classes</span>` : null}
          <button type="button" class="link small" onClick=${() => addBlock(dayIndex)}>+ Add block</button>
        </div>`;
      })}
    </div>
    <h4>Gym</h4>
    <div class="form-row">
      <${Field} label="Cycle anchor day" hint="Any day you know the split for."><input class="input" type="date" value=${draft.gymAnchor} onChange=${(event) => setDraft({ ...draft, gymAnchor: event.currentTarget.value })} /></${Field}>
      <${Field} label="That day was"><select class="input" value=${draft.gymPhase} onChange=${(event) => setDraft({ ...draft, gymPhase: Number(event.currentTarget.value), gymConfirmed: true })}>
        ${["Push", "Pull", "Legs", "Rest"].map((label, index) => html`<option value=${index}>${label}</option>`)}
      </select></${Field}>
      <${Field} label="Weekend gym time"><input class="input" type="time" step="300" value=${toTime(draft.weekendGym)} onChange=${(event) => setDraft({ ...draft, weekendGym: fromTime(event.currentTarget.value) })} /></${Field}>
    </div>
    <h4>Break weeks</h4>
    <p class="muted small">No classes these weeks (Monday dates).</p>
    <div class="chips">
      ${draft.breakWeeks.map((week) => html`<span class="chip">${week}<button type="button" class="chip-x" aria-label=${`Remove ${week}`} onClick=${() => setDraft({ ...draft, breakWeeks: draft.breakWeeks.filter((entry) => entry !== week) })}>×</button></span>`)}
      <input class="input input-sm" type="date" value=${breakWeek} aria-label="Add a break week" onChange=${(event) => {
        const value = event.currentTarget.value;
        if (value && !draft.breakWeeks.includes(value)) setDraft({ ...draft, breakWeeks: [...draft.breakWeeks, value].sort() });
      }} />
    </div>
    <footer class="modal-foot flush">
      <${Button} variant="ghost" disabled=${!dirty} onClick=${() => setDraft(settings)}>Reset</${Button}>
      <${Button} variant="primary" icon="check" disabled=${!dirty} onClick=${() => onSave(draft)}>Save schedule</${Button}>
    </footer>
  </div>`;
}

function SpotifySettings() {
  const [status, setStatus] = useState(null);
  const [clientId, setClientId] = useState("");
  const load = () => get("/api/integrations/spotify/status").then(setStatus).catch((error) => setStatus({ error: error.message }));
  useEffect(() => {
    load();
  }, []);
  if (!status) return html`<p class="muted small">Checking Spotify…</p>`;
  const connect = async () => {
    try {
      const data = await post("/api/integrations/spotify/connect", clientId ? { clientId } : {});
      window.open(data.authorizationUrl, "_blank");
      toast("Finish connecting in your browser, then come back.");
      setTimeout(load, 8000);
    } catch (error) {
      reportError(error);
    }
  };
  if (status.connected && !status.requiresReconnect && !status.musicReconnect) {
    return html`<div class="row space-between">
      <span><span class="pill pill-good">Connected</span> ${status.playback ? html`<span class="muted small">Now playing: ${status.playback.title}</span>` : null}</span>
      <${Button} size="sm" variant="ghost" onClick=${async () => { await post("/api/integrations/spotify/disconnect"); load(); }}>Disconnect</${Button}>
    </div>`;
  }
  // Playback still works; the Music tab needs recently played and playlist access.
  if (status.connected && !status.requiresReconnect) {
    return html`<div class="form">
      <p class="small"><span class="pill pill-good">Connected</span> <span class="muted">Reconnect once so the Music tab can record your plays and manage its playlists.</span></p>
      <div class="row gap-2"><${Button} variant="primary" onClick=${connect}>Reconnect</${Button}></div>
    </div>`;
  }
  return html`<div class="form">
    <p class="muted small">Playback control needs Spotify Premium. Create an app at developer.spotify.com, add <code>http://127.0.0.1:${location.port}/api/integrations/spotify/callback</code> as a redirect URI, then paste its client ID.</p>
    <div class="row gap-2">
      <input class="input" placeholder=${status.configured ? "Client ID saved" : "Spotify client ID"} value=${clientId} onInput=${(event) => setClientId(event.currentTarget.value.trim())} />
      <${Button} variant="primary" onClick=${connect} disabled=${!clientId && !status.configured}>${status.requiresReconnect ? "Reconnect" : "Connect"}</${Button}>
    </div>
  </div>`;
}

// ---------- app updates ----------
// ---------- cloud sync (desktop) ----------
function CloudSyncSection() {
  const [status, setStatus] = useState(null);
  const [form, setForm] = useState({ url: "https://jarvis.example.com", token: "" });
  const [busy, setBusy] = useState(false);
  const load = () => get("/api/cloud/status").then(setStatus).catch(() => setStatus({ configured: false }));
  useEffect(() => {
    load();
  }, []);
  const run = async (path, body) => {
    setBusy(true);
    try {
      setStatus(await post(`/api/cloud/${path}`, body));
      if (path === "connect") {
        toast("Connected. Your plan now syncs with the cloud.", { tone: "good" });
        setForm({ ...form, token: "" });
        refresh();
      }
      if (path === "sync") refresh();
    } catch (error) {
      reportError(error);
    }
    setBusy(false);
  };
  if (!status) return null;
  return html`<section class="cloud-sync">
    <h3>Cloud sync</h3>
    ${status.configured ? html`<div class="row space-between wrap gap-2">
      <span class="small">
        <span class=${`pill ${status.lastError ? "pill-warn" : "pill-good"}`}>${status.lastError ? "Problem" : "Connected"}</span>
        ${" "}<code>${status.url}</code>${status.device ? ` as ${status.device}` : ""}
        ${status.lastSyncAt ? html`<span class="muted"> · synced ${new Date(status.lastSyncAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>` : null}
      </span>
      <span class="row gap-2">
        <${Button} size="sm" icon="undo" disabled=${busy} onClick=${() => run("sync", {})}>Sync now</${Button}>
        <${Button} size="sm" variant="ghost" disabled=${busy} onClick=${() => window.confirm("Stop syncing this computer with the cloud?") && run("disconnect", {})}>Disconnect</${Button}>
      </span>
    </div>
    ${status.lastError ? html`<p class="warn small">${status.lastError}</p>` : null}
    <div class="form">
      <label class="toggle"><input type="checkbox" checked=${Boolean(status.phoneAgents)} disabled=${busy} onChange=${(event) => {
        const enabled = event.currentTarget.checked;
        if (enabled && !window.confirm("Your phone will be able to start agents on this computer, reply to them, stop them and cancel queued ones. They run in their own worktrees with the same permissions as runs you start here. Nothing is kept, discarded or pushed from the phone. Turn it on?")) {
          event.currentTarget.checked = false;
          return;
        }
        run("phone-agents", { enabled });
      }} /><span>Let my phone start and steer agents</span></label>
      <p class="muted small">Commands reach this computer within about 30 seconds while Jarvis is open, and expire after 10 minutes.</p>
    </div>` : html`<div class="form">
      <p class="muted small">Sync your plan with your phone. On jarvis.example.com, open Settings → Devices → Connect a desktop, then paste the token here.</p>
      <div class="form-row">
        <${Field} label="Cloud address"><input class="input" value=${form.url} onInput=${(event) => setForm({ ...form, url: event.currentTarget.value })} /></${Field}>
        <${Field} label="Device token"><input class="input" type="password" autocomplete="off" placeholder="jvs_…" value=${form.token} onInput=${(event) => setForm({ ...form, token: event.currentTarget.value.trim() })} /></${Field}>
      </div>
      <div><${Button} variant="primary" icon="check" disabled=${busy || !form.token} onClick=${() => run("connect", form)}>Connect</${Button}></div>
    </div>`}
  </section>`;
}

// ---------- focus: move other windows (Windows desktop) ----------
function MoveWindowsToggle() {
  const [status, setStatus] = useState(null);
  useEffect(() => {
    get("/api/focus/state").then((data) => setStatus(data.window)).catch(() => setStatus(null));
  }, []);
  if (!status?.canMoveWindows) return null;
  const toggle = async (event) => {
    try {
      setStatus((await post("/api/focus/move-windows", { enabled: event.currentTarget.checked })).window);
    } catch (error) {
      reportError(error);
    }
  };
  return html`<div class="form">
    <label class="toggle"><input type="checkbox" checked=${status.moveOtherWindows} onChange=${toggle} /><span>Move other windows to my other monitor during focus</span></label>
    <p class="muted small">So apps like Spotify aren't stuck behind Jarvis. They go back where they were when you leave focus mode.</p>
  </div>`;
}

// ---------- devices (web) ----------
function DevicesSection() {
  const [devices, setDevices] = useState(null);
  const [created, setCreated] = useState(null);
  const [name, setName] = useState("My PC");
  const load = () => get("/api/devices").then((data) => setDevices(data.devices)).catch(reportError);
  useEffect(() => {
    load();
  }, []);
  const create = async () => {
    try {
      const data = await post("/api/devices", { name });
      setCreated(data);
      load();
    } catch (error) {
      reportError(error);
    }
  };
  return html`<section class="devices">
    <div class="row space-between wrap gap-2">
      <h3>Devices</h3>
      <span class="muted small">Signed in as ${webUser.value?.login || "you"} · <button type="button" class="link small" onClick=${async () => { await post("/api/auth/logout").catch(() => {}); location.href = "/"; }}>Sign out</button></span>
    </div>
    <p class="muted small">Each Jarvis desktop syncs your plan here with its own token. Revoke a token to cut that computer off.</p>
    ${(devices || []).map((device) => html`<div class="device-row">
      <strong>${device.name}</strong>
      <span class="muted small">${device.last_seen_at ? `last synced ${new Date(device.last_seen_at).toLocaleString()}` : "never synced"}</span>
      <${Button} size="sm" variant="ghost" onClick=${async () => { if (!window.confirm(`Revoke ${device.name}? It stops syncing until you connect it again.`)) return; try { await post("/api/devices/revoke", { id: device.id }); load(); } catch (error) { reportError(error); } }}>Revoke</${Button}>
    </div>`)}
    ${devices && !devices.length ? html`<p class="small">No desktops connected yet.</p>` : null}
    ${created ? html`<div class="token-card">
      <strong>Token for ${created.device.name}</strong>
      <p class="muted small">Copy it now; it won't be shown again. In Jarvis on that computer: Settings → Cloud sync → paste it → Connect.</p>
      <code class="token">${created.token}</code>
      <div class="row gap-2"><${Button} size="sm" icon="note" onClick=${async () => { await navigator.clipboard?.writeText(created.token); toast("Token copied"); }}>Copy</${Button}><${Button} size="sm" variant="ghost" onClick=${() => setCreated(null)}>Done</${Button}></div>
    </div>` : html`<div class="row gap-2 wrap">
      <input class="input input-sm" value=${name} aria-label="Device name" onInput=${(event) => setName(event.currentTarget.value)} />
      <${Button} size="sm" variant="primary" icon="plus" onClick=${create}>Connect a desktop</${Button}>
    </div>`}
  </section>`;
}

function UpdatesSection() {
  const status = appUpdate.value;
  const [busy, setBusy] = useState("");
  const [blocked, setBlocked] = useState(null);
  useEffect(() => {
    if (can.value.updates) loadAppUpdate();
  }, []);
  // Poll while something is in flight so progress moves.
  useEffect(() => {
    if (!["checking", "downloading", "installing"].includes(status?.state)) return undefined;
    const timer = setInterval(loadAppUpdate, 1000);
    return () => clearInterval(timer);
  }, [status?.state]);
  if (!can.value.updates || !status?.desktop) return null;
  const act = async (path, body = {}, label = path) => {
    setBusy(label);
    try {
      const data = await post(`/api/app/update/${path}`, body);
      if (data.state !== "installing") await loadAppUpdate();
      return data;
    } catch (error) {
      if (error.status === 409 && path === "install") setBlocked(error.message);
      else reportError(error);
      return null;
    } finally {
      setBusy("");
    }
  };
  const install = async (force = false) => {
    setBlocked(null);
    const data = await act("install", { force }, "install");
    if (data?.state === "installing") {
      appUpdate.value = { ...appUpdate.value, state: "installing" };
      toast("Installing the update. Jarvis will reopen in a moment.", { tone: "good", duration: 20000 });
    }
  };
  const latest = status.latest;
  const available = status.available && !status.skippedThis;
  const state = status.state;
  return html`<section class="updates">
    <div class="row space-between wrap gap-2">
      <h3>Updates</h3>
      <span class="muted small">Jarvis ${status.currentVersion}${status.checkedAt ? ` · checked ${new Date(status.checkedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}</span>
    </div>
    ${state === "disabled" ? html`<p class="muted small">Updates apply to the installed app. This copy is running from source.</p>` : null}
    ${state === "up-to-date" ? html`<p class="small"><span class="pill pill-good">Up to date</span> You're on the newest version.</p>` : null}
    ${state === "checking" ? html`<p class="muted small">Checking GitHub for a newer version…</p>` : null}
    ${state === "error" && status.error ? html`<p class="warn small">${status.error}</p>` : null}
    ${status.justUpdated ? html`<div class="update-card is-done"><strong>Updated from ${status.justUpdated.from} to ${status.justUpdated.to}</strong>${status.justUpdated.notes ? html`<pre class="update-notes">${status.justUpdated.notes}</pre>` : null}</div>` : null}
    ${latest && (available || ["downloading", "ready", "installing"].includes(state)) ? html`<div class="update-card">
      <div class="row space-between wrap gap-2">
        <strong>Jarvis ${latest.version} is available</strong>
        ${latest.publishedAt ? html`<span class="muted small">released ${new Date(latest.publishedAt).toLocaleDateString()}</span>` : null}
      </div>
      ${status.notes ? html`<pre class="update-notes">${status.notes}</pre>` : null}
      ${state === "downloading" ? html`<div class="update-progress"><span style=${{ width: `${Math.round((status.progress || 0) * 100)}%` }}></span></div><span class="muted small">Downloading… ${Math.round((status.progress || 0) * 100)}%</span>` : null}
      ${state === "installing" ? html`<p class="muted small">Installing. Jarvis closes now and reopens on ${latest.version}.</p>` : null}
      ${status.error && state === "available" ? html`<p class="warn small">${status.error}</p>` : null}
      ${blocked ? html`<div class="update-blocked"><span>${blocked} Updating will close it. Your progress is saved.</span><div class="row gap-2"><${Button} size="sm" variant="primary" onClick=${() => install(true)}>Update anyway</${Button}><${Button} size="sm" variant="ghost" onClick=${() => setBlocked(null)}>Later</${Button}></div></div>` : null}
      ${!["downloading", "installing"].includes(state) && !blocked ? html`<div class="row gap-2 wrap">
        <${Button} variant="primary" icon="undo" disabled=${Boolean(busy)} onClick=${() => install(false)}>${state === "error" || status.error ? "Retry update" : "Update and restart"}</${Button}>
        <${Button} variant="ghost" size="sm" disabled=${Boolean(busy)} onClick=${() => act("skip", { version: latest.version })}>Skip this version</${Button}>
      </div>` : null}
    </div>` : null}
    ${state !== "disabled" && !["downloading", "installing"].includes(state) ? html`<div><${Button} size="sm" icon="search" disabled=${Boolean(busy) || state === "checking"} onClick=${() => act("check", {}, "check")}>Check for updates</${Button}></div>` : null}
    <p class="muted small">New versions are published to your private GitHub repo each time main changes, and downloaded with your gh login.</p>
  </section>`;
}

export function SettingsDialog() {
  const info = meta.value;
  const open = settingsOpen.value;
  const close = () => {
    settingsOpen.value = false;
  };
  const save = async (draft) => {
    const { newBreak, ...settings } = draft;
    try {
      await post("/api/plan/settings", settings);
      toast("Schedule saved. Your days were re-planned.", { tone: "good" });
      refresh();
    } catch (error) {
      reportError(error);
    }
  };
  return html`<${Modal} open=${open} onClose=${close} title="Settings" wide>
    ${info ? html`<div class="modal-body settings">
      <${UpdatesSection} />
      <section><h3>My schedule</h3><${ScheduleEditor} settings=${info.settings} onSave=${save} /></section>
      <section><h3>Appearance</h3>
        <div class="seg">
          <button type="button" class=${theme.value === "dark" ? "is-active" : ""} onClick=${() => setTheme("dark")}><${Icon} name="moon" size=${14} /> Dark</button>
          <button type="button" class=${theme.value === "light" ? "is-active" : ""} onClick=${() => setTheme("light")}><${Icon} name="sun" size=${14} /> Light</button>
        </div>
      </section>
      ${can.value.cloudSync ? html`<${CloudSyncSection} />` : null}
      ${can.value.devices ? html`<${DevicesSection} />` : null}
      <${JobsSettings} />
      ${can.value.spotify ? html`<section><h3>Spotify</h3><${SpotifySettings} /></section>` : null}
      ${can.value.wallpapers ? html`<section><h3>Focus</h3>
        <${MoveWindowsToggle} />
        <p class="muted small">Drop .jpg, .png, .webp, .gif, .mp4 or .webm files into the wallpapers folder and pick them from the background menu in Focus.</p>
        <${Button} size="sm" icon="image" onClick=${async () => { try { const data = await post("/api/focus/wallpapers/open-folder"); toast(`Opened ${data.folder}`); } catch (error) { reportError(error); } }}>Open wallpapers folder</${Button}>
      </section>` : null}
      <section><h3>Roadmap data</h3>
        <p class="muted small">${info.importedAt ? `Progress imported from the roadmap site on ${new Date(info.importedAt).toLocaleString()}.` : "No site import yet."} This app is now the source of truth.</p>
        ${isWeb.value ? null : html`<${Button} size="sm" variant="ghost" icon="undo" onClick=${async () => {
          try {
            const data = await post("/api/plan/import", {});
            toast(data.result.added.length ? `Imported ${data.result.added.length} records.` : "Nothing new to import. Local changes always win.");
            refresh();
          } catch (error) {
            reportError(error);
          }
        }}>Re-run site import</${Button}>`}
      </section>
    </div>` : null}
  </${Modal}>`;
}

// ---------- command palette ----------
export function CommandPalette() {
  const open = paletteOpen.value;
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [active, setActive] = useState(0);
  const listRef = useRef(null);
  const close = () => {
    paletteOpen.value = false;
    setQ("");
  };
  const info = meta.value;
  const today = todayKey.value;

  const commands = useMemo(() => {
    const list = [
      { id: "go-today", label: "Go to Today", icon: "today", run: () => { viewDate.value = today; loadDay(today); navigate("today"); } },
      { id: "go-focus", label: "Lock in (focus mode)", icon: "focus", run: () => startFocusOn(null) },
      { id: "go-roadmap", label: "Open roadmap", icon: "roadmap", run: () => navigate("roadmap") },
      { id: "go-jobs", label: "Open jobs", icon: "briefcase", run: () => navigate("jobs") },
      { id: "log-job", label: "Log an application", icon: "plus", run: () => logApplication() },
      ...(can.value.projects ? [{ id: "go-projects", label: "Open projects", icon: "projects", run: () => navigate("projects") }] : []),
      { id: "plan-day", label: "Spread carried tasks over the week", icon: "sparkles", run: async () => { navigate("today"); viewDate.value = todayKey.value; await loadDay(todayKey.value); await previewSpread(); } },
      { id: "log-nc", label: "Log a NeetCode problem", icon: "list", run: () => { neetcodePrompt.value = { taskId: null, title: "Log a problem" }; } },
      { id: "settings", label: "Settings & schedule", icon: "settings", run: () => { settingsOpen.value = true; } },
      { id: "theme", label: theme.value === "dark" ? "Switch to light theme" : "Switch to dark theme", icon: theme.value === "dark" ? "sun" : "moon", run: () => setTheme(theme.value === "dark" ? "light" : "dark") }
    ];
    for (const week of info?.weeks || []) list.push({ id: `week-${week.index}`, label: `Week ${week.number}: ${week.title}`, hint: week.phase, icon: "calendar", run: () => navigate("roadmap", week.start) });
    return list;
  }, [info, theme.value, today]);

  useEffect(() => {
    if (!open) return undefined;
    const needle = q.trim().toLowerCase();
    const matched = commands.filter((command) => !needle || `${command.label} ${command.hint || ""}`.toLowerCase().includes(needle)).slice(0, needle ? 8 : 7);
    setResults(matched.map((command) => ({ ...command, kind: "command" })));
    setActive(0);
    if (needle.length < 2) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      get(`/api/plan/search?${new URLSearchParams({ q: needle, status: "open", limit: "8" })}`, { signal: controller.signal })
        .then((data) => setResults([
          ...matched.map((command) => ({ ...command, kind: "command" })),
          ...data.tasks.map((task) => ({ id: task.id, kind: "task", task, label: task.title, hint: relativeDay(task.date, today), icon: "right" }))
        ]))
        .catch(() => {});
    }, 120);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q, open, commands]);

  const choose = (item, focus = false) => {
    close();
    if (item.kind === "task") {
      if (focus) startFocusOn(item.task);
      else openTask(item.task.id);
    } else item.run();
  };
  const onKey = (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((value) => Math.min(results.length - 1, value + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((value) => Math.max(0, value - 1));
    } else if (event.key === "Enter" && results[active]) {
      event.preventDefault();
      choose(results[active], event.ctrlKey || event.metaKey);
    }
  };
  useEffect(() => {
    listRef.current?.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return html`<${Modal} open=${open} onClose=${close} title="" class="palette">
    <div class="palette-input"><${Icon} name="search" size=${18} />
      <input autofocus placeholder="Jump to a week, find a task, run a command…" value=${q} onInput=${(event) => setQ(event.currentTarget.value)} onKeyDown=${onKey} aria-label="Command" />
      <${Kbd}>Esc</${Kbd}>
    </div>
    <div class="palette-list" ref=${listRef} role="listbox">
      ${results.map((item, index) => html`<button type="button" role="option" aria-selected=${index === active ? "true" : "false"}
        class=${`palette-item ${index === active ? "is-active" : ""}`} onMouseEnter=${() => setActive(index)} onClick=${() => choose(item)}
        style=${item.task ? { "--cat": categoryColor(item.task.category) } : null}>
        ${item.task ? html`<span class="dot" style=${{ background: "var(--cat)" }}></span>` : html`<${Icon} name=${item.icon} size=${16} />`}
        <span class="palette-label">${item.label}</span>
        ${item.hint ? html`<em>${item.hint}</em>` : null}
        ${item.task ? html`<span class="palette-meta">${CATEGORY_META[item.task.category]?.short} · ${formatMinutes(item.task.minutes)}</span>` : null}
      </button>`)}
      ${!results.length ? html`<div class="palette-empty muted">No matches</div>` : null}
    </div>
    <div class="palette-foot muted small"><span><${Kbd}>↑</${Kbd}><${Kbd}>↓</${Kbd}> move</span><span><${Kbd}>Enter</${Kbd}> open</span><span><${Kbd}>Ctrl</${Kbd}>+<${Kbd}>Enter</${Kbd}> focus on task</span></div>
  </${Modal}>`;
}

export { addDays, day };
