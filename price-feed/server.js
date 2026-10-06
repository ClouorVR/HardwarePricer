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
const REFRESH_HOURS = Number(process.env.REFRESH_HOURS) || 12;
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
    body = JSON.stringify(result);
    lastRefresh = result.generatedAt;
    fs.writeFile(FILE, JSON.stringify(result, null, 2) + '\n', () => {});
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
