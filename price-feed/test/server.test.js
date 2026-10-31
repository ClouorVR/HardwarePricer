'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('a failed disk write keeps the previous served feed and reports the failure', async () => {
  const oldFeed = { generatedAt: '2026-10-01T00:00:00.000Z', prices: { gpu: { price: 100 } } };
  const newFeed = { generatedAt: '2026-10-02T00:00:00.000Z', count: 1, live: 1, prices: { gpu: { price: 150 } } };
  let handler;
  let finish;
  const completed = new Promise((resolve) => { finish = resolve; });
  const errors = [];
  const diskError = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  const dependencies = {
    http: { createServer: (callback) => {
      handler = callback;
      return { listen: (_port, ready) => ready() };
    } },
    fs: {
      readFileSync: () => JSON.stringify(oldFeed),
      writeFile: (_file, _body, callback) => callback(diskError),
      promises: { writeFile: async () => { throw diskError; } },
    },
    './fetch-prices': { buildPrices: async () => newFeed },
  };
  const filename = path.join(__dirname, '..', 'server.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: (name) => dependencies[name] || require(name),
    __dirname: path.dirname(filename),
    process: { env: {} },
    setInterval: () => {},
    console: {
      log: (message) => { if (message.includes('refreshed:')) finish(); },
      error: (...args) => { errors.push(args.join(' ')); finish(); },
    },
  }, { filename });
  await completed;
  let served;
  handler({ url: '/prices.json' }, { writeHead: () => {}, end: (body) => { served = JSON.parse(body); } });
  assert.deepEqual(served, oldFeed);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /disk full/);
  let health;
  handler({ url: '/health' }, { writeHead: () => {}, end: (body) => { health = body; } });
  assert.equal(health, 'ok 2026-10-01T00:00:00.000Z');
});

function loadServer({ env = {}, built, disk }) {
  let handler;
  let interval;
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const logs = [];
  const dependencies = {
    http: { createServer: (callback) => {
      handler = callback;
      return { listen: (_port, ready) => ready() };
    } },
    fs: {
      readFileSync: () => JSON.stringify(disk),
      promises: { writeFile: async () => {} },
    },
    './fetch-prices': { buildPrices: async () => built },
  };
  const filename = path.join(__dirname, '..', 'server.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: (name) => dependencies[name] || require(name),
    __dirname: path.dirname(filename),
    process: { env },
    setInterval: (_fn, ms) => { interval = ms; },
    console: { log: (m) => { logs.push(m); if (/refreshed|keeping/.test(m)) finish(); }, error: (...a) => { logs.push(a.join(' ')); finish(); } },
  }, { filename });
  const serve = () => {
    let body;
    handler({ url: '/prices.json' }, { writeHead: () => {}, end: (b) => { body = JSON.parse(b); } });
    return body;
  };
  return { done, serve, interval: () => interval, logs };
}

test('REFRESH_HOURS is kept to a timer range that works', () => {
  const feed = { generatedAt: '2026-10-01T00:00:00.000Z', live: 0, prices: {} };
  const big = loadServer({ env: { REFRESH_HOURS: '10000' }, built: feed, disk: feed });
  assert.ok(big.interval() <= 2147483647, `interval ${big.interval()} overflows`);
  const neg = loadServer({ env: { REFRESH_HOURS: '-5' }, built: feed, disk: feed });
  assert.ok(neg.interval() >= 15 * 60 * 1000, `interval ${neg.interval()} is too short`);
});

test('a refresh with no store prices does not replace a feed that has them', async () => {
  const live = { generatedAt: '2026-10-01T00:00:00.000Z', live: 3, prices: { gpu: { price: 150, src: 'ebay' } } };
  const baseline = { generatedAt: '2026-10-02T00:00:00.000Z', count: 1, live: 0, prices: { gpu: { price: 100, src: 'baseline' } } };
  const s = loadServer({ built: baseline, disk: live });
  await s.done;
  assert.deepEqual(s.serve(), live);
});
