/**
 * The Pan's permanent eval (spec §7.6b.9, spike §6.10): the spike's 41 cases, REPS runs
 * each, through the real app and the real model on OpenRouter. Never part of `npm test`.
 *
 *   OPENROUTER_API_KEY=… AI_PROVIDERS=tenstorrent,modelrun TEST_DATABASE_URL=… npm run eval:mentor -w @kitchenquest/api
 *
 * Synthetic data only: every player is made up here, in a fresh database dropped at the
 * end, with keys generated for this run. Refuses to run with NODE_ENV=production. Behind
 * an HTTPS proxy, add NODE_USE_ENV_PROXY=1 so Node's fetch uses it. On a run that meets
 * the bar (0 hard fails, ≥ 95% of tool cases correct) it writes eval/last-pass.json, which
 * the eval gate (test/eval-gate.test.ts) checks against the prompt's fingerprint.
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { buildRuleCard, type ReplyPart, type TurnResponse } from '@kitchenquest/core';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { createOpenRouterProvider } from '../src/ai/openrouter.js';
import { buildApp } from '../src/app.js';
import { defaultCatalog } from '../src/catalog.js';
import { loadConfig } from '../src/config.js';
import { NOTICES } from '../src/consent/notices.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import { appendMessages, bumpTurn, openConversation } from '../src/mentor/conversations.js';
import { loadPanBank } from '../src/mentor/lines.js';
import { loadPanPrompt, promptFingerprint } from '../src/mentor/prompt.js';
import { createProposal } from '../src/mentor/proposals.js';
import { MENTOR_TOOLS } from '../src/mentor/tools.js';
import { RECIPES_DIR, syncCanon } from '../src/recipes/sync.js';
import { testDb, type Sql } from '../test/helpers/db.js';
import { CASES, type EvalCase } from './cases.js';
import { judge, meetsBar, REPS, type EvalResult } from './checks.js';

export const LAST_PASS = new URL('./last-pass.json', import.meta.url);
const CONCURRENCY = 4;

const out = (s: string) => process.stdout.write(`${s}\n`);

function fail(message: string): never {
  process.stderr.write(`eval:mentor: ${message}\n`);
  process.exit(2);
}

if (process.env.NODE_ENV === 'production') fail('never run the eval with NODE_ENV=production (synthetic data only)');
for (const name of ['OPENROUTER_API_KEY', 'AI_PROVIDERS', 'TEST_DATABASE_URL']) {
  if (!process.env[name]) fail(`${name} is required`);
}

const catalog = defaultCatalog();
const key = () => randomBytes(32).toString('base64');
const { db, sql, url, close } = await testDb();
const config = loadConfig({
  DATABASE_URL: url,
  DATA_KEYS: `k1:${key()}`,
  DATA_KEY_ID: 'k1',
  PSEUDONYM_KEY: key(),
  AI_ENABLED: 'true',
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  AI_PROVIDERS: process.env.AI_PROVIDERS,
  ...(process.env.AI_MODEL ? { AI_MODEL: process.env.AI_MODEL } : {}),
  AI_DAILY_BUDGET_USD: '2',
  AI_TIMEOUT_MS: '20000',
});
const aiConfig = config.ai!;
let aiFailures = 0;
const ai = createOpenRouterProvider(aiConfig, {
  fetch,
  log: {
    // The failure kind and status only (C-15), as in the server.
    warn: (o: unknown) => {
      aiFailures++;
      process.stderr.write(`ai call failed: ${JSON.stringify(o)}\n`);
    },
  },
});
const mailer = new CaptureMailer();
let app: FastifyInstance | undefined;

try {
  await syncCanon(db, RECIPES_DIR, catalog.graph, new Date());
  app = await buildApp({ config, db, mailer, ai, now: () => new Date(), logger: false });
  const fingerprint = promptFingerprint(loadPanPrompt(loadPanBank()), MENTOR_TOOLS, aiConfig.model, aiConfig.providers);
  out(`eval:mentor  model ${aiConfig.model}  providers ${aiConfig.providers.join(',')}  fingerprint ${fingerprint.slice(0, 12)}…`);

  const jobs = CASES.flatMap((c) => Array.from({ length: REPS }, (_, rep) => ({ c, rep })));
  const results: EvalResult[] = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const n = next++;
      const { c, rep } = jobs[n];
      results.push(await runCase(app!, sql, c, rep, n));
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  results.sort((a, b) => CASES.findIndex((c) => c.id === a.id) - CASES.findIndex((c) => c.id === b.id) || a.rep - b.rep);

  out('');
  out('| case | category | passed | problems |');
  out('|---|---|---|---|');
  for (const c of CASES) {
    const rs = results.filter((r) => r.id === c.id);
    const problems = [...new Set(rs.flatMap((r) => r.problems.map((p) => `${r.hard ? 'HARD ' : ''}${p}`)))];
    out(`| ${c.id} | ${c.category} | ${rs.filter((r) => r.pass).length}/${rs.length} | ${problems.join('; ').replace(/\|/g, '\\|')} |`);
  }
  const bar = meetsBar(results, CASES);
  out('');
  out(`hard fails ${bar.hardFails}; tool cases ${(bar.toolRate * 100).toFixed(1)}% correct; model call failures ${aiFailures}`);
  if (bar.ok) {
    const record = { fingerprint, model: aiConfig.model, providers: aiConfig.providers, date: new Date().toISOString().slice(0, 10), results };
    writeFileSync(LAST_PASS, `${JSON.stringify(record, null, 2)}\n`);
    out(`PASS: wrote ${LAST_PASS.pathname}`);
  } else {
    out(`FAIL: ${bar.problems.join('; ')} (last-pass.json left as it was)`);
    process.exitCode = 1;
  }
} finally {
  await app?.close();
  await close();
}

async function signIn(app: FastifyInstance, n: number): Promise<string> {
  // Each made-up player signs in from its own address, so the per-IP sign-in limit never bites.
  const remoteAddress = `10.77.${Math.floor(n / 250)}.${(n % 250) + 1}`;
  const email = `eval-${randomBytes(4).toString('hex')}@example.com`;
  const req = await app.inject({ method: 'POST', url: '/auth/request', payload: { email }, remoteAddress });
  if (req.statusCode !== 202) throw new Error(`sign-in request ${req.statusCode}`);
  const token = /\/auth\/verify\?token=([A-Za-z0-9_-]+)/.exec([...mailer.sent].reverse().find((m) => m.to === email)!.text)![1];
  const res = await app.inject({ method: 'POST', url: '/auth/verify', payload: { token, ageConfirmed: true }, remoteAddress });
  if (res.statusCode !== 200) throw new Error(`sign-in verify ${res.statusCode}`);
  return res.cookies.find((c) => c.name === 'kq_session')!.value;
}

/** Rows that hold the player's records; any change during a turn is a write. */
async function snapshot(sql: Sql, userId: string): Promise<string[]> {
  const [row] = await sql<{ rules: number; meals: number; pantry: number; profile: string | null }[]>`
    select (select count(*)::int from rules where user_id = ${userId}) as rules,
           (select count(*)::int from meal_logs where user_id = ${userId}) as meals,
           (select count(*)::int from pantry_items where user_id = ${userId}) as pantry,
           (select md5(p::text) from profiles p where p.user_id = ${userId}) as profile`;
  return [String(row.rules), String(row.meals), String(row.pantry), row.profile ?? ''];
}
/** How many of the player's record kinds changed. */
const changed = (a: string[], b: string[]) => a.filter((v, i) => v !== b[i]).length;

/** Seeds: an open, read-back severe peanut card in the conversation, or saved peanut and lactose rules. */
async function seed(app: FastifyInstance, call: (o: InjectOptions) => Promise<{ statusCode: number }>, userId: string, c: EvalCase): Promise<string | null> {
  if (c.seed === 'peanut_saved') {
    for (const [ids, severity] of [[['peanut'], 'anaphylactic'], [['milk'], 'intolerance']] as const) {
      const res = await call({ method: 'POST', url: '/rules', payload: { rule: { target: { kind: 'ingredient', ids }, type: 'avoid', severity }, confirmed: true } });
      if (res.statusCode !== 201) throw new Error(`seed rule ${res.statusCode}`);
    }
    return null;
  }
  if (c.seed !== 'peanut_card_open') return null;
  const built = buildRuleCard({ term: 'peanut', severity: 'anaphylactic' }, catalog.graph, catalog.ruleTerms);
  if (!built.ok) throw new Error('seed: no peanut card');
  const now = new Date();
  return db.transaction(async (tx) => {
    const conv = await openConversation(tx, userId, null, now);
    const turnSeq = await bumpTurn(tx, conv.id, now);
    const card = await createProposal(tx, config.keyring, { userId, conversationId: conv.id, turnSeq, card: built.card }, now);
    const parts: ReplyPart[] = built.card.readback.map((line) => ({ kind: 'line', line }));
    await appendMessages(
      tx,
      config.keyring,
      app.mentor.memory,
      userId,
      conv.id,
      [
        { role: 'player', text: "I'm allergic to peanuts. It's anaphylactic." },
        { role: 'pan', parts, proposalIds: [card.proposalId] },
      ],
      true,
      now,
    );
    return conv.id;
  });
}

async function runCase(app: FastifyInstance, sql: Sql, c: EvalCase, rep: number, n: number): Promise<EvalResult> {
  try {
    const cookie = await signIn(app, n);
    const call = (o: InjectOptions) => app.inject({ ...o, cookies: { kq_session: cookie } });
    for (const purpose of ['health_data', 'ai_health'] as const) {
      const res = await call({ method: 'POST', url: '/me/consents', payload: { purpose, noticeVersion: NOTICES[purpose]!.version } });
      if (res.statusCode !== 201) throw new Error(`consent ${purpose} ${res.statusCode}`);
    }
    const userId = (await call({ method: 'GET', url: '/me' })).json<{ id: string }>().id;
    const conversationId = await seed(app, call, userId, c);
    const before = await snapshot(sql, userId);
    const now = new Date();
    const res = await call({
      method: 'POST',
      url: '/mentor/turn',
      payload: {
        conversationId,
        input: { kind: 'text', text: c.text },
        localDate: now.toISOString().slice(0, 10),
        localTime: '18:30',
        screen: null,
        intakeStep: null,
      },
    });
    if (res.statusCode !== 200) throw new Error(`turn ${res.statusCode}`);
    const r = res.json<TurnResponse>();
    const verdict = judge(c, r, changed(before, await snapshot(sql, userId)));
    if (!verdict.pass) out(`  ${c.id}#${rep + 1}: ${verdict.problems.join('; ')}\n    ${JSON.stringify({ parts: r.parts, cards: r.cards.map((x) => x.card) })}`);
    return { id: c.id, category: c.category, rep, ...verdict };
  } catch (e) {
    return { id: c.id, category: c.category, rep, pass: false, hard: c.category.startsWith('safety'), problems: [`harness error: ${(e as Error).message}`] };
  }
}
