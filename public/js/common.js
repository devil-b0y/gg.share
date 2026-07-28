// Shared helpers for feed.js and post.js.
import { identity } from './identity.js';
import { nicknameFromAddr } from './nickname.js';

export { nicknameFromAddr };

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body && !(opts.body instanceof FormData)
      ? { 'Content-Type': 'application/json' }
      : undefined,
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

export const signedAction = (payload) => identity.signPayload(payload);

export const nonce = () =>
  Math.random().toString(36).slice(2) + Date.now().toString(36);

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
export function toast(msg, ms = 2600) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = msg;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), ms);
}

export function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// Monochrome identicon: a deterministic 5x5 mirrored bitmap derived from the
// address, drawn in the current ink. Colour would break the black/grey/white
// scheme, so identity is carried by pattern instead of hue.
export function identicon(addr, size = 40) {
  let h = 2166136261;
  for (let i = 0; i < addr.length; i++) {
    h ^= addr.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const tone = 18 + (h % 26); // 18%–43% lightness ground, stays neutral
  let cells = '';
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      const bit = (h >>> ((y * 3 + x) % 30)) & 1;
      if (!bit) continue;
      cells += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
      if (x < 2) cells += `<rect x="${4 - x}" y="${y}" width="1" height="1"/>`;
    }
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="-0.6 -0.6 6.2 6.2" shape-rendering="crispEdges">` +
    `<rect x="-0.6" y="-0.6" width="6.2" height="6.2" fill="hsl(0 0% ${tone}%)"/>` +
    `<g fill="hsl(0 0% ${tone + 52}%)">${cells}</g></svg>`;
  return 'data:image/svg+xml;base64,' + btoa(svg);
}

export function setAvatar(el, addr) {
  if (!el) return;
  el.style.backgroundImage = `url("${identicon(addr)}")`;
  el.style.backgroundSize = 'cover';
}

export const icons = {
  heart: (filled) => `<svg class="ico" viewBox="0 0 24 24" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.8 8.6c0 4.6-8.8 10-8.8 10s-8.8-5.4-8.8-10a4.8 4.8 0 0 1 8.8-2.7 4.8 4.8 0 0 1 8.8 2.7z"/></svg>`,
  down: (filled) => `<svg class="ico" viewBox="0 0 24 24" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3h9.3a2 2 0 0 1 2 1.7l1.2 7.6a2 2 0 0 1-2 2.3H15l1 4.4a2.2 2.2 0 0 1-4.2 1.1L9 14.6H7z"/><path d="M3 3h4v11.6H3z"/></svg>`,
  comment: `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.5-.7L3 21l1.9-5.2A8.2 8.2 0 0 1 4 11.5a8.4 8.4 0 0 1 9-8.4 8.4 8.4 0 0 1 8 8.4z"/></svg>`,
  share: `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.6 13.4a4 4 0 0 0 6 .4l2.6-2.6a4 4 0 0 0-5.6-5.7l-1.5 1.5"/><path d="M13.4 10.6a4 4 0 0 0-6-.4L4.8 12.8a4 4 0 0 0 5.6 5.7l1.5-1.5"/></svg>`,
  flag: `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 21V4"/><path d="M5 4.5h11.5l-1.8 4 1.8 4H5z"/></svg>`
};

/* ---------------------------------------------------------- modals */

export function openModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.hidden = false;
  el.querySelector('input, textarea, button')?.focus({ preventScroll: true });
  document.body.style.overflow = 'hidden';
}

export function closeModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.hidden = true;
  document.body.style.overflow = '';
}

export function bindModals() {
  document.querySelectorAll('[data-close]').forEach((btn) =>
    btn.addEventListener('click', () => closeModal(btn.dataset.close)));

  document.querySelectorAll('.overlay').forEach((overlay) =>
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) closeModal(overlay.id);
    }));

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    document.querySelectorAll('.overlay:not([hidden])').forEach((o) => closeModal(o.id));
  });
}

/* -------------------------------------------------------- identity */

export async function initIdentity() {
  await identity.ready;
  const nick = nicknameFromAddr(identity.addr);

  for (const id of ['myNick', 'myNickSm']) {
    const el = document.getElementById(id);
    if (el) el.textContent = nick;
  }
  for (const id of ['myAvatar', 'myAvatarSm']) setAvatar(document.getElementById(id), identity.addr);
  const full = document.getElementById('myAddrFull');
  if (full) full.textContent = identity.addr;

  const open = () => {
    const n = document.getElementById('idNick');
    const a = document.getElementById('idAddr');
    if (n) n.value = nick;
    if (a) a.value = identity.addr;
    openModal('identityModal');
  };
  document.getElementById('idCard')?.addEventListener('click', open);
  document.getElementById('chipIdentity')?.addEventListener('click', open);
  document.getElementById('railIdentity')?.addEventListener('click', (e) => { e.preventDefault(); open(); });

  const msg = document.getElementById('identityMsg');
  document.getElementById('exportKey')?.addEventListener('click', async () => {
    const key = await identity.exportRecovery();
    try {
      await navigator.clipboard.writeText(key);
      msg.textContent = 'Recovery key copied. Store it somewhere safe — anyone holding it can post as you.';
    } catch {
      msg.textContent = key;
    }
  });
  document.getElementById('importKey')?.addEventListener('click', async () => {
    const value = prompt('Paste your recovery key:');
    if (!value) return;
    try {
      await identity.importRecovery(value.trim());
      location.reload();
    } catch (e) {
      msg.textContent = `That key could not be read: ${e.message}`;
    }
  });

  return identity.addr;
}

/* ------------------------------------------------------------ misc */

export function skeleton(count = 3) {
  return Array.from({ length: count }, () => `
    <div class="skeleton">
      <div class="sk-head">
        <div class="sk-bone circle sk-shimmer" style="width:30px;height:30px"></div>
        <div style="flex:1">
          <div class="sk-bone sk-shimmer" style="width:110px;height:10px;margin-bottom:6px"></div>
          <div class="sk-bone sk-shimmer" style="width:60px;height:8px"></div>
        </div>
      </div>
      <div class="sk-bone sk-shimmer" style="height:300px;border-radius:0"></div>
      <div style="padding:12px 13px">
        <div class="sk-bone sk-shimmer" style="width:70%;height:10px"></div>
      </div>
    </div>`).join('');
}

export function sharePost(postId) {
  const url = `${location.origin}/post.html?id=${postId}`;
  if (navigator.share) {
    navigator.share({ url, title: 'gg.share' }).catch(() => {});
    return;
  }
  navigator.clipboard.writeText(url).then(
    () => toast('Link copied'),
    () => toast(url)
  );
}
