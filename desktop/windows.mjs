// Focus mode moves the other windows on Jarvis's monitor to another monitor,
// so apps like Spotify aren't trapped behind the always-on-top focus window,
// then puts them back afterwards. Windows only: a long-lived PowerShell helper
// (a script written to the temp folder) calls the Win32 window API, so there
// is no native npm module to package. Everything
// that decides what moves where is pure and tested; the helper only lists and
// places windows.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

// Desktop, taskbars and shell surfaces are never moved.
export const SHELL_CLASSES = new Set([
  "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "NotifyIconOverflowWindow",
  "Windows.UI.Core.CoreWindow", "XamlExplorerHostIslandWindow", "TopLevelWindowForOverflowXamlIsland",
  "Shell_InputSwitchTopLevelWindow", "ForegroundStaging", "MultitaskingViewFrame", "EdgeUiInputTopWndClass"
]);

const width = (rect) => rect.r - rect.l;
const height = (rect) => rect.b - rect.t;
const area = (rect) => Math.max(0, width(rect)) * Math.max(0, height(rect));

export function monitorOf(rect, monitors) {
  const cx = (rect.l + rect.r) / 2;
  const cy = (rect.t + rect.b) / 2;
  return monitors.find((monitor) => cx >= monitor.rect.l && cx < monitor.rect.r && cy >= monitor.rect.t && cy < monitor.rect.b) || null;
}

// The largest other monitor gets the windows.
export function pickTarget(monitors, jarvisMonitorId) {
  return monitors.filter((monitor) => monitor.id !== jarvisMonitorId).sort((a, b) => area(b.work) - area(a.work))[0] || null;
}

export function windowsToMove({ windows, monitors, jarvisMonitorId, jarvisPid }) {
  return windows.filter((win) => {
    if (win.pid === jarvisPid || win.minimized || win.cloaked || win.tool || win.owned) return false;
    if (SHELL_CLASSES.has(win.cls) || !String(win.title || "").trim()) return false;
    if (area(win.rect) < 400) return false;
    return monitorOf(win.rect, monitors)?.id === jarvisMonitorId;
  });
}

// Same offset from the work area's corner, shrunk and nudged to fit.
export function placeOn(rect, fromWork, toWork) {
  const w = Math.min(width(rect), width(toWork));
  const h = Math.min(height(rect), height(toWork));
  const x = toWork.l + Math.min(Math.max(rect.l - fromWork.l, 0), width(toWork) - w);
  const y = toWork.t + Math.min(Math.max(rect.t - fromWork.t, 0), height(toWork) - h);
  return { l: x, t: y, r: x + w, b: y + h };
}

// Windows reports a window's normal rect in workspace coordinates: screen
// coordinates shifted by the primary monitor's taskbar (when it's on the top
// or left).
export function normalRect(win, monitors) {
  const normal = win.placement?.normal;
  if (!normal) return win.rect;
  const primary = monitors.find((monitor) => monitor.primary);
  const dx = primary ? primary.work.l - primary.rect.l : 0;
  const dy = primary ? primary.work.t - primary.rect.t : 0;
  return { l: normal.l + dx, t: normal.t + dy, r: normal.r + dx, b: normal.b + dy };
}

// `skip` holds windows already handled this session, so one moved earlier and
// dragged back on purpose isn't moved again.
export function planMoves(list, jarvisPid, { skip = new Set() } = {}) {
  const monitors = list.monitors || [];
  if (monitors.length < 2) return { moves: [], note: "Only one monitor, so nothing was moved." };
  const from = monitors.find((monitor) => monitor.id === list.jarvisMonitor);
  const target = pickTarget(monitors, list.jarvisMonitor);
  if (!from || !target) return { moves: [], note: "Couldn't tell which monitor Jarvis is on." };
  const moves = windowsToMove({ windows: list.windows || [], monitors, jarvisMonitorId: from.id, jarvisPid }).filter((win) => !skip.has(win.hwnd)).map((win) => {
    // A maximized window moves by its normal (un-maximized) rect, then maximizes again.
    const rect = win.maximized ? normalRect(win, monitors) : win.rect;
    return {
      hwnd: win.hwnd,
      title: win.title,
      maximize: Boolean(win.maximized),
      rect: placeOn(rect, from.work, target.work),
      original: { maximize: Boolean(win.maximized), rect }
    };
  });
  return { moves, target: target.id, note: "" };
}

// A window still counts as "where we put it" if it hasn't moved more than a
// few pixels (or is still maximized on the same monitor).
export function stillPlaced(current, placed, monitors) {
  if (!current?.exists) return false;
  if (placed.maximize) return Boolean(current.maximized) && monitorOf(current.rect, monitors)?.id === monitorOf(placed.rect, monitors)?.id;
  return ["l", "t", "r", "b"].every((side) => Math.abs(current.rect[side] - placed.rect[side]) <= 16);
}

// ---------- the PowerShell helper ----------

const CSHARP = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class JRect { public int l { get; set; } public int t { get; set; } public int r { get; set; } public int b { get; set; } }
public class JPlacement { public int showCmd { get; set; } public int flags { get; set; } public JRect normal { get; set; } }
public class JMonitor { public long id { get; set; } public bool primary { get; set; } public JRect rect { get; set; } public JRect work { get; set; } }
public class JWindow { public long hwnd { get; set; } public int pid { get; set; } public string cls { get; set; } public string title { get; set; } public JRect rect { get; set; } public bool maximized { get; set; } public bool minimized { get; set; } public bool cloaked { get; set; } public bool tool { get; set; } public bool owned { get; set; } public JPlacement placement { get; set; } }
public class JState { public long hwnd { get; set; } public bool exists { get; set; } public bool maximized { get; set; } public JRect rect { get; set; } }

public static class JarvisWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct WINDOWPLACEMENT { public int length, flags, showCmd; public POINT ptMinPosition, ptMaxPosition; public RECT rcNormalPosition; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor, rcWork; public int dwFlags; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  public delegate bool MonitorProc(IntPtr m, IntPtr hdc, ref RECT r, IntPtr d);

  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr h, ref WINDOWPLACEMENT p);
  [DllImport("user32.dll")] static extern bool SetWindowPlacement(IntPtr h, ref WINDOWPLACEMENT p);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorProc cb, IntPtr d);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO i);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int size);

  static void Aware() { SetThreadDpiAwarenessContext(new IntPtr(-4)); }
  static JRect R(RECT r) { return new JRect { l = r.Left, t = r.Top, r = r.Right, b = r.Bottom }; }

  public static List<JMonitor> Monitors() {
    Aware();
    var list = new List<JMonitor>();
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (IntPtr m, IntPtr hdc, ref RECT r, IntPtr d) => {
      var info = new MONITORINFO(); info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
      if (GetMonitorInfo(m, ref info)) list.Add(new JMonitor { id = m.ToInt64(), primary = (info.dwFlags & 1) == 1, rect = R(info.rcMonitor), work = R(info.rcWork) });
      return true;
    }, IntPtr.Zero);
    return list;
  }

  public static long MonitorOf(long hwnd) { Aware(); return MonitorFromWindow(new IntPtr(hwnd), 2).ToInt64(); }

  public static List<JWindow> Windows() {
    Aware();
    var list = new List<JWindow>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var title = new StringBuilder(512); GetWindowText(h, title, 512);
      var cls = new StringBuilder(256); GetClassName(h, cls, 256);
      uint pid; GetWindowThreadProcessId(h, out pid);
      int ex = GetWindowLong(h, -20);
      int cloaked = 0; DwmGetWindowAttribute(h, 14, out cloaked, 4);
      RECT rect; GetWindowRect(h, out rect);
      var p = new WINDOWPLACEMENT(); p.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT)); GetWindowPlacement(h, ref p);
      list.Add(new JWindow {
        hwnd = h.ToInt64(), pid = (int)pid, cls = cls.ToString(), title = title.ToString(), rect = R(rect),
        maximized = IsZoomed(h), minimized = IsIconic(h), cloaked = cloaked != 0,
        tool = (ex & 0x80) != 0 && (ex & 0x40000) == 0, owned = GetWindow(h, 4) != IntPtr.Zero,
        placement = new JPlacement { showCmd = p.showCmd, flags = p.flags, normal = R(p.rcNormalPosition) }
      });
      return true;
    }, IntPtr.Zero);
    return list;
  }

  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);

  // Move a window to a normal-size rect (screen coordinates), maximizing it
  // there if asked. A maximized window is restored first, since Windows
  // ignores moves of maximized windows; this is what dragging it would do.
  public static JState MoveTo(long hwnd, int l, int t, int r, int b, bool maximize) {
    Aware();
    var h = new IntPtr(hwnd);
    if (!IsWindow(h)) return State(hwnd);
    if (IsZoomed(h)) ShowWindow(h, 9);
    SetWindowPos(h, IntPtr.Zero, l, t, r - l, b - t, 0x0004 | 0x0010 | 0x0200);
    if (maximize) ShowWindow(h, 3);
    return State(hwnd);
  }

  public static JState State(long hwnd) {
    Aware();
    var h = new IntPtr(hwnd);
    if (!IsWindow(h)) return new JState { hwnd = hwnd, exists = false };
    RECT rect; GetWindowRect(h, out rect);
    return new JState { hwnd = hwnd, exists = IsWindowVisible(h), maximized = IsZoomed(h), rect = R(rect) };
  }
}
`;

// One JSON command per line in, one JSON line out.
export const HELPER_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
${CSHARP}
'@ -Language CSharp
[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $cmd = $line | ConvertFrom-Json
    switch ($cmd.op) {
      'list' { $result = @{ ok = $true; monitors = @([JarvisWin]::Monitors()); windows = @([JarvisWin]::Windows()); jarvisMonitor = [JarvisWin]::MonitorOf([long]$cmd.jarvis) } }
      'place' { $result = @{ ok = $true; states = @(foreach ($m in $cmd.moves) { [JarvisWin]::MoveTo([long]$m.hwnd, $m.rect.l, $m.rect.t, $m.rect.r, $m.rect.b, [bool]$m.maximize) }) } }
      'restore' { $result = @{ ok = $true; states = @(foreach ($m in $cmd.windows) { [JarvisWin]::MoveTo([long]$m.hwnd, $m.rect.l, $m.rect.t, $m.rect.r, $m.rect.b, [bool]$m.maximize) }) } }
      'state' { $result = @{ ok = $true; states = @(foreach ($h in $cmd.hwnds) { [JarvisWin]::State([long]$h) }) } }
      default { $result = @{ ok = $false; error = "unknown op" } }
    }
  } catch {
    $result = @{ ok = $false; error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $result -Compress -Depth 8))
  [Console]::Out.Flush()
}
`;

// A child process that answers one JSON line per request, in order.
export class LineHelper {
  constructor({ command, args = [], timeoutMs = 8000, spawnImpl = spawn }) {
    Object.assign(this, { command, args, timeoutMs, spawnImpl });
    this.child = null;
    this.waiting = [];
    this.ready = null;
  }

  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const child = this.spawnImpl(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      this.child = child;
      let started = false;
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (!started && message.ready) {
          started = true;
          resolve();
          return;
        }
        this.waiting.shift()?.resolve(message);
      });
      const fail = (error) => {
        if (!started) reject(error);
        for (const pending of this.waiting.splice(0)) pending.reject(error);
        // Kill before dropping the reference: a helper that never answered is
        // still running, and its pipes would keep this process alive.
        try {
          child.kill();
        } catch {
          // Already gone.
        }
        lines.close();
        this.child = null;
        this.ready = null;
      };
      child.on("error", fail);
      child.on("exit", () => fail(new Error("The window helper stopped.")));
      child.stderr?.resume();
      setTimeout(() => !started && fail(new Error("The window helper didn't start.")), this.timeoutMs).unref?.();
    });
    return this.ready;
  }

  async request(command) {
    await this.start();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("The window helper didn't answer."));
        this.stop();
      }, this.timeoutMs);
      timer.unref?.();
      this.waiting.push({ resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      this.child.stdin.write(`${JSON.stringify(command)}\n`);
    });
  }

  stop() {
    try {
      this.child?.kill();
    } catch {
      // Already gone.
    }
    this.child = null;
    this.ready = null;
  }
}

// stdin carries only commands, so the script runs from a file named after its
// contents.
export function powershellHelper() {
  const script = join(tmpdir(), `jarvis-windows-${createHash("sha256").update(HELPER_SCRIPT).digest("hex").slice(0, 12)}.ps1`);
  writeFileSync(script, HELPER_SCRIPT, "utf8");
  return new LineHelper({
    command: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
    timeoutMs: 15_000
  });
}

// While focus is on, windows that open (or come back from the taskbar) on
// Jarvis's monitor are moved too. They stay on the other monitor afterwards:
// only windows that were open when focus started are put back.
export function createWindowMover({ platform = process.platform, helper = null, log = console.error, watchMs = 1500 } = {}) {
  let moved = [];
  let monitors = [];
  let chain = Promise.resolve();
  let session = null;
  const supported = platform === "win32";
  const getHelper = () => (helper ||= powershellHelper());
  const queue = (work) => {
    const result = chain.then(work, work);
    chain = result.catch(() => {});
    return result;
  };

  async function call(command) {
    const reply = await getHelper().request(command);
    if (!reply?.ok) throw new Error(reply?.error || "The window helper failed.");
    return reply;
  }

  function stopWatch() {
    if (session?.timer) clearInterval(session.timer);
    session = null;
  }

  function moveAway({ hwnd, pid }) {
    return queue(async () => {
      if (!supported) return { moved: 0, note: "" };
      stopWatch();
      session = { hwnd, pid, seen: new Set(), arrivals: 0, sweeping: false, timer: null };
      if (watchMs > 0) {
        session.timer = setInterval(() => { void sweep(); }, watchMs);
        session.timer.unref?.();
      }
      try {
        const list = await call({ op: "list", jarvis: hwnd });
        monitors = list.monitors || [];
        const plan = planMoves(list, pid);
        // Everything open now counts as handled, moved or not, so the watch
        // only ever moves windows that appear later.
        for (const win of list.windows || []) if (!win.minimized) session.seen.add(win.hwnd);
        if (!plan.moves.length) return { moved: 0, note: plan.note };
        const { states } = await call({ op: "place", moves: plan.moves.map(({ hwnd: id, rect, maximize }) => ({ hwnd: id, rect, maximize })) });
        // Remember where each window landed so a later manual move is respected.
        moved = plan.moves.map((move, index) => ({ ...move, rect: move.maximize ? move.rect : states?.[index]?.rect || move.rect }));
        return { moved: moved.length, note: "" };
      } catch (error) {
        log("Moving windows:", error.message);
        return { moved: 0, note: "Couldn't move your other windows." };
      }
    });
  }

  // One look for windows that arrived on Jarvis's monitor since the last one.
  function sweep() {
    const current = session;
    if (!supported || !current || current.sweeping) return Promise.resolve({ moved: 0 });
    current.sweeping = true;
    return queue(async () => {
      if (session !== current) return { moved: 0 };
      try {
        const list = await call({ op: "list", jarvis: current.hwnd });
        monitors = list.monitors || monitors;
        const plan = planMoves(list, current.pid, { skip: current.seen });
        // Handled either way: a window that won't move isn't retried forever.
        for (const move of plan.moves) current.seen.add(move.hwnd);
        if (!plan.moves.length) return { moved: 0 };
        await call({ op: "place", moves: plan.moves.map(({ hwnd: id, rect, maximize }) => ({ hwnd: id, rect, maximize })) });
        current.arrivals += plan.moves.length;
        return { moved: plan.moves.length };
      } catch (error) {
        log("Moving new windows:", error.message);
        return { moved: 0 };
      } finally {
        current.sweeping = false;
      }
    });
  }

  function bringBack() {
    stopWatch();
    return queue(async () => {
      if (!supported || !moved.length) return { restored: 0 };
      const toRestore = moved;
      moved = [];
      try {
        const { states } = await call({ op: "state", hwnds: toRestore.map((move) => move.hwnd) });
        const stay = toRestore.filter((move, index) => stillPlaced(states?.[index], move, monitors) && move.original);
        if (stay.length) await call({ op: "restore", windows: stay.map((move) => ({ hwnd: move.hwnd, rect: move.original.rect, maximize: move.original.maximize })) });
        return { restored: stay.length };
      } catch (error) {
        log("Restoring windows:", error.message);
        return { restored: 0 };
      }
    });
  }

  return {
    supported,
    moveAway,
    sweep,
    bringBack,
    moved: () => moved.length + (session?.arrivals || 0),
    dispose: () => {
      stopWatch();
      helper?.stop();
    }
  };
}
