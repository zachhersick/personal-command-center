import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { writeFile, rm } from "node:fs/promises";
import { initializeUserData } from "./user-data.mjs";
import { Updater } from "./updater.mjs";
import { fixMacPath } from "./mac.mjs";
import { createWindowMover } from "./windows.mjs";
import { app, BrowserWindow, Menu, Tray, nativeImage, safeStorage, session, shell, dialog } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { startServer } from "../server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(__dirname);
let storageDir = rootDir;
let quitting = false;

let mainWindow;
let tray;
let serverHandle;
let focusMode = false;
let updater;
// Focus mode moves the other windows on Jarvis's monitor to another monitor
// (Windows only) so nothing, Spotify included, is stuck behind it.
const windowMover = createWindowMover();
let movedWindows = 0;
let windowNote = "";

function focusPrefsFile() {
  return join(storageDir, "config", "focus-windows.local.json");
}

function moveOtherWindowsEnabled() {
  try {
    return JSON.parse(readFileSync(focusPrefsFile(), "utf8")).moveOtherWindows !== false;
  } catch {
    return true;
  }
}

async function setMoveOtherWindows(enabled) {
  mkdirSync(join(storageDir, "config"), { recursive: true });
  await writeFile(focusPrefsFile(), `${JSON.stringify({ moveOtherWindows: Boolean(enabled) }, null, 2)}\n`);
  return focusStatus();
}

function nativeHandle(win) {
  const handle = win.getNativeWindowHandle();
  return handle.length >= 8 ? Number(handle.readBigUInt64LE(0)) : handle.readUInt32LE(0);
}

function trayMenu() {
  const update = updater?.view();
  return Menu.buildFromTemplate([
    { label: `Open ${app.getName()}`, click: () => showWindow() },
    { label: "Exit focus mode", click: () => void exitFocusFromDesktop("tray") },
    { label: "Open Jarvis Data", click: () => shell.openPath(storageDir) },
    ...(update?.available ? [{ type: "separator" }, { label: `Update to ${update.latest.version}…`, click: () => { showWindow(); mainWindow?.webContents.executeJavaScript("import('/app/store.js').then((store) => { store.settingsOpen.value = true; })", true).catch(() => {}); } }] : []),
    { type: "separator" },
    { label: "Quit", click: () => app.quit() }
  ]);
}

function createTray() {
  // macOS menu bar icons are black template images the system tints.
  const icon = process.platform === "darwin"
    ? nativeImage.createFromPath(join(__dirname, "assets", "trayTemplate.png"))
    : nativeImage.createFromPath(join(rootDir, "public", "jarvis-icon.png"));
  if (process.platform === "darwin") icon.setTemplateImage(true);
  if (icon.isEmpty()) return;
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip(app.getName());
  tray.setContextMenu(trayMenu());
}

// Updates come from private GitHub releases, fetched with the user's gh login.
function startUpdater() {
  let repo = "";
  try {
    repo = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")).jarvisUpdates?.repo || "";
  } catch {
    repo = "";
  }
  updater = new Updater({
    repo,
    currentVersion: app.getVersion(),
    stateFile: join(app.getPath("userData"), "update-state.json"),
    downloadRoot: join(app.getPath("temp"), "jarvis-update"),
    enabled: app.isPackaged && Boolean(repo) && ["win32", "darwin"].includes(process.platform),
    appPath: process.platform === "darwin" ? macAppBundle() : "",
    quit: () => app.quit()
  });
  updater.on("status", (status) => {
    tray?.setContextMenu(trayMenu());
    if (status.state === "available") tray?.setToolTip(`Jarvis: update ${status.latest.version} available`);
  });
  void updater.loadState().catch((error) => console.error("Updater:", error.message));
  const check = () => void updater.check().catch((error) => console.error("Update check:", error.message));
  setTimeout(check, 30_000).unref?.();
  setInterval(check, 4 * 60 * 60 * 1000).unref?.();
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.moveTop();
  mainWindow.focus();
}

// Focus mode: the main window becomes a fullscreen, always-on-top desktop.
// Not kiosk mode, so a hung renderer can never trap the user; the tray item and
// the crash handlers below always restore the window.
async function setFocusMode(on) {
  if (!mainWindow || mainWindow.isDestroyed()) return { focusMode: false, fullScreen: false };
  const wasOn = focusMode;
  focusMode = Boolean(on);
  if (focusMode) {
    showWindow();
    mainWindow.setAlwaysOnTop(true, "screen-saver");
    if (process.platform === "darwin") mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    mainWindow.setFullScreen(true);
    if (!wasOn && windowMover.supported && moveOtherWindowsEnabled()) {
      const result = await windowMover.moveAway({ hwnd: nativeHandle(mainWindow), pid: process.pid });
      movedWindows = result.moved;
      windowNote = result.note;
    }
  } else {
    mainWindow.setFullScreen(false);
    mainWindow.setAlwaysOnTop(false);
    if (process.platform === "darwin") mainWindow.setVisibleOnAllWorkspaces(false);
    movedWindows = 0;
    windowNote = "";
    await windowMover.bringBack();
  }
  return focusStatus();
}

function focusStatus() {
  return {
    focusMode,
    fullScreen: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFullScreen()),
    canMoveWindows: windowMover.supported,
    moveOtherWindows: windowMover.supported && moveOtherWindowsEnabled(),
    movedWindows,
    windowNote
  };
}

// Escape hatches outside the renderer still log the early exit on the session.
async function exitFocusFromDesktop(source) {
  if (!focusMode) return;
  await setFocusMode(false);
  if (!serverHandle) return;
  try {
    await fetch(`http://127.0.0.1:${serverHandle.port}/api/focus/exit-early`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source })
    });
  } catch (error) {
    console.error("Focus exit:", error.message);
  }
}

async function createWindow() {
  serverHandle = await startServer({ host: "127.0.0.1", port: 0, dataRoot: storageDir });
  const url = `http://127.0.0.1:${serverHandle.port}`;
  await writeFile(join(storageDir, "desktop-runtime.local.json"), JSON.stringify({ pid: process.pid, port: serverHandle.port, version: app.getVersion(), executable: process.execPath }));

  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 980,
    minHeight: 680,
    title: app.getName(),
    icon: join(rootDir, "public", "jarvis-icon.png"),
    backgroundColor: "#0a0e14",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.once("ready-to-show", () => showWindow());
  mainWindow.on("close", (event) => {
    if (focusMode && !app.isQuitting) {
      event.preventDefault();
      return;
    }
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  // While focused, swallow the shortcuts that would leave or reload the page.
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (!focusMode || input.type !== "keyDown") return;
    const key = String(input.key || "").toLowerCase();
    if (key === "f11" || key === "f5" || ((input.control || input.meta) && ["w", "r", "q"].includes(key))) event.preventDefault();
  });
  mainWindow.webContents.on("render-process-gone", () => void exitFocusFromDesktop("renderer-crash"));
  mainWindow.on("unresponsive", () => void exitFocusFromDesktop("renderer-unresponsive"));
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target)) shell.openExternal(target);
    return { action: "deny" };
  });

  await mainWindow.loadURL(url);
  mainWindow.webContents.setAudioMuted(false);
  showWindow();
}

app.setName(app.isPackaged ? "Jarvis" : "Jarvis Dev");
app.setAppUserModelId(app.isPackaged ? "com.zachhersick.jarvis" : "com.zachhersick.jarvis.dev");
// Electron's single-instance lock follows userData; dev must not intercept release launches.
const profileDir = process.env.JARVIS_USER_DATA_DIR || join(app.getPath("appData"), app.getName());
mkdirSync(profileDir, { recursive: true });
app.setPath("userData", profileDir);
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

app.on("second-instance", () => showWindow());

// /Applications/Jarvis.app/Contents/MacOS/Jarvis -> /Applications/Jarvis.app
function macAppBundle() {
  const match = /^(.*?\.app)\//.exec(process.execPath);
  return match ? match[1] : "";
}

function defaultImportRoot() {
  if (process.env.JARVIS_IMPORT_DIR) return process.env.JARVIS_IMPORT_DIR;
  if (process.platform === "win32") return "C:\\Dev\\jarvis";
  const mac = join(homedir(), "Dev", "jarvis");
  return existsSync(mac) ? mac : "";
}

// Finder-launched apps don't see Homebrew/npm tools; fix PATH before anything
// spawns git, gh, node, claude or codex.
if (process.platform === "darwin") fixMacPath();

if (gotLock) app.whenReady().then(async () => {
  storageDir = process.env.JARVIS_DATA_DIR || (app.isPackaged ? join(app.getPath("userData"), "workspace") : rootDir);
  if (app.isPackaged) await initializeUserData({ dataRoot: storageDir, resourceRoot: rootDir, legacyRoot: defaultImportRoot() });
  if (["win32", "darwin"].includes(process.platform) && app.isPackaged && !process.env.JARVIS_USER_DATA_DIR) {
    app.setLoginItemSettings({
      openAtLogin: true,
      path: process.execPath,
      args: []
    });
  }

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const url = webContents.getURL();
    const isJarvis = url.startsWith("http://127.0.0.1:");
    callback(isJarvis && ["media", "notifications"].includes(permission));
  });

  startUpdater();
  globalThis.jarvisDesktopActions = {
    setFocusMode: (on) => setFocusMode(on),
    focusStatus: () => focusStatus(),
    setMoveOtherWindows: (enabled) => setMoveOtherWindows(enabled),
    updateStatus: () => updater.view(),
    checkForUpdates: async () => {
      await updater.check();
      return updater.view();
    },
    skipUpdate: async (version) => {
      await updater.skip(version);
      return updater.view();
    },
    installUpdate: async () => {
      if (focusMode) await setFocusMode(false);
      await updater.install();
      return updater.view();
    },
    // Secrets such as the job Gmail App Password, sealed with the OS keychain
    // (DPAPI on Windows, Keychain on macOS).
    encryptSecret: (text) => (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(String(text)).toString("base64") : null),
    decryptSecret: (sealed) => safeStorage.decryptString(Buffer.from(String(sealed), "base64")),
    // The music import reads exports where they are; this only returns a path.
    pickFolder: async ({ title } = {}) => {
      const parent = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
      const result = await dialog.showOpenDialog(parent, { title: title || "Choose a folder", properties: ["openDirectory"] });
      return result.canceled ? null : result.filePaths[0] || null;
    }
  };
  createTray();
  await createWindow();
}).catch((error) => {
  dialog.showErrorBox("Jarvis could not start", error.message);
  app.quit();
});

app.on("before-quit", (event) => {
  if (!gotLock || quitting) return;
  event.preventDefault();
  quitting = true;
  app.isQuitting = true;
  const close = serverHandle?.server ? new Promise((resolve) => serverHandle.server.close(resolve)) : Promise.resolve();
  // Live streams (the agents board) would hold the server open otherwise.
  serverHandle?.server?.closeAllConnections?.();
  // Put any windows moved for focus mode back before the helper goes away.
  const restore = Promise.race([windowMover.bringBack(), new Promise((resolve) => setTimeout(resolve, 3000))]);
  void Promise.race([Promise.all([close, restore]), new Promise((resolve) => setTimeout(resolve, 5000))]).finally(async () => {
    windowMover.dispose();
    await rm(join(storageDir, "desktop-runtime.local.json"), { force: true }).catch(() => {});
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    // Keep the tray resident on Windows for quick access.
  }
});

app.on("activate", () => {
  if (mainWindow) showWindow();
  else createWindow();
});
