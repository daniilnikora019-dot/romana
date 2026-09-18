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
svg = f'''<!-- splash:start -->
<div id="splash" aria-hidden="true" style="--board:{board};--board-deep:{board_deep}">
  <svg class="wood" viewBox="0 0 400 900" preserveAspectRatio="xMidYMid slice">
    <!-- Дерево столешницы: слой шире экрана и повёрнут, чтобы волокна шли по диагонали.
         Три слоя шума: длинные тонкие волокна с плавными изгибами, светлые прожилки
         для глубины и короткие засечки-поры вдоль волокна. Зерно у каждого запуска
         своё: номера шума перед показом меняет скрипт ниже. -->
    <filter id="wood-grain" filterUnits="userSpaceOnUse" x="-500" y="-500" width="1400" height="1900"
            color-interpolation-filters="sRGB">
      <feTurbulence data-rand type="fractalNoise" baseFrequency="0.0045 0.2" numOctaves="3" seed="23" result="fiber"/>
      <feTurbulence data-rand type="fractalNoise" baseFrequency="0.0028 0.009" numOctaves="2" seed="5" result="bend"/>
      <feDisplacementMap in="fiber" in2="bend" scale="70" xChannelSelector="R" yChannelSelector="G" result="grain"/>
      <feColorMatrix in="grain" type="matrix" result="dark"
        values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  2.1 0 0 0 -0.98"/>
      <feColorMatrix in="grain" type="matrix" result="light"
        values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  -2.2 0 0 0 0.5"/>
      <feTurbulence data-rand type="fractalNoise" baseFrequency="0.045 0.75" numOctaves="1" seed="41" result="pore"/>
      <feDisplacementMap in="pore" in2="bend" scale="70" xChannelSelector="R" yChannelSelector="G" result="porebent"/>
      <feColorMatrix in="porebent" type="matrix" result="pores"
        values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  7 0 0 0 -4.6"/>
      <feMerge><feMergeNode in="dark"/><feMergeNode in="light"/><feMergeNode in="pores"/></feMerge>
    </filter>
    <g transform="rotate(-34 200 450)">
      <rect x="-500" y="-500" width="1400" height="1900" filter="url(#wood-grain)"/>
    </g>
  </svg>
  <script>
    /* у каждого открытия свой рисунок дерева */
    (function () {{
      var t = document.querySelectorAll('#splash feTurbulence[data-rand]');
      for (var i = 0; i < t.length; i++) t[i].setAttribute('seed', String(1 + Math.floor(Math.random() * 9999)));
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
