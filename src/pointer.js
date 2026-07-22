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

module.exports = { localPoint };
