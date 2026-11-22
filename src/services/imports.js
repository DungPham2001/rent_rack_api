/**
 * CSV import (spec 10). The app reads the file and previews it; the server re-validates every row with the same rules
 * as the normal create endpoints: `POST /import/:type/preview { rows }` shows what would be created, `/commit` creates
 * the valid rows (rows with errors are skipped and reported). Pieces may name their style by `styleCode`, styles their
 * category by `categoryName`.
 */
const mongoose = require('mongoose');
const { byPath } = require('../resources/defs');
const { AppError } = require('../lib/errors');
const { noAccent } = require('../lib/util');
const audit = require('./audit');

const M = (name) => mongoose.model(name);
const TYPES = ['categories', 'styles', 'pieces', 'accessories', 'staff', 'customers', 'partners', 'suppliers', 'supplies', 'promos', 'faq'];
const MAX_ROWS = 1000;

/** Row fields that reference another table by a human key. */
async function resolvers(type) {
  if (type === 'pieces') {
    const styles = await M('Style').find({}).select('code').lean();
    const by = new Map(styles.map((s) => [noAccent(s.code), s._id]));
    return (row) => (row.styleCode && !row.styleId ? { ...row, styleId: by.get(noAccent(row.styleCode)) || row.styleCode } : row);
  }
  if (type === 'styles') {
    const cats = await M('Category').find({}).select('name').lean();
    const by = new Map(cats.map((c) => [noAccent(c.name), c._id]));
    return (row) => (row.categoryName && !row.categoryId ? { ...row, categoryId: by.get(noAccent(row.categoryName)) || row.categoryName } : row);
  }
  return (row) => row;
}

const errorOf = (err) => (err instanceof AppError ? { code: err.code, fields: err.extra?.fields || [], data: err.extra?.data } : { code: 'internal_error', fields: [] });

async function run(auth, type, body, { commit }) {
  const res = byPath[type];
  if (!TYPES.includes(type) || !res) throw new AppError(404, 'not_found');
  const rows = Array.isArray(body?.rows) ? body.rows : null;
  if (!rows || !rows.length) throw new AppError(400, 'validation_failed', { fields: [{ field: 'rows', code: 'required' }] });
  if (rows.length > MAX_ROWS) throw new AppError(400, 'validation_failed', { fields: [{ field: 'rows', code: 'too_long' }] });
  const resolve = await resolvers(type);
  const uniqueKey = res.def.unique?.[0]?.length === 1 ? res.def.unique[0][0] : null;
  const seen = new Set();
  const results = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = resolve(rows[i] && typeof rows[i] === 'object' ? { ...rows[i] } : {});
    delete row.id;
    try {
      if (uniqueKey && row[uniqueKey]) {
        const k = noAccent(String(row[uniqueKey]));
        if (seen.has(k)) throw new AppError(409, 'duplicate_code', { fields: [{ field: uniqueKey, code: 'duplicate_in_file' }] });
        seen.add(k);
      }
      if (commit) {
        const doc = await res.insert(row, auth);
        results.push({ row: i + 1, ok: true, id: doc._id });
      } else {
        await res.insert(row, auth, { dryRun: true });
        if (uniqueKey && row[uniqueKey] && (await res.model.exists({ [uniqueKey]: String(row[uniqueKey]).trim() }))) throw new AppError(409, 'duplicate_code', { fields: [{ field: uniqueKey, code: 'duplicate' }] });
        results.push({ row: i + 1, ok: true });
      }
    } catch (err) {
      if (!(err instanceof AppError) && err.code !== 11000) throw err;
      results.push({ row: i + 1, ok: false, error: err.code === 11000 ? { code: 'duplicate_code', fields: [] } : errorOf(err) });
    }
  }
  const created = results.filter((r) => r.ok).length;
  if (commit) await audit.log(auth, 'import', type, 'import_csv', `${created}/${rows.length} rows`);
  return { type, total: rows.length, valid: created, invalid: rows.length - created, ...(commit ? { created } : {}), results };
}

module.exports = { run, TYPES };
