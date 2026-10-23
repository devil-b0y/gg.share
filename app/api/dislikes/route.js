// POST /api/dislikes -- toggles a dislike. Body: { addr, pubkey, signature,
//   payload: { type: 'dislike', postId, ts, nonce } }  ->  { disliked: bool }
// Mutually exclusive with likes (see lib/server/content/votes.js).
import { route } from '@/lib/server/http/route';
import { writeLimiter } from '@/lib/server/security/ratelimit';
import { voteHandler } from '../_shared/vote-handlers';

export const POST = route(voteHandler('dislike'), { limit: [writeLimiter], body: 'json' });
