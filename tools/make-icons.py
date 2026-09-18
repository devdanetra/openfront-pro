"""Draws the extension icon (original artwork: three rising rank bars on a dark
rounded tile, with a tilted gold PRO tag on the large size) and writes

    icons/icon16.png  icons/icon48.png  icons/icon128.png   (manifest)
    store/store-icon-128.png   (Chrome Web Store: 96px art + 16px clear padding)
    store/icon-512.png         (for a repo / social preview)

    python tools/make-icons.py

Drawn at 1024px and scaled down, so edges stay clean at 16px. The small sizes
drop the tag: three bars are all that survives 16 pixels.
"""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
S = 1024


def font(size):
    for name in ["segoeuib.ttf", "arialbd.ttf"]:
        try:
            return ImageFont.truetype(os.path.join(os.environ.get("WINDIR", "C:\\Windows"), "Fonts", name), size)
        except OSError:
            continue
    return ImageFont.load_default()


def tile(with_tag):
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    # background: vertical gradient inside a rounded square
    grad = Image.new("RGBA", (S, S))
    gd = ImageDraw.Draw(grad)
    top, bottom = (24, 31, 48), (10, 13, 20)
    for y in range(S):
        t = y / (S - 1)
        gd.line([(0, y), (S, y)], fill=tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=255)
    im.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(im)
    # translucent marks go on their own layer: ImageDraw overwrites alpha, it does not blend
    glaze = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    g = ImageDraw.Draw(glaze)
    g.rounded_rectangle([6, 6, S - 7, S - 7], radius=int(S * 0.22) - 6, outline=(255, 255, 255, 28), width=8)

    # three rising bars
    base = int(S * 0.80)
    w = int(S * 0.17)
    gap = int(S * 0.065)
    left = (S - (3 * w + 2 * gap)) // 2
    bars = [(0.30, (125, 211, 252)), (0.47, (56, 189, 248)), (0.66, (163, 230, 53))]
    for i, (h, colour) in enumerate(bars):
        x0 = left + i * (w + gap)
        y0 = base - int(S * h)
        d.rounded_rectangle([x0, y0, x0 + w, base], radius=int(w * 0.22), fill=colour + (255,))
        g.rounded_rectangle([x0, y0, x0 + w // 3, base], radius=int(w * 0.22), fill=(255, 255, 255, 46))
    g.rounded_rectangle([left - int(S * 0.04), base + int(S * 0.025), left + 3 * w + 2 * gap + int(S * 0.04), base + int(S * 0.05)], radius=12, fill=(255, 255, 255, 70))
    im.alpha_composite(glaze)

    if with_tag:
        tag = Image.new("RGBA", (int(S * 0.50), int(S * 0.20)), (0, 0, 0, 0))
        td = ImageDraw.Draw(tag)
        td.rounded_rectangle([0, 0, tag.width - 1, tag.height - 1], radius=int(tag.height * 0.24), fill=(252, 211, 77, 255), outline=(20, 16, 4, 255), width=10)
        f = font(int(tag.height * 0.66))
        text = "PRO"
        tw = td.textlength(text, font=f)
        td.text(((tag.width - tw) / 2, tag.height * 0.10), text, font=f, fill=(24, 18, 4, 255))
        tag = tag.rotate(10, expand=True, resample=Image.BICUBIC)
        shadow = Image.new("RGBA", tag.size, (0, 0, 0, 0))
        shadow.paste((0, 0, 0, 120), (0, 0), tag.split()[3])
        shadow = shadow.filter(ImageFilter.GaussianBlur(14))
        pos = (int(S * 0.44), int(S * 0.04))
        im.alpha_composite(shadow, (pos[0] + 8, pos[1] + 14))
        im.alpha_composite(tag, pos)
    return im


def save(im, path, size):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    im.resize((size, size), Image.LANCZOS).save(path)
    print(os.path.relpath(path, ROOT), size)


big = tile(True)
plain = tile(False)
save(plain, os.path.join(ROOT, "icons", "icon16.png"), 16)
save(plain, os.path.join(ROOT, "icons", "icon48.png"), 48)
save(big, os.path.join(ROOT, "icons", "icon128.png"), 128)
save(big, os.path.join(ROOT, "store", "icon-512.png"), 512)

store_icon = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
art = big.resize((96, 96), Image.LANCZOS)
store_icon.paste(art, (16, 16), art)
store_icon.save(os.path.join(ROOT, "store", "store-icon-128.png"))
print("store/store-icon-128.png 128 (96 art + 16 padding)")
