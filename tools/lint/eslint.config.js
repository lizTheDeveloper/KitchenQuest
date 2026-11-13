// ESLint 9 flat config for the whole monorepo. Prettier owns formatting (eslint-config-prettier
// switches off every stylistic rule). See docs/engineering/code-quality.md.
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const root = fileURLToPath(new URL('../..', import.meta.url));

const TEST_FILES = [
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/test/**/*.ts',
  '**/tests/**/*.ts',
  '**/e2e/**/*.ts',
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.vite/**',
      '**/.data/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'apps/api/migrations/**', // generated, never hand-edited
      'art/**',
      'prototype/**',
      'data/**',
      'content/**',
      'recipes/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // Explicit project globs rather than `projectService`: the packages keep their tests in
        // tsconfig.test.json (so src can stay free of node types), and the project service only
        // ever reads tsconfig.json. tsconfig.eslint.json (root) covers config files, scripts and
        // e2e specs. Anything new under apps/* or packages/* with a tsconfig is picked up.
        project: [
          './apps/*/tsconfig.json',
          './apps/*/tsconfig.test.json',
          './apps/*/tsconfig.node.json',
          './apps/*/tsconfig.sw.json',
          './packages/*/tsconfig.json',
          './packages/*/tsconfig.test.json',
          './tsconfig.eslint.json',
        ],
        tsconfigRootDir: root,
      },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unnecessary-condition': 'warn',
      // `any` is allowed only with an inline disable and a reason:
      //   // eslint-disable-next-line @typescript-eslint/no-explicit-any -- <why>
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always'],
    },
  },

  // Plain JS/config files (no type information).
  {
    files: ['**/*.{js,cjs,mjs}'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { globals: globals.node, sourceType: 'commonjs' },
  },
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: { globals: globals.node },
  },

  // Runtime environments.
  { files: ['packages/core/src/**/*.ts'], languageOptions: { globals: {} } },
  { files: ['apps/api/**/*.ts'], languageOptions: { globals: globals.node } },
  { files: ['apps/voice/bench/**/*.ts'], languageOptions: { globals: globals.node } },
  { files: ['apps/game/**/*.ts'], languageOptions: { globals: globals.browser } },
  { files: ['**/vite.config.ts', '**/vitest.config.ts', '**/*.config.ts', 'scripts/**/*.ts'], languageOptions: { globals: globals.node } },

  // Tests: looser. Non-null assertions and a little `any` for fixtures are normal there.
  {
    files: TEST_FILES,
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },

  // Fastify route plugins are `async function xRoutes(app)` by convention (the plugin contract
  // is promise-returning) even when they only register handlers and never await. M7 Step 4: also
  // `*-routes.ts` (voice/status-routes.ts beside Step 5's voice/routes.ts).
  {
    files: ['apps/api/src/**/routes.ts', 'apps/api/src/**/*-routes.ts'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },

  // M7 C-18: apps/voice logs only through its typed logger (log.ts), which keeps numbers and enums, and writes nothing
  // to disk. No console; no process.stdout or process.stderr, as members or as node:process imports; no fs writes
  // (named, default, namespace or dynamic imports); no util.debuglog. log.ts is the one exception (fix round 2, N6).
  {
    files: ['apps/voice/src/**/*.ts'],
    ignores: ['apps/voice/src/log.ts'],
    languageOptions: { globals: globals.node },
    rules: {
      'no-console': 'error',
      'no-restricted-properties': [
        'error',
        { object: 'process', property: 'stdout', message: 'apps/voice logs only through log.ts (C-18).' },
        { object: 'process', property: 'stderr', message: 'apps/voice logs only through log.ts (C-18).' },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: ['process', 'node:process'].map((name) => ({
            name,
            importNames: ['stdout', 'stderr', 'default'],
            message: 'apps/voice logs only through log.ts (C-18).',
          })).concat(
            ['fs', 'node:fs', 'fs/promises', 'node:fs/promises'].map((name) => ({
              name,
              importNames: ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'write', 'writeSync', 'writev', 'writevSync', 'createWriteStream', 'open', 'openSync', 'cp', 'cpSync', 'copyFile', 'copyFileSync', 'mkdtemp', 'mkdtempSync', 'rename', 'renameSync', 'truncate', 'truncateSync', 'default'],
              message: 'apps/voice never writes to disk (C-18).',
            })),
            ['util', 'node:util'].map((name) => ({ name, importNames: ['debuglog', 'debug'], message: 'apps/voice logs only through log.ts (C-18).' })),
          ),
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportDeclaration[source.value=/^(node:)?(fs|fs\\/promises|process)$/] > ImportNamespaceSpecifier',
          message: 'apps/voice: import only the names it needs from fs or process (C-18).',
        },
        {
          selector: 'ImportExpression[source.value=/^(node:)?(fs|fs\\/promises|process|util)$/]',
          message: 'apps/voice: no dynamic import of fs, process or util (C-18).',
        },
      ],
    },
  },

  // Scripts and one-shot CLIs: console output is their interface.
  {
    files: ['scripts/**', 'apps/*/scripts/**', '**/*-cli.ts', '**/*.config.{ts,js,cjs,mjs}'],
    rules: { 'no-console': 'off' },
  },

  prettier,
);
