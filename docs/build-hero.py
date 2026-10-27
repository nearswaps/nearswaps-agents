"""Builds docs/hero.png (1200 x 630) for the README and the X post.
Same approach as the nearswaps site's og-build.py: ground #060708, the mint lockup from the logo masters, ink and body
text, JetBrains Mono for the one line, one hairline, no gradients. Everything it reads is in docs/brand.

Needs Python 3 with Pillow:   pip install pillow
Run (from anywhere):          python docs/build-hero.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
BRAND = os.path.join(HERE, "brand")
OUT = os.path.join(HERE, "hero.png")
W, H = 1200, 630
GROUND, INK, BODY, MUTED, MINT = (6, 7, 8), (242, 242, 240), (154, 159, 168), (110, 115, 124), (1, 250, 192)
LINE = (24, 25, 27)  # rgba(255,255,255,0.07) over the ground

def font(name, size, weight):
    f = ImageFont.truetype(os.path.join(BRAND, name), size)
    try: f.set_variation_by_name(weight)
    except Exception: pass
    return f

def trimmed(name):
    im = Image.open(os.path.join(BRAND, name)).convert("RGBA")
    return im.crop(im.getbbox())

lock = trimmed("Mint nearswaps logo lockup-2.png")
sym = trimmed("Mint nearswaps symbol with twin arrows-3.png")

im = Image.new("RGB", (W, H), GROUND)
d = ImageDraw.Draw(im)

# the symbol on the right edge, partly off the canvas, one flat alpha (as the site's OG images)
sh = 560
s = sym.resize((round(sym.width * sh / sym.height), sh), Image.LANCZOS)
s.putalpha(s.getchannel("A").point(lambda v: int(v * 0.16)))
im.paste(s, (W - s.width + 120, (H - sh) // 2 + 10), s)

# the lockup, large, on the left, then the one mono line
lh = 150
l = lock.resize((round(lock.width * lh / lock.height), lh), Image.LANCZOS)
ly = 186
im.paste(l, (72, ly), l)
fm = font("JetBrainsMono-VF.ttf", 38, b"Medium")
d.text((72, ly + lh + 56), "trade · withdraw → owner · caps on chain", font=fm, fill=MINT)

# footer: one hairline, the domain and the packages
ff = font("JetBrainsMono-VF.ttf", 22, b"Regular")
d.line([(72, H - 86), (W - 72, H - 86)], fill=LINE, width=1)
d.text((72, H - 62), "nearswaps.com/agents", font=ff, fill=INK)
foot = "@nearswaps/agent \u00b7 @nearswaps/agent-mcp"
d.text((W - 72 - d.textlength(foot, font=ff), H - 62), foot, font=ff, fill=MUTED)

im.save(OUT, optimize=True)
print("wrote", OUT, im.size, os.path.getsize(OUT), "bytes")
