'use strict';

/**
 * Getting the tool being run into the visible part of a narrow row.
 *
 * A `Bash` row shows the command, and the row is roughly forty characters wide.
 * Real commands routinely spend more than that on preamble before the tool is
 * named — from a live capture:
 *
 *     cd ~/dev/own/claude-activity-monitor && node scripts/record.js status
 *     cd ~/dev/pacvolt/ConfigTool && python3 - <<'PY'
 *     SP=/private/tmp/claude-501/-Users-…-ConfigTool/127342a7-…/scratchpad …
 *     env -u ELECTRON_RUN_AS_NODE npm run pack
 *
 * Clipped at the right, all four read as a directory change or a variable, and
 * the one word that says what is happening — `node`, `python3`, `npm` — is off
 * the end. So the preamble is skipped and the row leads with the tool, marked
 * with an ellipsis so it is visibly not the whole command.
 *
 * Dropping the `cd` costs nothing that is not already on screen: the session's
 * directory is the heading directly above. And nothing is lost outright — the
 * hover pane still shows the command as recorded, which is the division of
 * labour everywhere in this window. The row is the glance; the pane is the
 * truth.
 *
 * Pure, and separate from the renderer, because the renderer cannot be tested
 * without an Electron window and this can. The resize bug shipped precisely
 * because its arithmetic lived somewhere untestable.
 */

// Each one eats a preamble *statement* from the front. Order matters only in
// that the loop reapplies them all until nothing matches, so several stacked
// preambles come off one at a time.
const PREAMBLE = [
  // VAR=value, including quoted values, with or without a trailing separator.
  /^[ \t]*[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|[^\s;&|]*)[ \t]*(?:(?:&&|;|\n)[ \t\n]*)?/,
  /^[ \t]*export[ \t]+[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|[^\s;&|]*)[ \t]*(?:(?:&&|;|\n)[ \t\n]*)?/,
  // A `cd`, but only when something follows it. `cd somewhere` on its own IS the
  // command, and eating it would leave the row blank.
  /^[ \t]*cd[ \t]+(?:"[^"]*"|'[^']*'|[^\s;&|]+)[ \t]*(?:&&|;|\n)[ \t\n]*/,
  // `env` and its options, which is how this repo's own build commands start.
  /^[ \t]*env[ \t]+(?:-[a-zA-Z][ \t]+[^\s]+[ \t]+|-[a-zA-Z]+[ \t]+|[A-Za-z_]\w*=[^\s]*[ \t]+)*/,
  // Wrappers that say nothing about what is being run.
  /^[ \t]*(?:sudo|nohup|time|exec|command)[ \t]+/,
];

/** Where the interesting part of a command starts, in characters. */
function leadOffset(command) {
  let rest = command;
  let cut = 0;

  // Bounded: a pathological string must not spin here, since this runs inside
  // the render loop several times a second.
  for (let pass = 0; pass < 12; pass += 1) {
    let matched = false;

    for (const re of PREAMBLE) {
      const m = rest.match(re);
      if (!m || !m[0].length) continue;

      const next = rest.slice(m[0].length);
      // Never strip into nothing, and never leave the row starting on an
      // operator — either would be a worse line than the one we began with.
      if (!next.trim() || /^[&|;]/.test(next.trim())) continue;

      rest = next;
      cut += m[0].length;
      matched = true;
      break;
    }

    if (!matched) break;
  }

  return cut;
}

/**
 * The command as the row should show it: unchanged when it already leads with
 * its tool, and otherwise the tail from the tool onward behind an ellipsis.
 * Returns null for anything unusable so the caller has one case, not three.
 */
function leadCommand(command) {
  if (typeof command !== 'string') return null;

  const cut = leadOffset(command);
  const shown = (cut ? command.slice(cut) : command).replace(/\s+/g, ' ').trim();
  if (!shown) return null;

  return cut ? '… ' + shown : shown;
}

module.exports = { leadCommand, leadOffset };
