// GET /api/posts/tags/trending -- most-used hashtags across recent live posts.
import { route } from '@/lib/server/http/route';
import { json } from '@/lib/server/http/errors';
import { readLimiter } from '@/lib/server/security/ratelimit';
import { trendingTags } from '@/lib/server/content/text';

export const GET = route(async () => json({ tags: trendingTags(12) }), {
  limit: [readLimiter]
});
