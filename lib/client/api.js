// Thin fetch wrapper used by every component that talks to the API, plus the
// helpers for building signed actions.

/**
 * Calls the API and returns the parsed JSON. Non-2xx responses throw an
 * Error carrying the server's `{ error }` message and the HTTP `status`, so
 * callers can branch on e.g. 409 or 429.
 *
 * @param {string} path
 * @param {RequestInit} [opts] a string body is sent as JSON; FormData as multipart
 */
export async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: typeof opts.body === 'string' ? { 'Content-Type': 'application/json' } : undefined,
    ...opts
  });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** POSTs a JSON body. */
export function postJson(path, body) {
  return api(path, { method: 'POST', body: JSON.stringify(body) });
}

/**
 * A single-use value for a signed payload. The server burns each one (see
 * lib/server/security/replay.js), so a captured request can't be replayed.
 */
export function nonce() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Builds a fresh signed-action payload: the given fields plus `type`, the
 * current timestamp and a nonce, ready for identity.signPayload().
 */
export function actionPayload(type, fields = {}) {
  return { type, ...fields, ts: Date.now(), nonce: nonce() };
}
