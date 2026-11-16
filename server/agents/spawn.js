// Long-lived child processes with line-buffered output, a runtime cap and
// whole-tree termination (agents start their own shells and test runners).
import { execFile, spawn } from "node:child_process";

export function killTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

function lineSplitter(onLine) {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) if (line) onLine(line);
    },
    flush() {
      if (buffer) onLine(buffer);
      buffer = "";
    }
  };
}

export function spawnStreaming(command, args, { cwd, env, input, timeoutMs = 45 * 60_000, onLine = () => {}, onStderr = () => {}, shell = false } = {}) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    shell,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"]
  });
  const out = lineSplitter(onLine);
  const err = lineSplitter(onStderr);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => out.push(chunk));
  child.stderr.on("data", (chunk) => err.push(chunk));
  let timedOut = false;
  let stopped = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child);
  }, timeoutMs);
  timer.unref?.();
  const done = new Promise((resolve) => {
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, error: error.message, timedOut, stopped });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      out.flush();
      err.flush();
      resolve({ code, signal, timedOut, stopped });
    });
  });
  child.stdin.on("error", () => {});
  if (input !== undefined) child.stdin.end(input);
  else child.stdin.end();
  return {
    child,
    done,
    stop() {
      stopped = true;
      killTree(child);
    }
  };
}

// Runs a shell command (a loop's check, e.g. "npm test") and keeps the tail of
// its output for feeding back to the agent.
export async function runCheck(command, { cwd, signal, timeoutMs = 10 * 60_000, keepLines = 80 } = {}) {
  if (signal?.aborted) return { ok: false, code: null, stopped: true, tail: "", durationMs: 0 };
  const lines = [];
  const keep = (line) => {
    lines.push(line);
    if (lines.length > keepLines * 4) lines.splice(0, lines.length - keepLines * 2);
  };
  const started = Date.now();
  const handle = spawnStreaming(command, [], { cwd, shell: true, timeoutMs, onLine: keep, onStderr: keep });
  const stop = () => handle.stop();
  signal?.addEventListener("abort", stop, { once: true });
  const result = await handle.done.finally(() => signal?.removeEventListener("abort", stop));
  return {
    ok: result.code === 0 && !result.timedOut && !result.stopped,
    stopped: result.stopped,
    code: result.code,
    timedOut: result.timedOut,
    durationMs: Date.now() - started,
    tail: lines.slice(-keepLines).join("\n")
  };
}
