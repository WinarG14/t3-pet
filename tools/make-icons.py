"""Draw T3 Pet's app and tray icons (original artwork). Run: python tools/make-icons.py"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

OUT = Path(__file__).resolve().parent.parent / "assets"
OUT.mkdir(exist_ok=True)
S = 1024


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))


def app_icon():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    # rounded-square background with a diagonal violet-to-blue gradient
    grad = Image.new("RGBA", (S, S))
    gd = ImageDraw.Draw(grad)
    top, bottom = (151, 128, 255, 255), (86, 120, 255, 255)
    for y in range(S):
        gd.line([(0, y), (S, y)], fill=lerp(top, bottom, y / S))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([40, 40, S - 40, S - 40], radius=230, fill=255)
    img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img)
    white = (255, 255, 255, 255)
    ink = (38, 30, 82, 255)
    # soft shadow under the face
    sh = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(sh).ellipse([250, 330, 774, 830], fill=(20, 14, 60, 90))
    img.alpha_composite(sh.filter(ImageFilter.GaussianBlur(28)), (0, 18))
    # ears
    d.polygon([(285, 470), (330, 230), (470, 360)], fill=white)
    d.polygon([(739, 470), (694, 230), (554, 360)], fill=white)
    d.polygon([(318, 420), (342, 300), (420, 372)], fill=(255, 196, 214, 255))
    d.polygon([(706, 420), (682, 300), (604, 372)], fill=(255, 196, 214, 255))
    # head
    d.ellipse([250, 320, 774, 810], fill=white)
    # eyes
    d.ellipse([382, 520, 452, 610], fill=ink)
    d.ellipse([572, 520, 642, 610], fill=ink)
    d.ellipse([404, 536, 428, 562], fill=white)
    d.ellipse([594, 536, 618, 562], fill=white)
    # nose and smile
    d.polygon([(492, 640), (532, 640), (512, 664)], fill=(240, 120, 150, 255))
    d.arc([452, 640, 512, 700], start=20, end=160, fill=ink, width=12)
    d.arc([512, 640, 572, 700], start=20, end=160, fill=ink, width=12)
    # cheeks
    d.ellipse([330, 630, 390, 670], fill=(255, 196, 214, 200))
    d.ellipse([634, 630, 694, 670], fill=(255, 196, 214, 200))
    # status dot (a little "something needs you" badge)
    d.ellipse([690, 170, 860, 340], fill=(245, 165, 36, 255), outline=white, width=22)

    img.resize((512, 512), Image.LANCZOS).save(OUT / "icon.png")
    img.save(OUT / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    img.resize((1024, 1024), Image.LANCZOS).save(OUT / "icon-1024.png")


def tray_template():
    # macOS menu-bar template image: black shape on transparent; the OS recolours it.
    for size, name in ((16, "trayTemplate.png"), (32, "trayTemplate@2x.png")):
        big = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        d = ImageDraw.Draw(big)
        black = (0, 0, 0, 255)
        d.polygon([(200, 470), (250, 140), (430, 330)], fill=black)
        d.polygon([(824, 470), (774, 140), (594, 330)], fill=black)
        d.ellipse([170, 280, 854, 900], fill=black)
        clear = (0, 0, 0, 0)
        d.ellipse([350, 540, 450, 660], fill=clear)
        d.ellipse([574, 540, 674, 660], fill=clear)
        big.resize((size, size), Image.LANCZOS).save(OUT / name)


if __name__ == "__main__":
    app_icon()
    tray_template()
    print("icons written to", OUT)
