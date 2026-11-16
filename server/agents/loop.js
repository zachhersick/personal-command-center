// The agentic loop: let the agent work, run a check you trust (tests, type
// check, linter), and if it fails, hand the failure back and go again. Stops on
// the first passing check, after maxIterations, or when you stop it.
import { randomUUID } from "node:crypto";
import { runCheck } from "./spawn.js";
import { worktreeDiff } from "./worktrees.js";

export function feedbackPrompt(check, result, iteration) {
  return [
    `Iteration ${iteration}: the check \`${check}\` failed${result.timedOut ? " (timed out)" : ` with exit code ${result.code}`}.`,
    "Here is the end of its output:",
    "```",
    result.tail || "(no output)",
    "```",
    "Find the root cause and fix the code so the check passes. Don't weaken, skip or delete the check or its tests. Keep the change small and explain what you changed."
  ].join("\n");
}

export class LoopRunner {
  constructor({ launcher, now = () => new Date().toISOString(), check = runCheck }) {
    this.launcher = launcher;
    this.now = now;
    this.check = check;
  }

  async start({ check, maxIterations = 5, ...runInput }) {
    const command = String(check || "").trim();
    if (!command) {
      const error = new Error("A loop needs a check command, such as npm test.");
      error.status = 400;
      throw error;
    }
    const limit = Math.max(1, Math.min(10, Number(maxIterations) || 5));
    const loopId = randomUUID();
    const prompt = `${runInput.prompt}\n\nWhen you're done, this command must pass: \`${command}\`. Run it yourself if you can.`;
    const run = await this.launcher.start({ ...runInput, prompt, mode: "edit", loopId, kind: "loop" });
    run.loop = { id: loopId, check: command, maxIterations: limit, iterations: [], status: "running" };
    this.launcher.touch(run);
    const controller = new AbortController();
    const handle = { controller, done: null };
    this.launcher.loops.set(run.id, handle);
    handle.done = this.drive(run, controller.signal).catch((error) => {
      run.loop.status = controller.signal.aborted ? "stopped" : "error";
      run.loop.error = error.message;
      this.launcher.touch(run, { status: controller.signal.aborted ? "stopped" : "failed", error: error.message });
    }).finally(() => {
      this.launcher.loops.delete(run.id);
      this.launcher.released();
    });
    return run;
  }

  async waitForTurn(run) {
    if (!this.launcher.active.has(run.id) && run.status !== "starting") return;
    await new Promise((resolve) => {
      const onEnd = (ended) => {
        if (ended.id !== run.id) return;
        this.launcher.off("turn-ended", onEnd);
        resolve();
      };
      this.launcher.on("turn-ended", onEnd);
    });
  }

  async drive(run, signal) {
    const loop = run.loop;
    for (let iteration = 1; iteration <= loop.maxIterations; iteration += 1) {
      await this.waitForTurn(run);
      if (signal.aborted || run.status === "stopped" || loop.status === "stopped") {
        loop.status = "stopped";
        this.launcher.touch(run, { status: "stopped" });
        break;
      }
      // If the agent itself couldn't work (not signed in, crashed), running the
      // check again won't help.
      if (run.turns.at(-1)?.ok === false && (run.authError || run.status === "failed")) {
        loop.status = "agent-error";
        break;
      }
      const started = Date.now();
      this.launcher.touch(run, { status: "checking" });
      const result = await this.check(loop.check, { cwd: run.worktree, signal });
      if (signal.aborted) {
        loop.status = "stopped";
        this.launcher.touch(run, { status: "stopped" });
        break;
      }
      const diff = await worktreeDiff({ path: run.worktree, baseSha: run.baseSha }).catch(() => ({ added: 0, removed: 0, files: [] }));
      loop.iterations.push({
        n: iteration,
        agentOk: run.turns.at(-1)?.ok ?? null,
        checkOk: result.ok,
        checkCode: result.code,
        tail: result.tail.slice(-4000),
        durationMs: Date.now() - started,
        diff: { files: diff.files.length, added: diff.added || 0, removed: diff.removed || 0 },
        at: this.now()
      });
      this.launcher.touch(run);
      if (signal.aborted) { loop.status = "stopped"; break; }
      if (result.ok) {
        loop.status = "passed";
        break;
      }
      if (iteration === loop.maxIterations) {
        loop.status = "exhausted";
        break;
      }
      await this.launcher.message(run.id, feedbackPrompt(loop.check, result, iteration + 1), undefined, { loop: true });
    }
    this.launcher.touch(run, { status: signal.aborted ? "stopped" : run.status === "checking" ? "idle" : run.status });
    return run;
  }

  stop(run) {
    if (run.loop) run.loop.status = "stopped";
    this.launcher.stop(run.id);
  }
}
