/** Mongoose plugin: scopes a collection to the current shop (see tenant.js). */
const tenant = require('./tenant');

const QUERY_OPS = [
  'find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace', 'updateOne', 'updateMany', 'replaceOne',
  'deleteOne', 'deleteMany', 'countDocuments', 'distinct',
];

module.exports = function tenantPlugin(schema) {
  schema.add({ shopId: { type: String, default: null } });
  schema.index({ shopId: 1 });

  schema.pre(QUERY_OPS, function scope() {
    const shop = tenant.current();
    if (shop) this.where({ shopId: shop });
  });
  schema.pre('aggregate', function scopeAggregate() {
    const shop = tenant.current();
    if (shop) this.pipeline().unshift({ $match: { shopId: shop } });
  });
  schema.pre('validate', function stamp() {
    const shop = tenant.current();
    if (shop && this.isNew && !this.shopId) this.shopId = shop;
  });
  schema.pre('insertMany', function stampMany(next, docs) {
    const shop = tenant.current();
    if (shop && Array.isArray(docs)) for (const d of docs) if (d && !d.shopId) d.shopId = shop;
    next();
  });
};
