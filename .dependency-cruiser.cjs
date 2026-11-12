/**
 * Architecture rules, checked by `npm run lint` (dependency-cruiser). See
 * docs/engineering/code-quality.md. Paths are repo-relative.
 */

// Node built-ins, with or without the `node:` prefix.
const NODE_BUILTINS =
  '^(node:|(assert|async_hooks|buffer|child_process|cluster|console|constants|crypto|dgram|diagnostics_channel|dns|domain|events|fs|http|http2|https|inspector|module|net|os|path|perf_hooks|process|punycode|querystring|readline|repl|stream|string_decoder|sys|timers|tls|trace_events|tty|url|util|v8|vm|wasi|worker_threads|zlib)(/|$))';

module.exports = {
  forbidden: [
    {
      name: 'core-no-node-builtins',
      comment:
        'packages/core is pure TypeScript with no I/O: it may not use Node built-ins. ' +
        '(Tests under packages/core/test and *.test.ts files may, e.g. node:fs.)',
      severity: 'error',
      from: { path: '^packages/core/src', pathNot: '\\.test\\.ts$' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'core-no-node-builtins-by-name',
      comment: 'Same rule, for built-ins imported with the node: prefix (not always typed "core").',
      severity: 'error',
      from: { path: '^packages/core/src', pathNot: '\\.test\\.ts$' },
      to: { path: NODE_BUILTINS },
    },
    {
      name: 'core-no-apps',
      comment: 'packages/core never imports from apps/; dependencies point inward only.',
      severity: 'error',
      from: { path: '^packages/core' },
      to: { path: '^apps/' },
    },
    {
      name: 'game-no-api',
      comment: 'apps/game never imports from apps/api. Share code through packages/core.',
      severity: 'error',
      from: { path: '^apps/game' },
      to: { path: '^apps/api/' },
    },
    {
      name: 'game-no-api-package',
      comment: 'Same rule, for the workspace package name.',
      severity: 'error',
      from: { path: '^apps/game' },
      to: { path: '(^|/)@kitchenquest/api(/|$)' },
    },
    {
      name: 'voice-no-api',
      comment:
        'M7: apps/voice (the voice service) never imports from apps/api or apps/game. It speaks core\'s upstream ' +
        'protocol and knows no user (C-15); share code through packages/core.',
      severity: 'error',
      from: { path: '^apps/voice' },
      to: { path: '^apps/(api|game)/|(^|/)@kitchenquest/(api|game)(/|$)' },
    },
    {
      name: 'api-no-voice',
      comment:
        'M7: apps/api reaches the voice service over its WebSocket only, never by importing apps/voice. The one ' +
        'exception: the API\'s memory-only test uses the shared C-18 leak detectors (Step 5).',
      severity: 'error',
      from: { path: '^apps/api', pathNot: '^apps/api/test/voice-memory-only\\.test\\.ts$' },
      to: { path: '^apps/voice/|(^|/)@kitchenquest/voice(/|$)' },
    },
    {
      name: 'api-voice-leak-detectors-only',
      comment: 'M7 Step 5: the API memory-only test may import apps/voice\'s shared leak detectors, and nothing else of apps/voice.',
      severity: 'error',
      from: { path: '^apps/api/test/voice-memory-only\\.test\\.ts$' },
      to: { path: '^apps/voice/', pathNot: '^apps/voice/test/leak-detectors\\.ts$' },
    },
    {
      name: 'game-no-voice',
      comment: 'M7: apps/game never imports apps/voice; the device talks to the API, which talks to the voice service.',
      severity: 'error',
      from: { path: '^apps/game' },
      to: { path: '^apps/voice/|(^|/)@kitchenquest/voice(/|$)' },
    },
    {
      name: 'c10-org-no-health-modules',
      comment:
        'Compliance C-10: org data is never joined to health data. Nothing under an org/ path ' +
        'may import the health modules (rules/, consent/health-data, crypto/userkeys). ' +
        'No org/ exists yet; this guards the future. See also apps/api/test/architecture.test.ts.',
      severity: 'error',
      from: { path: '(^|/)org/' },
      to: { path: '(^|/)(rules/|consent/health-data|crypto/userkeys)' },
    },
    {
      name: 'no-circular',
      comment: 'Circular dependencies make load order fragile. Break the cycle (extract the shared part).',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.eslint.json' },
    exclude: { path: ['(^|/)dist/', '(^|/)\\.vite/', '^apps/api/migrations/', '^tools/'] },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
