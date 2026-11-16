// Turns one email into a pipeline signal: "applied to X", "assessment from X",
// "rejected by X". Pure and conservative: anything unsure comes back with low
// confidence so it lands in the review queue instead of moving a job.

// Applicant tracking systems that send confirmations and updates for companies.
export const ATS_DOMAINS = [
  "greenhouse-mail.io", "greenhouse.io", "hire.lever.co", "lever.co", "ashbyhq.com", "myworkday.com", "workday.com",
  "smartrecruiters.com", "icims.com", "jobvite.com", "rippling.com", "rippling-ats.com", "wellfound.com", "workablemail.com",
  "workable.com", "bamboohr.com", "applytojob.com", "teamtailor.com", "teamtailor-mail.com", "recruitee.com", "breezy.hr",
  "paylocity.com", "ultipro.com", "ukg.com", "successfactors.com", "sap.com", "taleo.net", "oraclecloud.com", "eightfold.ai",
  "phenom.com", "avature.net", "dover.com", "gem.com", "pinpointhq.com", "trinethire.com", "jazzhr.com"
];
export const ASSESSMENT_DOMAINS = ["hackerrank.com", "codesignal.com", "hirevue.com", "karat.com", "karat.io", "codility.com", "testgorilla.com", "coderpad.io", "byteboard.dev", "mettl.com", "imocha.io"];
export const SCHEDULING_DOMAINS = ["calendly.com", "goodtime.io", "modernloop.io", "gem.com", "prelude.co", "paradox.ai", "yello.co"];
// Job boards, digests and interview-prep newsletters: never a signal about an application.
export const NOISE_DOMAINS = [
  "joinrunway.io", "hellointerview.com", "leetcode.com", "neetcode.io", "interviewing.io", "pramp.com", "tryexponent.com",
  "glassdoor.com", "ziprecruiter.com", "joinhandshake.com", "simplify.jobs", "swelist.com", "builtin.com", "dice.com",
  "monster.com", "careerbuilder.com", "otta.com", "welcometothejungle.com", "github.com"
];
const NOISE_LINKEDIN = /^(jobalerts-noreply|jobs-listings|messages-noreply|notifications-noreply|invitations|news|editors-noreply|linkedin@e)/;
const GENERIC_MAIL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com"]);

export const AUTO_APPLY_CONFIDENCE = 0.65;

const REJECTION = /\b(unfortunately|regret to inform|not (be )?moving forward|will not be moving forward|won't be moving forward|decided (not )?to (move|proceed|pursue|go) (forward )?with (other|another)|other candidates (whose|who)|no longer (being )?considered|position has (been|now been) filled|not selected|not been selected|decided not to proceed|unable to (offer|move)|we (have|'ve) decided to pursue)\b/i;
const OFFER = /\b(pleased to (extend|offer)|offer letter|extend (you )?an offer|offer of employment|we('d| would) like to offer you)\b/i;
const SCREEN = /\b(phone screen|recruiter (call|screen|chat)|initial (call|conversation|chat|phone)|intro(ductory)? (call|chat)|quick (call|chat) to (learn|discuss)|30[- ]minute (call|chat))\b/i;
const INTERVIEW = /\b((schedule|book|set up|arrange)\b.{0,40}\b(interview|onsite|on-site|call|conversation|chat)|invite you to (an? )?(interview|onsite|virtual onsite|technical|final round|next round)|interview (invitation|confirmation|request|scheduled|details)|(technical|final|onsite|virtual) (interview|round)|next (round|step)s? (of|in) (the|our) (interview|hiring) process|share your availability|provide (your|some) availability)\b/i;
const ASSESSMENT = /\b(online assessment|coding (challenge|assessment|test|exercise)|technical assessment|take[- ]home|skills assessment|complete (the|this|an?) (assessment|challenge|test))\b/i;
const CONFIRMATION = /\b(thanks?( you)? for (applying|your application|submitting your application|your interest in)|(we('ve| have) )?received your application|application (has been )?(received|submitted)|we('ve| have) got your application|successfully (applied|submitted)|your application (to|for|with) )/i;
const LINKEDIN_SENT = /your application was sent to (.+?)\s*$/i;
const LINKEDIN_VIEWED = /your application was viewed by (.+?)\s*$/i;
const LINKEDIN_UPDATE = /(?:your )?update from (.+?)\s*$/i;

export function parseAddress(from = "") {
  const text = String(from || "");
  const angle = text.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  const email = (angle ? angle[2] : text).trim().toLowerCase();
  const name = angle ? angle[1].trim() : "";
  const domain = email.split("@")[1] || "";
  return { name, email, local: email.split("@")[0] || "", domain };
}

function domainIn(domain, list) {
  return list.some((entry) => domain === entry || domain.endsWith(`.${entry}`));
}

function cleanCompany(value) {
  return String(value || "")
    .replace(/[!.,;:]+$/g, "")
    .replace(/^(the\s+)?(team at|hiring team at|recruiting team at)\s+/i, "")
    .replace(/\s+(careers?|recruiting|recruitment|talent( acquisition)?( team)?|hiring( team)?|jobs|people( team| ops)?|hr|university recruiting|via greenhouse|via lever|via workday|no-?reply|notifications?)$/i, "")
    .replace(/\s+(careers?|recruiting|talent|hiring( team)?|team)$/i, "")
    .replace(/[“”"]/g, "")
    .trim()
    .slice(0, 120);
}

function titleCaseSlug(slug) {
  return String(slug || "")
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((part) => (part.length <= 3 && /\d/.test(part) ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)))
    .join(" ");
}

// Company name from the subject line, then the sender's display name, then the
// sender's own domain (only when it isn't a shared mail or ATS domain).
// Assessment and scheduling platforms send on a company's behalf, so their own
// name is never the company; it has to come from the subject or the body.
export function companyFrom({ subject = "", text = "", sender, platform = false }) {
  const invite = /^(.+?) (?:has )?(?:invited you|would like you to|is inviting you|wants you to)/i;
  for (const source of platform ? [subject, String(text).slice(0, 1500)] : [subject]) {
    const line = source.split(/\r?\n/).map((part) => part.trim()).find((part) => invite.test(part));
    const match = line?.match(invite);
    if (match?.[1] && match[1].split(" ").length <= 6) return { company: cleanCompany(match[1].replace(/^(hi|hello|hey)\b.*?[,!]\s*/i, "")), from: "subject" };
  }
  const patterns = [
    /(?:thanks?(?: you)?|thank you) for (?:applying|your application|your interest)(?: to| at| with| in)(?: the)? (.+?)(?:\s+[-–|]|[!.]|,| for | position| role|$)/i,
    /your application (?:to|at|with) (.+?)(?:\s+[-–|]|[!.]|,| for | has| was|$)/i,
    /application (?:for .+? )?(?:at|to|with) (.+?)(?:\s+[-–|]|[!.]|,|$)/i,
    /^(.+?) (?:application|job application|candidate)(?: (?:received|update|status|confirmation))?\s*$/i,
    /update (?:from|on your application (?:to|at|with)) (.+?)(?:[!.]|$)/i,
    /(?:interview|assessment|next steps?)(?: with| at| for) (.+?)(?:\s+[-–|]|[!.]|,| for |$)/i
  ];
  for (const pattern of patterns) {
    const match = subject.match(pattern);
    if (match?.[1]) {
      const company = cleanCompany(match[1]);
      if (company && company.length > 1 && !/^(your|our|the|this|a|an|us)$/i.test(company)) return { company, from: "subject" };
    }
  }
  if (platform) return { company: "", from: "" };
  const name = cleanCompany(sender.name);
  if (name && !/^(no-?reply|notifications?|workday|greenhouse|lever|ashby|smartrecruiters|icims|jobvite|careers|recruiting|talent|team|hr|linkedin)$/i.test(name) && !/@/.test(name)) {
    return { company: name, from: "sender" };
  }
  if (domainIn(sender.domain, ["myworkday.com"])) return { company: titleCaseSlug(sender.local), from: "domain" };
  if (sender.domain && !GENERIC_MAIL.has(sender.domain) && !domainIn(sender.domain, [...ATS_DOMAINS, ...ASSESSMENT_DOMAINS, ...SCHEDULING_DOMAINS])) {
    const parts = sender.domain.split(".");
    const base = parts.length > 2 && ["mail", "email", "e", "careers", "jobs", "talent", "hr", "recruiting", "notifications"].includes(parts[0]) ? parts[1] : parts[parts.length - 2];
    return { company: titleCaseSlug(base), from: "domain" };
  }
  return { company: "", from: "" };
}

export function roleFrom({ subject = "", text = "", company = "" }) {
  const sources = [subject, text.slice(0, 4000)];
  const patterns = [
    /application for (?:the )?(.{3,100}?) (?:position |role )?(?:at|with) /i,
    /(?:for|to) the (.{3,100}?) (?:position|role|opening|opportunity)\b/i,
    /(?:position|role) of (.{3,100}?)(?: at| with|[.,\n]|$)/i,
    /applying (?:for|to) (?:the )?(.{3,100}?) (?:position|role|opening|at|with)\b/i
  ];
  for (const source of sources) {
    for (const pattern of patterns) {
      const match = source.match(pattern);
      if (match?.[1]) {
        const role = match[1].replace(/[“”"]/g, "").replace(/\s+/g, " ").trim();
        if (role && role.toLowerCase() !== company.toLowerCase() && !/^(this|the|a|an|our|your)$/i.test(role)) return role.slice(0, 200);
      }
    }
  }
  return "";
}

// LinkedIn's confirmation lists the job title on the line above "Company · Location".
function linkedinRole(text, company) {
  if (!company) return "";
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const target = company.toLowerCase();
  for (let i = 1; i < Math.min(lines.length, 80); i += 1) {
    const line = lines[i].toLowerCase();
    if (line.startsWith(target) && /[·•|-]/.test(line.slice(target.length, target.length + 4))) {
      const candidate = lines[i - 1];
      if (candidate.length >= 3 && candidate.length <= 150 && !/application|linkedin|sent to|view job/i.test(candidate)) return candidate;
    }
  }
  return "";
}

function result(kind, company, role, confidence, reason) {
  return { kind, company: company || "", role: role || "", confidence, reason };
}

const NONE = (reason) => ({ kind: null, company: "", role: "", confidence: 0, reason });

export function classifyMail({ from = "", subject = "", text = "" } = {}) {
  const sender = parseAddress(from);
  const subj = String(subject || "").replace(/\s+/g, " ").trim();
  const body = String(text || "");
  const both = `${subj}\n${body.slice(0, 6000)}`;

  if (domainIn(sender.domain, NOISE_DOMAINS)) return NONE("job board or newsletter");

  if (domainIn(sender.domain, ["linkedin.com"])) {
    if (NOISE_LINKEDIN.test(sender.local)) return NONE("LinkedIn alert or message");
    let match = subj.match(LINKEDIN_SENT);
    if (match) {
      const company = cleanCompany(match[1]);
      return result("applied", company, linkedinRole(body, company), 0.95, "LinkedIn application sent");
    }
    match = subj.match(LINKEDIN_VIEWED);
    if (match) return result("viewed", cleanCompany(match[1]), "", 0.9, "LinkedIn application viewed");
    match = subj.match(LINKEDIN_UPDATE);
    if (match && REJECTION.test(body)) return result("rejected", cleanCompany(match[1]), roleFrom({ subject: subj, text: body }), 0.85, "LinkedIn update: not moving forward");
    if (match) return result(null, cleanCompany(match[1]), "", 0.4, "LinkedIn update from a company");
    return NONE("other LinkedIn mail");
  }

  const ats = domainIn(sender.domain, ATS_DOMAINS);
  const assessmentSender = domainIn(sender.domain, ASSESSMENT_DOMAINS);
  const scheduler = domainIn(sender.domain, SCHEDULING_DOMAINS) || /calendly\.com|goodtime\.io|modernloop\.io/i.test(body);
  const platform = assessmentSender || domainIn(sender.domain, SCHEDULING_DOMAINS);
  const { company, from: companySource } = companyFrom({ subject: subj, text: body, sender, platform });
  const role = roleFrom({ subject: subj, text: body, company });
  // Where the company name came from decides how much to trust it.
  const trust = companySource === "subject" ? 0.15 : companySource === "sender" ? 0.1 : 0;
  const base = ats ? 0.75 : 0.5;

  if (REJECTION.test(both) && (ats || CONFIRMATION.test(both) || /application|candidacy|position|role/i.test(both))) {
    return result("rejected", company, role, Math.min(0.95, base + trust), "rejection wording");
  }
  if (OFFER.test(both)) return result("offer", company, role, Math.min(0.9, base + trust), "offer wording");
  if (assessmentSender || ASSESSMENT.test(both)) {
    const confidence = assessmentSender ? 0.6 + trust : base + trust - 0.05;
    return result("assessment", company, role, Math.min(0.9, confidence), assessmentSender ? "assessment platform" : "assessment wording");
  }
  if (SCREEN.test(both)) return result("screen", company, role, Math.min(0.85, base + trust), "recruiter screen wording");
  if (scheduler || INTERVIEW.test(both)) {
    return result("interview", company, role, Math.min(0.85, base + trust - (scheduler && !INTERVIEW.test(both) ? 0.1 : 0)), scheduler ? "scheduling link" : "interview wording");
  }
  if (CONFIRMATION.test(both)) return result("applied", company, role, Math.min(0.95, base + trust + (ats ? 0.05 : 0)), ats ? "application system confirmation" : "confirmation wording");
  if (ats) return result(null, company, role, 0.3, "application system email without a clear status");
  return NONE("not about an application");
}

// The Gmail search that finds candidate messages. Classification still decides.
export function gmailSearchQuery(sinceDays) {
  // Gmail treats terms inside { } as alternatives.
  const senders = ["linkedin.com", ...ATS_DOMAINS, ...ASSESSMENT_DOMAINS, ...SCHEDULING_DOMAINS].map((domain) => `from:${domain}`);
  const phrases = ['"thank you for applying"', '"thanks for applying"', '"your application"', '"received your application"', "interview", "assessment", '"moving forward"', '"other candidates"', "unfortunately", '"offer letter"'];
  return `newer_than:${Math.max(1, Math.round(sinceDays))}d -in:chats -category:promotions {${[...senders, ...phrases].join(" ")}}`;
}
