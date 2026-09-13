# -*- coding: utf-8 -*-
"""Проверяет уже собранный каталог _site, а не исходники.

Появился после того, как config.js не попал в список копируемых файлов:
проверка исходников прошла, деплой прошёл, а на сайте приложение падало,
потому что файла там просто не было. Здесь берём все ссылки, которые
страница и service worker запрашивают, и убеждаемся, что каждая на месте.
"""
import os, re, sys

SITE = sys.argv[1] if len(sys.argv) > 1 else '_site'
errors = []

def read(p):
    full = os.path.join(SITE, p)
    if not os.path.exists(full):
        errors.append(f'в сборке нет {p} — проверьте список копируемых файлов в deploy.yml')
        return ''
    with open(full, encoding='utf-8') as f:
        return f.read()

if not os.path.isdir(SITE):
    sys.exit(f'нет каталога сборки {SITE}')

need = set()

# что подключает страница
html = read('index.html')
for m in re.finditer(r'(?:src|href)="([^"#:]+)"', html):
    ref = m.group(1)
    if not ref.startswith(('http', 'data:', '//')):
        need.add(ref)

# что кладёт в офлайн-кэш service worker
sw = read('sw.js')
block = re.search(r'SHELL_FILES\s*=\s*\[(.*?)\]', sw, re.S)
if not block:
    errors.append('в sw.js не найден список SHELL_FILES')
else:
    for lit in re.findall(r"'([^']+)'", block.group(1)):
        if lit not in ('./',):
            need.add(lit)
    # пути к данным приходят из config.js
    cfg = read('config.js')
    data = re.search(r'data:\s*\{(.*?)\}', cfg, re.S)
    if data:
        need.update(re.findall(r":\s*'([^']+)'", data.group(1)))
    elif cfg:
        errors.append('в config.js не найден раздел data')

for ref in sorted(need):
    if not os.path.exists(os.path.join(SITE, ref.lstrip('./'))):
        errors.append(f'страница запрашивает {ref}, но в сборке его нет')

if errors:
    print('СБОРКА НЕПОЛНАЯ:')
    for e in errors:
        print(' •', e)
    sys.exit(1)

print(f'сборка полная: проверено ссылок {len(need)}, файлов всего '
      f'{sum(len(f) for _, _, f in os.walk(SITE))}')
