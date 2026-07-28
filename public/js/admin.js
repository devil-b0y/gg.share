// Admin panel SPA. No build step -- just fetch + string templates, kept
// deliberately simple since this is a single-operator tool.
import { nicknameFromAddr } from './nickname.js';

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body && typeof opts.body === 'string' ? { 'Content-Type': 'application/json' } : undefined,
    credentials: 'same-origin',
    ...opts
  });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) throw new Error((data && data.error) || `request failed (${res.status})`);
  return data;
}

const loginScreen = document.getElementById('loginScreen');
const app = document.getElementById('app');
const viewEl = document.getElementById('view');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtTime(ts) {
  return ts ? new Date(ts).toLocaleString() : '—';
}
function badge(status) {
  return `<span class="badge ${status}">${status}</span>`;
}

async function checkSession() {
  const { authenticated } = await api('/api/admin/session');
  if (authenticated) {
    loginScreen.classList.add('hidden');
    app.classList.remove('hidden');
    navigate('dashboard');
  } else {
    loginScreen.classList.remove('hidden');
    app.classList.add('hidden');
  }
}

document.getElementById('loginBtn').addEventListener('click', async () => {
  const password = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  try {
    await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password }) });
    checkSession();
  } catch (e) {
    errEl.textContent = e.message;
  }
});
document.getElementById('loginPassword').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('loginBtn').click();
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST' });
  checkSession();
});

document.querySelectorAll('nav.side button[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => navigate(btn.dataset.view));
});

function setActiveNav(view) {
  document.querySelectorAll('nav.side button[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
}

async function navigate(view) {
  setActiveNav(view);
  viewEl.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const renderers = {
      dashboard, analytics,
      live: () => postsView('live'), review: () => postsView('review'), blacklist: () => postsView('blacklisted'), reports,
      reputation, bans,
      ledger, storage, security, audit, settings
    };
    await renderers[view]();
  } catch (e) {
    viewEl.innerHTML = `<p class="muted" style="color:var(--danger)">${esc(e.message)}</p>`;
  }
}

// --- dashboard --------------------------------------------------------
async function dashboard() {
  const d = await api('/api/admin/dashboard');
  const statuses = ['live', 'pending', 'review', 'blacklisted', 'removed'];
  viewEl.innerHTML = `
    <h2>Dashboard</h2>
    <div class="grid">
      <div class="stat"><div class="n">${d.totalPosts}</div><div class="l">Total posts</div></div>
      <div class="stat"><div class="n">${d.uploadsLast24h}</div><div class="l">Uploads (24h)</div></div>
      <div class="stat"><div class="n">${d.totalComments}</div><div class="l">Live comments</div></div>
      <div class="stat"><div class="n">${d.totalReports}</div><div class="l">Total reports</div></div>
      ${statuses.map((s) => `<div class="stat"><div class="n">${d.byStatus[s] || 0}</div><div class="l">${s}</div></div>`).join('')}
    </div>
  `;
}

// --- posts (live / review / blacklist share this) ----------------------
async function postsView(status) {
  const { posts } = await api(`/api/admin/posts?status=${status}`);
  const title = { live: 'Live posts', review: 'Review queue', blacklisted: 'Blacklist' }[status];
  viewEl.innerHTML = `<h2>${title}</h2>` + (posts.length === 0
    ? '<p class="muted">Nothing here.</p>'
    : `<table><thead><tr><th>Media</th><th>Addr</th><th>Type</th><th>NSFW scores</th><th>Reports</th><th>Created</th><th>Actions</th></tr></thead>
       <tbody>${posts.map((p) => postRow(p, status)).join('')}</tbody></table>`);
  wirePostActions();
}

function postRow(p, status) {
  const isText = p.kind === 'text';
  const scores = p.nsfw_scores
    ? `porn ${p.nsfw_scores.porn?.toFixed(2)} · hentai ${p.nsfw_scores.hentai?.toFixed(2)} · sexy ${p.nsfw_scores.sexy?.toFixed(2)}`
    : isText ? 'n/a (text)' : '—';
  const thumb = p.thumbUrl || p.mediaUrl;
  let media;
  if (isText) {
    media = `<div class="text-preview">${esc((p.body || '').slice(0, 140))}</div>`;
  } else if (p.mediaUrl) {
    media = p.media_type === 'video'
      ? `<video class="thumb" src="${esc(p.mediaUrl)}" muted></video>`
      : `<img class="thumb" src="${esc(thumb)}">`;
  } else {
    media = '<span class="muted">media purged</span>';
  }
  let actions = '';
  if (status === 'review') {
    actions = `<button class="btn p" data-approve="${p.id}">Approve</button><button class="btn d" data-blacklist="${p.id}">Blacklist</button>`;
  } else if (status === 'live') {
    actions = `<button class="btn d" data-remove="${p.id}">Remove</button><button class="btn d" data-blacklist="${p.id}">Blacklist</button>`;
  } else if (status === 'blacklisted') {
    actions = isText || p.mediaUrl
      ? `<button class="btn p" data-restore="${p.id}">Restore</button>${p.mediaUrl ? `<button class="btn d" data-purge="${p.id}">Purge permanently</button>` : ''}`
      : '<span class="muted">media purged</span>';
  }
  return `<tr>
    <td>${media}</td>
    <td><div>${esc(nicknameFromAddr(p.addr))}</div><div class="pill muted">${esc(p.addr)}</div></td>
    <td>${esc(isText ? 'text' : p.media_type)}</td>
    <td>${scores}</td>
    <td>${p.reportCount}</td>
    <td>${fmtTime(p.created_at)}</td>
    <td>${actions}</td>
  </tr>`;
}

function wirePostActions() {
  viewEl.querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', () => act(`posts/${b.dataset.approve}/approve`, 'review')));
  viewEl.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => act(`posts/${b.dataset.remove}/remove`, 'live')));
  viewEl.querySelectorAll('[data-blacklist]').forEach((b) => b.addEventListener('click', () => act(`posts/${b.dataset.blacklist}/blacklist`, currentStatusOf(b))));
  viewEl.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', () => act(`posts/${b.dataset.restore}/restore`, 'blacklisted')));
  viewEl.querySelectorAll('[data-purge]').forEach((b) => b.addEventListener('click', () => {
    if (confirm('Permanently delete this media? This cannot be undone.')) act(`posts/${b.dataset.purge}/purge`, 'blacklisted');
  }));
}
function currentStatusOf() {
  const active = document.querySelector('nav.side button.active');
  return { live: 'live', review: 'review', blacklist: 'blacklisted' }[active.dataset.view] || 'live';
}
async function act(path, reloadView) {
  try {
    await api(`/api/admin/${path}`, { method: 'POST' });
    navigate(reloadView === 'blacklisted' ? 'blacklist' : reloadView);
  } catch (e) {
    alert(e.message);
  }
}

// --- reports ------------------------------------------------------------
let reportsShowAll = false;

async function reports() {
  const { reports: rows, blacklistThreshold } = await api(
    `/api/admin/reports${reportsShowAll ? '?include=all' : ''}`
  );

  const reasonSummary = (reasons) => {
    const counts = {};
    for (const x of reasons) counts[x.reason] = (counts[x.reason] || 0) + 1;
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, n]) => `${esc(reason)} ×${n}`)
      .join(', ');
  };

  viewEl.innerHTML = `
    <h2>Reports</h2>
    <p class="muted" style="margin-top:-6px">
      Reported posts stay live and wait for your decision here.
      A post only hides itself automatically once it passes
      <strong>${blacklistThreshold}</strong> open reports (mass report) —
      it then moves to Blacklist, out of the public feed but still visible to you.
    </p>
    <div class="toolbar">
      <button class="btn ${reportsShowAll ? 'g' : 'p'}" id="toggleResolved">
        ${reportsShowAll ? 'Showing all' : 'Showing open only'}
      </button>
    </div>
    ${rows.length === 0
      ? `<p class="muted">${reportsShowAll ? 'No reports at all.' : 'No open reports. Nothing needs your attention.'}</p>`
      : `<table>
          <thead><tr><th>Media</th><th>Post</th><th>Status</th><th>Open reports</th><th>Reasons</th><th>Actions</th></tr></thead>
          <tbody>${rows.map(reportRow).join('')}</tbody>
        </table>`}
  `;

  document.getElementById('toggleResolved').addEventListener('click', () => {
    reportsShowAll = !reportsShowAll;
    navigate('reports');
  });

  viewEl.querySelectorAll('[data-dismiss]').forEach((b) => b.addEventListener('click', async () => {
    const r = await api(`/api/admin/reports/${b.dataset.dismiss}/dismiss`, { method: 'POST' });
    if (r.restored) alert('Post restored to the public feed.');
    navigate('reports');
  }));
  viewEl.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Remove this post from the site?')) return;
    await api(`/api/admin/posts/${b.dataset.rm}/remove`, { method: 'POST' });
    navigate('reports');
  }));
  viewEl.querySelectorAll('[data-bl]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/api/admin/posts/${b.dataset.bl}/blacklist`, { method: 'POST' });
    navigate('reports');
  }));

  function reportRow(r) {
    const thumb = r.thumbUrl || r.mediaUrl;
    let media;
    if (r.kind === 'text') {
      media = `<div class="text-preview">${esc((r.body || '').slice(0, 140))}</div>`;
    } else if (!r.mediaUrl) {
      media = '<span class="muted">media purged</span>';
    } else {
      media = r.media_type === 'video'
        ? `<video class="thumb" src="${esc(r.mediaUrl)}" muted></video>`
        : `<img class="thumb" src="${esc(thumb)}">`;
    }
    const heat = r.openCount >= blacklistThreshold
      ? `<strong style="color:var(--danger)">${r.openCount}</strong>`
      : r.openCount;
    return `<tr>
      <td>${media}</td>
      <td>
        <a href="/post.html?id=${r.post_id}" target="_blank">#${r.post_id}</a>
        <div class="muted">${esc(nicknameFromAddr(r.addr))}</div>
        <div class="muted">${fmtTime(r.created_at)}</div>
      </td>
      <td>${badge(r.status)}${r.autoBlacklisted ? '<div class="muted">auto (mass report)</div>' : ''}</td>
      <td>${heat}<div class="muted">${r.totalCount} total</div></td>
      <td>${reasonSummary(r.reasons)}</td>
      <td>
        <button class="btn p" data-dismiss="${r.post_id}">Keep</button>
        <button class="btn d" data-bl="${r.post_id}">Blacklist</button>
        <button class="btn d" data-rm="${r.post_id}">Remove</button>
      </td>
    </tr>`;
  }
}

// --- bans -----------------------------------------------------------------
async function bans() {
  const { bans: rows } = await api('/api/admin/bans');
  viewEl.innerHTML = `
    <h2>Bans</h2>
    <div class="card">
      <div class="toolbar">
        <select id="banKind"><option value="addr">Address</option><option value="iphash">IP hash</option></select>
        <input type="text" id="banValue" placeholder="value to ban" style="flex:1;min-width:200px">
        <input type="text" id="banReason" placeholder="reason (optional)" style="flex:1;min-width:160px">
        <button class="btn p" id="banSubmit">Ban</button>
      </div>
    </div>
    <table><thead><tr><th>Kind</th><th>Value</th><th>Reason</th><th>Since</th><th></th></tr></thead>
    <tbody>${rows.map((b) => `
      <tr>
        <td>${esc(b.kind)}</td>
        <td class="pill">${esc(b.value)}</td>
        <td>${esc(b.reason || '')}</td>
        <td>${fmtTime(b.created_at)}</td>
        <td><button class="btn g" data-unban="${b.kind}|${b.value}">Unban</button></td>
      </tr>`).join('')}</tbody></table>
  `;
  document.getElementById('banSubmit').addEventListener('click', async () => {
    const kind = document.getElementById('banKind').value;
    const value = document.getElementById('banValue').value.trim();
    const reason = document.getElementById('banReason').value.trim();
    if (!value) return;
    await api('/api/admin/bans', { method: 'POST', body: JSON.stringify({ kind, value, reason }) });
    navigate('bans');
  });
  viewEl.querySelectorAll('[data-unban]').forEach((b) => b.addEventListener('click', async () => {
    const [kind, value] = b.dataset.unban.split('|');
    await api(`/api/admin/bans/${kind}/${encodeURIComponent(value)}`, { method: 'DELETE' });
    navigate('bans');
  }));
}

// --- settings ---------------------------------------------------------
async function settings() {
  const { settings: s } = await api('/api/admin/settings');
  const fields = Object.keys(s);
  viewEl.innerHTML = `
    <h2>Settings</h2>
    <div class="card">
      <div class="settings-grid">
        ${fields.map((k) => `
          <div class="field">
            <label>${esc(k)}</label>
            ${typeof s[k] === 'boolean'
              ? `<select id="set_${k}"><option value="true" ${s[k] ? 'selected' : ''}>true</option><option value="false" ${!s[k] ? 'selected' : ''}>false</option></select>`
              : `<input type="number" step="0.01" id="set_${k}" value="${s[k]}">`}
          </div>`).join('')}
      </div>
      <button class="btn p" id="saveSettings">Save settings</button>
      <span class="muted" id="settingsMsg" style="margin-left:10px"></span>
    </div>
  `;
  document.getElementById('saveSettings').addEventListener('click', async () => {
    const updates = {};
    for (const k of fields) {
      const el = document.getElementById(`set_${k}`);
      updates[k] = typeof s[k] === 'boolean' ? el.value === 'true' : Number(el.value);
    }
    await api('/api/admin/settings', { method: 'POST', body: JSON.stringify(updates) });
    document.getElementById('settingsMsg').textContent = 'Saved.';
  });
}

// --- ledger monitor -----------------------------------------------------
// This app's ledger is a real hash-linked table, not a blockchain -- there
// is no wallet, gas, or contract layer. This is what actually exists: the
// block list and the tamper-evidence check.
async function ledger() {
  const { blocks, totalBlocks, redactedBlocks, byType, verify } = await api('/api/admin/ledger?limit=60');

  viewEl.innerHTML = `
    <h2>Ledger monitor</h2>
    <p class="muted" style="margin-top:-2px">
      Every post, like, dislike, comment and report is appended here as a hash-linked block.
      Tampering with any past row breaks every hash after it — that's what "verify" checks.
    </p>

    <div class="grid">
      <div class="stat"><div class="n">${totalBlocks}</div><div class="l">Total blocks</div></div>
      <div class="stat"><div class="n">${redactedBlocks}</div><div class="l">Redacted</div></div>
      <div class="stat"><div class="n">${verify.ok ? 'Intact' : 'Broken'}</div><div class="l">Integrity</div></div>
      ${Object.entries(byType).map(([t, n]) => `<div class="stat"><div class="n">${n}</div><div class="l">${esc(t)}</div></div>`).join('')}
    </div>

    <div class="card" id="verifyCard">
      ${verify.ok
        ? `<strong>Chain verified.</strong> ${verify.blocks} blocks, head hash <span class="pill">${esc(verify.headHash || '')}</span>`
        : `<strong>Chain broken at sequence ${verify.brokenAtSeq}.</strong> ${esc(verify.reason)}`}
      <button class="btn s" id="reverify" style="margin-left:10px">Re-verify</button>
    </div>

    <table>
      <thead><tr><th>Seq</th><th>Type</th><th>Address</th><th>Ref</th><th>Hash</th><th>When</th></tr></thead>
      <tbody>${blocks.map((b) => `
        <tr>
          <td>${b.seq}</td>
          <td>${esc(b.type)}${b.redacted ? ' <span class="muted">(redacted)</span>' : ''}</td>
          <td class="pill">${esc(nicknameFromAddr(b.addr))}</td>
          <td>${b.ref_id ?? '—'}</td>
          <td class="pill">${esc(b.hash.slice(0, 16))}…</td>
          <td>${fmtTime(b.ts)}</td>
        </tr>`).join('')}</tbody>
    </table>
  `;

  document.getElementById('reverify').addEventListener('click', () => navigate('ledger'));
}

// --- storage --------------------------------------------------------------
// Stands in for "IPFS storage" -- media lives on local disk under uploads/,
// not a distributed pinning network, so this reports real disk usage rather
// than pin/gateway status that doesn't exist here.
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n, i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(1)} ${units[i]}`;
}

async function storage() {
  const s = await api('/api/admin/storage');
  viewEl.innerHTML = `
    <h2>Storage</h2>
    <p class="muted" style="margin-top:-2px">Local disk usage under <span class="pill">uploads/</span> — this platform stores media on this server, not on IPFS or any pinning network.</p>

    <div class="grid">
      <div class="stat"><div class="n">${fmtBytes(s.totalBytes)}</div><div class="l">Media on disk</div></div>
      <div class="stat"><div class="n">${s.totalFiles}</div><div class="l">Files on disk</div></div>
      <div class="stat"><div class="n">${fmtBytes(s.dbBytes)}</div><div class="l">Database size</div></div>
      <div class="stat"><div class="n">${s.purgedMediaCount}</div><div class="l">Purged (blacklisted)</div></div>
    </div>

    <table>
      <thead><tr><th>Directory</th><th>Files</th><th>Size</th><th>Meaning</th></tr></thead>
      <tbody>
        <tr><td>live</td><td>${s.dirs.live.count}</td><td>${fmtBytes(s.dirs.live.bytes)}</td><td class="muted">Publicly served media</td></tr>
        <tr><td>quarantine</td><td>${s.dirs.quarantine.count}</td><td>${fmtBytes(s.dirs.quarantine.bytes)}</td><td class="muted">Blacklisted, admin-only, purged after ${s.quarantineRetentionHours}h if auto-flagged</td></tr>
        <tr><td>pending</td><td>${s.dirs.pending.count}</td><td>${fmtBytes(s.dirs.pending.bytes)}</td><td class="muted">Awaiting moderation</td></tr>
      </tbody>
    </table>

    <h2 style="margin-top:22px;font-size:1rem">By media type</h2>
    <div class="grid">
      ${Object.entries(s.byMediaType).map(([t, n]) => `<div class="stat"><div class="n">${n}</div><div class="l">${esc(t)}</div></div>`).join('') || '<p class="muted">No media on disk yet.</p>'}
    </div>
  `;
}

// --- security center --------------------------------------------------
async function security() {
  const s = await api('/api/admin/security');
  viewEl.innerHTML = `
    <h2>Security center</h2>
    <div class="grid">
      <div class="stat"><div class="n">${s.activeSessions}</div><div class="l">Active admin sessions</div></div>
      <div class="stat"><div class="n">${s.logins24h.ok || 0}</div><div class="l">Logins ok (24h)</div></div>
      <div class="stat"><div class="n">${s.logins24h.fail || 0}</div><div class="l">Logins failed (24h)</div></div>
      <div class="stat"><div class="n">${(s.bansByKind.addr || 0) + (s.bansByKind.iphash || 0)}</div><div class="l">Active bans</div></div>
    </div>

    <h2 style="font-size:1rem">Rate limits in effect</h2>
    <table>
      <thead><tr><th>Scope</th><th>Limit</th></tr></thead>
      <tbody>
        <tr><td>Uploads</td><td>${s.rateLimits.uploadPerHour} / hour / network</td></tr>
        <tr><td>Reads</td><td>${s.rateLimits.readPer15Min} / 15 min / network</td></tr>
        <tr><td>Likes &amp; comments</td><td>${s.rateLimits.writePerMin} / min / network</td></tr>
        <tr><td>Reports</td><td>${s.rateLimits.reportPerHour} / hour / network</td></tr>
        <tr><td>Admin login attempts</td><td>${s.rateLimits.adminLoginPer15Min} / 15 min / network, then locked out</td></tr>
      </tbody>
    </table>

    <h2 style="font-size:1rem;margin-top:22px">Recent failed admin logins (7d)</h2>
    ${s.recentFailedLogins.length === 0 ? '<p class="muted">None. Good.</p>' : `
      <table>
        <thead><tr><th>Network (hashed)</th><th>When</th></tr></thead>
        <tbody>${s.recentFailedLogins.map((f) => `
          <tr><td class="pill">${esc(f.iphash.slice(0, 20))}…</td><td>${fmtTime(f.created_at)}</td></tr>
        `).join('')}</tbody>
      </table>`}
    <p class="muted" style="margin-top:10px">
      Networks are identified only by an hourly-rotating salted hash — the raw IP address is never stored.
    </p>
  `;
}

// --- reputation -----------------------------------------------------------
async function reputation() {
  const { addresses } = await api('/api/admin/reputation');
  viewEl.innerHTML = `
    <h2>Reputation</h2>
    <p class="muted" style="margin-top:-2px">
      Behaviour summary per address, built from this platform's own data — posts, reports received/filed, likes.
      Sorted by reports received (worst first). There is no external trust oracle.
    </p>
    ${addresses.length === 0 ? '<p class="muted">No activity yet.</p>' : `
      <table>
        <thead><tr><th>Address</th><th>Posts</th><th>Blacklisted</th><th>Comments</th><th>Reports received</th><th>Reports filed</th><th>Likes received</th><th>First seen</th><th></th></tr></thead>
        <tbody>${addresses.map((a) => `
          <tr>
            <td><div>${esc(nicknameFromAddr(a.addr))}</div><div class="pill muted">${esc(a.addr)}</div></td>
            <td>${a.posts}</td>
            <td>${a.blacklisted}</td>
            <td>${a.comments}</td>
            <td>${a.reportsReceived}</td>
            <td>${a.reportsFiled}</td>
            <td>${a.likesReceived}</td>
            <td>${a.firstSeen ? fmtTime(a.firstSeen) : '—'}</td>
            <td>${a.bannedAddr
              ? '<span class="badge blacklisted">banned</span>'
              : `<button class="btn d" data-ban-addr="${esc(a.addr)}">Ban</button>`}</td>
          </tr>`).join('')}</tbody>
      </table>`}
  `;
  viewEl.querySelectorAll('[data-ban-addr]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`Ban ${b.dataset.banAddr}? They will no longer be able to post, comment, like or report.`)) return;
    await api('/api/admin/bans', { method: 'POST', body: JSON.stringify({ kind: 'addr', value: b.dataset.banAddr, reason: 'banned from reputation view' }) });
    navigate('reputation');
  }));
}

// --- analytics --------------------------------------------------------
function sparkbar(series, key, label) {
  const values = series.map((s) => s[key]);
  const max = Math.max(1, ...values);
  const bars = values.map((v, i) => `
    <div class="bar" style="height:${Math.max(2, Math.round((v / max) * 100))}%" title="${esc(series[i].day)}: ${v}"></div>
  `).join('');
  return `
    <div class="chart-card">
      <div class="chart-head"><span class="label">${esc(label)}</span><span class="pill">${values.reduce((a, b) => a + b, 0)} total</span></div>
      <div class="bars">${bars}</div>
    </div>`;
}

async function analytics() {
  const { series, reasonBreakdown, totals } = await api('/api/admin/analytics?days=14');
  viewEl.innerHTML = `
    <h2>Analytics</h2>
    <p class="muted" style="margin-top:-2px">Last 14 days, computed from this platform's own database.</p>

    <div class="grid">
      <div class="stat"><div class="n">${totals.addresses}</div><div class="l">Addresses seen (all time)</div></div>
      <div class="stat"><div class="n">${totals.posts}</div><div class="l">Total posts</div></div>
      <div class="stat"><div class="n">${totals.comments}</div><div class="l">Total comments</div></div>
      <div class="stat"><div class="n">${totals.likes}</div><div class="l">Total likes</div></div>
    </div>

    <div class="chart-grid">
      ${sparkbar(series, 'posts', 'Posts / day')}
      ${sparkbar(series, 'uniquePosters', 'Unique posting addresses / day')}
      ${sparkbar(series, 'comments', 'Comments / day')}
      ${sparkbar(series, 'likes', 'Likes / day')}
      ${sparkbar(series, 'reports', 'Reports filed / day')}
    </div>

    <h2 style="font-size:1rem;margin-top:22px">Report reasons (all time)</h2>
    ${Object.keys(reasonBreakdown).length === 0 ? '<p class="muted">No reports yet.</p>' : `
      <table><thead><tr><th>Reason</th><th>Count</th></tr></thead>
      <tbody>${Object.entries(reasonBreakdown).sort((a, b) => b[1] - a[1]).map(([r, n]) => `
        <tr><td>${esc(r)}</td><td>${n}</td></tr>
      `).join('')}</tbody></table>`}
  `;
}

// --- audit log --------------------------------------------------------
async function audit() {
  const { audit: rows } = await api('/api/admin/audit');
  viewEl.innerHTML = `<h2>Audit log</h2>` + (rows.length === 0 ? '<p class="muted">No actions logged yet.</p>' : `
    <table><thead><tr><th>When</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead>
    <tbody>${rows.map((r) => `
      <tr><td>${fmtTime(r.created_at)}</td><td>${esc(r.action)}</td><td class="pill">${esc(r.target || '')}</td><td class="pill">${esc(r.detail ? JSON.stringify(r.detail) : '')}</td></tr>
    `).join('')}</tbody></table>`);
}

checkSession();
