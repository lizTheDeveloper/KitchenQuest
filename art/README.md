# Kitchen Quest art

License: proprietary to Multiverse Games. All rights reserved.

Layout: `characters/` (64x64), `items/` (32x32), `scenes/` (320x180 backdrops), `ui/` (32x32 icons), `manifest.json` (every asset: path, size, kind, description, prompt, origin), `tools/`.

## Style rules
- 8/16-bit chibi RPG look: single dark outline, medium shading, warm saturated palette, transparent backgrounds for characters, items and UI; scenes are opaque.
- Always display with `image-rendering: pixelated` at integer scales (2x, 3x, 4x).
- Cooks are dignified, competent experts: everyday cooking clothes, aprons, real kitchens. No costume stereotypes.
- Family-mode helper avatars are cute mascot-style chibis, never realistic children.
- Freshness states: Sharp (cool blue), Warm (amber), Rusty (soft green "refresher" arrow). Rusty is never red or a warning.
- No readable text inside art; any pseudo-text on boards is decorative.

## Regenerate
Needs `PIXELLAB_API_KEY`. From `art/`:

    python3 tools/generate.py items/potato.png            # re-roll from the manifest prompt
    python3 tools/generate.py items/potato.png --seed 7

View the result upscaled before keeping it, then update `manifest.json`. PixelLab pixflux needs a canvas of at least 32x32. The Pan expressions are hand-edited from `characters/pan_neutral.png` by `tools/pan_expressions.py` (img2img could not keep the Pan's identity). Two scenes had letterbox bars cropped and stretched to 320x180.
Prototype sprites were copied from `prototype/art/` (origin `prototype` in the manifest; `source` gives the old filename).
