#!/usr/bin/env node
/*
  server.js - optional: host the price feed as a tiny web service
  (Render, Railway, Fly.io, a VPS, ...). Not needed if you use the GitHub Action.

    GET /prices.json   current prices (same format as prices.json)
    GET /health        "ok" + last refresh time

  Env: PORT (default 8080), REFRESH_HOURS (default 12), plus the API keys
  described in fetch-prices.js. Node 18+, no npm install needed.
*/
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { buildPrices } = require('./fetch-prices');

const PORT = Number(process.env.PORT) || 8080;
// a timer can't wait longer than ~24.8 days (2^31 ms): longer, negative or junk values made it fire nonstop
const refreshRaw = Number(process.env.REFRESH_HOURS);
const REFRESH_HOURS = Math.min(Math.max(Number.isFinite(refreshRaw) && refreshRaw > 0 ? refreshRaw : 12, 0.25), 595);
const FILE = path.join(__dirname, 'prices.json');

let body = null;
let lastRefresh = null;
let refreshing = false;

function loadFromDisk() {
  try {
    body = fs.readFileSync(FILE, 'utf8');
    lastRefresh = JSON.parse(body).generatedAt || null;
  } catch {
    body = null;
  }
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const result = await buildPrices({ out: FILE });
    // a refresh with no store prices (no keys, or the stores failed) never replaces a feed that has them
    let currentLive = 0;
    try { currentLive = body ? JSON.parse(body).live || 0 : 0; } catch { currentLive = 0; }
    if (!(result.live > 0) && currentLive > 0) {
      console.log(`[prices] refresh found no store prices (bestbuy ${result.providers && result.providers.bestbuy}, `
        + `ebay ${result.providers && result.providers.ebay}); keeping the current feed`);
      return;
    }
    await fs.promises.writeFile(FILE, JSON.stringify(result, null, 2) + '\n');
    body = JSON.stringify(result);
    lastRefresh = result.generatedAt;
    console.log(`[prices] refreshed: ${result.count} items, ${result.live} live`);
  } catch (e) {
    console.error('[prices] refresh failed, keeping old prices:', e.message);
  } finally {
    refreshing = false;
  }
}

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/prices.json' || url === '/') {
    if (!body) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('prices not ready yet');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
  } else if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`ok ${lastRefresh || 'never'}${refreshing ? ' (refreshing)' : ''}`);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
});

loadFromDisk();
server.listen(PORT, () => console.log(`[prices] listening on :${PORT}, refresh every ${REFRESH_HOURS}h`));
refresh();
setInterval(refresh, REFRESH_HOURS * 3600 * 1000);
