"""Render a simple book/headphones extension icon without external assets."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1] / "icons"
root.mkdir(exist_ok=True)
image = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
d = ImageDraw.Draw(image)
d.rounded_rectangle((12, 12, 500, 500), radius=112, fill="#785522")
d.polygon([(108, 212), (244, 236), (244, 392), (108, 366)], fill="#fff6dd")
d.polygon([(268, 236), (404, 212), (404, 366), (268, 392)], fill="#f0d9a5")
d.line((256, 240, 256, 390), fill="#4b3618", width=10)
d.arc((104, 75, 408, 377), 190, 350, fill="#fff6dd", width=26)
d.rounded_rectangle((86, 208, 123, 287), radius=13, fill="#fff6dd")
d.rounded_rectangle((389, 208, 426, 287), radius=13, fill="#fff6dd")
for size in (16, 32, 48, 128):
    image.resize((size, size), Image.Resampling.LANCZOS).save(root / f"icon-{size}.png")
print(root)
