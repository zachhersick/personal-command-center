// Thin fetch wrapper. Every write is JSON, which also keeps the plan API's
// CSRF guard happy (cross-site pages can't send JSON without a preflight).

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function api(path, { method = "GET", body, signal } = {}) {
  const init = { method, signal, headers: {} };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(path, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new ApiError(data.error || data.note || `${response.status} ${response.statusText}`, response.status);
  return data;
}

export const get = (path, options) => api(path, options);
export const post = (path, body = {}) => api(path, { method: "POST", body });
