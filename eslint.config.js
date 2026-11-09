// The real config lives in tools/lint (its own workspace, see tools/lint/package.json for why).
// ESLint finds this file at the repo root; `export *` keeps one config for the whole monorepo.
export { default } from './tools/lint/eslint.config.js';
