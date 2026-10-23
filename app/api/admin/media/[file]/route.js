// GET /api/admin/media/:file -- media in any state (live, pending, quarantined)
// so the admin can see what they're moderating. Admin sessions only, and
// confined to the uploads tree by media/storage.js#resolveMediaFile.
import { route } from '@/lib/server/http/route';
import { fileResponse } from '@/lib/server/http/files';
import { resolveMediaFile, LIVE_DIR, QUARANTINE_DIR, PENDING_DIR } from '@/lib/server/media/storage';
import { ADMIN } from '../../../_shared/admin-options';

export const GET = route(async (ctx) => {
  const fullPath = resolveMediaFile(ctx.params.file, [LIVE_DIR, QUARANTINE_DIR, PENDING_DIR]);
  if (!fullPath) return new Response(null, { status: 404 });
  return fileResponse(ctx.request, fullPath);
}, ADMIN);
