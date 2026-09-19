"""Builds the Chrome Web Store images and the README's extra images from the
curated captures in .shots/final/ (see the list in the comments below).

    python tools/make-store-images.py

Output:
  store/screenshot-1..5.png   1280x800, 24-bit, no alpha (the store rejects other sizes)
  store/promo-small-440x280.png, store/store-icon-128.png
  docs/img/*.png              the README's row for the clan hub, tournaments and overlay

Every UI in these images is a capture of the extension itself under a caption
bar. What is staged, and not real: the lobby panel around the badges is the
local fixture (test/index.html) dressed like OpenFront's lobby, with made-up
players and stats; the map behind the stream overlay and the timelapse frames
are made up; recap percentiles are made up. Dashboard, clan hub and tournament
data come from real public records (ofstats.io / OpenFront's game records).
"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SHOTS = os.path.join(ROOT, ".shots", "final")
OUT = os.path.join(ROOT, "store")
DOCS = os.path.join(ROOT, "docs", "img")
os.makedirs(OUT, exist_ok=True)
os.makedirs(DOCS, exist_ok=True)

W, H, BAR = 1280, 800, 104
BG, PANEL, TEXT, DIM, ACCENT, EDGE = (11, 13, 18), (22, 25, 33), (229, 231, 235), (156, 163, 175), (252, 211, 77), (63, 67, 77)
TAG = "OpenFront Pro · Unofficial"


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
    d.text((40, 18), title, font=font(36, True), fill=TEXT)
    d.text((40, 66), subtitle, font=font(19), fill=DIM)
    f = font(17, True)
    d.text((W - 40 - d.textlength(TAG, font=f), 30), TAG, font=f, fill=ACCENT)
    return im, d


def place(im, piece, box, align="center"):
    """Fits piece into box (x0, y0, x1, y1) with a thin frame; returns where it went."""
    x0, y0, x1, y1 = box
    piece = fit(piece, x1 - x0, y1 - y0)
    x = x0 + (x1 - x0 - piece.width) // 2
    y = y0 + (y1 - y0 - piece.height) // 2 if align == "center" else y0
    ImageDraw.Draw(im).rectangle([x - 2, y - 2, x + piece.width + 1, y + piece.height + 1], outline=EDGE, width=2)
    im.paste(piece, (x, y))
    return x, y, piece.width, piece.height


def label(im, text, x, y):
    ImageDraw.Draw(im).text((x, y), text, font=font(16, True), fill=ACCENT)


BODY = (32, BAR + 24, W - 32, H - 24)

# 1. lobby badges (01-lobby-badges.png: the local fixture dressed as a lobby, made-up players)
im, _ = canvas("Rank badges in the lobby", "Each player's world rank from public game history (ofstats.io), lobby strength, clan chips, map preview")
place(im, shot("01-lobby-badges.png"), BODY)
im.save(os.path.join(OUT, "screenshot-1.png"), optimize=True)

# 2. dashboard (03-dashboard-classic-hero.png: header, overview and maps of the real dashboard)
im, _ = canvas("Stats dashboard", "World rank, win rate, recent form and streak, and your rank on every map")
place(im, shot("03-dashboard-classic-hero.png"), BODY)
im.save(os.path.join(OUT, "screenshot-2.png"), optimize=True)

# 3. recap: three tabs of the widget at one common scale
im, _ = canvas("Post-game recap", "Your numbers against the lobby, the survival curve, and a timelapse of the map")
panels = [shot("04-recap-summary.png"), shot("04-recap-graphs.png"), shot("04-recap-timelapse.png")]
gap = 28
avail_w = BODY[2] - BODY[0] - gap * (len(panels) - 1)
avail_h = BODY[3] - BODY[1]
scale = min(avail_h / max(p.height for p in panels), avail_w / sum(p.width for p in panels))
sized = [p.resize((round(p.width * scale), round(p.height * scale)), Image.LANCZOS) for p in panels]
x = BODY[0] + (avail_w - sum(p.width for p in sized)) // 2
for p in sized:
    place(im, p, (x, BODY[1], x + p.width, BODY[1] + p.height), align="top")
    x += p.width + gap
im.save(os.path.join(OUT, "screenshot-3.png"), optimize=True)

# 4. themes (10-themes-nine.png: test/themes.html, the nine themes side by side)
im, _ = canvas("Nine themes", "One theme for badges, cards, dashboard and recap - and, if you like, the site itself")
place(im, shot("10-themes-nine.png"), BODY)
im.save(os.path.join(OUT, "screenshot-4.png"), optimize=True)

# 5. the three tools: a 2x2 grid with a label over each cell
im, _ = canvas("Stream overlay, clan hub, tournaments", "An overlay for OBS, clan leaderboards with weekly movers, leagues and brackets from game ids")
cells = [
    ("Stream overlay (made-up game behind it)", shot("07-overlay-over-game.png")),
    ("Clan hub - weekly leaderboard and movers", shot("08-clans-leaderboard.png")),
    ("Tournaments - bracket", shot("09-tournament-bracket.png")),
    ("Tournaments - results image", shot("09-tournament-results-league.png")),
]
cw = (BODY[2] - BODY[0] - 24) // 2
ch = (BODY[3] - BODY[1] - 24) // 2
for i, (text, pic) in enumerate(cells):
    cx = BODY[0] + (i % 2) * (cw + 24)
    cy = BODY[1] + (i // 2) * (ch + 24)
    label(im, text, cx, cy - 2)
    if i in (1, 2):  # wide pages: show their top at the cell's shape instead of shrinking them
        want = pic.width * (ch - 26) / cw
        pic = pic.crop((0, 0, pic.width, min(pic.height, round(want))))
    place(im, pic, (cx, cy + 24, cx + cw, cy + ch))
im.save(os.path.join(OUT, "screenshot-5.png"), optimize=True)

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
tile.save(os.path.join(OUT, "promo-small-440x280.png"), optimize=True)

# store icon: 96px artwork centred in a transparent 128px canvas (Google's spec)
store_icon = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
art = icon_src.resize((96, 96), Image.LANCZOS)
store_icon.paste(art, (16, 16), art)
store_icon.save(os.path.join(OUT, "store-icon-128.png"))

# README: one image per new tool, at most 1200 px wide, palette-quantised when that stays clean
readme = [
    ("overlay.png", "07-overlay-over-game.png", None),
    ("clan-hub.png", "08-clans-leaderboard.png", None),
    ("tournament.png", "09-tournament-bracket.png", None),
]
for out_name, src, _ in readme:
    pic = shot(src)
    if pic.width > 1200:
        pic = pic.resize((1200, round(pic.height * 1200 / pic.width)), Image.LANCZOS)
    pic.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(os.path.join(DOCS, out_name), optimize=True)

for folder in (OUT, DOCS):
    for f in sorted(os.listdir(folder)):
        if f.endswith(".png"):
            p = os.path.join(folder, f)
            im = Image.open(p)
            print(os.path.relpath(p, ROOT), im.size, im.mode, f"{os.path.getsize(p) // 1024} KB")
