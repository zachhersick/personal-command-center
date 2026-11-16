// Reads company, role and source from a job page's URL and title, so the
// "I applied" bookmark and Quick add can fill in the form. Pure; the UI reaches
// it through GET /api/jobs/parse-link.

function titleCaseSlug(slug) {
  return String(slug || "")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => (part.length <= 3 && /\d/.test(part) ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)))
    .join(" ");
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").replace(/^[\s|·•-]+|[\s|·•-]+$/g, "").trim();
}

function splitTitle(title) {
  return String(title || "").split(/\s+[|–—]\s+|\s+-\s+/).map(clean).filter(Boolean);
}

function safeUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return /^https?:$/.test(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

export function parseJobLink(rawUrl, rawTitle = "") {
  const url = safeUrl(rawUrl);
  const title = clean(rawTitle).replace(/^\(\d+\)\s*/, "");
  const out = { url: url ? url.toString() : "", company: "", role: "", location: "", source: "bookmark" };
  if (!url) return { ...out, ...fromTitle(title) };
  const host = url.hostname.replace(/^www\./, "");
  const path = url.pathname.split("/").filter(Boolean);

  if (host.endsWith("linkedin.com")) {
    out.source = "linkedin";
    const id = path[0] === "jobs" && path[1] === "view" ? path[2]?.match(/(\d{6,})/)?.[1] : url.searchParams.get("currentJobId");
    if (id) out.url = `https://www.linkedin.com/jobs/view/${id}/`;
    // "Role | Company | LinkedIn" or "Company hiring Role in Location | LinkedIn"
    const hiring = title.match(/^(.+?) hiring (.+?)(?: in (.+?))? \| LinkedIn$/i);
    if (hiring) return { ...out, company: clean(hiring[1]), role: clean(hiring[2]), location: clean(hiring[3]) };
    const parts = splitTitle(title).filter((part) => !/^linkedin$/i.test(part));
    if (parts.length >= 2 && !/top job picks|jobs? (search|for you)|recommended/i.test(title)) return { ...out, role: parts[0], company: parts[1] };
    return out;
  }

  if (host.endsWith("joinrunway.io")) {
    out.source = "runway";
    const match = title.match(/^(.+?) (?:at|@) (.+?)(?: [|–-] Runway.*)?$/i);
    if (match) return { ...out, role: clean(match[1]), company: clean(match[2]) };
    return { ...out, ...fromTitle(title.replace(/\s*[|–-]\s*Runway.*$/i, "")) };
  }

  if (host.endsWith("greenhouse.io")) {
    out.source = "ats";
    const slug = path[0] === "embed" ? url.searchParams.get("for") : path[0];
    const match = title.match(/^Job Application for (.+?) at (.+)$/i);
    if (match) return { ...out, role: clean(match[1]), company: clean(match[2]) };
    return { ...out, company: titleCaseSlug(slug), ...roleOnly(title) };
  }

  if (host === "jobs.lever.co") {
    out.source = "ats";
    const parts = splitTitle(title);
    if (parts.length >= 2) return { ...out, company: parts[0], role: parts.slice(1).join(" - ") };
    return { ...out, company: titleCaseSlug(path[0]), ...roleOnly(title) };
  }

  if (host === "jobs.ashbyhq.com") {
    out.source = "ats";
    const at = title.match(/^(.+?) @ (.+)$/);
    if (at) return { ...out, role: clean(at[1]), company: clean(at[2]) };
    const parts = splitTitle(title);
    if (parts.length >= 2) return { ...out, role: parts[0], company: parts[1] };
    return { ...out, company: titleCaseSlug(path[0]), ...roleOnly(title) };
  }

  if (host.endsWith("myworkdayjobs.com")) {
    out.source = "ats";
    const tenant = host.split(".")[0];
    const jobIndex = path.indexOf("job");
    const slug = jobIndex >= 0 ? path[path.length - 1] : "";
    const role = clean(title) || titleCaseSlug(String(slug).replace(/_[A-Z]*-?\d+.*$/i, ""));
    return { ...out, company: titleCaseSlug(tenant), role, location: jobIndex >= 0 && path[jobIndex + 1] !== slug ? titleCaseSlug(path[jobIndex + 1]) : "" };
  }

  if (host === "jobs.smartrecruiters.com") {
    out.source = "ats";
    const role = titleCaseSlug(String(path[1] || "").replace(/^\d+-/, ""));
    return { ...out, company: titleCaseSlug(path[0]), role: clean(title.split(/\s+[|–-]\s+/)[0]) || role };
  }

  return { ...out, ...fromTitle(title), company: fromTitle(title).company || titleCaseSlug(host.split(".").slice(-2, -1)[0]) };
}

function roleOnly(title) {
  const parts = splitTitle(title);
  return { role: parts[0] || "" };
}

// Generic page titles: "Role at Company", "Role - Company", "Company | Role".
function fromTitle(title) {
  const at = title.match(/^(.+?) (?:at|@) (.+?)(?: [|–-] .+)?$/i);
  if (at) return { role: clean(at[1]), company: clean(at[2]) };
  const parts = splitTitle(title);
  if (parts.length >= 2) return { role: parts[0], company: parts[1] };
  return { role: parts[0] || "", company: "" };
}

// The bookmark: a javascript: link that opens Jarvis's Quick add with this
// page's URL and title. It only reads location and document.title. iPhone
// Safari may block the new tab, so it falls back to opening Jarvis in place.
export function bookmarkletSource(appUrl) {
  const base = String(appUrl || "").replace(/\/+$/, "");
  return `javascript:(()=>{const u=${JSON.stringify(`${base}/#jobs?add=1`)}+'&url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title);if(!window.open(u,'_blank'))location.href=u})()`;
}
