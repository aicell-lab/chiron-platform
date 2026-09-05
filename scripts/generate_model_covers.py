#!/usr/bin/env python3
"""Generate the model cover images served from ``public/assets/``.

Why these are generated rather than sourced
-------------------------------------------
Tabula ships its own mark (``public/assets/tabula.png``, drawn by hand and left
untouched by this script). The other three foundation models Chiron hosts are
third-party projects whose logos we have no licence to redistribute, so the
cards here are our own: a consistent Chiron-family emblem per model rather than
a borrowed one. They exist so the model hub and My Models have something honest
to render, and they are deliberately plain enough that swapping in an official
mark later is a one-file change.

Each emblem shares Tabula's visual language (slate outline, soft gradient fill,
the padlock badge that stands for weights-only federation) and differs in hue
and interior motif so the four are distinguishable at card size.

Run from the repo root:  python3 scripts/generate_model_covers.py
"""

from __future__ import annotations

import pathlib

from PIL import Image, ImageDraw, ImageFont

OUT_DIR = pathlib.Path(__file__).resolve().parent.parent / "public" / "assets"
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

# Drawn at 4x and downsampled, which is cheaper than hand-rolling antialiasing
# and gives clean edges on the diagonal motifs.
SS = 4
W, H = 838, 772

SLATE = (26, 42, 54)

MODELS = {
    # name -> (wordmark, gradient start, gradient end, motif)
    "scgpt": ("scGPT", (129, 140, 248), (99, 102, 241), "tokens"),
    "geneformer": ("GENEFORMER", (94, 205, 179), (45, 156, 168), "layers"),
    "scfoundation": ("scFOUNDATION", (250, 191, 113), (243, 146, 79), "strata"),
}


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def gradient(size, top, bottom):
    """Vertical linear gradient as a standalone RGB image."""
    w, h = size
    img = Image.new("RGB", (1, h))
    px = img.load()
    for y in range(h):
        px[0, y] = lerp(top, bottom, y / max(1, h - 1))
    return img.resize((w, h))


def draw_emblem(img, draw_on, box, c0, c1, motif):
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0

    mask = Image.new("L", (w, h), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, w - 1, h - 1], radius=int(w * 0.30), fill=255)

    tile = gradient((w, h), c0, c1).convert("RGBA")
    tile.putalpha(mask)
    img.paste(tile, (x0, y0), tile)

    # Interior motif, drawn onto a transparent layer then masked to the emblem
    # so nothing bleeds past the rounded corners.
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    ink = SLATE + (235,)

    if motif == "tokens":
        # A band of attention tokens: three staggered rows of rounded cells.
        cell, gap = int(w * 0.135), int(w * 0.045)
        for row in range(3):
            n = 4 if row % 2 == 0 else 3
            span = n * cell + (n - 1) * gap
            sx = (w - span) // 2
            sy = int(h * 0.24) + row * (cell + gap)
            for i in range(n):
                cx = sx + i * (cell + gap)
                ld.rounded_rectangle([cx, sy, cx + cell, sy + cell],
                                     radius=int(cell * 0.30), outline=ink,
                                     width=int(w * 0.018))
    elif motif == "layers":
        # Stacked transformer layers with a node on each.
        bar_h = int(h * 0.085)
        for i in range(4):
            inset = int(w * 0.14) + int(w * 0.045) * abs(i - 1.5)
            ty = int(h * 0.22) + i * int(h * 0.16)
            ld.rounded_rectangle([inset, ty, w - inset, ty + bar_h],
                                 radius=bar_h // 2, outline=ink, width=int(w * 0.018))
            r = int(w * 0.028)
            ld.ellipse([w // 2 - r, ty + bar_h // 2 - r, w // 2 + r, ty + bar_h // 2 + r],
                       fill=ink)
    elif motif == "strata":
        # Concentric arcs rising from a foundation bar.
        base_y = int(h * 0.74)
        ld.rounded_rectangle([int(w * 0.16), base_y, int(w * 0.84), base_y + int(h * 0.075)],
                             radius=int(h * 0.037), outline=ink, width=int(w * 0.018))
        for i, f in enumerate((0.66, 0.48, 0.30)):
            rw = int(w * f)
            ld.arc([w // 2 - rw // 2, base_y - rw // 2, w // 2 + rw // 2, base_y + rw // 2],
                   start=180, end=360, fill=ink, width=int(w * 0.018))

    layer.putalpha(Image.composite(layer.split()[3], Image.new("L", (w, h), 0), mask))
    img.paste(layer, (x0, y0), layer)

    # Outline last so the motif cannot overlap it.
    draw_on.rounded_rectangle(box, radius=int(w * 0.30), outline=SLATE, width=int(w * 0.035))


def draw_lock(draw_on, cx, cy, r):
    """The padlock badge: weights cross the network, data does not."""
    draw_on.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 255, 255, 255))
    draw_on.ellipse([cx - r, cy - r, cx + r, cy + r], outline=SLATE, width=int(r * 0.16))
    bw, bh = int(r * 0.86), int(r * 0.62)
    draw_on.rounded_rectangle([cx - bw // 2, cy - bh // 6, cx + bw // 2, cy - bh // 6 + bh],
                              radius=int(r * 0.14), fill=SLATE)
    sw = int(r * 0.52)
    draw_on.arc([cx - sw // 2, cy - int(r * 0.72), cx + sw // 2, cy + int(r * 0.10)],
                start=180, end=360, fill=SLATE, width=int(r * 0.20))


def render(key, wordmark, c0, c1, motif):
    img = Image.new("RGBA", (W * SS, H * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    side = int(W * SS * 0.62)
    x0 = (W * SS - side) // 2
    y0 = int(H * SS * 0.035)
    draw_emblem(img, d, (x0, y0, x0 + side, y0 + side), c0, c1, motif)
    draw_lock(d, x0 + side - int(side * 0.06), y0 + side - int(side * 0.06), int(side * 0.155))

    # Wordmark, auto-fitted to a fixed width so short and long names sit on the
    # same optical baseline across the set.
    target = int(W * SS * 0.86)
    # Capped as well as fitted. Fitting to a fixed width alone makes a short
    # name like "scGPT" render at roughly twice the height of "scFOUNDATION",
    # which reads as a different design rather than the same one. The cap keeps
    # the set optically even and lets short names sit narrower than the box.
    cap = int(H * SS * 0.155)
    size = 10
    while True:
        f = ImageFont.truetype(FONT_BOLD, size)
        if d.textlength(wordmark, font=f) >= target or size >= cap:
            break
        size += 4
    f = ImageFont.truetype(FONT_BOLD, min(size - 4, cap))
    tw = d.textlength(wordmark, font=f)
    d.text(((W * SS - tw) / 2, y0 + side + int(H * SS * 0.045)), wordmark,
           font=f, fill=SLATE + (255,))

    out = img.resize((W, H), Image.LANCZOS)
    path = OUT_DIR / f"{key}.png"
    out.save(path, optimize=True)
    print(f"wrote {path} ({path.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for key, (wordmark, c0, c1, motif) in MODELS.items():
        render(key, wordmark, c0, c1, motif)
