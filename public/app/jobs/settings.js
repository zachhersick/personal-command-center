// Settings → Jobs: the job Gmail inbox (desktop), the old-data import, the
// weekly target, and the "I applied" bookmark.
import { useEffect, useState } from "preact/hooks";
import { html } from "../html.js";
import { Button, Field } from "../ui.js";
import { post } from "../api.js";
import { reportError, toast } from "../store.js";
import { can } from "../platform.js";
import { jobAction, jobs, loadJobs, shortWhen } from "./state.js";

// Same as server/jobs/links.js bookmarkletSource: opens Jarvis's Quick add
// with this page's address and title, in place if Safari blocks the new tab.
export function bookmarklet(appUrl) {
  const base = String(appUrl || "").replace(/\/+$/, "");
  return `javascript:(()=>{const u=${JSON.stringify(`${base}/#jobs?add=1`)}+'&url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title);if(!window.open(u,'_blank'))location.href=u})()`;
}

function InboxSettings() {
  const inbox = jobs.value?.inbox;
  const [form, setForm] = useState({ email: "", password: "" });
  const [busy, setBusy] = useState("");
  const [preview, setPreview] = useState(null);
  if (!inbox) return null;

  const run = async (label, path, body) => {
    setBusy(label);
    try {
      const result = await post(`/api/jobs/inbox/${path}`, body);
      await loadJobs();
      return result;
    } catch (error) {
      reportError(error);
      return null;
    } finally {
      setBusy("");
    }
  };

  if (!inbox.configured) {
    return html`<div class="form">
      <p class="muted small">Jarvis reads your job-hunting Gmail (read-only) for application confirmations, assessments, interview requests and rejections, and keeps the pipeline current. It needs a Google App Password: turn on 2-Step Verification, then create one at <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">myaccount.google.com/apppasswords</a>. It's stored encrypted on this computer and never leaves it.</p>
      <div class="form-row">
        <${Field} label="Job Gmail address"><input class="input" type="email" autocomplete="off" value=${form.email} placeholder="you@gmail.com" onInput=${(event) => setForm({ ...form, email: event.currentTarget.value })} /></${Field}>
        <${Field} label="App Password"><input class="input" type="password" autocomplete="off" value=${form.password} placeholder="16 letters" onInput=${(event) => setForm({ ...form, password: event.currentTarget.value })} /></${Field}>
      </div>
      <div><${Button} variant="primary" icon="mail" disabled=${Boolean(busy) || !form.email || !form.password} onClick=${async () => {
        if (await run("connect", "connect", form)) {
          setForm({ email: "", password: "" });
          toast("Connected. Preview the first scan before anything is added.", { tone: "good" });
        }
      }}>${busy === "connect" ? "Checking…" : "Connect"}</${Button}></div>
    </div>`;
  }

  const details = preview?.details;
  return html`<div class="form">
    <div class="row space-between wrap gap-2">
      <span class="small">
        <span class=${`pill ${inbox.lastError ? "pill-warn" : "pill-good"}`}>${inbox.lastError ? "Problem" : "Connected"}</span>
        ${" "}${inbox.email}${inbox.lastScanAt ? html`<span class="muted"> · checked ${shortWhen(inbox.lastScanAt)} ${new Date(inbox.lastScanAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>` : null}
        ${inbox.encrypted ? null : html`<span class="warn"> · stored without the OS keychain</span>`}
      </span>
      <span class="row gap-2">
        ${inbox.firstScanDone ? html`<${Button} size="sm" icon="undo" disabled=${Boolean(busy)} onClick=${async () => {
          const result = await run("scan", "scan", {});
          if (result) toast(`Checked ${result.scan.messages} emails: ${result.scan.created} new, ${result.scan.updated} updated, ${result.scan.review} to check.`);
        }}>${busy === "scan" ? "Checking…" : "Check now"}</${Button}>` : null}
        <${Button} size="sm" variant="ghost" disabled=${Boolean(busy)} onClick=${() => window.confirm("Disconnect your job Gmail? The saved App Password is deleted.") && run("disconnect", "disconnect", {})}>Disconnect</${Button}>
      </span>
    </div>
    ${inbox.lastError ? html`<p class="warn small">${inbox.lastError}</p>` : null}
    ${!inbox.firstScanDone ? html`<div class="inbox-preview">
      <p class="small">First, preview what the last 120 days of email would add. Nothing changes until you import.</p>
      <div><${Button} variant="primary" icon="eye" disabled=${Boolean(busy)} onClick=${async () => {
        const result = await run("preview", "scan", { preview: true });
        if (result) setPreview(result.scan);
      }}>${busy === "preview" ? "Reading your inbox…" : "Preview first scan"}</${Button}></div>
      ${details ? html`<div class="preview-result">
        <p class="small"><strong>${preview.messages}</strong> emails matched: <strong>${details.created.length}</strong> new applications, <strong>${details.updated.length}</strong> updates to ones you have, <strong>${details.review.length}</strong> to check by hand.</p>
        <ul class="preview-list">
          ${[...details.created.map((item) => ({ ...item, tag: "New" })), ...details.updated.map((item) => ({ ...item, tag: "Update" })), ...details.review.map((item) => ({ ...item, tag: "Check" }))].slice(0, 40).map((item) => html`<li>
            <span class="pill">${item.tag}</span><strong>${item.company || "?"}</strong><span class="muted">${item.role || ""}</span><span class="muted small">${item.subject}</span>
          </li>`)}
        </ul>
        <div class="row gap-2">
          <${Button} variant="primary" icon="check" disabled=${Boolean(busy)} onClick=${async () => {
            const result = await run("import", "scan", {});
            if (result) {
              setPreview(null);
              toast(`Added ${result.scan.created}, updated ${result.scan.updated}. ${result.scan.review} to check on the Jobs page.`, { tone: "good" });
            }
          }}>Import</${Button}>
          <${Button} variant="ghost" onClick=${() => setPreview(null)}>Cancel</${Button}>
        </div>
      </div>` : null}
    </div>` : html`<p class="muted small">Checks every 15 minutes while Jarvis is open. Emails it isn't sure about wait on the Jobs page for you.</p>`}
  </div>`;
}

export function JobsSettings() {
  const data = jobs.value;
  const [target, setTarget] = useState("");
  useEffect(() => {
    loadJobs();
  }, []);
  useEffect(() => {
    if (data) setTarget(String(data.settings.weeklyTarget));
  }, [data?.settings.weeklyTarget]);
  if (!data) return null;
  const link = data.appUrl ? bookmarklet(data.appUrl) : "";
  return html`<section class="jobs-settings">
    <h3>Jobs</h3>
    ${can.value.jobsInbox ? html`<h4>Job inbox</h4><${InboxSettings} />` : null}
    ${data.legacy?.available ? html`<div class="row space-between wrap gap-2">
      <span class="small">${data.legacy.count} applications from the old Jarvis are on this computer.</span>
      <${Button} size="sm" onClick=${() => jobAction("import-legacy", {}, (result) => `Imported ${result.added} applications`)}>Import them</${Button}>
    </div>` : null}
    <div class="row gap-2 wrap">
      <${Field} label="Applications per week"><input class="input input-sm" type="number" min="0" max="200" value=${target} onInput=${(event) => setTarget(event.currentTarget.value)} /></${Field}>
      <${Button} size="sm" disabled=${String(data.settings.weeklyTarget) === target} onClick=${() => jobAction("settings", { weeklyTarget: Number(target) }, "Weekly target saved")}>Save</${Button}>
    </div>
    <h4>“I applied” bookmark</h4>
    ${link ? html`<div class="bookmarklet">
      <p class="muted small">After you apply anywhere (LinkedIn, Runway, a company site), tap this bookmark on that page. Jarvis opens with the company, role and link filled in.</p>
      <div class="row gap-2 wrap">
        <a class="btn btn-secondary btn-sm bookmarklet-link" href=${link} onClick=${(event) => { event.preventDefault(); toast("Drag this to your bookmarks bar instead of clicking it."); }}>＋ I applied</a>
        <${Button} size="sm" icon="note" onClick=${async () => { await navigator.clipboard?.writeText(link); toast("Bookmark code copied"); }}>Copy for iPhone</${Button}>
      </div>
      <p class="muted small"><strong>Computer:</strong> drag “＋ I applied” to the bookmarks bar. <strong>iPhone:</strong> tap Copy, bookmark any page in Safari, then edit that bookmark: name it “I applied” and paste over its address.</p>
    </div>` : html`<p class="muted small">Connect Cloud sync above first. The bookmark opens Jarvis on your website, so it works on any computer or phone you're signed in on.</p>`}
  </section>`;
}
