"""Draw the toolbar icons (grouped tabs over signal bars) at 16/32/48/128 px."""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "icons"
S = 512  # draw large, then downscale for smooth edges
BLUE = (26, 115, 232, 255)
WHITE = (255, 255, 255, 255)
SOFT = (255, 255, 255, 150)


def draw() -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([16, 16, S - 16, S - 16], radius=112, fill=BLUE)

    # Three browser tabs joined by a group bar.
    d.rounded_rectangle([88, 104, S - 88, 128], radius=12, fill=WHITE)
    tab_w, gap = 96, 24
    x = 88
    for i in range(3):
        d.rounded_rectangle([x, 136, x + tab_w, 200], radius=18, fill=WHITE if i == 0 else SOFT)
        x += tab_w + gap

    # Signal bars = network.
    bars = [(120, 300), (200, 260), (280, 220), (360, 180)]
    for bx, top in bars:
        d.rounded_rectangle([bx, top + 40, bx + 52, 416], radius=14, fill=WHITE)
    return img


def main() -> None:
    OUT.mkdir(exist_ok=True)
    big = draw()
    for size in (16, 32, 48, 128):
        big.resize((size, size), Image.LANCZOS).save(OUT / f"icon{size}.png")
    print("icons written to", OUT)


if __name__ == "__main__":
    main()
