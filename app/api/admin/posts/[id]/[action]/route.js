// POST /api/admin/posts/:id/:action
//   action = remove | approve | blacklist | restore | purge
// The rules for each live in lib/server/content/moderation.js; every
// successful action is written to the audit log.
import { route } from '@/lib/server/http/route';
import { json, errorJson } from '@/lib/server/http/errors';
import { POST_ACTIONS, audit } from '@/lib/server/content/moderation';
import { ADMIN } from '../../../../_shared/admin-options';

export const POST = route(async (ctx) => {
  const { id, action } = ctx.params;
  const handler = Object.prototype.hasOwnProperty.call(POST_ACTIONS, action) ? POST_ACTIONS[action] : null;
  if (!handler) return errorJson(404, 'not found');

  const result = handler.run(id);
  if (!result.ok) return errorJson(result.status, result.error);

  audit(handler.audit, id, null);
  return json({ ok: true });
}, ADMIN);
