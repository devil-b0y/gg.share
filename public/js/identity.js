// Client-side identity: an Ed25519 keypair generated in the browser and
// kept only in localStorage. It never leaves the device -- every signed
// action sends the public key + a signature, never the private key.
//
// Prefers the browser's native WebCrypto Ed25519 support (Chrome 137+,
// Firefox 130+, Safari 17+). Where that's unavailable, falls back to the
// vendored pure-JS @noble/ed25519 implementation.
import * as nobleEd from './vendor/noble-ed25519.js';

const STORAGE_KEY = 'anon-share.identity.v1';

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
 * bytes match exactly. Keep in sync with server/lib/crypto.js. */
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
        this._rawPrivate = Uint8Array.from(
          atob(data.jwkPrivate.d.replace(/-/g, '+').replace(/_/g, '/')),
          (c) => c.charCodeAt(0)
        );
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
      return 'anonkey1:' + btoa(JSON.stringify({ mode: 'native', jwk }));
    }
    return 'anonkey1:' + btoa(JSON.stringify({ mode: 'noble', privateHex: toHex(this._rawPrivate) }));
  }

  async importRecovery(str) {
    if (!str.startsWith('anonkey1:')) throw new Error('Not a recognized recovery string');
    const data = JSON.parse(atob(str.slice('anonkey1:'.length)));
    if (data.mode ===