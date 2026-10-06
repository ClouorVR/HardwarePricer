#!/usr/bin/env node
/*
  gen-catalog.js - turns hardware.json into the game's Luau catalog module.

    node price-feed/gen-catalog.js            writes ../src/shared/Catalog.luau
    node price-feed/gen-catalog.js out.luau   writes somewhere else

  Then paste the file into ReplicatedStorage.Shared.Catalog (or let Rojo sync it).
  Search hints ("feed") stay out of the game; everything else is copied.
*/
'use strict';

const fs = require('fs');
const path = require('path');

const hw = JSON.parse(fs.readFileSync(path.join(__dirname, 'hardware.json'), 'utf8'));
const out = path.resolve(process.argv[2] || path.join(__dirname, '..', 'src', 'shared', 'Catalog.luau'));

const RESERVED = new Set(['and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'if', 'in',
  'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while', 'continue', 'type', 'export']);

function key(k) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !RESERVED.has(k) ? k : `[${JSON.stringify(k)}]`;
}

function lua(v) {
  if (v === null || v === undefined) return 'nil';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(6)));
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `{ ${v.map(lua).join(', ')} }`;
  const parts = Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => `${key(k)} = ${lua(x)}`);
  return parts.length ? `{ ${parts.join(', ')} }` : '{}';
}

// sanity checks: unique ids, every referenced id exists
const ids = new Set();
for (const it of hw.items) {
  if (ids.has(it.id)) throw new Error(`duplicate id ${it.id}`);
  ids.add(it.id);
}
const refs = [];
for (const it of hw.items) {
  for (const id of Object.keys(it.bundle || {})) refs.push([it.id, id]);
  for (const id of Object.keys(it.grants || {})) refs.push([it.id, id]);
  for (const v of Object.values(it.parts || {})) (Array.isArray(v) ? v : [v]).forEach((id) => refs.push([it.id, id]));
}
for (const [from, id] of refs) if (!ids.has(id)) throw new Error(`${from} references unknown item ${id}`);

const lines = [];
lines.push('--[[');
lines.push('\tCATALOG: every piece of hardware in the game (AUTO-GENERATED, do not edit by hand).');
lines.push('\tSource: price-feed/hardware.json -> run `node price-feed/gen-catalog.js`.');
lines.push(`\tBaseline prices: US street prices around ${hw.baselineDate}. Live prices come from the price feed.`);
lines.push(']]');
lines.push('');
lines.push('local Catalog = {}');
lines.push(`Catalog.baselineDate = ${lua(hw.baselineDate)}`);
lines.push('local list: { any } = {');
for (const it of hw.items) {
  const copy = { ...it };
  delete copy.feed;
  lines.push(`\t${lua(copy)},`);
}
lines.push('}');
lines.push('Catalog.list = list');
lines.push('');
lines.push('Catalog.items = {} :: { [string]: any }');
lines.push('for i, def in ipairs(Catalog.list) do');
lines.push('\tdef.order = i');
lines.push('\tCatalog.items[def.id] = def');
lines.push('end');
lines.push('');
lines.push('return Catalog');
lines.push('');

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, lines.join('\n'));
console.log(`Catalog.luau: ${hw.items.length} items -> ${out}`);
