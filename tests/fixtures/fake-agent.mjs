// A stand-in for the Claude Code / Codex CLIs in tests. Reads the prompt from
// stdin, prints events in the provider's streaming format, and edits math.js
// in its working directory on the second attempt (so loops pass on iteration 2).
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const provider = process.argv[2] || "claude";
const resumeIndex = process.argv.indexOf("--resume");
const resumed = resumeIndex >= 0 || process.argv.includes("resume");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", async () => {
  if (prompt.includes("NO RESULT")) return;
  if (prompt.includes("BAD EXIT")) {
    console.log(JSON.stringify({ type: "result", subtype: "success", result: "Done" }));
    process.exitCode = 1;
    return;
  }
  if (prompt.includes("SLEEP")) {
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    return;
  }
  if (prompt.includes("PAUSE")) await new Promise((resolve) => setTimeout(resolve, 500));
  const attempted = existsSync(".attempt");
  const fixes = attempted || prompt.includes("FIX NOW");
  writeFileSync(".attempt", "1");
  if (fixes && existsSync("math.js")) writeFileSync("math.js", readFileSync("math.js", "utf8").replace("a - b", "a + b"));
  const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  if (provider === "claude") {
    out({ type: "system", subtype: "init", session_id: "fake-session-1", model: "fake-model" });
    out({ type: "assistant", session_id: "fake-session-1", message: { model: "fake-model", content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] } });
    if (fixes) out({ type: "assistant", session_id: "fake-session-1", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "math.js" } }] } });
    out({ type: "assistant", session_id: "fake-session-1", message: { content: [{ type: "text", text: resumed ? "Continuing." : "Looked at it." }] } });
    out({ type: "result", subtype: "success", is_error: false, result: fixes ? "Fixed add()." : "Investigated.", session_id: "fake-session-1", usage: { input_tokens: 10, output_tokens: 5 },
      // Claude reports helper models alongside the one doing the work.
      modelUsage: { "fake-helper": { outputTokens: 2 }, "fake-model": { outputTokens: 40 } } });
  } else {
    out({ type: "thread.started", thread_id: "fake-thread-1" });
    out({ type: "turn.started" });
    out({ type: "item.started", item: { id: "c1", type: "command_execution", command: "npm test", status: "in_progress" } });
    out({ type: "item.completed", item: { id: "c1", type: "command_execution", command: "npm test", exit_code: 1, aggregated_output: "fail" } });
    if (fixes) out({ type: "item.completed", item: { id: "f1", type: "file_change", changes: [{ path: "math.js", kind: "update" }] } });
    out({ type: "item.completed", item: { id: "m1", type: "agent_message", text: fixes ? "Fixed add()." : "Investigated." } });
    out({ type: "turn.completed", usage: { input_tokens: 20, output_tokens: 7 } });
  }
});
