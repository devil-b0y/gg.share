// Shared handlers for the like and dislike endpoints, which differ only in
// which vote they toggle. Kept in one place so the two can't drift apart.
//
// `_shared` is a private folder: Next.js never turns a folder starting with
// an underscore into a route.
import { json, errorJson } from '@/lib/server/http/errors';
import { authenticateAction, toRowId } from '@/lib/server/security/signed';
import { isLivePost } from '@/lib/server/content/posts';
import { toggleVote, hasVote, VOTE_TABLES } from '@/lib/server/content/votes';

/** POST handler: verify the signed vote, then toggle it. */
export function voteHandler(kind) {
  return async (ctx) => {
    const action = authenticateAction(ctx, ctx.body, kind);
    if (!action.ok) return errorJson(action.status, action.error);

    const postId = toRowId(action.payload.postId);
    if (!postId) return errorJson(400, 'invalid post id');
    if (!isLivePost(postId)) return errorJson(404, 'post not found');

    return json(toggleVote(kind, postId, action.addr, action.payload));
  };
}

/** GET handler: the given address's current vote state on a post. Bad
 * input answers "no vote" rather than an error, as before. */
export function voteStateHandler(kind) {
  const { resultKey } = VOTE_TABLES[kind];
  return async (ctx) => {
    const postId = toRowId(ctx.params.postId);
    const addr = ctx.query.get('addr');
    if (!postId || !addr) return json({ [resultKey]: false });
    return json({ [resultKey]: hasVote(kind, postId, addr) });
  };
}
