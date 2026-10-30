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
