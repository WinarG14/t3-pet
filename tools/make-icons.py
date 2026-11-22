"""Build T3 Pet's app and tray icons from the logo artwork in assets/brand/logo-source.png.

The source is the generated logo (a chrome cat head on a black rounded tile, on a light background).
This script trims it to the tile, gives it clean transparent rounded corners, and writes:
  assets/icon-1024.png, assets/icon.png (512), assets/icon.ico (16-256),
  assets/trayTemplate.png / @2x (macOS menu bar: black cat silhouette on transparent).
Run: python tools/make-icons.py
"""
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "brand" / "logo-source.png"
OUT = ROOT / "assets"


def squircle_mask(size, radius_ratio=0.225, supersample=4):
    s = size * supersample
    m = Image.new("L", (s, s), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * radius_ratio), fill=255)
    return m.resize((size, size), Image.LANCZOS)


def tile_from_source(src):
    rgb = src.convert("RGB")
    # The tile is the dark/grey area on a near-white background: find its bounding box.
    bg = Image.new("RGB", rgb.size, (255, 255, 255))
    diff = ImageChops.difference(rgb, bg).convert("L").point(lambda v: 255 if v > 40 else 0)
    box = diff.getbbox()
    tile = rgb.crop(box)
    side = max(tile.size)
    sq = Image.new("RGB", (side, side), (0, 0, 0))
    sq.paste(tile, ((side - tile.width) // 2, (side - tile.height) // 2))
    # Inset a little so the generated soft rim is replaced by our own clean edge.
    inset = int(side * 0.03)
    sq = sq.crop((inset, inset, side - inset, side - inset)).resize((1024, 1024), Image.LANCZOS)
    out = sq.convert("RGBA")
    out.putalpha(squircle_mask(1024))
    return out


def largest_component(mask):
    """Keep the biggest connected light region (the cat), dropping stray highlight lines."""
    small = mask.resize((256, 256), Image.NEAREST)
    w, h = small.size
    px = small.load()
    seen = bytearray(w * h)
    best = []
    for sy in range(h):
        for sx in range(w):
            if px[sx, sy] < 128 or seen[sy * w + sx]:
                continue
            stack, comp = [(sx, sy)], []
            seen[sy * w + sx] = 1
            while stack:
                x, y = stack.pop()
                comp.append((x, y))
                for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                    if 0 <= nx < w and 0 <= ny < h and not seen[ny * w + nx] and px[nx, ny] >= 128:
                        seen[ny * w + nx] = 1
                        stack.append((nx, ny))
            if len(comp) > len(best):
                best = comp
    keep = Image.new("L", (w, h), 0)
    kp = keep.load()
    for x, y in best:
        kp[x, y] = 255
    # fill the eye/mouth holes back in only where they were holes inside the kept shape's bbox: keep holes
    keep = keep.resize(mask.size, Image.NEAREST).filter(ImageFilter.MaxFilter(5))
    return ImageChops.multiply(mask, keep)


def tray_template(tile):
    """Light (chrome) pixels inside the tile = the cat. Eyes stay as holes. Excludes the amber dot."""
    rgb = tile.convert("RGB")
    w, h = rgb.size
    mask = Image.new("L", (w, h), 0)
    px = rgb.load()
    mp = mask.load()
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            light = (r + g + b) / 3
            amber = r > 180 and b < 120 and r - b > 90
            if light > 110 and not amber:
                mp[x, y] = 255
    # keep the main shape only: drop thin rim highlights near the tile edge
    edge = Image.new("L", (w, h), 0)
    ImageDraw.Draw(edge).rounded_rectangle([int(w * .06), int(h * .06), int(w * .94), int(h * .94)], radius=int(w * .2), fill=255)
    mask = ImageChops.multiply(mask, edge).filter(ImageFilter.MedianFilter(5))
    mask = largest_component(mask)
    box = mask.getbbox()
    glyph = mask.crop(box)
    side = int(max(glyph.size) * 1.08)
    canvas = Image.new("L", (side, side), 0)
    canvas.paste(glyph, ((side - glyph.width) // 2, (side - glyph.height) // 2))
    for size, name in ((16, "trayTemplate.png"), (32, "trayTemplate@2x.png")):
        a = canvas.resize((size, size), Image.LANCZOS)
        img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        img.putalpha(a)
        img.save(OUT / name)


def main():
    tile = tile_from_source(Image.open(SRC))
    tile.save(OUT / "icon-1024.png")
    tile.resize((512, 512), Image.LANCZOS).save(OUT / "icon.png")
    tile.save(OUT / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    tray_template(tile)
    print("icons written to", OUT)


if __name__ == "__main__":
    main()
