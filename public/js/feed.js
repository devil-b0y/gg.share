import { identity } from './identity.js';
import {
  api, signedAction, nonce, toast, timeAgo, setAvatar, nicknameFromAddr,
  escapeHtml, icons, bindModals, openModal, closeModal, initIdentity,
  skeleton, sharePost
} from './common.js';

const feedEl = document.getElementById('feed');
const footEl = document.getElementById('feedFoot');
const sentinel = document.getElementById('sentinel');

const SORT_NAMES = ['latest', 'trending', 'top', 'discussed', 'controversial'];

// Feed query state. Kept in the URL so a filtered view is shareable and
// survives a reload / back button.
const state = { sort: 'latest', q: '', kind: '', tag: '' };
let cursor = null;      // keyset id for "latest"
let offset = 0;         // offset for the ranked sorts
let loading = false;
let done = false;
let myAddr = '';
let reportPostId = null;
let requestSeq = 0;     // guards against a slow response overwriting a newer one

bindModals();

/* --------------------------------------------------------- rendering */

// Turns #hashtags in a body into filter links. The text is escaped first,
// so this only ever injects our own anchor markup around safe content.
function linkifyTags(body) {
  return escapeHtml(body).replace(
    /(^|[^0-9A-Za-z_#])#([0-9A-Za-z_]{1,50})/g,
    (_m, lead, tag) => `${lead}<a class="tag" href="?tag=${encodeURIComponent(tag.toLowerCase())}">#${tag}</a>`
  );
}

function actionsBar(post) {
  return `
    <div class="actions">
      <button class="act act-like${post.viewerLiked ? ' is-on' : ''}" data-act="like"
              aria-pressed="${post.viewerLiked}" title="Like">
        ${icons.heart(post.viewerLiked)}<span class="count">${post.likeCount}</span>
      </button>
      <button class="act act-dislike${post.viewerDisliked ? ' is-on' : ''}" data-act="dislike"
              aria-pressed="${post.viewerDisliked}" title="Dislike">
        ${icons.down(post.viewerDisliked)}<span class="count">${post.dislikeCount}</span>
      </button>
      <a class="act" href="/post.html?id=${post.id}" title="Comments">
        ${icons.comment}<span class="count">${post.commentCount}</span>
      </a>
      <span class="act-spacer"></span>
      <button class="act" data-act="share" title="Copy link">${icons.share}</button>
      <button class="act act-report" data-act="report" title="Report">${icons.flag}</button>
    </div>`;
}

function headRow(post, kindLabel) {
  return `
    <div class="post-head">
      <span class="avatar" data-avatar></span>
      <span class="who">
        <span class="nick">${escapeHtml(nicknameFromAddr(post.addr))}</span>
        <time datetime="${new Date(post.createdAt).toISOString()}">${timeAgo(post.createdAt)}</time>
      </span>
      <span class="kind">${kindLabel}</span>
    </div>`;
}

function postCard(post) {
  const el = document.createElement('article');
  el.className = post.kind === 'text' ? 'post is-text' : 'post';
  el.dataset.id = post.id;

  if (post.kind === 'text') {
    el.innerHTML = `
      ${headRow(post, 'text')}
      <div class="post-text">${linkifyTags(post.body || '')}</div>
      ${actionsBar(post)}`;
  } else {
    // Reserving the exact aspect ratio up front is what keeps the feed from
    // jumping as images decode.
    const ar = post.width && post.height ? `${post.width} / ${post.height}` : null;
    const media = post.mediaType === 'video'
      ? `<video src="${escapeHtml(post.mediaUrl)}" controls playsinline preload="none"
               ${post.thumbUrl ? `poster="${escapeHtml(post.thumbUrl)}"` : ''}></video>`
      : `<img src="${escapeHtml(post.mediaUrl)}" alt="${post.caption ? escapeHtml(post.caption) : 'Anonymous post'}"
             loading="lazy" decoding="async"
             ${post.width ? `width="${post.width}" height="${post.height}"` : ''}>`;

    el.innerHTML = `
      ${headRow(post, post.mediaType || 'media')}
      <a class="${ar ? 'frame is-reserved' : 'frame'}"${ar ? ` style="--ar:${ar}"` : ''}
         href="/post.html?id=${post.id}" aria-label="Open post">${media}</a>
      ${post.caption ? `<div class="post-body"><p class="caption">${linkifyTags(post.caption)}</p></div>` : ''}
      ${actionsBar(post)}`;

    const img = el.querySelector('img');
    if (img) {
      if (img.complete && img.naturalWidth > 0) img.classList.add('is-loaded');
      else {
        img.addEventListener('load', () => img.classList.add('is-loaded'), { once: true });
        img.addEventListener('error', () => el.querySelector('.frame')?.classList.add('is-broken'), { once: true });
      }
    }
  }

  setAvatar(el.querySelector('[data-avatar]'), post.addr);

  const likeBtn = el.querySelector('[data-act="like"]');
  const dislikeBtn = el.querySelector('[data-act="dislike"]');
  likeBtn.addEventListener('click', () => vote('like', post.id, likeBtn, dislikeBtn));
  dislikeBtn.addEventListener('click', () => vote('dislike', post.id, likeBtn, dislikeBtn));
  el.querySelector('[data-act="share"]').addEventListener('click', () => sharePost(post.id));
  el.querySelector('[data-act="report"]').addEventListener('click', () => openReport(post.id));

  return el;
}

/* -------------------------------------------------------------- vote */

function paintVote(btn, on, kind) {
  btn.classList.toggle('is-on', on);
  btn.setAttribute('aria-pressed', String(on));
  const count = btn.querySelector('.count');
  btn.innerHTML = (kind === 'like' ? icons.heart(on) : icons.down(on)) + count.outerHTML;
}

async function vote(kind, postId, likeBtn, dislikeBtn) {
  const wasLiked = likeBtn.classList.contains('is-on');
  const wasDisliked = dislikeBtn.classList.contains('is-on');
  const likeCount = likeBtn.querySelector('.count');
  const dislikeCount = dislikeBtn.querySelector('.count');

  try {
    const envelope = await signedAction({ type: kind, postId, ts: Date.now(), nonce: nonce() });
    const result = await api(kind === 'like' ? '/api/likes' : '/api/dislikes', {
      method: 'POST', body: JSON.stringify(envelope)
    });

    const nowLiked = kind === 'like' ? result.liked : false;
    const nowDisliked = kind === 'dislike' ? result.disliked : false;

    // The server clears the opposite vote, so mirror that in both counters.
    let dLike = 0, dDislike = 0;
    if (kind === 'like') {
      dLike = nowLiked ? 1 : -1;
      if (wasDisliked && nowLiked) dDislike = -1;
    } else {
      dDislike = nowDisliked ? 1 : -1;
      if (wasLiked && nowDisliked) dLike = -1;
    }
    likeCount.textContent = Math.max(0, +likeCount.textContent + dLike);
    dislikeCount.textContent = Math.max(0, +dislikeCount.textContent + dDislike);

    paintVote(likeBtn, nowLiked, 'like');
    paintVote(dislikeBtn, nowDisliked, 'dislike');
  } catch (e) {
    toast(e.message);
  }
}

/* ------------------------------------------------------------ report */

function setReportError(msg) {
  const el = document.getElementById('reportError');
  if (el) el.textContent = msg;
}

function openReport(postId) {
  reportPostId = postId;
  document.querySelectorAll('#reasons input').forEach((i) => { i.checked = false; });
  document.getElementById('reportNote').value = '';
  setReportError('');
  const btn = document.getElementById('submitReport');
  if (btn) { btn.disabled = false; btn.textContent = 'Send report'; }
  openModal('reportModal');
}

document.getElementById('submitReport')?.addEventListener('click', async () => {
  const btn = document.getElementById('submitReport');
  const picked = document.querySelector('#reasons input:checked');
  if (!picked) return setReportError('Choose a reason first.');

  // Guard against double-submits: without this, an error leaves the modal
  // open and every extra click fires another request straight into the
  // per-hour report limit.
  btn.disabled = true;
  btn.textContent = 'Sending…';
  setReportError('');

  try {
    const envelope = await signedAction({
      type: 'report', postId: reportPostId, reason: picked.value,
      note: document.getElementById('reportNote').value.trim(),
      ts: Date.now(), nonce: nonce()
    });
    await api('/api/reports', { method: 'POST', body: JSON.stringify(envelope) });
    closeModal('reportModal');
    toast('Report sent — a moderator will review it');
  } catch (e) {
    // Retrying won't help for these, so close out rather than trapping the
    // user in a modal with a button that can only fail again.
    if (e.status === 404 || e.status === 409 || e.status === 429) {
      closeModal('reportModal');
      toast(e.status === 404 ? 'That post no longer exists' : e.message);
    } else {
      setReportError(e.message);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send report';
  }
});

/* -------------------------------------------------------------- feed */

function buildQuery() {
  const qs = new URLSearchParams({ limit: '10', sort: state.sort });
  if (myAddr) qs.set('addr', myAddr);
  if (state.q) qs.set('q', state.q);
  if (state.kind) qs.set('kind', state.kind);
  if (state.tag) qs.set('tag', state.tag);
  if (state.sort === 'latest') { if (cursor) qs.set('before', cursor); }
  else if (offset) qs.set('offset', offset);
  return qs;
}

async function loadMore() {
  if (loading || done) return;
  loading = true;
  const seq = ++requestSeq;
  const firstPage = state.sort === 'latest' ? !cursor : offset === 0;
  if (firstPage) feedEl.innerHTML = skeleton(3);

  try {
    const data = await api(`/api/posts?${buildQuery()}`);
    if (seq !== requestSeq) return; // a newer filter change already superseded this

    if (firstPage) feedEl.innerHTML = '';

    // One reflow for the whole page of cards rather than one per card.
    const frag = document.createDocumentFragment();
    for (const p of data.posts) frag.appendChild(postCard(p));
    feedEl.appendChild(frag);

    cursor = data.nextBefore;
    offset = data.nextOffset ?? offset;

    const noMore = state.sort === 'latest' ? !data.nextBefore : data.nextOffset === null;
    if (!data.posts.length || noMore) {
      done = true;
      footEl.innerHTML = feedEl.children.length
        ? '<div class="note"><span class="label">End of feed</span>Nothing more to show.</div>'
        : emptyMessage();
    } else {
      footEl.innerHTML = '';
    }
  } catch (e) {
    if (seq !== requestSeq) return;
    if (firstPage) feedEl.innerHTML = '';
    footEl.innerHTML = `<div class="note">Couldn't load the feed — ${escapeHtml(e.message)}</div>`;
  } finally {
    if (seq === requestSeq) loading = false;
    feedEl.setAttribute('aria-busy', 'false');
  }
}

function emptyMessage() {
  if (state.q) return `<div class="empty"><h2>No matches</h2><p>Nothing found for “${escapeHtml(state.q)}”.</p></div>`;
  if (state.tag) return `<div class="empty"><h2>No posts tagged #${escapeHtml(state.tag)}</h2><p>Be the first to use it.</p></div>`;
  return '<div class="empty"><h2>Nothing here yet</h2><p>Be the first to post something. No account needed.</p></div>';
}

function resetFeed() {
  cursor = null;
  offset = 0;
  done = false;
  loading = false;
  footEl.innerHTML = '';
  feedEl.innerHTML = '';
  loadMore();
}

// An observer only wakes when the sentinel nears the viewport, unlike a
// scroll handler that fires on every frame of every scroll.
new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting)) loadMore();
}, { rootMargin: '900px 0px' }).observe(sentinel);

/* ---------------------------------------------------------- controls */

function syncUrl() {
  const qs = new URLSearchParams();
  if (state.sort !== 'latest') qs.set('sort', state.sort);
  if (state.q) qs.set('q', state.q);
  if (state.kind) qs.set('kind', state.kind);
  if (state.tag) qs.set('tag', state.tag);
  const str = qs.toString();
  history.replaceState(null, '', str ? `?${str}` : location.pathname);
}

function paintActiveFilter() {
  const el = document.getElementById('activeFilter');
  const bits = [];
  if (state.tag) bits.push(`tag <strong>#${escapeHtml(state.tag)}</strong>`);
  if (state.q) bits.push(`search <strong>“${escapeHtml(state.q)}”</strong>`);
  if (state.kind) bits.push(`type <strong>${escapeHtml(state.kind)}</strong>`);
  if (!bits.length) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `Filtering by ${bits.join(' · ')} <button id="clearFilter">Clear</button>`;
  document.getElementById('clearFilter').addEventListener('click', () => {
    state.q = ''; state.tag = ''; state.kind = '';
    document.getElementById('search').value = '';
    document.getElementById('kindFilter').value = '';
    paintActiveFilter(); syncUrl(); resetFeed();
  });
}

document.getElementById('sorts').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-sort]');
  if (!btn || btn.dataset.sort === state.sort) return;
  state.sort = btn.dataset.sort;
  document.querySelectorAll('#sorts button').forEach((b) => b.classList.toggle('is-on', b === btn));
  syncUrl();
  resetFeed();
});

let searchTimer;
document.getElementById('search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const value = e.target.value.trim();
  // Debounced so typing doesn't fire a query per keystroke.
  searchTimer = setTimeout(() => {
    state.q = value;
    paintActiveFilter(); syncUrl(); resetFeed();
  }, 320);
});

document.getElementById('kindFilter').addEventListener('change', (e) => {
  state.kind = e.target.value;
  paintActiveFilter(); syncUrl(); resetFeed();
});

// Tag links are plain anchors so they work with middle-click / open-in-new-tab,
// but same-page clicks are intercepted to avoid a full reload.
document.addEventListener('click', (e) => {
  const link = e.target.closest('a.tag, a.tag-chip');
  if (!link || e.metaKey || e.ctrlKey || e.button !== 0) return;
  e.preventDefault();
  const tag = new URLSearchParams(link.search).get('tag');
  if (!tag) return;
  state.tag = tag;
  paintActiveFilter(); syncUrl(); resetFeed();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

async function loadTrendingTags() {
  try {
    const { tags } = await api('/api/posts/tags/trending');
    if (!tags.length) return;
    const wrap = document.getElementById('railTags');
    const list = document.getElementById('tagList');
    list.innerHTML = tags.map((t) =>
      `<a class="tag-chip" href="?tag=${encodeURIComponent(t.tag)}">#${escapeHtml(t.tag)}<span class="n">${t.n}</span></a>`
    ).join('');
    wrap.hidden = false;
  } catch { /* non-critical */ }
}

/* ------------------------------------------------------------ ledger */

async function checkChain() {
  const strip = document.getElementById('chainStrip');
  const text = document.getElementById('chainText');
  if (!strip) return;
  try {
    const r = await api('/api/chain/verify');
    if (r.ok) text.textContent = `ledger verified · ${r.blocks} blocks`;
    else { strip.classList.add('is-broken'); text.textContent = `ledger broken at #${r.brokenAtSeq}`; }
  } catch {
    text.textContent = 'ledger unavailable';
  }
}

/* ----------------------------------------------------------- compose */

const drop = document.getElementById('drop');
const dropIdle = document.getElementById('dropIdle');
const dropPreview = document.getElementById('dropPreview');
const fileInput = document.getElementById('fileInput');
const textBody = document.getElementById('textBody');
let picked = null;
let mode = 'text';

document.getElementById('fab').addEventListener('click', () => openModal('uploadModal'));
document.getElementById('railUpload')?.addEventListener('click', (e) => {
  e.preventDefault();
  openModal('uploadModal');
});

document.getElementById('modeTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-mode]');
  if (!btn) return;
  mode = btn.dataset.mode;
  document.querySelectorAll('#modeTabs button').forEach((b) => b.classList.toggle('is-on', b === btn));
  document.getElementById('modeText').hidden = mode !== 'text';
  document.getElementById('modeMedia').hidden = mode !== 'media';
  document.getElementById('uploadStatus').textContent = '';
});

textBody.addEventListener('input', () => {
  const counter = document.getElementById('textCounter');
  counter.textContent = `${textBody.value.length} / 500`;
  counter.classList.toggle('is-over', textBody.value.length > 480);
});

drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
['dragenter', 'dragover'].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('is-over'); }));
['dragleave', 'drop'].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('is-over'); }));
drop.addEventListener('drop', (e) => {
  const f = e.dataTransfer.files?.[0];
  if (f) choose(f);
});
fileInput.addEventListener('change', () => fileInput.files[0] && choose(fileInput.files[0]));

function choose(file) {
  picked = file;
  const url = URL.createObjectURL(file);
  dropIdle.hidden = true;
  dropPreview.hidden = false;
  dropPreview.innerHTML = file.type.startsWith('video')
    ? `<video src="${url}" controls></video>`
    : `<img src="${url}" alt="">`;
}

function resetCompose() {
  picked = null;
  fileInput.value = '';
  dropIdle.hidden = false;
  dropPreview.hidden = true;
  dropPreview.innerHTML = '';
  document.getElementById('caption').value = '';
  textBody.value = '';
  document.getElementById('textCounter').textContent = '0 / 500';
  document.getElementById('uploadStatus').textContent = '';
}

document.getElementById('submitUpload').addEventListener('click', async () => {
  const status = document.getElementById('uploadStatus');
  const btn = document.getElementById('submitUpload');

  if (mode === 'text' && !textBody.value.trim()) return toast('Write something first');
  if (mode === 'media' && !picked) return toast('Choose a photo or video first');

  btn.disabled = true;
  status.textContent = mode === 'text' ? 'Signing and posting…' : 'Signing and uploading…';

  try {
    if (mode === 'text') {
      const envelope = await signedAction({
        type: 'text_post', body: textBody.value.trim(), ts: Date.now(), nonce: nonce()
      });
      await api('/api/posts/text', { method: 'POST', body: JSON.stringify(envelope) });
      closeModal('uploadModal');
      resetCompose();
      toast('Posted');
      // Text posts go live immediately, so show it right away.
      state.sort = 'latest';
      document.querySelectorAll('#sorts button').forEach((b) => b.classList.toggle('is-on', b.dataset.sort === 'latest'));
      resetFeed();
      loadTrendingTags();
    } else {
      const envelope = await signedAction({ type: 'post', ts: Date.now(), nonce: nonce() });
      const form = new FormData();
      form.set('addr', envelope.addr);
      form.set('pubkey', envelope.pubkey);
      form.set('signature', envelope.signature);
      form.set('payload', JSON.stringify(envelope.payload));
      form.set('caption', document.getElementById('caption').value.trim());
      form.set('file', picked);

      await api('/api/posts', { method: 'POST', body: form });
      status.textContent = 'Uploaded. It appears once automated moderation clears it.';
      toast('Post submitted');
      setTimeout(() => { closeModal('uploadModal'); resetCompose(); }, 1100);
    }
  } catch (e) {
    status.textContent = '';
    toast(e.message);
  } finally {
    btn.disabled = false;
  }
});

/* -------------------------------------------------------------- boot */

(async () => {
  const params = new URLSearchParams(location.search);
  if (SORT_NAMES.includes(params.get('sort'))) state.sort = params.get('sort');
  state.q = params.get('q') || '';
  state.kind = ['text', 'media'].includes(params.get('kind')) ? params.get('kind') : '';
  state.tag = (params.get('tag') || '').toLowerCase();

  document.querySelectorAll('#sorts button').forEach((b) => b.classList.toggle('is-on', b.dataset.sort === state.sort));
  document.getElementById('search').value = state.q;
  document.getElementById('kindFilter').value = state.kind;
  paintActiveFilter();

  // Identity resolves from localStorage, so this is fast; awaiting it before
  // the first fetch lets the feed return the viewer's own vote state inline
  // instead of the client asking per card afterwards.
  myAddr = await initIdentity();
  await loadMore();
  loadTrendingTags();
  checkChain();
})();
