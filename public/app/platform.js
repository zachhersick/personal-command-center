// Desktop app vs. the web/phone version (jarvis.example.com). The server
// says which it is; the web version hides things that need this computer.
import { signal, computed } from "@preact/signals";

export const mode = signal(null); // "desktop" | "web"
export const signedIn = signal(true);
export const webUser = signal(null);
export const signInError = signal("");

export const isWeb = computed(() => mode.value === "web");

// What each version can do.
export const can = computed(() => {
  const web = mode.value === "web";
  return {
    projects: !web,
    launchAgents: !web,
    liveAgents: !web,
    hooks: !web,
    updates: !web,
    spotify: !web,
    wallpapers: !web,
    desktopWindow: !web,
    cloudSync: !web,
    jobsInbox: !web,
    devices: web
  };
});

export async function loadSession() {
  const reason = new URLSearchParams(location.search).get("signin");
  if (reason) {
    signInError.value = reason === "denied" ? "That GitHub account isn't allowed to use this Jarvis." : reason === "expired" ? "That sign-in link expired. Try again." : "Sign-in didn't work. Try again.";
    history.replaceState(null, "", location.pathname + location.hash);
  }
  try {
    const response = await fetch("/api/session", { headers: { accept: "application/json" } });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      mode.value = "web";
      signedIn.value = false;
      return mode.value;
    }
    mode.value = data.mode === "web" ? "web" : "desktop";
    webUser.value = data.user || null;
    signedIn.value = true;
  } catch {
    // Older desktop servers have no /api/session.
    mode.value = "desktop";
  }
  return mode.value;
}

export function registerServiceWorker() {
  if (mode.value !== "web" || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
