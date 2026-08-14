'use strict';

/**
 * Where the cursor is, in the window's own coordinates.
 *
 * The renderer cannot answer this for itself. macOS delivers mouse-moved events
 * to the frontmost application, and this window belongs to an app that is never
 * frontmost — it is a background overlay you point at while working in something
 * else. So `mousemove` (and with it CSS `:hover`) only starts arriving once you
 * have clicked the overlay and activated it, which is exactly the wrong moment:
 * hovering has to work *without* taking focus, or the window steals the click you
 * meant for the editor underneath.
 *
 * Polling the cursor from the main process sidesteps the question. This is the
 * arithmetic half, kept separate from the polling so it can be tested without an
 * Electron window: both arguments are plain DIP rectangles/points.
 */

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/**
 * Returns null whenever the cursor is not over the content — including for a
 * degenerate window — so the caller can treat "not over it" and "cannot tell"
 * the same way: close the hover box.
 */
function localPoint(bounds, cursor) {
  if (!bounds || !cursor) return null;
  if (!finite(bounds.x) || !finite(bounds.y) || !finite(bounds.width) || !finite(bounds.height)) {
    return null;
  }
  if (!finite(cursor.x) || !finite(cursor.y)) return null;

  const x = cursor.x - bounds.x;
  const y = cursor.y - bounds.y;

  // Right and bottom edges are exclusive: a point at x === width is the first
  // column of whatever is beside the window, not the last column of this one.
  if (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) return null;

  return { x, y };
}

/**
 * The window a grip drag should produce, from the anchor taken at pointerdown and
 * where the cursor is now. Both cursor positions are in *screen* coordinates.
 *
 * The anchor is the whole point. Sizing a window from the cursor's position
 * *inside* it measures against a frame the same gesture is moving — drag the
 * south-west grip and the left edge walks, so the origin shifts underneath the
 * drag. Correcting for that needs the window's live bounds, and macOS applies
 * `setBounds` asynchronously, so the bounds read back and the next pointer event
 * disagree for a frame; the discrepancy feeds back and lands as a visible jump.
 * Windows applies it synchronously and so never showed the fault.
 *
 * Working from a fixed anchor removes the loop entirely: nothing read here is
 * anything the caller writes. It also preserves where inside the grip the drag
 * started, instead of snapping the corner onto the cursor.
 *
 * Which edges move is the corner's business: 'sw' holds the right edge still and
 * spends the whole width change on the left one, anything else holds the left.
 * The top edge never moves either way — these are bottom corners.
 */
function dragBounds(anchor, cursor, limits) {
  if (!anchor || !cursor || !limits) return null;
  for (const n of [anchor.cursorX, anchor.cursorY, anchor.x, anchor.y, anchor.width, anchor.height]) {
    if (!finite(n)) return null;
  }
  if (!finite(cursor.x) || !finite(cursor.y)) return null;

  const { minWidth, minHeight, maxSide } = limits;
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(n)));

  const dx = cursor.x - anchor.cursorX;
  const dy = cursor.y - anchor.cursorY;

  const height = clamp(anchor.height + dy, minHeight, maxSide);

  let width;
  let x = anchor.x;
  if (anchor.corner === 'sw') {
    width = clamp(anchor.width - dx, minWidth, maxSide);
    // Derived from the anchor's right edge, never the live one — that is what
    // keeps the held edge exactly still even when a move is dropped.
    x = anchor.x + anchor.width - width;
  } else {
    width = clamp(anchor.width + dx, minWidth, maxSide);
  }

  return { x, y: anchor.y, width, height };
}

module.exports = { localPoint, dragBounds };
