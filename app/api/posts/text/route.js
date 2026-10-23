// POST /api/posts/text -- a short text post.
//
// Signed exactly like a media post, but there's no file, so it skips the
// upload quota (which is about bandwidth and disk) and the NSFW pipeline
// (nothing to scan) and goes live immediately. Text still passes through
// reports and moderation. Body: { addr, pubkey, signature,
// payload: { type: 'text_post', body, ts, nonce } }
import { route } from '@/lib/server/http/route';
import { json, errorJson } from '@/lib/server/http/errors';
import { writeLimiter } from '@/lib/server/security/ratelimit';
import { authenticateAction } from '@/lib/server/security/signed';
import { validateBody, saveTags } from '@/lib/server/content/text';
import { appendBlock } from '@/lib/server/content/ledger';
import db from '@/lib/server/core/db';
import settings from '@/lib/server/core/settings';

export const POST = route(async (ctx) => {
  if (!settings.get('uploads_enabled')) {
    return errorJson(503, 'Posting is temporarily disabled by the administrator.');
  }

  const action = authenticateAction(ctx, ctx.body, 'text_post');
  if (!action.ok) return errorJson(action.status, action.error);
  const { addr, pubkey, payload, iphash } = action;

  const checked = validateBody(payload.body);
  if (!checked.ok) return errorJson(400, checked.error);

  // Cooldown: text posts are cheap to produce, so the guard is a short gap
  // between posts from the same address rather than a bandwidth quota.
  const lastPost = db.prepare(
    "SELECT created_at FROM posts WHERE addr = ? AND kind = 'text' ORDER BY id DESC LIMIT 1"
  ).get(addr);
  const cooldownMs = settings.get('text_post_cooldown_seconds') * 1000;
  if (lastPost && Date.now() - lastPost.created_at < cooldownMs) {
    const wait = Math.ceil((cooldownMs - (Date.now() - lastPost.created_at)) / 1000);
    return errorJson(429, `Please wait ${wait}s before posting again.`);
  }

  const info = db.prepare(`
    INSERT INTO posts (addr, pubkey, kind, body, status, iphash, created_at)
    VALUES (?, ?, 'text', ?, 'live', ?, ?)
  `).run(addr, pubkey, checked.body, iphash, Date.now());

  const postId = info.lastInsertRowid;
  const tags = saveTags(postId, checked.body);
  appendBlock({ type: 'post', addr, refId: postId, payload });

  return json({ id: postId, status: 'live', tags }, 201);
}, {
  limit: [writeLimiter],
  body: 'json'
});
