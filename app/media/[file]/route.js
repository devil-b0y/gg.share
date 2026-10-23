// GET /media/:file -- public media.
//
// Only uploads/live/ is exposed here. Anything still pending, in review, or
// quarantined is only reachable through the authenticated admin media route
// (app/api/admin/media/[file]). Filenames are the content's own SHA-256, so
// responses are cached immutably.
import { fileResponse } from '@/lib/server/http/files';
import { resolveMediaFile, LIVE_DIR } from '@/lib/server/media/storage';

export async function GET(request, { params }) {
  const { file } = await params;
  const fullPath = resolveMediaFile(file, [LIVE_DIR]);
  if (!fullPath) return new Response('not found', { status: 404 });
  return fileResponse(request, fullPath, { immutable: true });
}
