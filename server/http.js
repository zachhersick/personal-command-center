// Shared request guards for state-changing routes. Writes must be JSON (which a
// cross-site page can't send without a CORS preflight) and must come from a
// loopback Host header (which blocks DNS rebinding).

const BODY_LIMIT = 1_000_000;

export function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// The media type itself must be JSON. A header that only mentions it, such as
// "text/plain; x=application/json", is still text/plain to a browser, which
// sends it cross-site without a preflight.
export function isJsonType(header = "") {
  return String(header).split(";")[0].trim().toLowerCase() === "application/json";
}

// A browser names the page that sent a write. Only the page this server
// served may write; a page on another site or another local port may not.
// Tools that aren't browsers send neither header and are let through.
export function isCrossSite(req) {
  if (String(req.headers["sec-fetch-site"] || "").toLowerCase() === "cross-site") return true;
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  try {
    return new URL(origin).host.toLowerCase() !== String(req.headers.host || "").toLowerCase();
  } catch {
    return true;
  }
}

export async function readJsonBody(req, { limit = BODY_LIMIT } = {}) {
  if (!isJsonType(req.headers["content-type"])) throw httpError(415, "Send JSON with content-type application/json.");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw httpError(413, "Request body is too large.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch {
    throw httpError(400, "Request body is not valid JSON.");
  }
}

export function isLocalHost(hostHeader = "") {
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(hostHeader));
}
