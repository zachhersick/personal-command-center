import { useEffect, useMemo, useState } from "preact/hooks";
import { html } from "../html.js";
import { Icon } from "../icons.js";
import { Bar, Button, Empty, Field, IconButton, Modal, Sheet, Skeleton } from "../ui.js";
import { addDays } from "../format.js";
import { navigate, settingsOpen, todayKey } from "../store.js";
import { isWeb } from "../platform.js";
import {
  addDraft, ago, BOARD_STAGES, EVENT_LABELS, followUpIds, gmailLink, jobAction, jobs, loadJobs, openQuickAdd, openReviews, parseLink,
  selectedJob, shortWhen, SOURCE_LABELS, STAGE_LABELS, takeBookmarkFromHash
} from "./state.js";

const LANE_LIMIT = 25;

function Kpis({ metrics }) {
  const week = metrics.weeklyTarget ? metrics.appliedThisWeek / metrics.weeklyTarget : 0;
  return html`<div class="jobs-kpis">
    <div class="stat">
      <strong>${metrics.appliedThisWeek}<em>/${metrics.weeklyTarget}</em></strong>
      <span>applied this week</span>
      <${Bar} value=${week} color=${week >= 1 ? "var(--good)" : "var(--accent)"} />
    </div>
    <div class="stat"><strong>${metrics.responseRate === null ? "—" : `${metrics.responseRate}%`}</strong><span>${metrics.matured ? `heard back on ${metrics.matured} older than 2 weeks` : "response rate"}</span></div>
    <div class=${`stat ${metrics.active ? "stat-good" : ""}`}><strong>${metrics.active}</strong><span>in screens or interviews</span></div>
    <div class=${`stat ${jobs.value.followUps.length ? "stat-warn" : ""}`}><strong>${jobs.value.followUps.length}</strong><span>follow-ups due</span></div>
  </div>`;
}

function InboxLine() {
  const data = jobs.value;
  const inbox = data.inbox;
  if (isWeb.value) return html`<p class="muted">${data.settings.inboxEmail ? `Your desktop reads ${data.settings.inboxEmail} and fills this in.` : "Connect your job Gmail in Jarvis on your PC to fill this in automatically."}</p>`;
  if (!inbox?.configured) return html`<p class="muted">Applications you log land here. <button type="button" class="link" onClick=${() => { settingsOpen.value = true; }}>Connect your job Gmail</button> and Jarvis fills it in from your confirmation emails.</p>`;
  return html`<p class="muted">
    <${Icon} name="mail" size=${14} /> Reading ${inbox.email}${inbox.lastScanAt ? ` · checked ${ago(inbox.lastScanAt)}` : ""}
    ${inbox.lastError ? html` · <span class="danger">${inbox.lastError}</span>` : null}
    ${!inbox.firstScanDone ? html` · <button type="button" class="link" onClick=${() => { settingsOpen.value = true; }}>Run the first scan</button>` : null}
  </p>`;
}

function Banners() {
  const data = jobs.value;
  const cohort = data.metrics.cohort;
  return html`
    ${data.legacy?.available ? html`<div class="jobs-banner">
      <${Icon} name="layers" size=${18} />
      <div><strong>${data.legacy.count} applications from the old Jarvis</strong><span class="muted small">From the job board, Runway's Applied tab and the old tracker. Duplicates are merged.</span></div>
      <${Button} size="sm" variant="primary" onClick=${() => jobAction("import-legacy", {}, (result) => `Imported ${result.added} applications`)}>Import</${Button}>
    </div>` : null}
    ${cohort?.needsReview ? html`<div class="jobs-banner jobs-banner-warn">
      <${Icon} name="flag" size=${18} />
      <div><strong>${cohort.screens} human screen${cohort.screens === 1 ? "" : "s"} in your last ${cohort.size} applications</strong><span class="muted small">Your rule: under two per 30 means review targeting and the resume before sending more of the same.</span></div>
    </div>` : null}`;
}

function ReviewStrip() {
  const items = openReviews.value;
  if (!items.length) return null;
  return html`<section class="jobs-review">
    <div class="lane-head"><strong>Check these emails</strong><em>${items.length}</em><span class="muted small">Jarvis wasn't sure what they mean. Nothing changes until you decide.</span></div>
    <div class="jobs-review-list">${items.slice(0, 6).map((item) => html`<${ReviewItem} key=${item.id} item=${item} />`)}</div>
  </section>`;
}

function ReviewItem({ item }) {
  const [company, setCompany] = useState(item.company);
  const [target, setTarget] = useState(item.candidates[0] || "");
  const open = (jobs.value?.jobs || []).filter((job) => !["rejected", "withdrawn"].includes(job.stage));
  const candidates = [...item.candidates.map((id) => open.find((job) => job.id === id)).filter(Boolean), ...open.filter((job) => !item.candidates.includes(job.id)).slice(0, 40)];
  return html`<article class="review-card">
    <div class="review-top"><span class="pill">${EVENT_LABELS[item.kind] || "Unclear"}</span><span class="muted small">${shortWhen(item.at)}</span></div>
    <strong class="review-subject">${item.subject || "(no subject)"}</strong>
    <span class="muted small">${item.from}</span>
    <span class="warn small">${item.why}</span>
    <div class="review-actions">
      <input class="input input-sm" value=${company} placeholder="Company" aria-label="Company" onInput=${(event) => setCompany(event.currentTarget.value)} />
      <${Button} size="sm" variant="primary" disabled=${!company.trim()} onClick=${() => jobAction("review", { id: item.id, action: "accept", company, kind: item.kind || "applied" }, `Added to ${company}`)}>Add</${Button}>
    </div>
    ${candidates.length ? html`<div class="review-actions">
      <select class="input input-sm" value=${target} aria-label="Existing application" onChange=${(event) => setTarget(event.currentTarget.value)}>
        <option value="">Link to an application…</option>
        ${candidates.map((job) => html`<option value=${job.id}>${job.company}${job.role ? ` · ${job.role}` : ""}</option>`)}
      </select>
      <${Button} size="sm" disabled=${!target} onClick=${() => jobAction("review", { id: item.id, action: "assign", jobId: target, kind: item.kind || "note" }, "Linked")}>Link</${Button}>
    </div>` : null}
    <button type="button" class="link small" onClick=${() => jobAction("review", { id: item.id, action: "ignore" })}>Not about a job</button>
  </article>`;
}

function JobCard({ job }) {
  const due = followUpIds.value.has(job.id);
  const last = (job.events || []).at(-1);
  return html`<button type="button" class=${`job-card stage-${job.stage} ${due ? "is-due" : ""}`} onClick=${() => { selectedJob.value = job.id; }}>
    <div class="job-card-top"><strong>${job.company}</strong><span class="muted small">${job.appliedAt ? ago(job.appliedAt) : ""}</span></div>
    ${job.role ? html`<span class="job-role">${job.role}</span>` : null}
    <div class="job-card-foot">
      <span class=${`src src-${job.source}`}>${SOURCE_LABELS[job.source] || job.source}</span>
      ${due ? html`<span class="pill pill-warn">Follow up</span>` : last && last.kind !== "applied" && last.kind !== "imported" ? html`<span class="muted small">${EVENT_LABELS[last.kind]} · ${ago(last.at)}</span>` : null}
    </div>
  </button>`;
}

function Lane({ stage, list }) {
  const [all, setAll] = useState(false);
  const shown = all ? list : list.slice(0, LANE_LIMIT);
  return html`<section class=${`lane job-lane lane-${stage}`}>
    <div class="lane-head"><strong>${STAGE_LABELS[stage]}</strong><em>${list.length}</em></div>
    <div class="lane-cards">
      ${shown.map((job) => html`<${JobCard} key=${job.id} job=${job} />`)}
      ${!list.length ? html`<div class="lane-empty">Nothing here yet</div>` : null}
      ${list.length > shown.length ? html`<button type="button" class="link small" onClick=${() => setAll(true)}>Show all ${list.length}</button>` : null}
    </div>
  </section>`;
}

function Closed({ groups }) {
  const total = groups.reduce((sum, group) => sum + group.list.length, 0);
  if (!total) return null;
  return html`<details class="jobs-closed">
    <summary><strong>Closed and quiet</strong> <span class="muted small">${groups.map((group) => `${group.list.length} ${group.label.toLowerCase()}`).join(" · ")}</span></summary>
    ${groups.filter((group) => group.list.length).map((group) => html`<div class="jobs-closed-group">
      <h4>${group.label}</h4>
      <div class="jobs-closed-list">${group.list.slice(0, 200).map((job) => html`<button type="button" class="closed-row" onClick=${() => { selectedJob.value = job.id; }}>
        <strong>${job.company}</strong><span class="muted">${job.role}</span><span class="muted small">${job.appliedAt ? shortWhen(job.appliedAt) : "date unknown"}</span>
      </button>`)}</div>
    </div>`)}
  </details>`;
}

function QuickAdd() {
  const draft = addDraft.value;
  const [busy, setBusy] = useState(false);
  if (!draft) return null;
  const set = (field) => (event) => { addDraft.value = { ...addDraft.value, [field]: event.currentTarget.value }; };
  const close = () => { addDraft.value = null; };
  const fill = async (event) => {
    const url = event.currentTarget.value.trim();
    if (!/^https?:\/\//i.test(url)) return;
    const parsed = await parseLink(url);
    if (parsed && addDraft.value) addDraft.value = { ...addDraft.value, url: parsed.url || url, company: addDraft.value.company || parsed.company, role: addDraft.value.role || parsed.role, location: addDraft.value.location || parsed.location, source: parsed.source };
  };
  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    const { loading, ...body } = addDraft.value;
    const result = await jobAction("upsert", { ...body, url: body.url || undefined }, (data) => (data.created ? `Logged ${data.job.company}` : `${data.job.company} was already in your pipeline`));
    setBusy(false);
    if (result) close();
  };
  return html`<${Modal} open=${true} onClose=${close} title="Log an application">
    <form class="modal-body form" onSubmit=${save}>
      <${Field} label="Link" hint="Paste the posting; company and role fill in.">
        <input class="input" type="url" value=${draft.url} placeholder="https://www.linkedin.com/jobs/view/…" onInput=${set("url")} onChange=${fill} />
      </${Field}>
      ${draft.loading ? html`<${Skeleton} lines=${2} />` : html`<div class="form-row">
        <${Field} label="Company"><input class="input" required autofocus value=${draft.company} onInput=${set("company")} /></${Field}>
        <${Field} label="Role"><input class="input" value=${draft.role} onInput=${set("role")} /></${Field}>
      </div>
      <div class="form-row">
        <${Field} label="Location"><input class="input" value=${draft.location} onInput=${set("location")} /></${Field}>
        <${Field} label="Status"><select class="input" value=${draft.stage} onChange=${set("stage")}>
          <option value="applied">Applied</option>
          <option value="saved">Saved for later</option>
        </select></${Field}>
      </div>`}
      <footer class="modal-foot flush"><${Button} variant="ghost" onClick=${close}>Cancel</${Button}><${Button} variant="primary" type="submit" icon="check" disabled=${busy || draft.loading}>Save</${Button}></footer>
    </form>
  </${Modal}>`;
}

function JobDetail({ job, onClose }) {
  const data = jobs.value;
  const [notes, setNotes] = useState(job.notes || "");
  const [prepDate, setPrepDate] = useState(todayKey.value ? addDays(todayKey.value, 1) : "");
  useEffect(() => setNotes(job.notes || ""), [job.id]);
  const update = (patch, message) => jobAction("upsert", { id: job.id, ...patch }, message);
  const due = followUpIds.value.has(job.id);
  return html`<div class="sheet-body job-detail">
    <header class="sheet-head">
      <div class="row gap-2 wrap"><span class=${`pill stage-pill stage-${job.stage}`}>${STAGE_LABELS[job.stage]}</span><span class=${`src src-${job.source}`}>${SOURCE_LABELS[job.source] || job.source}</span>${job.ghosted ? html`<span class="pill">No reply in 30+ days</span>` : null}</div>
      <${IconButton} icon="x" label="Close" onClick=${onClose} />
    </header>
    <h2 class="sheet-title">${job.company}</h2>
    ${job.role ? html`<p class="job-detail-role">${job.role}</p>` : null}
    <div class="sheet-facts">
      <span><${Icon} name="calendar" size=${14} />${job.appliedAt ? `Applied ${shortWhen(job.appliedAt)}` : "Applied date unknown"}</span>
      ${job.location ? html`<span><${Icon} name="flag" size=${14} />${job.location}</span>` : null}
      ${job.url ? html`<a href=${job.url} target="_blank" rel="noreferrer"><${Icon} name="external" size=${14} />Posting</a>` : null}
    </div>
    ${due ? html`<div class="agent-callout"><${Icon} name="clock" size=${15} /><span>Two weeks with no reply. A short follow-up with something new is worth sending; skip it if you have nothing to add.</span></div>` : null}
    <div class="sheet-actions">
      <select class="input input-sm" value=${job.stage} aria-label="Stage" onChange=${(event) => update({ stage: event.currentTarget.value }, `Moved to ${STAGE_LABELS[event.currentTarget.value]}`)}>
        ${Object.entries(STAGE_LABELS).map(([value, label]) => html`<option value=${value}>${label}</option>`)}
      </select>
      ${job.stage === "applied" ? html`<${Button} size="sm" icon="send" onClick=${() => jobAction("event", { id: job.id, kind: "followed_up" }, "Logged your follow-up")}>I followed up</${Button}>` : null}
      ${["assessment", "screen", "interview"].includes(job.stage) ? html`<span class="row gap-2">
        <input class="input input-sm" type="date" value=${prepDate} aria-label="Prep date" onInput=${(event) => setPrepDate(event.currentTarget.value)} />
        <${Button} size="sm" variant="primary" icon="plus" disabled=${!prepDate} onClick=${() => jobAction("prep-task", { id: job.id, date: prepDate, minutes: 60 }, "Prep task added to your plan")}>Add prep task</${Button}>
      </span>` : null}
    </div>
    <div class="sheet-section">
      <h4>Next step</h4>
      <div class="row gap-2 wrap">
        <input class="input input-sm job-next" value=${job.nextAction || ""} placeholder="e.g. Email the recruiter" aria-label="Next step"
          onChange=${(event) => update({ nextAction: event.currentTarget.value })} />
        <input class="input input-sm" type="date" value=${(job.nextActionDate || "").slice(0, 10)} aria-label="Next step date"
          onChange=${(event) => update({ nextActionDate: event.currentTarget.value || null })} />
      </div>
    </div>
    <div class="sheet-section">
      <h4>Notes</h4>
      <textarea class="input" rows="4" value=${notes} placeholder="Recruiter, salary range, what they asked…" onInput=${(event) => setNotes(event.currentTarget.value)}
        onBlur=${() => notes !== (job.notes || "") && update({ notes }, "Notes saved")}></textarea>
    </div>
    <div class="sheet-section">
      <h4>Timeline</h4>
      <ol class="job-timeline">${[...(job.events || [])].reverse().map((event) => html`<li class=${`tl-${event.kind}`}>
        <span class="tl-when">${shortWhen(event.at)}</span>
        <div>
          <strong>${event.kind === "stage" ? `Moved to ${STAGE_LABELS[event.stage] || event.stage}` : EVENT_LABELS[event.kind] || event.kind}</strong>
          ${event.subject ? html`<span class="muted small">${event.subject}</span>` : null}
          ${event.note ? html`<span class="muted small">${event.note}</span>` : null}
          ${event.messageId ? html`<a class="small" href=${gmailLink(event.messageId, data.settings.inboxEmail)} target="_blank" rel="noreferrer">Open in Gmail</a>` : null}
        </div>
      </li>`)}</ol>
    </div>
    <div class="row gap-2"><${Button} size="sm" variant="ghost" icon="trash" onClick=${async () => {
      if (!window.confirm(`Remove ${job.company} from your pipeline?`)) return;
      await jobAction("delete", { id: job.id }, "Removed");
      onClose();
    }}>Remove</${Button}></div>
  </div>`;
}

export function JobSheet() {
  const id = selectedJob.value;
  const job = jobs.value?.jobs.find((entry) => entry.id === id);
  const close = () => { selectedJob.value = null; };
  return html`<${Sheet} open=${Boolean(job)} onClose=${close} title="Application">${job ? html`<${JobDetail} job=${job} onClose=${close} />` : null}</${Sheet}>`;
}

export function JobsPage() {
  useEffect(() => {
    loadJobs();
    takeBookmarkFromHash();
    const onHash = () => takeBookmarkFromHash();
    window.addEventListener("hashchange", onHash);
    const timer = setInterval(loadJobs, 60_000);
    return () => {
      window.removeEventListener("hashchange", onHash);
      clearInterval(timer);
    };
  }, []);
  const data = jobs.value;
  const lanes = useMemo(() => {
    if (!data) return null;
    const byRecent = (a, b) => Date.parse(b.lastActivityAt || b.appliedAt || b.createdAt || 0) - Date.parse(a.lastActivityAt || a.appliedAt || a.createdAt || 0);
    const live = data.jobs.filter((job) => !job.ghosted).sort(byRecent);
    return {
      saved: live.filter((job) => job.stage === "saved"),
      board: BOARD_STAGES.map((stage) => ({ stage, list: live.filter((job) => job.stage === stage) })),
      closed: [
        { label: "No reply", list: data.jobs.filter((job) => job.ghosted).sort(byRecent) },
        { label: "Rejected", list: live.filter((job) => job.stage === "rejected") },
        { label: "Withdrawn", list: live.filter((job) => job.stage === "withdrawn") }
      ]
    };
  }, [data]);

  return html`<div class="page page-jobs">
    <header class="page-head">
      <div>
        <div class="eyebrow">Jobs</div>
        <h1>Your pipeline</h1>
        ${data ? html`<${InboxLine} />` : null}
      </div>
      <div class="agent-kpis">
        <${Button} variant="primary" icon="plus" onClick=${() => openQuickAdd()}>Log an application</${Button}>
      </div>
    </header>
    ${!data ? html`<${Skeleton} lines=${6} />` : html`
      <${Kpis} metrics=${data.metrics} />
      <${Banners} />
      <${ReviewStrip} />
      ${!data.jobs.length ? html`<${Empty} icon="briefcase" title="No applications yet">
        Log one with the button above, use the “I applied” bookmark from Settings on any job page, or connect your job Gmail and Jarvis adds them for you.
      </${Empty}>` : html`
        ${lanes.saved.length ? html`<div class="jobs-saved"><span class="muted small">Saved for later</span>${lanes.saved.map((job) => html`<button type="button" class="chip" onClick=${() => { selectedJob.value = job.id; }}>${job.company}${job.role ? ` · ${job.role}` : ""}</button>`)}</div>` : null}
        <div class="agent-board jobs-board">${lanes.board.map((lane) => html`<${Lane} key=${lane.stage} stage=${lane.stage} list=${lane.list} />`)}</div>
        <${Closed} groups=${lanes.closed} />`}
    `}
    <${JobSheet} />
    <${QuickAdd} />
  </div>`;
}

// Today's rail card: this week's pace, follow-ups, interviews, and emails to check.
export function JobsCard() {
  useEffect(() => {
    if (!jobs.value) loadJobs();
  }, []);
  const data = jobs.value;
  if (!data) return null;
  const { metrics } = data;
  const interviews = data.jobs.filter((job) => ["screen", "interview", "offer"].includes(job.stage));
  const due = data.jobs.filter((job) => followUpIds.value.has(job.id)).slice(0, 3);
  return html`<section class="card jobs-card">
    <div class="row space-between"><span class="card-eyebrow">Job search</span><button type="button" class="link small" onClick=${() => navigate("jobs")}>Open</button></div>
    <div class="jobs-card-pace">
      <strong>${metrics.appliedThisWeek}<span class="muted">/${metrics.weeklyTarget}</span></strong>
      <span class="muted small">applied this week</span>
    </div>
    <${Bar} value=${metrics.weeklyTarget ? metrics.appliedThisWeek / metrics.weeklyTarget : 0} color=${metrics.appliedThisWeek >= metrics.weeklyTarget ? "var(--good)" : "var(--accent)"} />
    ${interviews.length ? html`<div class="jobs-card-list">${interviews.slice(0, 3).map((job) => html`<button type="button" class="jobs-card-row" onClick=${() => { navigate("jobs"); selectedJob.value = job.id; }}>
      <span class=${`pill stage-pill stage-${job.stage}`}>${STAGE_LABELS[job.stage]}</span><span>${job.company}</span>
    </button>`)}</div>` : null}
    ${due.length ? html`<div class="jobs-card-list">
      <span class="warn small">Follow up</span>
      ${due.map((job) => html`<div class="jobs-card-row">
        <button type="button" class="link" onClick=${() => { navigate("jobs"); selectedJob.value = job.id; }}>${job.company}</button>
        <span class="muted small">${ago(job.appliedAt)}</span>
        <button type="button" class="link small" onClick=${() => jobAction("event", { id: job.id, kind: "followed_up" }, "Logged your follow-up")}>Done</button>
      </div>`)}
    </div>` : null}
    ${data.reviews.length ? html`<button type="button" class="link small" onClick=${() => navigate("jobs")}>${data.reviews.length} email${data.reviews.length === 1 ? "" : "s"} to check</button>` : null}
    <${Button} size="sm" icon="plus" onClick=${() => { navigate("jobs"); openQuickAdd(); }}>Log an application</${Button}>
  </section>`;
}

export function logApplication() {
  navigate("jobs");
  openQuickAdd();
}
