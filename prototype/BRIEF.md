# Prototype brief (shared by all three pages)

Throwaway, playable UI prototypes of Kitchen Quest's weekly loop. Purpose: let Liz (founder) *feel* the loop and the UI on her phone and laptop. Read the spec first: `docs/superpowers/specs/2026-11-09-kitchenquest-design.md` (esp. §1–3.5, §5, §7.0).

Pages:
- `prototype/kitchen.html` — **Kitchen Day**: talk to the Pan (mentor) who does all data entry.
- `prototype/market.html` — **Market Day**: gamified market, shopping-skills minigames + the week's list.
- `prototype/quest.html` — **Recipe Quest**: world map → cook's quest → recipe card w/ allergy check → cook mode → photo → reaction.

## Hard platform rules (Claude artifact pages)

- One self-contained HTML file. Write page content directly: **no** `<!doctype>`, `<html>`, `<head>`, `<body>` tags. Start the file with `<title>…</title>`, `<meta name="claude:viewport-fit-sides" content="cover">`, then `<style>`.
- Inline all CSS and JS. External: only Google Fonts stylesheets; scripts only from cdnjs (pinned exact versions). Prefer no libraries at all — vanilla JS.
- Images: relative paths `art/<name>.png` (published alongside). Always `image-rendering: pixelated`. Scale sprites by integer multiples (2x, 3x, 4x).
- No `alert/confirm/prompt` (they don't work). No fetch to other hosts. No mic/camera APIs (refused) — photos come from `<input type="file" accept="image/*" capture="environment">`.
- `speechSynthesis` (text-to-speech) is OK to try for the Pan's voice: put behind a "🔊 Voice" toggle, off by default, started from a click. Speech *input* is not available on these pages; say so in a small note ("In the real app you'll talk out loud; here, type.").
- localStorage only inside try/catch; page must work without it.
- Must work at 400px phone width with no horizontal page scroll; side gutter: `padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px));` on the outer wrapper.
- Respect `prefers-reduced-motion`. Visible focus states. Buttons are real `<button>`s.
- Single deliberate theme (a game screen) is allowed: set `color-scheme: dark` on `:root`, explicit `body` background. Use the tokens below; no stray literal colors.

## The AI inside the page (`sample` capability)

The page can call Claude (a stand-in for the production Qwen model) through the viewer's account:

```js
let sample = null;
(async () => { try { sample = await window.claude?.use?.("sample"); } catch {} updateAiBadge(); })();
// chat with tools (page functions Claude can call)
const ctl = new AbortController();
const { text } = await sample([{role:"user", content: RULES}, ...turns], {
  cache: false, modelTier: "quick", signal: ctl.signal,
  onText: ({ text }) => { bubble.textContent = text; },   // `text` = WHOLE answer so far, assign it
  tools: [{ name: "log_meal", description: "…what it does and returns…",
            inputSchema: { type:"object", properties:{…}, required:[…] },
            execute: (input) => { /* coerce + validate input; change page state; return small JSON */ } }],
});
// images (photo reaction): sample(prompt, { images: [file], modelTier: "quick" })  — page declares sample.images
// JSON: await sample.json(prompt, { modelTier: "quick" })
```

- Rules: no system role — standing instructions go in a leading user turn. Call only on a click/send, never in a loop or timer. When tools are passed, do **not** pass `cache` except `false`.
- Errors reject `{code, message, text?}`. `not_granted`/`sampling_disabled`/`tools_unavailable` → switch to **scripted mode**; `rate_limited` → in-character "The Pan needs a moment" and keep the input; `cancelled` → silent.
- `sample` may be `null` (page opened outside Claude, or ~10s later). **Every page must be fully playable in scripted mode** with canned, funny responses and keyword matching, so the loop can be felt without AI. Show a small badge: "Pan: live AI" vs "Pan: scripted".
- Show "The Pan is thinking…" until the first `onText`. Offer a Stop button during a call.

## Look

8-bit / 16-bit RPG UI. The world is warm and cluttered; the UI chrome is a dark cast-iron frame with parchment dialogue boxes. Commit to it.

```css
/* Layout: one game "screen" (pixel backdrop + sprites) on top, parchment dialogue/panel below; stacks on phones */
:root {
  color-scheme: dark;
  --iron: #1e1b1d;        /* page bg, cast-iron */
  --iron-2: #2b2629;      /* panels on iron */
  --iron-edge: #4a4044;   /* pixel borders */
  --parchment: #f2e3c2;   /* dialogue boxes */
  --parchment-ink: #2a1d14;
  --ember: #e8743b;       /* accent: XP, primary buttons, the Pan's heat */
  --herb: #6fae4f;        /* success / ✅ ok */
  --saffron: #f2c14e;     /* swap 🔁 / warnings / stamps highlight */
  --chili: #c8423a;       /* ⛔ blocked / severe allergy */
  --sky: #6aa6d8;         /* ❓ can't verify / info */
  --fg: #efe6d8;          /* text on iron */
  --muted: #a89a8e;
  --display: "Pixelify Sans", "Courier New", monospace;   /* headings, buttons, names */
  --body: "Atkinson Hyperlegible", system-ui, sans-serif; /* dialogue + reading text: legibility first */
  --mono: "VT323", "Courier New", monospace;              /* numbers, XP, timers, stamps */
}
```
Fonts: `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&family=Pixelify+Sans:wght@400;600&family=VT323&display=swap">`

Components (each page implements its own copy, keep them looking the same):
- **Pixel border**: `box-shadow` stepped border (e.g. `0 0 0 3px var(--iron-edge), 0 0 0 6px var(--iron)`), square corners, no blur shadows, no rounded corners.
- **Dialogue box**: parchment bg, ink text, speaker nameplate tab top-left in `--display`, portrait sprite at left (2x). Text types in (skip on click; instant if reduced motion).
- **Buttons**: `--display`, chunky, 2px pixel "press" (translateY on :active), ember primary, iron secondary.
- **XP toast**: slides from top-right: "+25 XP · Knife" in `--mono`, plus Bureau Stamp count. A top HUD bar shows apprentice level, XP bar, stamps.
- **Bureau confirmation card** (for saving anything): looks like an official form slip — "PANTRY BUREAU · FORM 27-B/ALLERGEN", fields, and two buttons "Stamp it ✔" / "Not quite". Stamping plays a stamp animation (red rotated "APPROVED" in `--mono`).
- **Status chips**: ✅ ok (herb) · 🔁 swap (saffron) · ⛔ blocked (chili) · ❓ can't verify (sky).

## Art (in `prototype/art/`, transparent PNG unless bg_)

Characters 64×64: `pan` (grumpy cast-iron skillet, the mentor), `player` (apprentice), `cook_mx` (Doña Marisol, home cook, Oaxaca, Mexico), `cook_in` (Ammachi Leela, older home cook, Kochi, Kerala, India), `cook_jp` (Haruka, onigiri shop cook, Osaka, Japan), `butcher` (Big Bram, butcher), `grocer` (Old Wen, produce seller), `tofu` (Mr. Okafor-Sato, tofu & legume merchant).
Items 32×32: `i_avocado i_tomato i_onion i_garlic i_chili i_lentils i_rice i_egg i_tortilla i_chicken i_beef i_tofu i_squash i_strawberry i_cilantro i_seaweed i_cumin`.
Backdrops: `bg_kitchen` 320×153, `bg_market` 320×180, `bg_map` 384×216 (real Earth; approx. % positions — Mexico/Oaxaca x≈21% y≈44%, Kerala x≈67% y≈50%, Osaka x≈86% y≈34%; verify by eye and adjust).
Scale backdrops to container width with `image-rendering: pixelated`.

## Voice and comedy (Douglas Adams × Terry Pratchett, original)

- **The Pan**: deadpan, fond, a little put-upon; 140 years seasoned; licensed by the Pantry Bureau as a mentor "somewhat against its will". Short lines. Example: "It has been six hours. I am a pan, and even I am concerned." / "Nothing green since Tuesday. I've noticed. The cilantro has noticed."
- **The Pantry Bureau**: absurd, footnoted bureaucracy. Forms in triplicate. Footnotes as small `*` asides in UI copy ("*Form 27-B must be stamped by a qualified pan.").
- **Cooks**: competent, warm, dignified experts. Never the butt of the joke. The player is a **guest and apprentice**; recipes are *taught* and *gifted*, never looted or "discovered". Credit the community and region on every recipe card.
- Never joke about cultures, accents, bodies, weight. No "exotic". Reward eating *enough*; never praise eating less.

## Safety behaviors to show (even in a prototype)

- The Pan **reads back** any allergy/diet rule and the player must tap "Stamp it ✔" before it saves. For severe allergies, the Pan spells the ingredient ("kiwi — K-I-W-I").
- Recipe cards show the allergy check result per ingredient using plain deterministic JS (a small `contains`/`is_a` map), never the AI. Include the line: "Kitchen Quest can't guarantee a dish is safe for your allergy. Always check labels."
- Photo reaction is a reaction, not verification.

## Verifying your page

Serve the folder and screenshot once at 400px and 1280px with Playwright (pre-installed; `require('playwright')`, `chromium.launch()`), e.g. `python3 -m http.server 8765 -d /home/user/KitchenQuest/prototype`. Check: no console errors, no horizontal scroll at 400px, scripted mode fully playable end to end (click through it with Playwright). Fix what you find, once. Do not publish; do not commit; report back the file path and a 5-line summary of what's playable.
