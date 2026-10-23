// GET /api/likes/:postId/mine?addr=... -- whether that address likes the post.
import { route } from '@/lib/server/http/route';
import { writeLimiter } from '@/lib/server/security/ratelimit';
import { voteStateHandler } from '../../../_shared/vote-handlers';

export const GET = route(voteStateHandler('like'), { limit: [writeLimiter] });
