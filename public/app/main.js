import { render } from "preact";
import { useEffect } from "preact/hooks";
import { html } from "./html.js";
import { Icon } from "./icons.js";
import { IconButton, Kbd } from "./ui.js";
import { ROUTES, routeLabel } from "../routes.js";
import { TodayPage } from "./today.js";
import { RoadmapPage } from "./roadmap.js";
import { ProjectsPage } from "./projects.js";
import { FocusPage } from "./focus/focus.js";
import { AgentsPage } from "./agents/agents.js";
import { JobsPage } from "./jobs/jobs.js";
import { MusicPage } from "./music/music.js";
import { connectAgents, needsYou } from "./agents/state.js";
import { can, isWeb, registerServiceWorker, signedIn, signInError } from "./platform.js";
import { TaskSheet } from "./task-sheet.js";
import { CommandPalette, NeetcodeDialog, SettingsDialog } from "./dialogs.js";
import {
  appUpdate, boot, dismissToast, focusState, loadError, meta, navigate, paletteOpen, route, setTheme, settingsOpen, theme, toasts
} from "./store.js";

const NAV_ICONS = { today: "today", focus: "focus", roadmap: "roadmap", jobs: "briefcase", agents: "bot", music: "music", projects: "projects" };
const PENDING_HASH = "jarvis-after-signin";

function visibleRoutes() {
  return ROUTES.filter((item) => item.id !== "projects" || can.value.projects);
}

// Signing in goes through GitHub and comes back to "/", so remember where we
// were headed (e.g. the "I applied" bookmark) and return there afterwards.
function rememberHash() {
  try {
    if (location.hash.length > 1) sessionStorage.setItem(PENDING_HASH, location.hash);
  } catch {}
}

function restoreHash() {
  try {
    const pending = sessionStorage.getItem(PENDING_HASH);
    sessionStorage.removeItem(PENDING_HASH);
    if (pending && !location.hash) location.hash = pending;
  } catch {}
}

function SignIn() {
  return html`<div class="signin">
    <div class="signin-card">
      <img src="/icons/icon-192.png" alt="" width="72" height="72" />
      <h1>Jarvis</h1>
      <p class="muted">Your roadmap, focus timer and agents, anywhere.</p>
      ${signInError.value ? html`<p class="warn small">${signInError.value}</p>` : null}
      <a class="btn btn-primary btn-lg" href="/api/auth/login" onClick=${rememberHash}><${Icon} name="github" size=${18} /><span>Sign in with GitHub</span></a>
    </div>
  </div>`;
}

function Rail() {
  const active = route.value;
  const live = Boolean(focusState.value?.session);
  return html`<nav class="rail" aria-label="Main">
    <div class="rail-brand" title="Jarvis"><span>J</span></div>
    <div class="rail-nav">
      ${visibleRoutes().map((item) => html`<button type="button" class=${`rail-item ${active === item.id ? "is-active" : ""}`}
        aria-current=${active === item.id ? "page" : undefined} onClick=${() => navigate(item.id)}>
        <span class="rail-icon"><${Icon} name=${NAV_ICONS[item.id]} size=${20} />${item.id === "focus" && live ? html`<i class="rail-live"></i>` : null}${item.id === "agents" && needsYou.value ? html`<i class="rail-badge">${needsYou.value}</i>` : null}</span>
        <span class="rail-label">${item.label}</span>
      </button>`)}
    </div>
    <div class="rail-foot">
      <${IconButton} icon="search" label="Command palette (Ctrl+K)" onClick=${() => { paletteOpen.value = true; }} />
      <${IconButton} icon=${theme.value === "dark" ? "sun" : "moon"} label="Toggle theme" onClick=${() => setTheme(theme.value === "dark" ? "light" : "dark")} />
      <span class="rail-settings">
        <${IconButton} icon="settings" label=${appUpdate.value?.available && !appUpdate.value?.skippedThis ? `Settings (Jarvis ${appUpdate.value.latest?.version} is available)` : "Settings"} onClick=${() => { settingsOpen.value = true; }} />
        ${appUpdate.value?.available && !appUpdate.value?.skippedThis ? html`<i class="rail-update-dot"></i>` : null}
      </span>
    </div>
  </nav>`;
}

function Toasts() {
  return html`<div class="toasts" role="status" aria-live="polite">
    ${toasts.value.map((entry) => html`<div class=${`toast toast-${entry.tone}`} key=${entry.id}>
      <span>${entry.message}</span>
      ${entry.action ? html`<button type="button" class="toast-action" onClick=${() => { entry.action.run(); dismissToast(entry.id); }}>${entry.action.label}</button>` : null}
      <button type="button" class="toast-x" aria-label="Dismiss" onClick=${() => dismissToast(entry.id)}><${Icon} name="x" size=${14} /></button>
    </div>`)}
  </div>`;
}

function Page() {
  switch (route.value) {
    case "roadmap":
      return html`<${RoadmapPage} />`;
    case "projects":
      return can.value.projects ? html`<${ProjectsPage} />` : html`<${TodayPage} />`;
    case "agents":
      return html`<${AgentsPage} />`;
    case "jobs":
      return html`<${JobsPage} />`;
    case "music":
      return html`<${MusicPage} />`;
    default:
      return html`<${TodayPage} />`;
  }
}

function App() {
  useEffect(() => {
    const onKey = (event) => {
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName) || event.target.isContentEditable;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (route.value !== "focus") paletteOpen.value = !paletteOpen.value;
        return;
      }
      if (typing || route.value === "focus" || event.ctrlKey || event.metaKey) return;
      if (event.altKey && new RegExp(`^[1-${visibleRoutes().length}]$`).test(event.key)) {
        event.preventDefault();
        navigate(visibleRoutes()[Number(event.key) - 1].id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    document.title = `${routeLabel(route.value)} · Jarvis`;
  }, [route.value]);

  if (!signedIn.value) return html`<${SignIn} /><${Toasts} />`;
  if (loadError.value && !meta.value) {
    return html`<div class="boot boot-error">
      <div class="boot-mark"></div>
      <strong>Jarvis couldn't load your roadmap.</strong>
      <span class="muted">${loadError.value}</span>
      <button type="button" class="btn btn-primary" onClick=${boot}>Try again</button>
    </div>`;
  }
  if (!meta.value) return html`<div class="boot"><div class="boot-mark"></div><span>Loading your roadmap…</span></div>`;

  if (route.value === "focus") {
    return html`<${FocusPage} /><${Toasts} /><${NeetcodeDialog} /><${SettingsDialog} />`;
  }
  return html`<div class="app">
    <${Rail} />
    <main class="main" id="main"><${Page} /></main>
    <button type="button" class="palette-hint" onClick=${() => { paletteOpen.value = true; }}><${Icon} name="search" size=${14} />Search or jump<span><${Kbd}>Ctrl</${Kbd}><${Kbd}>K</${Kbd}></span></button>
  </div>
  <${TaskSheet} />
  <${SettingsDialog} />
  <${CommandPalette} />
  <${NeetcodeDialog} />
  <${Toasts} />`;
}

document.documentElement.dataset.theme = theme.value;
render(html`<${App} />`, document.getElementById("app"));
boot().then(() => {
  if (!signedIn.value) return;
  if (isWeb.value) {
    restoreHash();
    registerServiceWorker();
  }
  else connectAgents();
});
