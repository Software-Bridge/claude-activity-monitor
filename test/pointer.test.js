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

const { localPoint, dragBounds } = require('../src/pointer');

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

// ---------------------------------------------------- the grip drag ----
//
// This arithmetic shipped without a test and a real bug went with it: sizing the
// window from the cursor's position *inside* it fed the window's own movement
// back into the next frame's input, which macOS's asynchronous setBounds turned
// into a visible snap. The cases below are the ones that would have caught it —
// above all that a held edge stays exactly where it was, and that the result
// depends on nothing but the anchor.

const LIMITS = { minWidth: 240, minHeight: 80, maxSide: 4000 };
// Grabbed 9px in from the card's left edge and 9px up from its bottom, which is
// roughly the middle of a grip.
const SE = { corner: 'se', cursorX: 1500, cursorY: 450, x: 1171, y: 46, width: 340, height: 415 };
const SW = { corner: 'sw', cursorX: 1180, cursorY: 450, x: 1171, y: 46, width: 340, height: 415 };

// The zero-delta case is the one the old code got wrong: it snapped the corner
// onto the cursor, so merely pressing the grip resized the window before any
// drag had happened.
check('pressing without moving changes nothing (se)', dragBounds(SE, { x: 1500, y: 450 }, LIMITS), { x: 1171, y: 46, width: 340, height: 415 });
check('pressing without moving changes nothing (sw)', dragBounds(SW, { x: 1180, y: 450 }, LIMITS), { x: 1171, y: 46, width: 340, height: 415 });

// South-east: the origin is untouched and the delta lands on the size.
check('se out and down grows both sides', dragBounds(SE, { x: 1600, y: 550 }, LIMITS), { x: 1171, y: 46, width: 440, height: 515 });
check('se inward shrinks without moving the origin', dragBounds(SE, { x: 1450, y: 400 }, LIMITS), { x: 1171, y: 46, width: 290, height: 365 });

// South-west: the right edge is the anchor. Width and x have to move together,
// and 1171 + 340 = 1511 has to still be the right edge afterwards.
const swOut = dragBounds(SW, { x: 1080, y: 550 }, LIMITS);
check('sw out and down grows leftward', swOut, { x: 1071, y: 46, width: 440, height: 515 });
check('sw keeps the right edge still', swOut.x + swOut.width, 1511);
const swIn = dragBounds(SW, { x: 1240, y: 450 }, LIMITS);
check('sw inward shrinks from the left', swIn, { x: 1231, y: 46, width: 280, height: 415 });
check('sw still keeps the right edge still', swIn.x + swIn.width, 1511);

// The top edge belongs to neither corner: these are the bottom two.
check('the top edge never moves', dragBounds(SE, { x: 1600, y: 200 }, LIMITS).y, 46);

// Absolute, not incremental: the same cursor gives the same window however it
// got there, which is what makes a dropped or repeated move harmless.
check('the same cursor gives the same window', dragBounds(SE, { x: 1600, y: 550 }, LIMITS), dragBounds(SE, { x: 1600, y: 550 }, LIMITS));

// Clamping holds the anchored edge too — a drag past the minimum must not walk
// the right edge left, which is how a clamp bug would look on screen.
const swTiny = dragBounds(SW, { x: 1600, y: 450 }, LIMITS);
check('sw clamps to the minimum width', swTiny.width, 240);
check('sw holds the right edge even when clamped', swTiny.x + swTiny.width, 1511);
check('se clamps to the minimum height', dragBounds(SE, { x: 1500, y: 0 }, LIMITS).height, 80);
check('a runaway drag clamps to the maximum', dragBounds(SE, { x: 99999, y: 99999 }, LIMITS).width, 4000);

// Same contract as localPoint: anything unusable is null rather than a guess.
check('a missing anchor is null', dragBounds(null, { x: 1, y: 1 }, LIMITS), null);
check('a missing cursor is null', dragBounds(SE, null, LIMITS), null);
check('a non-finite cursor is null', dragBounds(SE, { x: NaN, y: 450 }, LIMITS), null);
check('a non-finite anchor is null', dragBounds({ ...SE, width: NaN }, { x: 1500, y: 450 }, LIMITS), null);

let failed = 0;
for (const r of results) {
  const ok = r.actual === r.expected;
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${r.label}${ok ? '' : `  (got ${r.actual}, want ${r.expected})`}`);
}
console.log(failed ? `\n${failed} failing` : '\nall passing');
process.exit(failed ? 1 : 0);
