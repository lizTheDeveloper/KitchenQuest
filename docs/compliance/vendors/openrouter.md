# Vendor review: OpenRouter (C-34)

OpenRouter routes the Pan's requests (M4 mentor) to the model providers on the allow-list. It is the first and hardest processor review (compliance report §6, C-34). Nothing here is confirmed yet: every item is **[verify]** until the founder checks it against OpenRouter's current terms, and records the answer and its source here and in `processors.json`.

**Status:** the client is built (M4 Step 4) and **disabled in production**: with `NODE_ENV=production` the API refuses to boot with `AI_ENABLED=true` while `processors.json` lists `openrouter` or `openrouter-model-providers` with a `dpa_status` other than `signed` (P-11, N-9). Outside production it may run with synthetic data only (the eval, `npm run eval:mentor`).

## 1. The C-34 checklist

| Item | What we need | Finding |
|---|---|---|
| DPA | A signed data processing agreement (GDPR Art. 28; the MHMDA / state-law processor terms) covering OpenRouter and, through it, the upstream providers | **[verify]** not signed |
| Retention | Zero data retention for prompts and completions, at OpenRouter and at every allow-listed provider | **[verify]** |
| Training use | No training on, or other use of, our requests, at OpenRouter or the providers | **[verify]** |
| Sub-processors | The list (the model providers behind `AI_MODEL`), how changes are notified, and that our allow-list binds routing | **[verify]** |
| Region | Where OpenRouter and each allow-listed provider process requests; the transfer mechanism (SCCs or EU-US DPF) | **[verify]** |
| Breach-notice terms | Notice period and content, so our FTC HBNR, MHMDA and GDPR Art. 33 clocks can be met | **[verify]** |
| Deletion API | How to delete anything they hold; the target is that nothing is retained, so none is needed | **[verify]** |

## 2. The C-14 parameter-name check

The request body is pinned in `apps/api/src/ai/openrouter.ts` (`buildRequestBody`, marked `VERIFY`). Before production, confirm against OpenRouter's current API reference that each name below exists and does what we rely on, and record the date checked:

| Parameter we send | What we rely on | Checked |
|---|---|---|
| `provider.data_collection: "deny"` | Only providers that don't store or train on data are used | **[verify]** |
| `provider.zdr: true` | Only zero-data-retention endpoints are used | **[verify]** |
| `provider.only: AI_PROVIDERS` | Routing never leaves the allow-list | **[verify]** |
| `provider.order`, `allow_fallbacks: true` | The allow-list order, falling back only within it | **[verify]** |
| `provider.require_parameters: true` | A provider that ignores a parameter is skipped | **[verify]** |
| `reasoning: { enabled: false }`, `temperature: 0.3`, `max_tokens: 200` | §7.6b.6 inference settings | **[verify]** |
| no `user`, `metadata`, `transforms`, `HTTP-Referer`, `X-Title` | No identifiers leave us (C-13) | (code: tested) |

Also re-check the allow-list monthly from `/models/qwen/qwen3.8-27b/endpoints` (spike §6.6): exclude fp4 providers, and confirm each listed slug still serves the model. On 2026-11-11 the endpoints list showed Tenstorrent (fp8) but no longer ModelRun, so `AI_PROVIDERS` is now `tenstorrent` alone (controller ruling, M4 Step 12). One provider means no fallback: an outage or its rate limits (seen in the eval as many 429s) show as `ai_unavailable`, and the scripted Pan answers.

## 3. Account-level settings (founder actions)

- [ ] Prompt and completion logging **off** for the account (OpenRouter's "log inputs/outputs" or equivalent).
- [ ] Training / data-sharing opt-ins **off** for the account; the account's provider data policy set to deny providers that train or retain.
- [ ] MFA or a passkey on the OpenRouter account (C-36).
- [ ] A spend limit on the production key, separate from the synthetic-data dev key.
- [ ] Review the provider allow-list (`AI_PROVIDERS`, now `tenstorrent` alone): confirm each provider's ZDR and no-training status on OpenRouter, consider adding a second vetted non-fp4 provider for fallback, and record the date checked. A change moves the prompt fingerprint, so re-run `npm run eval:mentor`.
- [ ] Sign the DPA, then set `dpa_status` to `signed` for `openrouter` and `openrouter-model-providers` in `processors.json` (this is what lets production boot with AI on).
