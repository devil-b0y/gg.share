// GET  /api/posts  -- the public feed (live posts only)
// POST /api/posts  -- media upload (multipart: addr, pubkey, signature,
//                     payload [JSON string of the signed envelope], caption?, file)
import { route } from '@/lib/server/http/route';
import { json, errorJson } from '@/lib/server/http/errors';
import { parseMultipart } from '@/lib/server/http/multipart';
import { readLimiter, writeLimiter, checkUploadQuota } from '@/lib/server/security/ratelimit';
import { authenticateAction } from '@/lib/server/security/signed';
import { listFeed, parseFeedQuery } from '@/lib/server/content/posts';
import { appendBlock } from '@/lib/server/content/ledger';
import { ingestUpload } from '@/lib/server/media/ingest';
import { enqueueModeration } from '@/lib/server/media/queue';
import db from '@/lib/server/core/db';
import settings from '@/lib/server/core/settings';

const MAX_CAPTION_LEN = 500;

// Query: sort (latest|trending|top|discussed|controversial), kind, tag, q,
// limit, before (latest) / offset (ranked), addr (viewer, for vote state).
export const GET = route(async (ctx) => json(listFeed(parseFeedQuery(ctx.query))), {
  limit: [readLimiter]
});

export const POST = route(async (ctx) => {
  // The quota is checked before the body is read, so an over-quota client
  // can't make the server buffer a 100 MB upload first.
  const quota = checkUploadQuota(ctx.ip);
  if (!quota.allowed) {
    return errorJson(429, `Upload limit reached (${quota.limit} per hour). Try again later.`);
  }

  const { fields, file } = await parseMultipart(ctx.request);

  if (!settings.get('uploads_enabled')) {
    return errorJson(503, 'Uploads are temporarily disabled by the administrator.');
  }
  if (!file) return errorJson(400, 'no file provided');

  let payload;
  try {
    payload = JSON.parse(fields.payload);
  } catch {
    return errorJson(400, 'bad payload JSON');
  }

  const action = authenticateAction(ctx, fields, 'post', payload);
  if (!action.ok) return errorJson(action.status, action.error);
  const { addr, pubkey, iphash } = action;

  // Multipart fields arrive as arrays when a key is repeated, so the type
  // has to be checked rather than assumed.
  const caption = typeof fields.caption === 'string' ? fields.caption.slice(0, MAX_CAPTION_LEN) : '';

  const media = await ingestUpload(file.buffer);
  if (!media.ok) return errorJson(media.status, media.error, media.extra);

  const info = db.prepare(`
    INSERT INTO posts (addr, pubkey, media_type, file_hash, file_path, thumb_path, caption, width, height, status, iphash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(addr, pubkey, media.mediaType, media.fileHash, media.filePath, media.thumbPath,
    caption, media.width, media.height, iphash, Date.now());

  const postId = info.lastInsertRowid;
  appendBlock({ type: 'post', addr, refId: postId, payload });
  quota.record();
  enqueueModeration(postId);

  return json({ id: postId, status: 'pending', message: 'Uploaded. Awaiting automated moderation.' }, 202);
}, {
  limit: [writeLimiter]
});
