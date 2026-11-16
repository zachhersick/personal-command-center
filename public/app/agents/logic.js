// What the hub works out from a board. Pure, so it's shared by the desktop and
// the phone and tested in Node.

export const COLUMNS = [
  { id: "todo", label: "To do", hint: "Saved tasks and agents waiting for a slot" },
  { id: "running", label: "Running", hint: "Working right now" },
  { id: "review", label: "In review", hint: "Waiting on your decision, or a pull request still open" },
  { id: "done", label: "Done", hint: "Committed, merged or discarded" }
];

// The server decides this. A board pushed by an older desktop doesn't say, so
// fall back to what its statuses used to mean.
export function columnOf(session) {
  if (session.column) return session.column;
  if (session.status === "queued") return "todo";
  if (session.status === "working" || session.status === "starting") return "running";
  if (session.status === "needs-you") return "review";
  return "done";
}

const newestFirst = (a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));

export function boardColumns(data, filter = "all") {
  const sessions = (data?.sessions || []).filter((session) => filter === "all" || session.provider === filter);
  const drafts = (data?.drafts || []).filter((draft) => filter === "all" || draft.provider === filter);
  const runs = sessions.filter((session) => session.origin === "jarvis");
  const inColumn = (id) => runs.filter((session) => columnOf(session) === id);
  return {
    columns: {
      todo: inColumn("todo").sort((a, b) => String(a.queuedAt || "").localeCompare(String(b.queuedAt || ""))),
      running: inColumn("running").sort(newestFirst),
      review: inColumn("review").sort((a, b) => Number(b.status === "needs-you") - Number(a.status === "needs-you") || newestFirst(a, b)),
      done: inColumn("done").sort(newestFirst)
    },
    drafts,
    // Started in a terminal or the Claude app: watched here, steered there.
    outside: sessions.filter((session) => session.origin !== "jarvis").sort((a, b) => Number(b.status === "needs-you") - Number(a.status === "needs-you") || Number(b.status === "working") - Number(a.status === "working") || newestFirst(a, b))
  };
}

// The sidebar's sections, in the order you'd act on them. Needs-you runs get
// their own section at the top; the rest follow the board's columns.
export const THREAD_GROUPS = [
  { id: "needs", label: "Needs you" },
  { id: "running", label: "Running" },
  { id: "todo", label: "Up next" },
  { id: "review", label: "In review" },
  { id: "done", label: "Done" }
];

export function threadGroups(data, filter = "all") {
  const { columns, drafts, outside } = boardColumns(data, filter);
  return {
    needs: columns.review.filter((session) => session.status === "needs-you"),
    running: columns.running,
    todo: columns.todo,
    drafts,
    review: columns.review.filter((session) => session.status !== "needs-you"),
    done: columns.done,
    outside
  };
}

const textOf = (item) => String(item.detail || item.title || "").trim();

// Turns the event stream into a conversation: your messages and the agent's
// replies, with the tool calls between them folded into one line each.
export function conversationItems(events = []) {
  const items = [];
  let prompts = 0;
  for (const item of events) {
    if (item.kind === "prompt") items.push({ type: "you", text: textOf(item), at: item.at, index: prompts++ });
    else if (item.kind === "error" || item.ok === false && item.kind === "result") items.push({ type: "error", text: textOf(item), at: item.at });
    else if (item.kind === "message" || item.kind === "result") {
      const text = textOf(item);
      // Claude ends a turn by repeating its last reply as the result.
      const last = items[items.length - 1];
      if (item.kind === "result" && (text === "Done" || (last?.type === "agent" && last.text === text))) continue;
      items.push({ type: "agent", text, at: item.at });
    } else {
      const last = items[items.length - 1];
      if (last?.type === "activity") last.events.push(item);
      else items.push({ type: "activity", events: [item] });
    }
  }
  return items;
}

// A retry starts over from the original commit, so it needs everything you had
// asked for up to that point.
export function retryPrompt(items, index) {
  const asked = items.filter((item) => item.type === "you" && item.index <= index).map((item) => item.text);
  if (asked.length < 2) return asked[0] || "";
  return `${asked[0]}\n\nFollow-ups I gave on an earlier attempt:\n${asked.slice(1).map((text) => `- ${text}`).join("\n")}`;
}

const lineKind = (line) => {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+") && !line.startsWith("+++")) return "add";
  if (line.startsWith("-") && !line.startsWith("---")) return "del";
  return "";
};

// Splits a unified diff by file, so the Changes tab can show one at a time.
export function parseDiff(patch = "") {
  const files = [];
  for (const line of String(patch).split("\n")) {
    if (line.startsWith("diff --git ")) {
      const path = / b\/(.+)$/.exec(line)?.[1] || line.slice("diff --git ".length);
      files.push({ path, lines: [] });
    } else if (files.length && !/^(index |--- |\+\+\+ |new file|deleted file|similarity |rename |old mode|new mode)/.test(line)) {
      files[files.length - 1].lines.push({ text: line, kind: lineKind(line) });
    }
  }
  return files;
}

// The chip on a card and in a workspace. Merged and closed say so and stop there.
export function prLabel(pr) {
  if (!pr) return { text: "PR open", tone: "accent" };
  if (pr.state === "MERGED") return { text: "Merged", tone: "good" };
  if (pr.state === "CLOSED") return { text: "PR closed", tone: "" };
  const checks = pr.checks || {};
  if (checks.failing) return { text: `${checks.failing} ${checks.failing === 1 ? "check" : "checks"} failing`, tone: "danger" };
  if (pr.review === "CHANGES_REQUESTED") return { text: "Changes requested", tone: "warn" };
  if (checks.pending) return { text: "Checks running", tone: "accent" };
  if (pr.draft) return { text: "Draft PR", tone: "" };
  if (pr.review === "APPROVED") return { text: "Approved", tone: "good" };
  return { text: checks.passing ? "Checks passing" : "PR open", tone: checks.passing ? "good" : "accent" };
}

// A plan finished and hasn't been answered yet. Reviews also run in plan mode,
// but there's nothing to approve at the end of one.
export const awaitingApproval = (session) => session.origin === "jarvis" && session.mode === "plan" && session.kind === "task" && session.status === "needs-you" && !session.outcome;
