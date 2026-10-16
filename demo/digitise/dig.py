import numpy as np
from PIL import Image
K = 200 / 72

def load(page, box):
    x0, y0, x1, y1 = box
    im = np.asarray(Image.open(page).convert('RGB')).astype(int)
    return im[int(y0 * K):int(y1 * K), int(x0 * K):int(x1 * K)]

def lines(a, frac=0.45):
    """Columns / rows that are mostly grey or dark: grid lines and axes."""
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    grey = (abs(r - g) < 18) & (abs(g - b) < 18) & (r < 225)
    cols = grey.mean(axis=0); rows = grey.mean(axis=1)
    def peaks(v, thr):
        idx = np.where(v > thr)[0]
        out, cur = [], []
        for i in idx:
            if cur and i - cur[-1] > 2: out.append(float(np.mean(cur))); cur = []
            cur.append(i)
        if cur: out.append(float(np.mean(cur)))
        return out
    return peaks(cols, frac * cols.max()), peaks(rows, frac * rows.max())

def curve(a, pred, exclude=(), xr=None):
    """Median y of matching pixels in each column -> list of (x, y) in crop pixels."""
    m = pred(a[..., 0], a[..., 1], a[..., 2])
    for (x0, y0, x1, y1) in exclude: m[y0:y1, x0:x1] = False
    pts = []
    for x in range(m.shape[1]):
        if xr and not (xr[0] <= x <= xr[1]): continue
        ys = np.where(m[:, x])[0]
        if len(ys): pts.append((x, float(np.median(ys))))
    return pts

red = lambda r, g, b: (r > 200) & (g < 90) & (b < 90)
green = lambda r, g, b: (g > 140) & (r < 110) & (b < 110)
blue = lambda r, g, b: (b > 170) & (r < 90) & (g < 110)
