# -*- coding: utf-8 -*-
"""Заставка «мелом по доске»: переводит слово в контуры букв и вписывает в index.html.

  ~/venvs/kartuli/bin/python3 tools/build_splash.py <слово> <шрифт.ttf>

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
<div id="splash" aria-hidden="true">
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
