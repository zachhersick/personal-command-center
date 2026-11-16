// Normalized activity events shared by every agent source:
// { at, kind, title, detail?, ok? }
// kind: prompt | message | command | edit | read | search | tool | plan | result | error | status

const short = (value, length = 140) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
};

export function baseName(path) {
  return String(path || "").split(/[\\/]/).filter(Boolean).slice(-2).join("/");
}

// Codex runs commands through a shell wrapper:
//   "C:\...\powershell.exe" -Command 'git status --short'
// Show the command inside, not the wrapper.
export function cleanCommand(command) {
  const text = String(command || "").trim();
  const wrapped = /^"?[^"\s]*?(?:powershell|pwsh|cmd|bash|sh)(?:\.exe)?"?\s+(?:-NoProfile\s+)?(?:-Command|-c|\/c|-lc)\s+([\s\S]+)$/i.exec(text);
  if (!wrapped) return text;
  const inner = wrapped[1].trim();
  const quoted = /^(['"])([\s\S]*)\1$/.exec(inner);
  return (quoted ? quoted[2] : inner).replace(/^git -c safe\.directory=\* /, "git ");
}

export function event(at, kind, title, extra = {}) {
  return { at: at || null, kind, title: short(kind === "command" ? cleanCommand(title) : title), ...extra };
}

export function summarize(text, length) {
  return short(text, length);
}

// One-line "what is it doing right now" from the newest event.
export function currentLine(events = []) {
  const last = [...events].reverse().find((entry) => entry.kind !== "status");
  if (!last) return "";
  switch (last.kind) {
    case "command":
      return `Running ${last.title}`;
    case "edit":
      return `Editing ${last.title}`;
    case "read":
      return `Reading ${last.title}`;
    case "search":
      return `Searching ${last.title}`;
    case "prompt":
      return `Prompt: ${last.title}`;
    default:
      return last.title;
  }
}
