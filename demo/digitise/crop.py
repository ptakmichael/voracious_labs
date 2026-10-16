import sys
from PIL import Image
# usage: crop.py page.png x0 y0 x1 y1 (pts) out.png
page, x0, y0, x1, y1, out = sys.argv[1], *map(float, sys.argv[2:6]), sys.argv[6]
k = 200 / 72
im = Image.open(page)
im.crop((int(x0 * k), int(y0 * k), int(x1 * k), int(y1 * k))).save(out)
