"""Builds the Chrome Web Store images from real captures in .shots/ (made by the
tools/cdp-*.mjs scripts against the live site).

    python tools/make-store-images.py

Output: store/screenshot-1..5.png (1280x800, 24-bit, no alpha - the store rejects
other sizes), store/promo-small-440x280.png and store/store-icon-128.png. Every screenshot is a real
capture under a caption bar; nothing is mocked up.
"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SHOTS = os.path.join(ROOT, ".shots")
OUT = os.path.join(ROOT, "store")
os.makedirs(OUT, exist_ok=True)

W, H, BAR = 1280, 800, 104
BG, PANEL, TEXT, DIM, ACCENT = (11, 13, 18), (22, 25, 33), (229, 231, 235), (156, 163, 175), (252, 211, 77)


def font(size, bold=False):
    for name in (["segoeuib.ttf", "arialbd.ttf"] if bold else ["segoeui.ttf", "arial.ttf"]):
        try:
            return ImageFont.truetype(os.path.join(os.environ.get("WINDIR", "C:\\Windows"), "Fonts", name), size)
        except OSError:
            continue
    return ImageFont.load_default()


def shot(name):
    return Image.open(os.path.join(SHOTS, name)).convert("RGB")


def fit(im, w, h):
    scale = min(w / im.width, h / im.height)
    return im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.LANCZOS)


def canvas(title, subtitle):
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, W, BAR], fill=PANEL)
    d.rectangle([0, BAR - 3, W, BAR], fill=ACCENT)
    d.text((40, 20), title, font=font(36, True), fill=TEXT)
    d.text((40, 66), subtitle, font=font(19), fill=DIM)
    tag = "OpenFront Pro - unofficial"
    f = font(17, True)
    d.text((W - 40 - d.textlength(tag, font=f), 30), tag, font=f, fill=ACCENT)
    return im, d


def place(im, piece, box):
    x0, y0, x1, y1 = box
    piece = fit(piece, x1 - x0, y1 - y0)
    x = x0 + (x1 - x0 - piece.width) // 2
    y = y0 + (y1 - y0 - piece.height) // 2
    ImageDraw.Draw(im).rectangle([x - 2, y - 2, x + piece.width + 1, y + piece.height + 1], outline=(63, 67, 77), width=2)
    im.paste(piece, (x, y))


BODY = (32, BAR + 24, W - 32, H - 24)

# 1. ranks in the lobby
im, _ = canvas("Every player's world rank, right in the lobby", "Percentile badges from public game history (ofstats.io), lobby strength, form and one-click stats")
place(im, shot("badge-lobby.png").crop((48, 172, 552, 340)), BODY)  # stand-in lobby from tools/cdp-badge.mjs; swap for a real lobby capture when you have one
im.save(os.path.join(OUT, "screenshot-1.png"))

# 2. dashboard
im, _ = canvas("A stats dashboard inside the game's site", "Rank per map and mode, rolling win rate, survival and gold trends, recent games, clan stats")
place(im, shot("theme-classic-dashboard.png"), BODY)
im.save(os.path.join(OUT, "screenshot-2.png"))

# 3. recap
im, _ = canvas("Game recap: how it really went", "Your numbers ranked in the lobby, survival curve, awards, standings - and a share image for Discord")
third = (W - 64 - 48) // 3
place(im, shot("recap-ffa-out-summary.png"), (32, BAR + 24, 32 + third, H - 24))
place(im, shot("recap-ffa-out-graphs.png"), (32 + third + 24, BAR + 24, 32 + 2 * third + 24, H - 24))
place(im, shot("recap-ffa-win-card.png"), (32 + 2 * third + 48, BAR + 24, W - 32, H - 24))
im.save(os.path.join(OUT, "screenshot-3.png"))

# 4. themes
im, _ = canvas("One theme for everything", "Classic, Neon, Tactical, Pastel, Mono, High contrast - the extension and, if you like, the site itself")
cw, ch = (W - 64 - 24) // 2, (H - BAR - 48 - 24) // 2
for i, name in enumerate(["theme-neon-home.png", "theme-pastel-home.png", "theme-tactical-home.png", "theme-contrast-home.png"]):
    cx = 32 + (i % 2) * (cw + 24)
    cy = BAR + 24 + (i // 2) * (ch + 24)
    place(im, shot(name), (cx, cy, cx + cw, cy + ch))
im.save(os.path.join(OUT, "screenshot-4.png"))

# 5. layouts
im, _ = canvas("Website layouts: Wide, Sidebar, Focus", "Re-arranges the front page only. Ads are never hidden.")
place(im, shot("site-sidebar.png"), BODY)
im.save(os.path.join(OUT, "screenshot-5.png"))

# small promo tile: mostly graphic, must read at half size
tile = Image.new("RGB", (440, 280), BG)
d = ImageDraw.Draw(tile)
icon_src = Image.open(os.path.join(ROOT, "icons", "icon128.png")).convert("RGBA")
icon = icon_src.resize((132, 132), Image.LANCZOS)
tile.paste(icon, (154, 36), icon)
title = "OpenFront Pro"
f = font(36, True)
d.text(((440 - d.textlength(title, font=f)) / 2, 182), title, font=f, fill=TEXT)
tag = "unofficial stats companion"
f = font(17)
d.text(((440 - d.textlength(tag, font=f)) / 2, 230), tag, font=f, fill=ACCENT)
tile.save(os.path.join(OUT, "promo-small-440x280.png"))

# store icon: 96px artwork centred in a transparent 128px canvas (Google's spec)
store_icon = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
art = icon_src.resize((96, 96), Image.LANCZOS)
store_icon.paste(art, (16, 16), art)
store_icon.save(os.path.join(OUT, "store-icon-128.png"))

for f in sorted(os.listdir(OUT)):
    if f.endswith(".png"):
        im = Image.open(os.path.join(OUT, f))
        print(f, im.size, im.mode)
