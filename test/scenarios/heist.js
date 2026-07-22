'use strict';

/**
 * Three terminals planning a museum job that nobody has thought all the way
 * through. Same shape as the other scenarios: three terminals, each with more
 * prompts, tools and agent descriptions than a run will use, so successive runs
 * with different seeds look different.
 */
module.exports = {
  name: 'heist',
  blurb: 'A museum job, planned across three terminals by people who should not be planning it.',
  terminals: [
    {
      project: 'getaway-van',
      cwd: '/Users/demo/dev/getaway-van',
      prompts: [
        'The van only starts downhill. Plan around that.',
        'Find a parking space that is legal at 3am on a Tuesday',
        'Work out how long the van holds a charge with the radio on',
      ],
      tools: [
        { tool: 'Bash', detail: 'route --avoid=hills --avoid=cameras' },
        { tool: 'Read', detail: 'parking-bylaws-1987.pdf' },
        { tool: 'Grep', detail: 'tow zone' },
        { tool: 'Edit', detail: 'escape-route.ts' },
        { tool: 'WebSearch', detail: 'jump starting a van quietly' },
      ],
      agents: [
        'Find a downhill start within two blocks of the loading dock',
        'Check whether the van is still registered to anyone real',
        'Time the route with the radio on and the radio off',
        'Work out what the tow zone hours actually are',
        'Sort out a story for the parking attendant',
      ],
    },
    {
      project: 'museum-floorplan',
      cwd: '/Users/demo/dev/museum-floorplan',
      prompts: [
        'Which gallery is the loading dock actually attached to?',
        'Map the guard rotation against the cafe opening hours',
        'The floorplan and the fire exit map disagree — reconcile them',
      ],
      tools: [
        { tool: 'Read', detail: 'east-wing-floorplan.svg' },
        { tool: 'Grep', detail: 'motion sensor' },
        { tool: 'Bash', detail: 'diff floorplan.json fire-exits.json' },
        { tool: 'WebFetch', detail: 'https://museum.example/visit/opening-hours' },
        { tool: 'Task', detail: 'reconcile the two maps' },
      ],
      agents: [
        'Reconcile the floorplan against the fire exit map',
        'Chart the guard rotation against the cafe opening hours',
        'Find which door the loading dock actually opens onto',
        'Count the motion sensors in the east wing',
        'Check whether the skylight opens from the inside',
      ],
    },
    {
      project: 'alibi-service',
      cwd: '/Users/demo/dev/alibi-service',
      prompts: [
        'Three of us claim to be at the same wedding. Fix the seating chart.',
        'Generate an alibi that survives one follow-up question',
        'Back-date the bowling league scores, plausibly',
      ],
      tools: [
        { tool: 'Bash', detail: 'npm run alibi -- --for=tuesday --plausible' },
        { tool: 'Edit', detail: 'seating-chart.json' },
        { tool: 'Grep', detail: 'wedding' },
        { tool: 'Read', detail: 'bowling-league-scores.csv' },
        { tool: 'WebSearch', detail: 'what time do weddings actually end' },
      ],
      agents: [
        'Reseat the wedding so three people are not at one chair',
        'Stress-test the alibi with one follow-up question',
        'Back-date the bowling scores without breaking the averages',
        'Check whether anyone actually knows the bride',
        'Draft the version of Tuesday we are all telling',
      ],
    },
  ],
};
