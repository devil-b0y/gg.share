import {
  api, signedAction, nonce, toast, timeAgo, setAvatar, nicknameFromAddr,
  escapeHtml, icons, bindModals, openModal, closeModal, initIdentity, sharePost
} from './common.js';

const postId = Number(new URLSearchParams(location.search).get('id'));
const container = document.getElementById('postContainer');
const commentsSection = document.getElementById('commentsSection');
let myAddr = '';

bindModals();

function paintVote(btn, on, kind) {
  btn.classList.toggle('is-on', on);
  btn.setAttribute('aria-pressed', String(on));
  const count = btn.querySelector('.count');
  btn.innerHTML = (kind === 'like' ? icons.heart(on) : icons.down(on)) + count.outerHTML;
}

// Same #hashtag -> filter-link treatment as the feed, so a tag clicked from
// a post's detail page lands on the feed pre-filtered to it.
function linkifyTags(text) {
  return escapeHtml(text).replace(
    /(^|[^0-9A-Za-z_#])#([0-9A-Za-z_]{1,50})/g,
    (_m, lead, tag) => `${lead}<a class="tag" href="/?tag=${encodeURIComponent(tag.toLowerCase())}">#${tag}</a>`
  );
}

function renderPost(post) {
  const el = document.createElement('article');
  el.className = post.kind === 'text' ? 'post is-text' : 'post';

  const headHtml = `
    <div class="post-head">
      <span class="avatar" data-avatar></span>
      <span class="who">
        <span class="nick">${escapeHtml(nicknameFromAddr(post.addr))}</span>
        <time datetime="${new Date(post.createdAt).toISOString()}">${timeAgo(post.createdAt)}</time>
      </span>
      <span class="kind">${post.kind === 'text' ? 'text' : (post.mediaType || 'media')}</span>
    </div>`;

  const actionsHtml = `
    <div class="actions">
      <button class="act act-like${post.viewerLiked ? ' is-on' : ''}" data-act="like"
              aria-pressed="${post.viewerLiked}" title="Like">
        ${icons.heart(post.viewerLiked)}<span class="count">${post.likeCount}</span>
      </button>
      <button class="act act-dislike${post.viewerDisliked ? ' is-on' : ''}" data-act="dislike"
              aria-pressed="${post.viewerDisliked}" title="Dislike">
        ${icons.down(post.viewerDisliked)}<span class="count">${post.dislikeCount}</span>
      </button>
      <span class="act">${icons.comment}<span class="count">${post.commentCount}</span></span>
      <span class="act-spacer"></span>
      <button class="act" data-act="share" title="Copy link">${icons.share}</button>
      <button class="act act-report" data-act="report" title="Report">${icons.flag}</button>
    </div>`;

  if (post.kind === 'text') {
    el.innerHTML = `${headHtml}<div class="post-text">${linkifyTags(post.body || '')}</div>${actionsHtml}`;
  } else {
    const ar = post.width && post.height ? `${post.width} / ${post.height}` : null;
    const media = post.mediaType === 'video'
      ? `<video src="${escapeHtml(post.mediaUrl)}" controls playsinline preload="metadata"
               ${post.thumbUrl ? `poster="${escapeHtml(post.thumbUrl)}"` : ''}></video>`
      : `<img src="${escapeHtml(post.mediaUrl)}" alt="${post.caption ? escapeHtml(post.caption) : 'Anonymous post'}"
             decoding="async" ${post.width ? `width="${post.width}" height="${post.height}"` : ''}>`;

    el.innerHTML = `
      ${headHtml}
      <div class="${ar ? 'frame is-reserved' : 'frame'}"${ar ? ` style="--ar:${ar}"` : ''}>${media}</div>
      ${post.caption ? `<div class="post-body"><p class="caption">${linkifyTags(post.caption)}</p></div>` : ''}
      ${actionsHtml}
    `;

    // Media fades in via .frame img { opacity: 0 } + .is-loaded in app.css.
    // Without this the image loads correctly but stays invisible forever --
    // that was the "black box" bug on this page.
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

  async function vote(kind) {
    const wasLiked = likeBtn.classList.contains('is-on');
    const wasDisliked = dislikeBtn.classList.contains('is-on');
    const likeCount = likeBtn.querySelector('.count');
    const dislikeCount = dislikeBtn.querySelector('.count');
    try {
      const envelope = await signedAction({ type: kind, postId: post.id, ts: Date.now(), nonce: nonce() });
      const r = await api(kind === 'like' ? '/api/likes' : '/api/dislikes', {
        method: 'POST', body: JSON.stringify(envelope)
      });
      const nowLiked = kind === 'like' ? r.liked : false;
      const nowDisliked = kind === 'dislike' ? r.disliked : false;
      let dL = 0, dD = 0;
      if (kind === 'like') { dL = nowLiked ? 1 : -1; if (wasDisliked && nowLiked) dD = -1; }
      else { dD = nowDisliked ? 1 : -1; if (wasLiked && nowDisliked) dL = -1; }
      likeCount.textContent = Math.max(0, +likeCount.textContent + dL);
      dislikeCount.textContent = Math.max(0, +dislikeCount.textContent + dD);
      paintVote(likeBtn, nowLiked, 'like');
      paintVote(dislikeBtn, nowDisliked, 'dislike');
    } catch (e) {
      toast(e.message);
    }
  }

  likeBtn.addEventListener('click', () => vote('like'));
  dislikeBtn.addEventListener('click', () => vote('dislike'));
  el.querySelector('[data-act="share"]').addEventListener('click', () => sharePost(post.id));
  el.querySelector('[data-act="report"]').addEventListener('click', () => {
    document.querySelectorAll('#reasons input').forEach((i) => { i.checked = false; });
    document.getElementById('reportNote').value = '';
    setReportError('');
    const btn = document.getElementById('submitReport');
    if (btn) { btn.disabled = false; btn.textContent = 'Send report'; }
    openModal('reportModal');
  });

  return el;
}

function setReportError(msg) {
  const el = document.getElementById('reportError');
  if (el) el.textContent = msg;
}

document.getElementById('submitReport')?.addEventListener('click', async () => {
  const btn = document.getElementById('submitReport');
  const picked = document.querySelector('#reasons input:checked');
  if (!picked) return setReportError('Choose a reason first.');

  btn.disabled = true;
  btn.textContent = 'Sending…';
  setReportError('');

  try {
    const envelope = await signedAction({
      type: 'report', postId, reason: picked.value,
      note: document.getElementById('reportNote').value.trim(),
      ts: Date.now(), nonce: nonce()
    });
    await api('/api/reports', { method: 'POST', body: JSON.stringify(envelope) });
    closeModal('reportModal');
    toast('Report sent — a moderator will review it');
  } catch (e) {
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

/* ---------------------------------------------------------- comments */

function commentEl(c, depth) {
  const el = document.createElement('div');
  el.className = depth > 0 ? 'comment is-reply' : 'comment';
  el.innerHTML = `
    <div class="meta">
      <span class="nick">${escapeHtml(nicknameFromAddr(c.addr))}</span>
      <time datetime="${new Date(c.created_at).toISOString()}">${timeAgo(c.created_at)}</time>
    </div>
    <div class="text"></div>`;
  el.querySelector('.text').textContent = c.body;
  return el;
}

async function loadComments() {
  const { comments } = await api(`/api/comments/${postId}`);
  const byParent = new Map();
  for (const c of comments) {
    const key = c.parent_id || 'root';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(c);
  }

  const panel = document.createElement('section');
  panel.className = 'panel';
  panel.innerHTML = `
    <div class="panel-head">
      <span class="label">Comments</span>
      <span class="label">${comments.length}</span>
    </div>`;

  const roots = byParent.get('root') || [];
  if (!roots.length) {
    const empty = document.createElement('div');
    empty.className = 'comment';
    empty.innerHTML = '<div class="text" style="color:var(--ink-3)">No comments yet.</div>';
    panel.appendChild(empty);
  } else {
    const frag = document.createDocumentFragment();
    const walk = (list, depth) => {
      for (const c of list) {
        frag.appendChild(commentEl(c, depth));
        walk(byParent.get(c.id) || [], depth + 1);
      }
    };
    walk(roots, 0);
    panel.appendChild(frag);
  }

  commentsSection.innerHTML = '';
  commentsSection.appendChild(panel);
}

function renderComposer() {
  const panel = document.createElement('section');
  panel.className = 'panel';
  panel.innerHTML = `
    <div class="panel-body">
      <div class="field" style="margin-bottom:10px">
        <label class="label" for="commentBody">Add a comment</label>
        <textarea id="commentBody" maxlength="1000" placeholder="Keep it kind."></textarea>
      </div>
      <button class="btn btn-primary btn-block" id="submitComment">Comment</button>
    </div>`;
  container.after(panel);

  panel.querySelector('#submitComment').addEventListener('click', async () => {
    const box = panel.querySelector('#commentBody');
    const body = box.value.trim();
    if (!body) return;
    try {
      const envelope = await signedAction({
        type: 'comment', postId, body, parentId: null, ts: Date.now(), nonce: nonce()
      });
      await api('/api/comments', { method: 'POST', body: JSON.stringify(envelope) });
      box.value = '';
      await loadComments();
      toast('Comment posted');
    } catch (e) {
      toast(e.message);
    }
  });
}

/* -------------------------------------------------------------- boot */

(async () => {
  myAddr = await initIdentity();
  if (!postId) {
    container.innerHTML = '<div class="empty"><h2>No post specified</h2><p>That link looks incomplete.</p></div>';
    return;
  }
  try {
    const post = await api(`/api/posts/${postId}?addr=${encodeURIComponent(myAddr)}`);
    container.appendChild(renderPost(post));
    renderComposer();
    await loadComments();
  } catch (e) {
    container.innerHTML = `<div class="empty">
      <h2>Post unavailable</h2>
      <p>${escapeHtml(e.message)} — it may have been removed by a moderator.</p></div>`;
  }
})();
