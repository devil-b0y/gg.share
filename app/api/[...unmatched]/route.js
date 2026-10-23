// Any /api/* path no other route matches -> JSON 404, for every method.
// Without this, Next.js would answer API clients with its HTML 404 page.
import { route } from '@/lib/server/http/route';
import { errorJson } from '@/lib/server/http/errors';
import { readLimiter } from '@/lib/server/security/ratelimit';

const notFound = route(async () => errorJson(404, 'not found'), { limit: [readLimiter] });

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
