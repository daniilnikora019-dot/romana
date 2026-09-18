# -*- coding: utf-8 -*-
"""Заставка «мелом по доске»: переводит слово в контуры букв и вписывает в index.html.

  ~/venvs/kartuli/bin/python3 tools/build_splash.py <слово> <шрифт.ttf> [<цвет иконки>]

Буквы берутся из шрифта и сохраняются векторными контурами, по одному на букву:
анимация проводит линию по каждому контуру с небольшой задержкой между буквами,
как будто слово пишут мелом. Шрифт в приложение не попадает — только контуры
нескольких букв, несколько килобайт.

Нужен fontTools (pip install fonttools). Переменный шрифт приводится к
среднему начертанию (вес 500), чтобы мел был не слишком тонким и не жирным.
Результат вписывается между пометками <!-- splash:start --> и <!-- splash:end -->.
Стили заставки кладутся туда же, прямо в страницу: иначе доска ждала бы загрузки
общего файла стилей, и на медленной сети вместо неё несколько секунд был белый экран.
"""
import os, re, sys
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
word, font_path = sys.argv[1], sys.argv[2]
icon = sys.argv[3] if len(sys.argv) > 3 else '#26302b'


def board_colors(hexcolor):
    """Доска того же оттенка, что иконка, но тёмная: иначе белый мел не читается.
    Светлота 14%, насыщенность чуть приглушена, чтобы цвет не спорил с надписью.
    Второй цвет — для волокон дерева, ещё темнее."""
    import colorsys
    r, g, b = (int(hexcolor[i:i + 2], 16) / 255 for i in (1, 3, 5))
    hue, _, sat = colorsys.rgb_to_hls(r, g, b)
    def mk(light, s_mul):
        rr, gg, bb = colorsys.hls_to_rgb(hue, light, min(1, sat * s_mul))
        return '#%02x%02x%02x' % (round(rr * 255), round(gg * 255), round(bb * 255))
    return mk(0.14, 0.8), mk(0.07, 0.75)


board, board_deep = board_colors(icon)

font = TTFont(font_path)
if 'fvar' in font:
    from fontTools.varLib import instancer
    axes = {a.axisTag: a.defaultValue for a in font['fvar'].axes}
    axes['wght'] = 500
    font = instancer.instantiateVariableFont(font, axes)

cmap = font.getBestCmap()
glyphs = font.getGlyphSet()
hmtx = font['hmtx']
upm = font['head'].unitsPerEm
asc, desc = font['hhea'].ascent, font['hhea'].descent

paths, x = [], 0
for ch in word:
    name = cmap.get(ord(ch))
    if name is None:
        sys.exit(f'в шрифте нет буквы {ch!r}')
    adv = hmtx[name][0]
    if ch.strip():
        pen = SVGPathPen(glyphs, ntos=lambda v: str(round(v)))   # единицы шрифта — целых хватает
        # в шрифте ось y смотрит вверх, в SVG — вниз: переворачиваем и сдвигаем на место буквы
        glyphs[name].draw(TransformPen(pen, (1, 0, 0, -1, x, asc)))
        d = pen.getCommands()
        if d:
            paths.append(d)
    x += adv

pad = upm * 0.08
w, h = x + pad * 2, (asc - desc) + pad * 2
sw = round(upm * 0.03, 1)           # толщина мела — около трёх процентов кегля
wobble = round(upm * 0.016, 1)      # насколько мел «рвёт» край линии
# Частоты шума заданы в единицах шрифта, а не в пикселях: весь рисунок живёт
# в координатах букв. Крупный шум гнёт край линии, мелкий выбивает в ней
# просветы — так ложится мел на доску.
warp_freq = round(12 / upm, 4)
dust_freq = round(60 / upm, 4)

body = '\n'.join(
    f'      <path class="chalk" pathLength="1" style="--i:{i}" d="{d}"/>'
    for i, d in enumerate(paths))
SPLASH_CSS = '#splash{ position:fixed;inset:0;z-index:200;display:grid;place-items:center; background:var(--board,#1d2421); transition:opacity .38s ease; } #splash.out{opacity:0;pointer-events:none} #splash .chalk-word{width:min(78vw,520px);height:auto;overflow:visible;position:relative} #splash .wood{position:absolute;inset:0;width:100%;height:100%} #splash .chalk{ fill:#f1ede2;fill-opacity:0;stroke:#f1ede2;stroke-opacity:.92; stroke-linecap:round;stroke-linejoin:round; stroke-dasharray:1;stroke-dashoffset:1; animation:chalk-draw .75s cubic-bezier(.45,.05,.4,1) forwards, chalk-fill .4s ease-out forwards; animation-delay:calc(var(--i) * .12s), calc(.7s + var(--i) * .12s); } @keyframes chalk-draw{to{stroke-dashoffset:0}} @keyframes chalk-fill{to{fill-opacity:.9}} @media (prefers-reduced-motion: reduce){#splash{display:none}}'

svg = f'''<!-- splash:start -->
<style>{SPLASH_CSS}</style>
<div id="splash" aria-hidden="true" style="--board:{board};--board-deep:{board_deep}">
  <canvas class="wood" id="splash-wood"></canvas>
  <script>
    /* Дерево столешницы рисуется здесь же, скриптом, а не SVG-фильтром: фильтр
       с шумом на весь экран Safari на iPhone считал по нескольку секунд, и всё это
       время вместо заставки был белый экран. Скрипт укладывается в сотые доли секунды.
       Рисунок тот же: длинные тонкие волокна, изогнутые медленным шумом, светлые
       прожилки и короткие засечки-поры вдоль волокна; слой повёрнут на 34°, чтобы
       волокна шли по диагонали. Зерно постоянное: рисунок всегда один и тот же.
       Заодно запоминаем, когда заставка появилась, — от этого момента, а не от
       начала загрузки, считаются её две секунды. */
    window.SPLASH_AT = performance.now();
    (function () {{
      var cv = document.getElementById('splash-wood');
      var W = Math.max(1, innerWidth), H = Math.max(1, innerHeight);
      cv.width = W; cv.height = H;
      var ctx = cv.getContext && cv.getContext('2d');
      if (!ctx) return;
      // перемешанная таблица 0..255 — основа шума; перемешана по постоянному зерну
      var P = new Uint8Array(512), i, j, t, seed = 20260918;
      function rnd() {{ seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) / 16777216; }}
      for (i = 0; i < 256; i++) P[i] = i;
      for (i = 255; i > 0; i--) {{ j = Math.floor(rnd() * (i + 1)); t = P[i]; P[i] = P[j]; P[j] = t; }}
      for (i = 0; i < 256; i++) P[i + 256] = P[i];
      function noise(x, y) {{            // гладкий шум 0..1
        var xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
        xi &= 255; yi &= 255;
        var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
        var a = P[P[xi] + yi], b = P[P[xi + 1] + yi], c = P[P[xi] + yi + 1], d = P[P[xi + 1] + yi + 1];
        var top = a + (b - a) * u, bot = c + (d - c) * u;
        return (top + (bot - top) * v) / 255;
      }}
      function fbm(x, y, oct) {{         // несколько октав — от крупного к мелкому
        var s = 0, amp = 1, tot = 0;
        for (var o = 0; o < oct; o++) {{ s += (noise(x, y) - .5) * amp; tot += amp; x *= 2; y *= 2; amp *= .5; }}
        return .5 + .8 * s / tot;
      }}
      var hex = getComputedStyle(cv.parentNode).getPropertyValue('--board').trim() || '#1d2421';
      var br = parseInt(hex.substr(1, 2), 16), bg = parseInt(hex.substr(3, 2), 16), bb = parseInt(hex.substr(5, 2), 16);
      // экран вписан в поле 400×900, как у обычной картинки «по размеру с обрезкой»
      var k = Math.max(W / 400, H / 900), co = Math.cos(34 * Math.PI / 180), si = Math.sin(34 * Math.PI / 180);
      var img = ctx.createImageData(W, H), px = img.data, n = 0, OP = .6;
      for (var y = 0; y < H; y++) {{
        var dy = (y - H / 2) / k;
        for (var x = 0; x < W; x++) {{
          var dx = (x - W / 2) / k;
          var qx = dx * co - dy * si + 2000, qy = dx * si + dy * co + 2000;
          // медленный шум изгибает волокна
          qx += 70 * (fbm(qx * .0028, qy * .009, 2) - .5);
          qy += 70 * (fbm(qx * .0028 + 57, qy * .009 + 131, 2) - .5);
          // широкие годичные полосы + тонкие волокна поверх них
          var ring = fbm(qx * .0016, qy * .035, 2);
          var f = .55 * fbm(qx * .003, qy * .16, 4) + .45 * ring;
          var p = noise(qx * .09, qy * 1.1);
          var dk = Math.min(1, Math.max(0, 2.6 * f - 1.22)) * OP;      // тёмные волокна
          var lt = Math.min(1, Math.max(0, .42 - 1.9 * f)) * OP;       // светлые прожилки
          var pr = Math.min(1, Math.max(0, 6 * p - 5.1)) * OP;         // поры-засечки
          var r = br, g = bg, b = bb, m = (1 - dk) * (1 - pr);
          r = (r * (1 - lt) + 255 * lt) * m; g = (g * (1 - lt) + 255 * lt) * m; b = (b * (1 - lt) + 255 * lt) * m;
          px[n] = r; px[n + 1] = g; px[n + 2] = b; px[n + 3] = 255; n += 4;
        }}
      }}
      ctx.putImageData(img, 0, 0);
      window.SPLASH_WOOD_MS = performance.now() - window.SPLASH_AT;
    }})();
  </script>
  <svg class="chalk-word" viewBox="{-pad:.0f} {-pad:.0f} {w:.0f} {h:.0f}" role="img">
    <defs>
      <filter id="chalk-edge" x="-10%" y="-10%" width="120%" height="120%">
        <feTurbulence type="fractalNoise" baseFrequency="{warp_freq}" numOctaves="2" seed="7" result="warp"/>
        <feDisplacementMap in="SourceGraphic" in2="warp" scale="{wobble}" xChannelSelector="R" yChannelSelector="G" result="rough"/>
        <feTurbulence type="fractalNoise" baseFrequency="{dust_freq}" numOctaves="2" seed="3" result="dust"/>
        <feColorMatrix in="dust" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 -2.4 1.95" result="holes"/>
        <feComposite in="rough" in2="holes" operator="in"/>
      </filter>
    </defs>
    <g filter="url(#chalk-edge)" stroke-width="{sw}">
{body}
    </g>
  </svg>
</div>
<!-- splash:end -->'''

p = f'{ROOT}/index.html'
html = open(p, encoding='utf-8').read()
if '<!-- splash:start -->' in html:
    html = re.sub(r'<!-- splash:start -->.*?<!-- splash:end -->', lambda m: svg, html, flags=re.S)
else:
    html = html.replace('<body>', '<body>\n' + svg, 1)
open(p, 'w', encoding='utf-8').write(html)
print(f'заставка: «{word}», букв {len(paths)}, {len(svg.encode()) // 1024} КБ разметки')
