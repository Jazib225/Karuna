"""Karuna desktop icons from the brand lotus (web/public/brand/lotus.png: black lotus on white, 1024 px).

  app-icon-rounded.png  1024 px tile with rounded corners (Windows 11 style); feed it to `tauri icon`
  tray-<N>.png          the lotus alone, white on transparent, for the dark tray, rendered at each
                        size Windows uses for tray icons (16/20/24/32/40 px = 100–250% scaling), with
                        the strokes thickened as the size drops so the lines stay solid.

Run: python -I desktop/scripts/make-icons.py
"""
import os
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
SRC = os.path.join(ROOT, "web", "public", "brand", "lotus.png")
OUT = os.path.join(ROOT, "desktop", "src-tauri", "icons")

art = Image.open(SRC).convert("L")  # black lotus on white
n = art.width

# --- app / taskbar tile: rounded corners, smooth edge (drawn 4x, then reduced) --------------------
ss = 4
mask = Image.new("L", (n * ss, n * ss), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, n * ss - 1, n * ss - 1), radius=int(n * ss * 0.225), fill=255)
mask = mask.resize((n, n), Image.LANCZOS)
tile = Image.merge("RGBA", (art, art, art, mask))
tile.save(os.path.join(OUT, "app-icon-rounded.png"))

# --- tray: lotus only, white, alpha from ink ------------------------------------------------------
ink = ImageChops.invert(art)  # lotus strokes = 255
box = ink.point(lambda v: 255 if v > 40 else 0).getbbox()
x0, y0, x1, y1 = box
side = max(x1 - x0, y1 - y0)
pad = int(side * 0.06)
cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
half = side // 2 + pad
square = ink.crop((cx - half, cy - half, cx + half, cy + half))

for size in (16, 20, 24, 32, 40, 48, 64):
    # Thicken strokes in proportion to how much we shrink, so a 1-2 px line survives at 16-24 px.
    shrink = square.width / size
    grow = max(0, int(round(shrink * 0.16)))
    m = square.filter(ImageFilter.MaxFilter(grow * 2 + 1)) if grow else square
    a = m.resize((size, size), Image.LANCZOS)
    a = a.point(lambda v: min(255, int(v * 1.15)))  # firm up the antialiased edge
    white = Image.new("L", (size, size), 255)
    Image.merge("RGBA", (white, white, white, a)).save(os.path.join(OUT, f"tray-{size}.png"))

# Clean up earlier single-size tray files.
for old in ("tray.png",):
    p = os.path.join(OUT, old)
    if os.path.exists(p):
        os.remove(p)
print("ok", file=sys.stderr)
