# Milestone 1: Recipe & Allergy Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task lives in its own step file below; tick boxes there.

**Goal:** A tested, UI-free TypeScript package that parses Cooklang recipes, resolves ingredients through an ingredient graph, checks recipes against arbitrary allergy/diet rules (✅/🔁/⛔/❓), and computes per-serving nutrition.

**Architecture:** npm workspaces monorepo. The existing Phaser scaffold moves to `apps/game`; new pure-TS package `packages/core` holds all logic with no I/O (callers pass data in). Seed data lives in `data/` (JSON) and the open recipe canon in `recipes/` (`.cook`). A canon test loads both from disk and validates them.

**Tech Stack:** TypeScript (repo's `typescript@^7`), Vitest (repo's `^5.1`), `@cooklang/cooklang@0.19.1` (official WASM parser), `fast-check@4` (property tests), Node 22.

**Spec:** `docs/superpowers/specs/2026-11-09-kitchenquest-design.md` (§2 principles, §4 recipes & allergy engine, §10 canon, §12 testing).

## Global Constraints

- The AI is not involved anywhere in this milestone. Every check is deterministic code over confirmed data (spec §2.1).
- "Can't verify" is never "safe": an unresolved ingredient or a label-dependent ingredient is never `ok` (spec §2.2).
- Status precedence for a recipe: `blocked` > `unverified` > `swap` > `ok`.
- Disclaimer text, exactly: `Kitchen Quest can't guarantee a dish is safe for your allergy. Always check labels.`
- Severities: `anaphylactic` | `allergy` | `intolerance` | `preference`. "Severe" means `anaphylactic` or `allergy`.
- Dates are ISO `YYYY-MM-DD` strings; a phase's `start` and `end` are both inclusive.
- Recipe front matter required keys: `title, country, region, credit, cook, difficulty (1–5), skills (string[]), servings (>0), license, status (draft|reviewed)`; `sacred` optional, default `false`.
- Canon license: `CC-BY-SA-4.0`. Canon recipes ship `status: draft` until a reviewer from that cuisine signs off (spec §10).
- Nutrients tracked: `energy_kcal, protein_g, fat_g, carb_g, fiber_g, sugars_g, sodium_mg` (spec §4.6).
- `packages/core` does no file or network I/O. Loading from disk happens only in tests and future apps.
- Fail loudly: malformed data throws with a message naming the offending id. No silent fallbacks.

## Review Focus

1. Ingredient names as people write them ("Spring Onions ", "tomatoes", "GARLIC") must resolve. An unknown name returns `null` and becomes ❓, never a crash. → Task 3 tests.
2. Malformed graph data (a cycle, an unknown reference, a duplicate alias across two ingredients) must fail at load with a message naming the culprit, not loop forever or resolve ambiguously. → Task 3 tests.
3. Phase boundary dates: a rule ending `2026-12-01` is active on that day and inactive on `2026-12-02`. → Task 4 tests.
4. A substitute that itself violates another active rule (tamari offered for soy sauce to someone allergic to soy) must never be offered. → Task 5 tests.
5. Ingredients with no quantity (`@salt{}`), counts without a known weight, or volume units without a density must never produce `NaN`. They are reported as estimated or missing. → Task 6 tests.

## Tasks

- [x] [Step 1 — Workspace restructure + core package skeleton](step-1.md)
- [x] [Step 2 — Recipe parsing and front-matter validation](step-2.md)
- [x] [Step 3 — Ingredient graph](step-3.md)
- [x] [Step 4 — Rule types, validation, and active phases](step-4.md)
- [x] [Step 5 — Recipe check and swaps](step-5.md)
- [ ] [Step 6 — Nutrition](step-6.md)
- [ ] [Step 7 — Seed data, canon recipes, canon validation](step-7.md)
- [ ] [Step 8 — Safety property test](step-8.md)

**Deferred, on purpose:** importing FoodOn and the full USDA dataset (M1 uses a hand-curated seed with each ingredient's USDA FDC id recorded for provenance; an importer comes with milestone 2's sync job), diet journeys (milestone 9), and persistence (milestone 2).
