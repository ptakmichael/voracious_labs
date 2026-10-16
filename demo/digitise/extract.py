import json, numpy as np, dig
from PIL import Image, ImageDraw
K = dig.K
def fit(px, vals):
    a, b = np.polyfit(px, vals, 1); return a, b   # value = a*px + b

orange = lambda r, g, b: (r > 225) & (g > 150) & (g < 215) & (b > 90) & (b < 175) & (r - b > 75)
magenta = lambda r, g, b: (r > 215) & (g < 175) & (b > 215)
tan = lambda r, g, b: (r > 175) & (r < 225) & (g > 135) & (g < 190) & (b > 95) & (b < 165) & (r - b > 45)
red2 = lambda r, g, b: (r > 215) & (g < 150) & (b < 150) & (r - g > 90)

X28 = [2.0, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8]
P = {
 'p5':  dict(page='p-3.png', box=(300,120,580,218), xv=([58,136,214,293,372,451,530,608,687], X28), yv=([28,65,102,139,176,212],[0,-5,-10,-15,-20,-25]),
            series=[('S11', 'red')], ex=[(290,30,385,58),(20,212,130,245),(700,0,778,272)]),
 'p4':  dict(page='p-3.png', box=(28,625,305,717), xv=([67,149,230,313,394,476,558,640,722], X28), yv=([28,55,82,110,137,164,191,218],[35,30,25,20,15,10,5,0]),
            series=[('VSWR', 'red')], ex=[(30,222,150,250),(725,0,770,255)]),
 'p6':  dict(page='p-3.png', box=(300,285,580,380), xv=([46,130,214,298,382,550,634,718],[2.0,2.1,2.2,2.3,2.4,2.6,2.7,2.8]), yv=([38,65,93,122,150,176,205,233],[35,30,25,20,15,10,5,0]),
            series=[('VSWR', 'red'), ('S11 magnitude', 'green')], ex=[(380,40,485,82),(20,236,130,264),(722,0,778,264)]),
 'p7':  dict(page='p-3.png', box=(300,408,580,512), xv=([50,136,222,307,391,478,564,650,735], X28), yv=([38,61,84,108,132,154,178,202,226,248,272],[4,3.5,3,2.5,2,1.5,1,0.5,0,-0.5,-1]),
            series=[('Gain', 'red')], ex=[(470,40,745,72),(115,242,245,272)]),
 'p8':  dict(page='p-4.png', box=(28,28,305,135), xv=([66,157,250,341,432,524,616,708],[2.0,2.1,2.2,2.3,2.4,2.5,2.6,2.7]), yv=([66,93,121,150,178,204,232,261],[7.1,7.0,6.9,6.8,6.7,6.6,6.5,6.4]),
            series=[('Directivity', 'green')], ex=[(555,68,770,112),(60,228,170,256)]),
 'p9':  dict(page='p-4.png', box=(28,245,305,335), xv=([86,150,214,278,342,405,469,533],[2.0,2.1,2.2,2.3,2.4,2.5,2.6,2.7]), yv=([42,72,101,130,160,189],[0.5,0.4,0.3,0.2,0.1,0.0]),
            series=[('Power accepted', 'orange'), ('Power radiated', 'tan'), ('Loss in dielectrics', 'red2'), ('Power outgoing', 'magenta')], ex=[(570,0,770,250),(380,0,470,30)]),
 'p12': dict(page='p-4.png', box=(300,388,580,488), xv=([83,153,222,292,362,432,502,572,642,712],[0,20,40,60,80,100,120,140,160,180]), yv=([37,65,94,123,152,180,209,238],[5,0,-5,-10,-15,-20,-25,-30]),
            series=[('Gain', 'red')], ex=[(355,38,515,68),(155,172,315,232),(720,0,778,278)]),
 'p13': dict(page='p-4.png', box=(300,580,580,698), xv=([90,170,248,326,406,484,562,641,720], X28), yv=([46,78,112,146,180,213,248,281],[0.005,0.004,0.003,0.002,0.001,0,-0.001,-0.002]),
            series=[('Power absorbed at all ports', 'blue')], ex=[(435,52,605,82),(148,252,285,278)]),
 'p14': dict(page='p-5.png', box=(28,105,305,210), xv=([112,189,265,342,418,494,570,646,722], X28), yv=([36,78,119,160,201,242],[0.25,0.2,0.15,0.1,0.05,0]),
            series=[('Loss in dielectrics', 'red'), ('Loss in metals', 'green')], ex=[(172,182,345,225),(725,0,770,292)]),
 'p16': dict(page='p-5.png', box=(300,72,580,158), xv=([60,144,226,310,393,560,643,726],[2.0,2.1,2.2,2.3,2.4,2.6,2.7,2.8]), yv=([19,41,64,87,109,132,155,178,200],[-2,-4,-6,-8,-10,-12,-14,-16,-18]),
            series=[('Radiation efficiency', 'red2'), ('Total efficiency', 'green')], ex=[(595,18,750,58),(422,105,525,218),(290,0,330,60),(370,0,410,40),(712,38,745,62),(712,150,745,175)]),
}
preds = dict(red2=red2, red=dig.red, green=dig.green, blue=dig.blue, orange=orange, magenta=magenta, tan=tan)
out = {}
for name, s in P.items():
    a = dig.load(s['page'], s['box'])
    ax, bx = fit(*s['xv']); ay, by = fit(*s['yv'])
    x0p, x1p = min(s['xv'][0]), max(s['xv'][0]) if name not in ('p8','p9') else (min(s['xv'][0]), (2.8 - bx) / ax)
    if isinstance(x1p, tuple): x0p, x1p = x1p
    y0p, y1p = (s['yv'][0][0], s['yv'][0][-1])
    ser = []
    im = Image.fromarray(a.astype('uint8')); dr = ImageDraw.Draw(im)
    for label, col in s['series']:
        pts = dig.curve(a, preds[col], [tuple(e) for e in s['ex']], xr=(int(x0p), int(min(x1p, a.shape[1] - 1))))
        pts = [(x, y) for x, y in pts if y0p - 25 <= y <= max(y1p, a.shape[0]) ]
        pts = pts[::3] if len(pts) > 60 else pts
        data = [[round(ax * x + bx, 4), round(ay * y + by, 5)] for x, y in pts]
        ser.append({'label': label, 'color': col, 'data': data})
        for x, y in pts: dr.ellipse((x - 1.5, y - 1.5, x + 1.5, y + 1.5), fill=(0, 0, 0))
    im.save(f'chk-{name}.png')
    # plot frame in page points, and the data->points mapping (linear): pt = box0 + (val - b)/a / K
    out[name] = {'box': s['box'], 'x': {'a': ax, 'b': bx}, 'y': {'a': ay, 'b': by}, 'series': ser}
    print(name, [(x['label'], len(x['data'])) for x in ser])
json.dump(out, open('patch-digitised.json', 'w'))
