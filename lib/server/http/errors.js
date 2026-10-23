// HTTP error type and JSON response helpers shared by every route handler.
'use strict';

/**
 * An error that maps directly to an HTTP response. Throw it from anywhere
 * inside a handler (body parsing, multipart limits, validation) and the
 * route wrapper turns it into `{ error: message }` with this status, instead
 * of a logged 500.
 */
class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.extra = extra; // optional extra JSON fields, e.g. { postId }
  }
}

/** A JSON response. Every API response in this app goes through here. */
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers }
  });
}

/** `{ error }` JSON with the given status -- the API's one error shape. */
function errorJson(status, error, extra) {
  return json({ error, ...(extra || {}) }, status);
}

module.exports = { HttpError, json, errorJson };
