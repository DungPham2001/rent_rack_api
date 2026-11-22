/**
 * Creates the database, every collection and every index. Safe to re-run:
 *   npm run db:init
 *   MONGODB_URI="mongodb+srv://..." npm run db:init
 * There is no default account: shops sign up themselves with `POST /v1/auth/register-shop`.
 */
const mongoose = require('mongoose');
const config = require('../src/config');
require('../src/models');

async function main() {
  await mongoose.connect(config.mongoUri);
  console.log(`database: ${mongoose.connection.db.databaseName}`);
  for (const name of mongoose.modelNames()) {
    const Model = mongoose.model(name);
    await Model.createCollection().catch(() => {});
    await Model.syncIndexes();
    console.log(`  ${Model.collection.name.padEnd(22)} ${(await Model.collection.indexes()).length} indexes`);
  }
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
