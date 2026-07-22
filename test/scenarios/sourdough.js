'use strict';

/**
 * Three terminals running a bakery as if it were a distributed system, which is
 * the joke: the starter has a CI pipeline, the ovens are a cluster, and the
 * frosting is behind an API with a rate limit.
 */
module.exports = {
  name: 'sourdough',
  blurb: 'A bakery operated as a distributed system, with predictable results.',
  terminals: [
    {
      project: 'starter-ci',
      cwd: '/Users/demo/dev/starter-ci',
      prompts: [
        'The starter failed its overnight build again — find out why',
        'Pin the hydration ratio so the nightly stops drifting',
        'Someone fed the starter twice. Work out who and when.',
      ],
      tools: [
        { tool: 'Bash', detail: 'npm run feed -- --ratio=1:1:1' },
        { tool: 'Read', detail: 'nightly-rise.log' },
        { tool: 'Grep', detail: 'FAILED: did not double' },
        { tool: 'Edit', detail: 'hydration.config.ts' },
        { tool: 'WebSearch', detail: 'why is my starter sluggish at 18C' },
      ],
      agents: [
        'Find out why the starter failed its overnight build',
        'Pin the hydration ratio and stop the nightly drifting',
        'Work out who fed the starter twice on Thursday',
        'Correlate rise failures against the kitchen thermostat',
        'Write a health check that does not involve tasting it',
      ],
    },
    {
      project: 'oven-cluster',
      cwd: '/Users/demo/dev/oven-cluster',
      prompts: [
        'Oven three keeps dropping out of the cluster mid-bake',
        'Rebalance the trays — one oven is doing all the work',
        'Give me a bake schedule that survives losing an oven',
      ],
      tools: [
        { tool: 'Bash', detail: 'ovenctl status --all' },
        { tool: 'Read', detail: 'oven-3-thermal.log' },
        { tool: 'Grep', detail: 'node oven-3 left the cluster' },
        { tool: 'Edit', detail: 'tray-scheduler.ts' },
        { tool: 'Task', detail: 'drain oven three safely' },
      ],
      agents: [
        'Find out why oven three keeps leaving the cluster',
        'Rebalance the trays away from the hot oven',
        'Draft a bake schedule that tolerates losing one oven',
        'Check whether the door seal explains the thermal log',
        'Drain oven three without losing the loaves in it',
      ],
    },
    {
      project: 'frosting-api',
      cwd: '/Users/demo/dev/frosting-api',
      prompts: [
        'The frosting endpoint is rate limiting the birthday orders',
        'Cache the buttercream so we stop remaking it per request',
        'Sprinkles are being applied twice. Make it idempotent.',
      ],
      tools: [
        { tool: 'Bash', detail: 'curl -s localhost:8080/frosting/buttercream' },
        { tool: 'Read', detail: 'ratelimit.md' },
        { tool: 'Grep', detail: '429 Too Many Sprinkles' },
        { tool: 'Edit', detail: 'sprinkle-idempotency.ts' },
        { tool: 'WebFetch', detail: 'https://bakery.example/orders/birthday' },
      ],
      agents: [
        'Work out what is rate limiting the birthday orders',
        'Cache the buttercream instead of remaking it per request',
        'Make sprinkle application idempotent',
        'Trace a birthday order end to end through the ovens',
        'Find out whether anyone is paginating the cupcakes',
      ],
    },
  ],
};
