import { useEffect, useState } from "preact/hooks";
import { html } from "../html.js";
import { Button, Skeleton } from "../ui.js";
import { get } from "../api.js";
import { parseDiff } from "./logic.js";

// The Changes tab: a file list beside a unified diff. Reloads when a turn ends
// or the run is committed, not on every update, because reading a diff itself
// counts as activity on the run.
export function Changes({ runId, version }) {
  const [diff, setDiff] = useState(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState("");
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let current = true;
    setError("");
    get(`/api/agents/runs/diff?id=${encodeURIComponent(runId)}`)
      .then((data) => { if (current) setDiff(data.diff); })
      .catch((loadError) => { if (current) setError(loadError.message); });
    return () => { current = false; };
  }, [runId, version, nonce]);
  if (error) return html`<p class="danger small">${error}</p>`;
  if (!diff) return html`<${Skeleton} lines=${4} />`;
  if (diff.missing) return html`<p class="muted small">This run's worktree was removed, so its changes can't be shown here.</p>`;
  if (!diff.files.length) return html`<div class="row space-between"><p class="muted small">No changes yet.</p><${Button} size="sm" variant="ghost" onClick=${() => setNonce(nonce + 1)}>Refresh</${Button}></div>`;
  const parsed = parseDiff(diff.patch);
  const visible = selected ? parsed.filter((file) => file.path === selected) : parsed;
  return html`<div class="diff">
    <div class="diff-summary">
      <strong>${diff.files.length} ${diff.files.length === 1 ? "file" : "files"}</strong><span class="good">+${diff.added}</span><span class="danger">−${diff.removed}</span>
      ${diff.added + diff.removed > 300 ? html`<span class="warn small">Large diff: consider splitting the task</span>` : null}
      <${Button} size="sm" variant="ghost" class="diff-refresh" onClick=${() => setNonce(nonce + 1)}>Refresh</${Button}>
    </div>
    <div class="diff-layout">
      <ul class="diff-files">
        <li><button type="button" class=${!selected ? "is-active" : ""} aria-pressed=${!selected ? "true" : "false"} onClick=${() => setSelected("")}><span class="diff-path">All files</span></button></li>
        ${diff.files.map((file) => html`<li><button type="button" class=${selected === file.path ? "is-active" : ""} aria-pressed=${selected === file.path ? "true" : "false"} title=${file.path} onClick=${() => setSelected(file.path)}>
          <span class="diff-path">${file.path}</span><span class="good">+${file.added}</span><span class="danger">−${file.removed}</span>
        </button></li>`)}
      </ul>
      <div class="diff-patch">
        ${visible.map((file) => html`<section key=${file.path}>
          <h4 class="diff-file-head">${file.path}</h4>
          <pre>${file.lines.map((line) => html`<span class=${line.kind}>${line.text}\n</span>`)}</pre>
        </section>`)}
        ${selected && !visible.length ? html`<p class="muted small diff-note">This file is past the point where the diff was cut off, or is binary.</p>` : null}
      </div>
    </div>
    ${diff.truncated ? html`<p class="muted small">Diff truncated. Open the worktree in VS Code for the rest.</p>` : null}
  </div>`;
}
