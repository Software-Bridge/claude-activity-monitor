#!/usr/bin/env node
'use strict';

/**
 * Turns a capture of real work into one that can be published.
 *
 *   node scripts/scrub-recording.js --file=<capture>                  # what is in it
 *   node scripts/scrub-recording.js --file=<capture> --map=<map.json> --out=<file>
 *
 * A capture is a faithful record, which is the point of it and also the problem:
 * it carries real working directories, real file names, real prompt text and real
 * subagent descriptions. Anything derived from one and committed has to be read
 * and rewritten first, deliberately, by someone who knows what is sensitive.
 *
 * So the default mode reports rather than transforms. It prints every distinct
 * string a viewer of the replay could read, grouped by where it comes from, and
 * writes a map skeleton with every one of them as a key. You edit that map - the
 * values are what the published capture will say - and run it again to apply.
 *
 * There is no automatic redaction and there is deliberately no guessing: a tool
 * that silently decided what looked sensitive would be trusted, and would
 * eventually be wrong in the direction that matters.
 */

const fs = require('fs');
const path = require('path');

const FIELDS = {
  cwd: (p) => p.cwd,
  prompt: (p) => p.prompt,
  session_title: (p) => p.session_title,
  command: (p) => p.tool_input && p.tool_input.command,
  file_path: (p) => p.tool_input && (p.tool_input.file_path || p.tool_input.path),
  pattern: (p) => p.tool_input && p.tool_input.pattern,
  query: (p) => p.tool_input && p.tool_input.query,
  url: (p) => p.tool_input && p.tool_input.url,
  tool_description: (p) => p.tool_input && p.tool_input.description,
};

function load(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((e) => e && e.payload);
}

function collect(entries) {
  const found = {};
  const add = (kind, value) => {
    if (typeof value !== 'string' || !value.trim()) return;
    (found[kind] = found[kind] || new Map()).set(value, (found[kind].get(value) || 0) + 1);
  };

  for (const entry of entries) {
    for (const [kind, get] of Object.entries(FIELDS)) add(kind, get(entry.payload));
    add('agent_description', entry.description);
    add('session_id', entry.payload.session_id);
  }
  return found;
}

function report(entries) {
  const found = collect(entries);
  const skeleton = {};

  for (const kind of Object.keys(FIELDS).concat(['agent_description', 'session_id'])) {
    const values = found[kind];
    if (!values) continue;
    console.log(`\n${kind}  (${values.size} distinct)`);
    for (const [value, n] of [...values].sort((a, b) => b[1] - a[1])) {
      const one = value.replace(/\s+/g, ' ').trim();
      console.log(`  ${String(n).padStart(4)}x  ${one.length > 100 ? one.slice(0, 99) + '…' : one}`);
      skeleton[value] = value;
    }
  }
  return skeleton;
}

/**
 * Substring replacement, longest key first, so a map that renames both a project
 * and a path inside it cannot have the shorter rename eat the longer one.
 */
function applyMap(text, pairs) {
  let out = text;
  for (const [from, to] of pairs) out = out.split(from).join(to);
  return out;
}

function scrub(entries, map) {
  const pairs = Object.entries(map).sort((a, b) => b[0].length - a[0].length);
  const walk = (value) => {
    if (typeof value === 'string') return applyMap(value, pairs);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };
  return entries.map(walk);
}

const args = {};
for (const arg of process.argv.slice(2)) {
  const [k, v] = arg.replace(/^--/, '').split('=');
  args[k] = v === undefined ? true : v;
}

// `--file path` (a space, not an =) parses as the boolean true, which would
// otherwise reach readFileSync and fail with an unhelpful type error.
if (typeof args.file !== 'string') {
  console.error('usage: scrub-recording.js --file=<capture> [--map=<map.json> --out=<file>]');
  process.exit(2);
}

const entries = load(args.file);
console.log(`${entries.length} event(s) in ${path.basename(args.file)}`);

if (!args.map) {
  const skeleton = report(entries);
  const out = args.out || `${args.file.replace(/\.jsonl$/, '')}.map.json`;
  fs.writeFileSync(out, JSON.stringify(skeleton, null, 2) + '\n');
  console.log(`\nmap skeleton written to ${out}`);
  console.log('Edit the values, then re-run with --map=<that file> --out=<scrubbed.jsonl>.');
  console.log('Every value still equal to its key is a decision not yet made.');
} else {
  if (!args.out) {
    console.error('--out is required when applying a map');
    process.exit(2);
  }
  const map = JSON.parse(fs.readFileSync(args.map, 'utf8'));
  const unchanged = Object.entries(map).filter(([k, v]) => k === v).length;
  const scrubbed = scrub(entries, map);
  fs.writeFileSync(args.out, scrubbed.map((e) => JSON.stringify(e)).join('\n') + '\n');
  console.log(`wrote ${scrubbed.length} event(s) to ${args.out}`);
  console.log(`${Object.keys(map).length - unchanged} replacement(s) applied` +
    (unchanged ? `; ${unchanged} value(s) left identical to their key` : ''));
}
