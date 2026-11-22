/**
 * Background work (spec 11), run by the cron (`GET /v1/jobs/run`, Vercel Cron daily; safe to call as often as every few
 * minutes): holds past `until` expire (logged as the system), old revoked sessions are removed. Expired sessions go by TTL.
 */
const { Session } = require('../models');
const holds = require('./holds');
const tenant = require('../lib/tenant');
const { Hold } = require('../models');

async function run() {
  // holds of every shop: find the shops that have a due hold, then expire them inside that shop
  const shops = await tenant.unscoped(() => Hold.distinct('shopId', { status: 'active', until: { $lt: new Date() } }));
  let expired = 0;
  for (const shopId of shops) expired += await tenant.run(shopId, () => holds.expireDue());
  const s = await Session.deleteMany({ revokedAt: { $lt: new Date(Date.now() - 30 * 86400000) } });
  return { ok: true, holdsExpired: expired, revokedSessionsRemoved: s.deletedCount || 0 };
}

module.exports = { run };
