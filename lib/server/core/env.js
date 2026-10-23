// Static configuration from environment variables (.env).
//
// Deliberately has no database dependency: server.js loads this before Next
// starts, to refuse a production boot with placeholder secrets before
// anything else runs. Admin-editable values (thresholds, limits) are a
// different thing and live in ./settings.js.
'use strict';

// Placeholders shipped in .env.example. Booting with either of these in a
// production environment is a hard error, not a warning: IP_SALT_SEED is the
// only thing standing between a stored iphash and the address it came from,
// and the whole IPv4 space can be enumerated against a known seed in
// minutes. A default seed means the "we never store IPs" guarantee is void.
const PLACEHOLDER_SEEDS = new Set(['change-me-too', 'dev-only-insecure-seed', '']);

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const IP_SALT_SEED = process.env.IP_SALT_SEED || 'dev-only-insecure-seed';

/**
 * Parses TRUST_PROXY into the value proxy-addr expects, using the same rules
 * Express's `trust proxy` setting did:
 *   unset / "false"  -> trust nothing (use the socket address)
 *   "true"           -> trust every hop (leftmost X-Forwarded-For entry)
 *   "1", "2", ...    -> trust that many hops from the right
 *   anything else    -> comma-separated IPs/CIDRs/names ("loopback", ...)
 *
 * The numeric case matters: passing the raw string "1" to Express treated it
 * as an IP address, not a hop count.
 */
function parseTrustProxy(raw) {
  const value = String(raw || '').trim();
  if (!value || /^false$/i.test(value)) return false;
  if (/^true$/i.test(value)) return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Startup gate, called from server.js before the server listens. */
function assertSecureConfig() {
  const problems = [];
  if (PLACEHOLDER_SEEDS.has(IP_SALT_SEED.trim())) {
    problems.push('IP_SALT_SEED is unset or still the example value. Generate one with: ' +
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  } else if (IP_SALT_SEED.length < 32) {
    problems.push('IP_SALT_SEED is shorter than 32 characters.');
  }

  if (!IS_PRODUCTION) {
    for (const p of problems) console.warn(`[config] WARNING: ${p}`);
    if (problems.length) console.warn('[config] These are fatal when running with `npm start`.');
    return;
  }

  if (!process.env.TRUST_PROXY) {
    // Not fatal, but worth saying plainly: behind a proxy without this,
    // every request looks like it came from the proxy, so all the per-IP
    // limits collapse into one shared bucket.
    console.warn('[config] WARNING: TRUST_PROXY is unset. If this server sits behind a reverse ' +
      'proxy, every client shares one rate-limit bucket and one iphash.');
  }

  if (problems.length) {
    throw new Error(`Refusing to start in production:\n  - ${problems.join('\n  - ')}`);
  }
}

module.exports = {
  PORT: parseInt(process.env.PORT, 10) || 3000,
  IP_SALT_SEED,
  IS_PRODUCTION,
  TRUST_PROXY: parseTrustProxy(process.env.TRUST_PROXY),
  FORCE_TFJS_CPU: /^true$/i.test(process.env.FORCE_TFJS_CPU || ''),
  parseTrustProxy,
  assertSecureConfig
};
