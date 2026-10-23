// POST /api/likes -- toggles a like. Body: { addr, pubkey, signature,
//   payload: { type: 'like', postId, ts, nonce } }  ->  { liked: bool }
import { route } from '@/lib/server/http/route';
import { writeLimiter } from '@/lib/server/security/ratelimit';
import { voteHandler } from '../_shared/vote-handlers';

export const POST = route(voteHandler('like'), { limit: [writeLimiter], body: 'json' });
