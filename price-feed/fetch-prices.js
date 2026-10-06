#!/usr/bin/env node
/*
  fetch-prices.js - real-world hardware prices for Datacenter Sim.

  Reads hardware.json, looks every item up on Best Buy and eBay, and writes
  prices.json (the file the game downloads). Without API keys it still writes a
  valid prices.json from the baseline prices, so the game never breaks.

  Usage
    node fetch-prices.js                  live prices (API keys from env vars)
    node fetch-prices.js --offline        no network, baseline prices only
    node fetch-prices.js --only gpu_5090,cpu_r9_9950x --verbose

  Environment variables (all optional)
    BESTBUY_API_KEY       free key: https://developer.bestbuy.com
    EBAY_CLIENT_ID        free production keyset: https://developer.ebay.com
    EBAY_CLIENT_SECRET
    EBAY_MARKETPLACE      default EBAY_US

  Node 18+ (uses built-in fetch). No npm install needed.
*/
'use strict';

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const HW_FILE = path.join(DIR, 'hardware.json');
const OUT_FILE = path.join(DIR, 'prices.json');
const OVERRIDES_FILE = path.join(DIR, 'overrides.json');

const BESTBUY_DELAY_MS = 450; // free keys allow ~5 calls/s; stay well under
const EBAY_DELAY_MS = 350;
const TIMEOUT_MS = 15000;

// ---------------------------------------------------------------- helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Can't read ${path.basename(file)}: ${e.message}`);
  }
}

function parseArgs(argv) {
  const args = { offline: false, verbose: false, only: null, out: OUT_FILE };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--offline') args.offline = true;
    else if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (a === '--only') args.only = new Set(String(argv[++i] || '').split(',').filter(Boolean));
    else if (a.startsWith('--only=')) args.only = new Set(a.slice(7).split(',').filter(Boolean));
    else if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a.startsWith('--out=')) args.out = path.resolve(a.slice(6));
  }
  return args;
}

async function httpJson(url, options = {}, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...options, signal: ctrl.signal });
      const text = await res.text();
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        err.fatal = true;
        throw err;
      }
      return JSON.parse(text);
    } catch (e) {
      if (e.fatal || attempt >= retries) throw e;
      await sleep(1500 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------- title matching
// "2 x 16 GB" -> "2x16gb", "(2PK x 16GB)" -> "2x16gb", "RTX-5070 Ti" -> "rtx 5070 ti"
function normalize(title) {
  return ` ${String(title).toLowerCase()} `
    .replace(/(\d+)\s*pk\s*x\s*(\d+)/g, '$1x$2')
    .replace(/(\d+(?:\.\d+)?)\s*(gb|tb|w|mhz|btu)\b/g, '$1$2')
    .replace(/(\d+)\s*[x×]\s*(\d+)/g, '$1x$2')
    .replace(/[^a-z0-9.]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function hasTerm(norm, term) {
  return norm.includes(` ${normalize(term).trim()} `);
}

function titleMatches(title, feed) {
  const norm = normalize(title);
  for (const m of feed.must || []) if (!hasTerm(norm, m)) return false;
  for (const n of feed.not || []) if (hasTerm(norm, n)) return false;
  return true;
}

// ---------------------------------------------------------------- statistics
function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function median(values) {
  return percentile([...values].sort((a, b) => a - b), 0.5);
}

// Street price = 35th percentile after dropping outliers (cheap but real listings).
function streetPrice(prices) {
  let s = prices.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (s.length === 0) return null;
  if (s.length >= 4) {
    const q1 = percentile(s, 0.25);
    const q3 = percentile(s, 0.75);
    const iqr = q3 - q1;
    const kept = s.filter((x) => x >= q1 - 1.5 * iqr && x <= q3 + 1.5 * iqr);
    if (kept.length > 0) s = kept;
  }
  return { price: percentile(s, 0.35), n: s.length };
}

function inRange(feed) {
  const min = feed.min ?? 0;
  const max = feed.max ?? Infinity;
  return (x) => x >= min && x <= max;
}

function niceRound(x) {
  if (x >= 10000) return Math.round(x / 100) * 100;
  if (x >= 1000) return Math.round(x / 10) * 10;
  if (x >= 20) return Math.round(x);
  return Math.round(x * 100) / 100;
}

// ---------------------------------------------------------------- Best Buy
async function bestBuyPrice(item, log) {
  const key = process.env.BESTBUY_API_KEY;
  if (!key) return null;
  const feed = item.feed;
  const words = (feed.bb ? feed.bb.split(/\s+/) : feed.must || [])
    .map((w) => String(w).replace(/[^A-Za-z0-9.-]/g, ''))
    .filter((w) => w.length > 0 && !/^\d+x\d+/.test(w))
    .slice(0, 6);
  if (words.length === 0) return null;
  const filter = words.map((w) => `search=${encodeURIComponent(w)}`).join('&');
  const url = `https://api.bestbuy.com/v1/products(${filter})?format=json&pageSize=50`
    + `&show=sku,name,salePrice,regularPrice,onlineAvailability&apiKey=${encodeURIComponent(key)}`;
  const data = await httpJson(url);
  const ok = inRange(feed);
  const mult = feed.multiply || 1;
  const prices = (data.products || [])
    .filter((p) => titleMatches(p.name, feed))
    .map((p) => Number(p.salePrice ?? p.regularPrice) * mult)
    .filter(ok);
  log(`  bestbuy: ${data.products ? data.products.length : 0} results, ${prices.length} matched`);
  return streetPrice(prices);
}

// ---------------------------------------------------------------- eBay
let ebayToken = null;
let ebayTokenExpires = 0;

async function ebayAuth() {
  const id = process.env.EBAY_CLIENT_ID;
  const secret = process.env.EBAY_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (ebayToken && Date.now() < ebayTokenExpires - 60000) return ebayToken;
  const body = 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope');
  const data = await httpJson('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
    },
    body,
  });
  ebayToken = data.access_token;
  ebayTokenExpires = Date.now() + (data.expires_in || 7200) * 1000;
  return ebayToken;
}

const EBAY_CONDITIONS = {
  new: '1000',
  used: '2000|2010|2020|2030|2500|3000|4000|5000',
  any: null,
};

async function ebayPrice(item, log) {
  const token = await ebayAuth();
  if (!token) return null;
  const feed = item.feed;
  const mult = feed.multiply || 1;
  const min = Math.max(1, Math.floor((feed.min ?? 1) / mult));
  const max = Math.ceil((feed.max ?? 1000000) / mult);
  let filter = `buyingOptions:{FIXED_PRICE},price:[${min}..${max}],priceCurrency:USD`;
  const cond = EBAY_CONDITIONS[feed.cond || 'new'];
  if (cond) filter += `,conditionIds:{${cond}}`;
  const url = 'https://api.ebay.com/buy/browse/v1/item_summary/search'
    + `?q=${encodeURIComponent(feed.q)}&limit=100&filter=${encodeURIComponent(filter)}`;
  const data = await httpJson(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': process.env.EBAY_MARKETPLACE || 'EBAY_US',
    },
  });
  const ok = inRange(feed);
  const prices = (data.itemSummaries || [])
    .filter((it) => it.price && it.price.currency === 'USD' && titleMatches(it.title, feed))
    .map((it) => Number(it.price.value) * mult)
    .filter(ok);
  log(`  ebay: ${data.itemSummaries ? data.itemSummaries.length : 0} results, ${prices.length} matched`);
  return streetPrice(prices);
}

// ---------------------------------------------------------------- bundles & prebuilts
function partList(parts) {
  const list = [];
  for (const [slot, v] of Object.entries(parts || {})) {
    if (Array.isArray(v)) v.forEach((id) => list.push(id));
    else if (v) list.push(v);
    void slot;
  }
  return list;
}

function derivedPrice(item, priceOf) {
  let sum = 0;
  if (item.bundle) {
    for (const [id, n] of Object.entries(item.bundle)) {
      const p = priceOf(id);
      if (p == null) return null;
      sum += p * n;
    }
  } else if (item.parts) {
    for (const id of partList(item.parts)) {
      const p = priceOf(id);
      if (p == null) return null;
      sum += p;
    }
  } else {
    return null;
  }
  return sum * (item.premium ?? 1);
}

// ---------------------------------------------------------------- main
async function buildPrices(opts = {}) {
  const hw = readJson(HW_FILE);
  const overrides = readJson(OVERRIDES_FILE, {});
  const previous = readJson(opts.out || OUT_FILE, { prices: {} });
  const log = opts.verbose ? (...a) => console.log(...a) : () => {};
  const items = hw.items;
  const byId = Object.fromEntries(items.map((it) => [it.id, it]));

  const providers = {
    bestbuy: process.env.BESTBUY_API_KEY && !opts.offline ? 'on' : 'off',
    ebay: process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET && !opts.offline ? 'on' : 'off',
  };
  const errors = { bestbuy: 0, ebay: 0 };
  const prices = {};
  let live = 0;

  // 1) items with their own search
  for (const item of items) {
    if (item.builtin) continue;
    if (opts.only && !opts.only.has(item.id)) continue;
    if (!item.feed) continue;
    log(`${item.id}  (${item.name})`);
    const estimates = [];
    const sources = [];
    let samples = 0;
    if (providers.bestbuy === 'on') {
      try {
        const r = await bestBuyPrice(item, log);
        if (r) { estimates.push(r.price); sources.push('bestbuy'); samples += r.n; }
      } catch (e) {
        errors.bestbuy++;
        log(`  bestbuy error: ${e.message}`);
      }
      await sleep(BESTBUY_DELAY_MS);
    }
    if (providers.ebay === 'on') {
      try {
        const r = await ebayPrice(item, log);
        if (r) { estimates.push(r.price); sources.push('ebay'); samples += r.n; }
      } catch (e) {
        errors.ebay++;
        log(`  ebay error: ${e.message}`);
      }
      await sleep(EBAY_DELAY_MS);
    }
    if (estimates.length > 0) {
      let p = median(estimates);
      p = Math.min(Math.max(p, item.price / 3), item.price * 3); // sanity: never wilder than 3x
      prices[item.id] = { price: niceRound(p), base: item.price, src: sources.join('+'), n: samples };
      live++;
      log(`  -> $${prices[item.id].price} (baseline $${item.price})`);
    }
  }

  // 2) everything else: baseline, then bundles/prebuilts from their parts
  const priceOf = (id) => {
    if (prices[id]) return prices[id].price;
    const it = byId[id];
    return it ? it.price : null;
  };
  for (const item of items) {
    if (item.builtin || prices[item.id]) continue;
    if (opts.only && !opts.only.has(item.id) && !(item.bundle || item.parts)) continue;
    if (item.bundle || item.parts) continue; // second pass
    prices[item.id] = { price: item.price, base: item.price, src: 'baseline', n: 0 };
  }
  for (const item of items) {
    if (item.builtin || !(item.bundle || item.parts)) continue;
    const p = derivedPrice(item, priceOf);
    prices[item.id] = { price: niceRound(p ?? item.price), base: item.price, src: p == null ? 'baseline' : 'parts', n: 0 };
  }

  // 3) manual overrides win
  for (const [id, v] of Object.entries(overrides)) {
    const p = typeof v === 'number' ? v : v && v.price;
    if (byId[id] && Number.isFinite(p) && p > 0) prices[id] = { price: p, base: byId[id].price, src: 'override', n: 0 };
  }

  // 4) remember the previous price so the game can show trends
  for (const [id, rec] of Object.entries(prices)) {
    const old = previous.prices && previous.prices[id];
    if (old && Number.isFinite(old.price)) rec.prev = old.price;
  }

  return {
    schema: 1,
    game: 'datacenter-sim',
    generatedAt: new Date().toISOString(),
    currency: hw.currency || 'USD',
    providers: {
      bestbuy: providers.bestbuy === 'on' ? (errors.bestbuy ? `on (${errors.bestbuy} errors)` : 'on') : 'off',
      ebay: providers.ebay === 'on' ? (errors.ebay ? `on (${errors.ebay} errors)` : 'on') : 'off',
    },
    count: Object.keys(prices).length,
    live,
    prices,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const result = await buildPrices(args);
  if (args.only) {
    // partial run: merge into the existing file instead of replacing it
    const existing = readJson(args.out, { prices: {} });
    result.prices = { ...existing.prices, ...result.prices };
    result.count = Object.keys(result.prices).length;
  }
  fs.writeFileSync(args.out, JSON.stringify(result, null, 2) + '\n');
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`prices.json: ${result.count} items, ${result.live} live prices `
    + `(bestbuy ${result.providers.bestbuy}, ebay ${result.providers.ebay}) in ${secs}s`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
}

module.exports = { buildPrices, titleMatches, normalize, streetPrice };
