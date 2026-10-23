// Client-side identity: an Ed25519 keypair generated in the browser and
// kept only in localStorage. It never leaves the device -- every signed
// action sends the public key + a signature, never the private key.
//
// Prefers the browser's native WebCrypto Ed25519 support (Chrome 137+,
// Firefox 130+, Safari 17+). Where that's unavailable, falls back to the
// pure-JS @noble/ed25519 implementation.
//
// Browser-only: everything here touches localStorage or WebCrypto, so it is
// only ever reached from client components, after mount (see
// components/identity/IdentityProvider.jsx).
import * as nobleEd from '@noble/ed25519';

const STORAGE_KEY = 'anon-share.identity.v1';
const RECOVERY_PREFIX = 'anonkey1:';

function toHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function utf8(str) {
  return new TextEncoder().encode(str);
}
function fromBase64Url(b64url) {
  return Uint8Array.from(atob(b64url.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
}

async function detectNativeEd25519() {
  if (!window.crypto?.subtle?.generateKey) return false;
  try {
    const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    await crypto.subtle.sign('Ed25519', kp.privateKey, utf8('probe'));
    return true;
  } catch {
    return false;
  }
}

/** Same deterministic canonical-JSON stringify as the server, so signed
 * bytes match exactly. Keep in sync with lib/server/security/crypto.js. */
function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(',')}}`;
}

async function deriveAddress(pubkeyHex) {
  const digest = await crypto.subtle.digest('SHA-256', fromHex(pubkeyHex));
  return 'anon:' + base32(new Uint8Array(digest)).slice(0, 16).toLowerCase();
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

class Identity {
  constructor() {
    this.ready = this._init();
  }

  async _init() {
    const nativeAvailable = await detectNativeEd25519();
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const data = JSON.parse(saved);
      this.pubkeyHex = data.pubkeyHex;
      this.addr = data.addr;

      // Which path to use must follow the format the key was actually saved
      // in, not live feature detection -- a browser can gain or lose native
      // Ed25519 support between visits (updates, flags, a copied
      // localStorage). Deciding by feature-detection alone left `useNative`
      // and the loaded key material out of sync in either direction, which
      // made signPayload() crash: crypto.subtle.sign() on an undefined key,
      // or fromHex(undefined) reading a field that was never saved.
      if (data.jwkPrivate && nativeAvailable) {
        this._nativePrivateKey = await crypto.subtle.importKey(
          'jwk', data.jwkPrivate, { name: 'Ed25519' }, true, ['sign']
        );
        this.useNative = true;
      } else if (data.privateHex) {
        this._rawPrivate = fromHex(data.privateHex);
        this.useNative = false;
      } else if (data.jwkPrivate) {
        // Saved by a browser with native support; this one doesn't have it.
        // The JWK's 'd' field is the raw 32-byte seed -- the same format
        // noble expects -- so the identity can still be recovered here.
        this._rawPrivate = fromBase64Url(data.jwkPrivate.d);
        this.useNative = false;
      } else {
        throw new Error('Stored identity is missing its key material');
      }
      return;
    }
    this.useNative = nativeAvailable;
    await this._generate();
  }

  async _generate() {
    if (this.useNative) {
      const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
      const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
      const jwkPrivate = await crypto.subtle.exportKey('jwk', kp.privateKey);
      this.pubkeyHex = toHex(rawPub);
      this._nativePrivateKey = kp.privateKey;
      this.addr = await deriveAddress(this.pubkeyHex);
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ pubkeyHex: this.pubkeyHex, addr: this.addr, jwkPrivate }));
    } else {
      const secretKey = nobleEd.utils.randomSecretKey();
      const pub = await nobleEd.getPublicKeyAsync(secretKey);
      this.pubkeyHex = toHex(pub);
      this._rawPrivate = secretKey;
      this.addr = await deriveAddress(this.pubkeyHex);
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        pubkeyHex: this.pubkeyHex, addr: this.addr, privateHex: toHex(secretKey)
      }));
    }
  }

  /** Signs `payload` (plain object) and returns the envelope the server
   * expects: { addr, pubkey, signature, payload }. */
  async signPayload(payload) {
    await this.ready;
    const message = utf8(canonicalJSON(payload));
    let sigBytes;
    if (this.useNative) {
      sigBytes = new Uint8Array(await crypto.subtle.sign('Ed25519', this._nativePrivateKey, message));
    } else {
      sigBytes = await nobleEd.signAsync(message, this._rawPrivate);
    }
    return { addr: this.addr, pubkey: this.pubkeyHex, signature: toHex(sigBytes), payload };
  }

  /** Exports a recovery string the user can save and re-import on another
   * device/browser. Contains the raw private key material -- treat it like
   * a password. */
  async exportRecovery() {
    await this.ready;
    if (this.useNative) {
      const jwk = await crypto.subtle.exportKey('jwk', this._nativePrivateKey);
      return RECOVERY_PREFIX + btoa(JSON.stringify({ mode: 'native', jwk }));
    }
    return RECOVERY_PREFIX + btoa(JSON.stringify({ mode: 'noble', privateHex: toHex(this._rawPrivate) }));
  }

  /**
   * Replaces this browser's identity with one from a recovery string made by
   * exportRecovery() -- on this device or another. Both formats are accepted
   * whatever this browser supports: a native-mode key's JWK `d` field is the
   * same raw 32-byte seed noble uses, so _init() can load either.
   *
   * The key is checked before anything is overwritten: the public key it
   * derives must match the one the string claims, so a truncated or
   * hand-edited string can't replace a working identity with a broken one.
   */
  async importRecovery(str) {
    if (typeof str !== 'string' || !str.startsWith(RECOVERY_PREFIX)) {
      throw new Error('Not a recognized recovery string');
    }

    let data;
    try {
      data = JSON.parse(atob(str.slice(RECOVERY_PREFIX.length)));
    } catch {
      throw new Error('Recovery string is corrupted');
    }

    let record;
    let seed;
    if (data.mode === 'native' && data.jwk && typeof data.jwk.d === 'string' && typeof data.jwk.x === 'string') {
      seed = fromBase64Url(data.jwk.d);
      record = { pubkeyHex: toHex(fromBase64Url(data.jwk.x)), jwkPrivate: data.jwk };
    } else if (data.mode === 'noble' && /^[0-9a-f]{64}$/i.test(data.privateHex || '')) {
      seed = fromHex(data.privateHex.toLowerCase());
      record = { pubkeyHex: toHex(await nobleEd.getPublicKeyAsync(seed)), privateHex: data.privateHex.toLowerCase() };
    } else {
      throw new Error('Recovery string is missing its key material');
    }

    if (seed.length !== 32 || toHex(await nobleEd.getPublicKeyAsync(seed)) !== record.pubkeyHex) {
      throw new Error('Recovery key does not match its public key');
    }

    record.addr = await deriveAddress(record.pubkeyHex);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(record));

    // Reload from storage through the normal path, so the in-memory state is
    // exactly what a fresh page load would produce.
    this.ready = this._init();
    await this.ready;
  }
}

let instance = null;

/** The one Identity for this tab. Created lazily, on first use, because
 * construction reads localStorage and must not run during server render. */
export function getIdentity() {
  if (typeof window === 'undefined') throw new Error('identity is only available in the browser');
  if (!instance) instance = new Identity();
  return instance;
}
