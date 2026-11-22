/** To-dos with repeat (spec 10): finishing a repeating to-do moves `due` forward instead of ticking it off. */
const mongoose = require('mongoose');
const settings = require('./settings');
const { notFound } = require('../lib/errors');
const T = require('../lib/time');

const addMonth = (date) => {
  const [y, m, d] = date.split('-').map(Number);
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d, last))).toISOString().slice(0, 10);
};

async function complete(id) {
  const M = mongoose.model('Todo');
  const todo = await M.findById(id).lean();
  if (!todo) throw notFound();
  const S = await settings.ctx();
  const base = todo.due || S.today;
  const set = { updatedAt: new Date() };
  if (todo.repeat === 'daily') set.due = T.addDays(base, 1);
  else if (todo.repeat === 'weekly') set.due = T.addDays(base, 7);
  else if (todo.repeat === 'monthly') set.due = addMonth(base);
  else set.done = true;
  await M.updateOne({ _id: id }, { $set: set });
  const r = await M.findById(id).lean();
  return { id, title: r.title, due: r.due, repeat: r.repeat, done: r.done, updatedAt: r.updatedAt.toISOString() };
}

module.exports = { complete, addMonth };
