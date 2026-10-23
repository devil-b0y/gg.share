// GET /api/posts/:id -- one live post. `?addr=` adds the viewer's vote state.
import { route } from '@/lib/server/http/route';
import { json, errorJson } from '@/lib/server/http/errors';
import { readLimiter } from '@/lib/server/security/ratelimit';
import { toRowId } from '@/lib/server/security/signed';
import { getPublicPost } from '@/lib/server/content/posts';

export const GET = route(async (ctx) => {
  const id = toRowId(ctx.params.id);
  const post = id && getPublicPost(id, ctx.query.get('addr') || '');
  return post ? json(post) : errorJson(404, 'not found');
}, {
  limit: [readLimiter]
});
