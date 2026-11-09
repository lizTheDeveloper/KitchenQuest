#!/usr/bin/env python3
"""Regenerate (or generate) one art asset from its manifest entry using PixelLab pixflux.

  export PIXELLAB_API_KEY=...
  python3 tools/generate.py items/potato.png            # re-roll from manifest prompt
  python3 tools/generate.py items/potato.png --seed 7   # reproducible variant
  python3 tools/generate.py new/path.png --w 32 --h 32 --prompt "..." [--bg] [--kind item]

Run from the art/ folder. View the result upscaled before keeping it. Update manifest.json.
Note: pixflux needs a canvas of at least 32x32.
"""
import os, sys, json, base64, urllib.request, urllib.error, argparse
p = argparse.ArgumentParser()
p.add_argument("path"); p.add_argument("--w", type=int); p.add_argument("--h", type=int)
p.add_argument("--prompt"); p.add_argument("--bg", action="store_true"); p.add_argument("--seed", type=int)
p.add_argument("--kind", default="")
a = p.parse_args()
here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
man = json.load(open(os.path.join(here, "manifest.json")))
e = next((x for x in man["assets"] if x["path"] == a.path), {})
w = a.w or e.get("width"); h = a.h or e.get("height"); prompt = a.prompt or e.get("prompt")
bg = a.bg or e.get("background", False)
if not (w and h and prompt):
    sys.exit("No manifest prompt/size for this path; pass --w --h --prompt")
body = {"description": prompt, "image_size": {"width": w, "height": h}, "no_background": not bg,
        "outline": "single color black outline", "shading": "medium shading", "detail": "medium detail"}
if a.seed: body["seed"] = a.seed
req = urllib.request.Request("https://api.pixellab.ai/v1/generate-image-pixflux", data=json.dumps(body).encode(),
    headers={"Authorization": "Bearer " + os.environ["PIXELLAB_API_KEY"], "Content-Type": "application/json"})
try:
    r = json.load(urllib.request.urlopen(req, timeout=180))
except urllib.error.HTTPError as ex:
    sys.exit(f"PixelLab error {ex.code}: {ex.read()[:300]}")
out = os.path.join(here, a.path); os.makedirs(os.path.dirname(out), exist_ok=True)
open(out, "wb").write(base64.b64decode(r["image"]["base64"].split(",")[-1]))
print("wrote", out)
