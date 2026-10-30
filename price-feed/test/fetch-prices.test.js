'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function fixture(t, items, { overrides = {}, previous = { prices: {} } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hardware-pricer-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(path.join(__dirname, '..', 'fetch-prices.js'), path.join(dir, 'fetch-prices.js'));
  fs.writeFileSync(path.join(dir, 'hardware.json'), JSON.stringify({ currency: 'USD', items }));
  fs.writeFileSync(path.join(dir, 'overrides.json'), JSON.stringify(overrides));
  fs.writeFileSync(path.join(dir, 'prices.json'), JSON.stringify(previous));
  return { dir, ...require(path.join(dir, 'fetch-prices.js')) };
}

const component = { id: 'gpu', price: 100 };
const bundle = { id: 'pc', price: 200, bundle: { gpu: 2 }, premium: 1.1 };

test('component overrides flow into bundle prices', async (t) => {
  const { buildPrices } = fixture(t, [component, bundle], { overrides: { gpu: 150 } });
  const result = await buildPrices({ offline: true });
  assert.equal(result.prices.gpu.price, 150);
  assert.equal(result.prices.pc.price, 330);
});

test('a direct bundle override wins over derived pricing', async (t) => {
  const { buildPrices } = fixture(t, [component, bundle], { overrides: { gpu: 150, pc: 400 } });
  const result = await buildPrices({ offline: true });
  assert.equal(result.prices.pc.price, 400);
  assert.equal(result.prices.pc.src, 'override');
});

test('nested bundles use updated costs regardless of catalog order', async (t) => {
  const rack = { id: 'rack', price: 400, bundle: { pc: 2 } };
  const { buildPrices } = fixture(t, [rack, bundle, component]);
  const result = await buildPrices({ offline: true });
  assert.equal(result.prices.pc.price, 220);
  assert.equal(result.prices.rack.price, 440);
});

test('cyclic bundle references fail with a useful error', async (t) => {
  const { buildPrices } = fixture(t, [
    { id: 'a', price: 100, bundle: { b: 1 } },
    { id: 'b', price: 100, bundle: { a: 1 } },
  ]);
  await assert.rejects(buildPrices({ offline: true }), /cycle.*a/i);
});

test('partial feed live count includes retained provider prices', async (t) => {
  const { dir } = fixture(t, [component, { id: 'cpu', price: 50 }], {
    previous: { prices: { gpu: { price: 180, base: 100, src: 'ebay', n: 4 } } },
  });
  const run = spawnSync(process.execPath, [path.join(dir, 'fetch-prices.js'), '--offline', '--only', 'cpu'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(fs.readFileSync(path.join(dir, 'prices.json'), 'utf8'));
  assert.equal(result.live, 1);
});

test('partial CLI refresh preserves untouched live components when recomputing bundles', (t) => {
  const previous = { prices: {
    gpu: { price: 180, base: 100, src: 'ebay', n: 4, prev: 170 },
    cpu: { price: 80, base: 50, src: 'ebay', n: 2 },
    pc: { price: 260, base: 150, src: 'parts', n: 0 },
  } };
  const { dir } = fixture(t, [component, { id: 'cpu', price: 50 },
    { id: 'pc', price: 150, parts: { gpu: ['gpu'], cpu: 'cpu' } }], { previous });
  const run = spawnSync(process.execPath, [path.join(dir, 'fetch-prices.js'), '--offline', '--only', 'cpu'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(fs.readFileSync(path.join(dir, 'prices.json'), 'utf8'));
  assert.deepEqual(result.prices.gpu, previous.prices.gpu);
  assert.equal(result.prices.cpu.price, 50);
  assert.equal(result.prices.pc.price, 230);
  assert.equal(result.prices.pc.prev, 260);
  assert.equal(result.live, 1);
  assert.equal(result.count, 3);
});

function ebayFixture(t, fetchImpl) {
  const names = ['BESTBUY_API_KEY', 'EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET'];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  delete process.env.BESTBUY_API_KEY;
  process.env.EBAY_CLIENT_ID = 'test-client';
  process.env.EBAY_CLIENT_SECRET = 'test-secret';
  t.after(() => {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });
  t.mock.method(globalThis, 'fetch', fetchImpl);
  return fixture(t, [{ ...component, feed: { q: 'test gpu', must: ['gpu'], min: 50, max: 300 } }]);
}

function response(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const listing = { itemSummaries: [{ title: 'Test GPU', price: { value: '150', currency: 'USD' } }] };

test('eBay renews a rejected cached token and retries the price request once', async (t) => {
  let grants = 0;
  let searches = 0;
  const { buildPrices } = ebayFixture(t, async (url, options) => {
    if (url.endsWith('/oauth2/token')) {
      grants++;
      assert.equal(options.headers.Authorization, 'Basic ' + Buffer.from('test-client:test-secret').toString('base64'));
      assert.equal(new URLSearchParams(options.body).get('grant_type'), 'client_credentials');
      return response({ access_token: `token-${grants}`, token_type: 'Application Access Token', expires_in: 7200 });
    }
    searches++;
    if (searches === 2) return response({ errors: [{ message: 'Invalid access token' }] }, 401);
    assert.equal(options.headers.Authorization, searches === 1 ? 'Bearer token-1' : 'Bearer token-2');
    return response(listing);
  });
  assert.equal((await buildPrices()).prices.gpu.price, 150);
  const result = await buildPrices();
  assert.equal(result.prices.gpu.price, 150);
  assert.equal(result.providers.ebay, 'on');
  assert.equal(grants, 2);
  assert.equal(searches, 3);
});

test('eBay stops after one renewal if the replacement token is also rejected', async (t) => {
  let grants = 0;
  let searches = 0;
  const { buildPrices } = ebayFixture(t, async (url) => {
    if (url.endsWith('/oauth2/token')) {
      grants++;
      return response({ access_token: `token-${grants}`, expires_in: 7200 });
    }
    searches++;
    return response({ errors: [{ message: 'Invalid access token' }] }, 401);
  });
  const result = await buildPrices();
  assert.equal(result.prices.gpu.src, 'baseline');
  assert.equal(result.providers.ebay, 'on (1 errors)');
  assert.equal(grants, 2);
  assert.equal(searches, 2);
});

test('eBay does not renew tokens for permission failures', async (t) => {
  let grants = 0;
  const { buildPrices } = ebayFixture(t, async (url) => {
    if (url.endsWith('/oauth2/token')) {
      grants++;
      return response({ access_token: 'token', expires_in: 7200 });
    }
    return response({ errors: [{ message: 'Access denied' }] }, 403);
  });
  assert.equal((await buildPrices()).prices.gpu.src, 'baseline');
  assert.equal(grants, 1);
});
