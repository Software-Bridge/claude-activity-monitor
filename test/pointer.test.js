#!/usr/bin/env node
'use strict';

/**
 * The cursor-to-window arithmetic behind the hover box. Pure, so it is tested
 * here rather than through a window: the Electron test covers what the renderer
 * does with a point, and this covers whether the point is the right one.
 *
 * The cases that matter are the boundaries. Getting an edge wrong shows up as a
 * box that opens with the cursor a pixel outside the window, or one that will
 * not open on the first row because the window's own origin was not subtracted.
 */

const { localPoint } = require('../src/pointer');

const BOUNDS = { x: 1171, y: 46, width: 340, height: 415 };

const results = [];
const check = (label, actual, expected) =>
  results.push({ label, actual: JSON.stringify(actual), expected: JSON.stringify(expected) });

// Screen coordinates in, window coordinates out — the window's own origin has to
// come off, or every row is resolved 1171px to the left of where it is.
check('a point inside becomes window-relative', localPoint(BOUNDS, { x: 1191, y: 66 }), { x: 20, y: 20 });
check('the top-left corner is inside', localPoint(BOUNDS, { x: 1171, y: 46 }), { x: 0, y: 0 });
check('the last pixel is inside', localPoint(BOUNDS, { x: 1510, y: 460 }), { x: 339, y: 414 });

// Exclusive far edges: a point at x === width belongs to whatever is beside the
// window, and treating it as inside would hold the box open past the border.
check('the right edge is outside', localPoint(BOUNDS, { x: 1511, y: 200 }), null);
check('the bottom edge is outside', localPoint(BOUNDS, { x: 1300, y: 461 }), null);
check('a point left of the window is outside', localPoint(BOUNDS, { x: 1170, y: 200 }), null);
check('a point above the window is outside', localPoint(BOUNDS, { x: 1300, y: 45 }), null);

// Everything unusable is the same answer — "not over it" — so the caller has one
// case to handle rather than three.
check('a window with no size is outside', localPoint({ x: 0, y: 0, width: 0, height: 0 }, { x: 0, y: 0 }), null);
check('missing bounds are outside', localPoint(null, { x: 10, y: 10 }), null);
check('a missing cursor is outside', localPoint(BOUNDS, null), null);
check('a non-finite cursor is outside', localPoint(BOUNDS, { x: NaN, y: 46 }), null);
check('non-finite bounds are outside', localPoint({ x: 0, y: 0, width: Infinity, height: 10 }, { x: 1, y: 1 }), null);

let failed = 0;
for (const r of results) {
  const ok = r.actual === r.expected;
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${r.label}${ok ? '' : `  (got ${r.actual}, want ${r.expected})`}`);
}
console.log(failed ? `\n${failed} failing` : '\nall passing');
process.exit(failed ? 1 : 0);
