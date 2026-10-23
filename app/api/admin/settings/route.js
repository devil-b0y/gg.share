// GET  /api/admin/settings -> { settings, defaults, rules }
// POST /api/admin/settings { key: value, ... } -> { ok, settings }
import { route } from '@/lib/server/http/route';
import { json, errorJson } from '@/lib/server/http/errors';
import settings from '@/lib/server/core/settings';
import { audit } from '@/lib/server/content/moderation';
import { ADMIN, ADMIN_JSON } from '../../_shared/admin-options';

export const GET = route(async () => json({
  settings: settings.getAll(),
  defaults: settings.DEFAULTS,
  rules: settings.RULES
}), ADMIN);

export const POST = route(async (ctx) => {
  const updates = ctx.body;
  if (typeof updates !== 'object' || updates === null || Array.isArray(updates)) {
    return errorJson(400, 'expected an object of settings');
  }

  // Validate the whole batch first, then apply. A half-applied update would
  // leave the moderation thresholds in a combination the admin never chose.
  const accepted = [];
  for (const key of Object.keys(updates)) {
    if (!settings.isKnownSetting(key)) return errorJson(400, `unknown setting: ${key}`);
    if (!settings.isValid(key, updates[key])) {
      const rule = settings.RULES[key];
      const range = rule.type === 'boolean' ? 'true or false' : `${rule.type} between ${rule.min} and ${rule.max}`;
      return errorJson(400, `invalid value for ${key} (expected ${range})`);
    }
    accepted.push(key);
  }

  for (const key of accepted) settings.set(key, updates[key]);
  audit('update_settings', null, Object.fromEntries(accepted.map((k) => [k, updates[k]])));
  return json({ ok: true, settings: settings.getAll() });
}, ADMIN_JSON);
