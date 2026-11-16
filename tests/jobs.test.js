import test from "node:test";
import assert from "node:assert/strict";
import { addJobEvent, advanceStage, deleteJob, followUpsDue, isGhosted, jobId, jobMetrics, mergeJobs, upsertJob } from "../server/jobs/model.js";
import { classifyMail, gmailSearchQuery } from "../server/jobs/mail-rules.js";
import { bookmarkletSource, parseJobLink } from "../server/jobs/links.js";
import { importLegacyJobs, legacyCandidates } from "../server/jobs/legacy-import.js";
import { ensurePlanState, mergePlanState } from "../server/plan/state.js";

const NOW = "2026-10-19T17:00:00.000Z";
const daysAgo = (days) => new Date(Date.parse(NOW) - days * 86_400_000).toISOString();

test("job ids ignore legal suffixes, case and req numbers", () => {
  assert.equal(jobId("Acme, Inc.", "Software Engineer (Remote)"), jobId("acme", "software engineer"));
  assert.equal(jobId("The Acme Corporation", "Software Engineer - Req ID 123456"), jobId("Acme", "Software Engineer"));
  assert.notEqual(jobId("Acme", "Software Engineer"), jobId("Acme", "Data Engineer"));
});

test("automatic stage changes only move forward", () => {
  assert.equal(advanceStage("interview", "applied"), "interview");
  assert.equal(advanceStage("applied", "assessment"), "assessment");
  assert.equal(advanceStage("interview", "rejected"), "rejected");
  assert.equal(advanceStage("offer", "rejected"), "offer");
  assert.equal(advanceStage("rejected", "interview"), "rejected");
  assert.equal(advanceStage("withdrawn", "offer"), "withdrawn");
});

test("adding the same job twice fills gaps instead of duplicating", () => {
  let plan = ensurePlanState({});
  ({ plan } = upsertJob(plan, { company: "Acme", role: "Backend Engineer", source: "linkedin" }, NOW));
  const { plan: next, result } = upsertJob(plan, { company: "ACME Inc", role: "Backend Engineer", url: "https://jobs.lever.co/acme/1", source: "bookmark" }, NOW);
  assert.equal(next.jobs.length, 1);
  assert.equal(result.created, false);
  assert.equal(next.jobs[0].url, "https://jobs.lever.co/acme/1");
  assert.equal(next.jobs[0].source, "linkedin", "existing fields are kept");
  assert.throws(() => upsertJob(plan, { role: "x" }, NOW), /company/);
  assert.throws(() => upsertJob(plan, { company: "x", url: "javascript:alert(1)" }, NOW), /url/);
});

test("a manual stage change is recorded on the timeline", () => {
  let plan = ensurePlanState({});
  ({ plan } = upsertJob(plan, { company: "Acme", role: "SWE" }, NOW));
  const id = plan.jobs[0].id;
  ({ plan } = upsertJob(plan, { id, stage: "interview" }, NOW));
  assert.equal(plan.jobs[0].stage, "interview");
  assert.ok(plan.jobs[0].events.some((event) => event.kind === "stage" && event.stage === "interview"));
  ({ plan } = addJobEvent(plan, { id, kind: "followed_up" }, NOW));
  assert.ok(plan.jobs[0].events.some((event) => event.kind === "followed_up"));
  ({ plan } = deleteJob(plan, { id }, NOW));
  assert.equal(plan.jobs[0].deleted, true);
});

test("merging jobs keeps the newer fields and every event", () => {
  const base = { id: "job:1", company: "Acme", role: "SWE", stage: "applied", events: [{ id: "e1", at: daysAgo(10), kind: "applied" }], updatedAt: daysAgo(10) };
  const pc = { ...base, stage: "assessment", events: [...base.events, { id: "e2", at: daysAgo(2), kind: "assessment", messageId: "<m2>" }], updatedAt: daysAgo(2) };
  const phone = { ...base, notes: "Recruiter is Sam", events: [...base.events, { id: "e3", at: daysAgo(1), kind: "note" }], updatedAt: daysAgo(1) };
  const [merged] = mergeJobs([pc], [phone]);
  assert.equal(merged.notes, "Recruiter is Sam");
  assert.deepEqual(merged.events.map((event) => event.id), ["e1", "e2", "e3"]);
  const plan = mergePlanState({ jobs: [pc] }, { jobs: [phone] });
  assert.equal(plan.jobs.length, 1);
  assert.equal(plan.jobs[0].events.length, 3);
  assert.deepEqual(mergePlanState({ records: {} }, { records: {} }).jobs, [], "older plans without jobs merge cleanly");
});

test("follow-ups, ghosting and the cohort rule", () => {
  const job = (days, extra = {}) => ({ id: `job:${days}:${Math.random()}`, company: "C", role: "R", stage: "applied", appliedAt: daysAgo(days), lastActivityAt: daysAgo(days), events: [], ...extra });
  const jobs = [job(3), job(20), job(20, { events: [{ id: "f", at: daysAgo(5), kind: "followed_up" }] }), job(60), job(20, { stage: "interview" })];
  const due = followUpsDue(jobs, NOW);
  assert.equal(due.length, 1, "only the 20-day job with no follow-up and no reply");
  assert.equal(isGhosted(job(31), NOW), true);
  assert.equal(isGhosted(job(10), NOW), false);

  const cohort = Array.from({ length: 31 }, (_, index) => job(40 + index, index === 0 ? { stage: "screen" } : {}));
  const metrics = jobMetrics([...cohort, job(0)], { now: NOW, weekStart: "2026-10-19", toDateKey: (iso) => iso.slice(0, 10), weeklyTarget: 10 });
  assert.equal(metrics.appliedThisWeek, 1);
  assert.equal(metrics.cohort.screens, 0, "the screened job falls in the second, incomplete cohort");
  assert.equal(metrics.cohort.needsReview, true);
  assert.equal(metrics.active, 1);

  // Imported records never tracked replies: no follow-ups, no effect on the rates.
  const imported = Array.from({ length: 30 }, (_, index) => job(20 + index, { events: [{ id: `i${index}`, at: daysAgo(20 + index), kind: "imported" }] }));
  assert.equal(followUpsDue(imported, NOW).length, 10, "only the ones still inside the 14–30 day window");
  const importedMetrics = jobMetrics(imported, { now: NOW, weekStart: "2026-10-19", toDateKey: (iso) => iso.slice(0, 10) });
  assert.equal(importedMetrics.responseRate, null);
  assert.equal(importedMetrics.cohort, null);
  assert.equal(followUpsDue([job(35)], NOW).length, 0, "ghosted jobs aren't follow-ups");
});

const mail = (from, subject, text = "") => classifyMail({ from, subject, text });

test("LinkedIn confirmations, views and updates", () => {
  const sent = mail("LinkedIn <jobs-noreply@linkedin.com>", "Zach, your application was sent to Acme Robotics", "Your application was sent to Acme Robotics\n\nBackend Software Engineer\nAcme Robotics · Springfield, CA (On-site)\nApplied on October 18");
  assert.deepEqual([sent.kind, sent.company, sent.role], ["applied", "Acme Robotics", "Backend Software Engineer"]);
  assert.ok(sent.confidence > 0.9);
  assert.equal(mail("LinkedIn <jobs-noreply@linkedin.com>", "Your application was viewed by Acme Robotics").kind, "viewed");
  const update = mail("LinkedIn <jobs-noreply@linkedin.com>", "Your update from Acme Robotics", "Unfortunately, we will not be moving forward with your application.");
  assert.deepEqual([update.kind, update.company], ["rejected", "Acme Robotics"]);
  assert.equal(mail("LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>", "30+ new jobs for software engineer").kind, null);
});

test("application systems: confirmation, rejection, assessment, interview, offer", () => {
  const greenhouse = mail("Fabrikam <no-reply@us.greenhouse-mail.io>", "Thank you for applying to Fabrikam!", "Thanks for applying for the Software Engineer (Agent Platform) role at Fabrikam.");
  assert.deepEqual([greenhouse.kind, greenhouse.company], ["applied", "Fabrikam"]);
  assert.ok(greenhouse.confidence >= 0.9);
  const lever = mail("Northwind <no-reply@hire.lever.co>", "Your application to Northwind", "Thank you for your interest. Unfortunately we have decided to move forward with other candidates.");
  assert.deepEqual([lever.kind, lever.company], ["rejected", "Northwind"]);
  const workday = mail("contoso@myworkday.com", "Thank you for applying", "We have received your application for the position of Associate Software Engineer.");
  assert.equal(workday.kind, "applied");
  assert.equal(workday.company, "Contoso");
  const assessment = mail("HackerRank <support@hackerrank.com>", "Tailspin has invited you to take a coding challenge", "Complete the assessment within 7 days.");
  assert.deepEqual([assessment.kind, assessment.company], ["assessment", "Tailspin"]);
  const codesignal = mail("CodeSignal <noreply@codesignal.com>", "Your General Coding Assessment", "Hi Zach,\nAcme Robotics has invited you to take a CodeSignal assessment.");
  assert.deepEqual([codesignal.kind, codesignal.company], ["assessment", "Acme Robotics"]);
  assert.equal(mail("HackerRank <support@hackerrank.com>", "Practice makes perfect", "Complete the assessment").company, "", "never the platform's own name");
  const interview = mail("Jordan at Woodgrove <jordan@woodgrove.com>", "Next steps with Woodgrove", "We'd love to schedule a technical interview. Please share your availability here: https://calendly.com/x");
  assert.deepEqual([interview.kind, interview.company], ["interview", "Woodgrove"]);
  const screen = mail("Acme Recruiting <talent@acme.com>", "Acme application update", "Would you be open to a 30-minute call with our recruiter? This is an initial phone screen.");
  assert.equal(screen.kind, "screen");
  assert.equal(mail("Acme <no-reply@ashbyhq.com>", "Offer letter from Acme", "We are pleased to extend an offer").kind, "offer");
});

test("newsletters and job boards are ignored", () => {
  assert.equal(mail("Runway <hello@tower.joinrunway.io>", "Adatum just posted a role you'd be great for", "93% match").kind, null);
  assert.equal(mail("Pat <pat@hellointerview.com>", "Prepare for your interview on your commute").kind, null);
  assert.equal(mail("TLDR <editor@tldrnewsletter.com>", "Meta Wonder, interview tips").kind, null);
  assert.match(gmailSearchQuery(120), /^newer_than:120d .*\{from:linkedin\.com .*"thank you for applying"/);
});

test("job links fill in company, role and source", () => {
  const linkedin = parseJobLink("https://www.linkedin.com/jobs/view/4012345678/?trk=abc", "Backend Engineer | Acme Robotics | LinkedIn");
  assert.deepEqual([linkedin.source, linkedin.company, linkedin.role, linkedin.url], ["linkedin", "Acme Robotics", "Backend Engineer", "https://www.linkedin.com/jobs/view/4012345678/"]);
  const hiring = parseJobLink("https://www.linkedin.com/jobs/collections/recommended/?currentJobId=4012345678", "Acme hiring Software Engineer in Springfield, CA | LinkedIn");
  assert.deepEqual([hiring.company, hiring.role, hiring.location], ["Acme", "Software Engineer", "Springfield, CA"]);
  assert.equal(parseJobLink("https://job-boards.greenhouse.io/fabrikam/jobs/123", "Job Application for Software Engineer at Fabrikam").company, "Fabrikam");
  assert.deepEqual(Object.values(parseJobLink("https://jobs.lever.co/northwind/abc", "Northwind - Founding Engineer")).slice(1, 3), ["Northwind", "Founding Engineer"]);
  assert.equal(parseJobLink("https://jobs.ashbyhq.com/fabrikam/abc", "Software Engineer @ Fabrikam").role, "Software Engineer");
  const workday = parseJobLink("https://contoso.wd1.myworkdayjobs.com/en-US/Contoso_External_Site/job/Springfield-CA/Associate-Software-Engineer_R10012345", "");
  assert.deepEqual([workday.company, workday.role, workday.location], ["Contoso", "Associate Software Engineer", "Springfield CA"]);
  assert.equal(parseJobLink("https://app.joinrunway.io/explore/job/abc", "Software Engineer at Adatum | Runway").company, "Adatum");
  assert.equal(parseJobLink("not a url", "Engineer at Acme").company, "Acme");
  const bookmark = bookmarkletSource("https://jarvis.example.com/");
  assert.ok(bookmark.startsWith("javascript:"));
  assert.ok(bookmark.includes('"https://jarvis.example.com/#jobs?add=1"'));
});

test("the old Jarvis data imports once without duplicates", () => {
  const sources = {
    board: { jobs: [
      { company: "Fabrikam", title: "Software Engineer", applicationUrl: "https://jobs.ashbyhq.com/fabrikam/1?utm_source=x", applied: true, appliedDate: "2026-07-20" },
      { company: "Fabrikam", title: "Software Engineer", applicationUrl: "https://jobs.ashbyhq.com/fabrikam/1", applied: true },
      { company: "Skipped Co", title: "Not applied", applied: false }
    ] },
    runway: { jobs: [
      { company: "Adatum", title: "SWE New Grad", runwayUrl: "https://app.joinrunway.io/explore/job/9", applicationUrl: "", applied: true, appliedDate: "2026-08-01" },
      { company: "Fabrikam, Inc.", title: "Software Engineer", applicationUrl: "", applied: true, appliedDate: "2026-07-15" }
    ] },
    runtime: {
      jobApplications: { a1: { task: { company: "Acme", jobTitle: "Backend Engineer", applicationUrl: "https://acme.com/jobs/1" }, appliedDate: "2026-09-01" } },
      jobProgress: { a1: { stage: "Phone Screen" } }
    }
  };
  const rows = legacyCandidates(sources);
  assert.equal(rows.length, 3);
  const fabrikam = rows.find((row) => row.company === "Fabrikam");
  assert.equal(fabrikam.appliedAt, "2026-07-15T12:00:00.000Z", "earliest date wins");
  assert.equal(fabrikam.source, "runway");
  assert.equal(rows.find((row) => row.company === "Acme").stage, "screen");

  let plan = ensurePlanState({});
  ({ plan } = upsertJob(plan, { company: "Acme", role: "Backend Engineer", stage: "interview" }, NOW));
  const { plan: imported, result } = importLegacyJobs(plan, sources, NOW);
  assert.deepEqual(result, { added: 2, skipped: 1, withoutDate: 0 });
  assert.equal(imported.jobs.find((job) => job.company === "Acme").stage, "interview", "existing jobs are left alone");
  assert.ok(imported.legacyJobsImportedAt);
});
