/**
 * Real deletion (no soft delete) of a whole shop: every shop-owned collection, its accounts, sessions, reset codes,
 * idempotency receipts and counters. Used when the last admin deletes their account (spec 2.3, Google Play).
 */
const mongoose = require('mongoose');
const models = require('../models');
const tenant = require('../lib/tenant');

async function purgeShop(shopId) {
  await tenant.unscoped(async () => {
    const accountIds = (await models.Account.find({ shopId }).select('_id').lean()).map((a) => a._id);
    for (const name of mongoose.modelNames()) {
      const M = mongoose.model(name);
      if (!M.schema.path('shopId') || models.SHARED.has(M.collection.name)) continue;
      await M.deleteMany({ shopId });
    }
    await models.Session.deleteMany({ accountId: { $in: accountIds } });
    await models.PasswordReset.deleteMany({ accountId: { $in: accountIds } });
    await models.Receipt.deleteMany({ _id: { $regex: `^idem\\|${shopId}\\|` } });
    await models.Counter.deleteMany({ _id: { $regex: `^${shopId}\\|` } });
    await models.Account.deleteMany({ shopId });
  });
}

module.exports = { purgeShop };
