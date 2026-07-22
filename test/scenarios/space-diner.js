'use strict';

/**
 * Three terminals running a pancake restaurant in low orbit. The threads are
 * deliberately entangled — the syrup shortage, pancake #7 and the raccoon each
 * show up in more than one terminal — so a viewer watching the window can tell
 * the sections apart and still see one story.
 */
module.exports = {
  name: 'space-diner',
  blurb: 'A pancake diner in low orbit, its pantry, and the comet that delivers.',
  terminals: [
    {
      project: 'orbital-diner',
      cwd: '/Users/demo/dev/orbital-diner',
      prompts: [
        'Get the griddle back to 190°C before the breakfast rush',
        'Pancake #7 came out square again — find out why',
        'Ration the syrup until the pantry resupplies',
      ],
      tools: [
        { tool: 'Bash', detail: 'npm run flip -- --stack=7' },
        { tool: 'Read', detail: 'griddle-thermostat.md' },
        { tool: 'Grep', detail: 'syrup' },
        { tool: 'Edit', detail: 'batter-viscosity.ts' },
        { tool: 'WebSearch', detail: 'does maple syrup pour in zero gravity' },
      ],
      agents: [
        'Work out why pancake #7 keeps coming out square',
        'Chase the raccoon out of the walk-in freezer',
        'Calibrate the griddle against the thermostat log',
        'Draft an apology for table four',
        'Audit the syrup ration before the rush',
      ],
    },
    {
      project: 'asteroid-pantry',
      cwd: '/Users/demo/dev/asteroid-pantry',
      prompts: [
        'Find out who signed for eleven crates of syrup and none of the flour',
        'Reconcile the pantry inventory with the diner order',
        'The raccoon has a keycard. Revoke it.',
      ],
      tools: [
        { tool: 'Bash', detail: 'inventory --count-crates --loud' },
        { tool: 'Read', detail: 'manifest-2287.csv' },
        { tool: 'Grep', detail: 'signed_by: raccoon' },
        { tool: 'Write', detail: 'flour-reorder.json' },
        { tool: 'Task', detail: 'trace the missing flour' },
      ],
      agents: [
        'Trace the eleven crates of syrup back to a signature',
        'Cross-check the flour count against the diner order',
        'Revoke the raccoon keycard and log the incident',
        'Find a supplier who delivers past the asteroid belt',
        'Recount shelf 9 — the numbers disagree with themselves',
      ],
    },
    {
      project: 'comet-delivery',
      cwd: '/Users/demo/dev/comet-delivery',
      prompts: [
        'Replot the syrup run before the comet swings out of range',
        'The flour is on the wrong comet. Fix it.',
        'Give the diner an honest ETA for once',
      ],
      tools: [
        { tool: 'Bash', detail: 'plot-course --to=orbital-diner --fuel=low' },
        { tool: 'Read', detail: 'comet-window.txt' },
        { tool: 'WebFetch', detail: 'https://ephemeris.example/comet/halley' },
        { tool: 'Edit', detail: 'delivery-eta.ts' },
        { tool: 'Grep', detail: 'crate_id' },
      ],
      agents: [
        'Replot the syrup run for the closing comet window',
        'Work out which comet the flour actually left on',
        'Compute an ETA the diner can plan a rush around',
        'Check the cargo bay seals before the burn',
        'Negotiate a slot with the asteroid pantry dock',
      ],
    },
  ],
};
