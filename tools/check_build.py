# -*- coding: utf-8 -*-
"""Проверка перед публикацией: словарь на месте, озвучка не разъехалась с ним."""
import json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
errors = []

data = json.load(open(f'{ROOT}/data/words-ro.json', encoding='utf-8'))
words = data['words']
if len(words) < 4000:
    errors.append(f'в словаре только {len(words)} лексем — ожидалось минимум 4000')

idx = json.load(open(f'{ROOT}/data/audio_index.json', encoding='utf-8'))
missing_idx = [w['ka'] for w in words if w['ka'] not in idx]
if missing_idx:
    errors.append(f'нет в индексе озвучки: {len(missing_idx)} слов, например {missing_idx[:3]}')

missing_files = [w['ka'] for w in words[:400]
                 if w['ka'] in idx and not os.path.exists(f"{ROOT}/audio/f/{idx[w['ka']]}.mp3")]
if missing_files:
    errors.append(f'нет звуковых файлов: {len(missing_files)}, например {missing_files[:3]}')

alphabet = json.load(open(f'{ROOT}/data/alphabet-ro.json', encoding='utf-8'))
if len(alphabet) != 31:
    errors.append(f'в алфавите {len(alphabet)} букв вместо 31')

json.load(open(f'{ROOT}/data/mnemonics-ro.json', encoding='utf-8'))

for f in ['index.html', 'app.js', 'style.css', 'sw.js', 'manifest.json']:
    if not os.path.exists(f'{ROOT}/{f}'):
        errors.append(f'нет файла {f}')

# --- config.js покрывает всё, что запрашивает общий код ---
# app.js/sw.js одинаковы в обоих проектах, различия живут только в config.js.
# Если в коде появилось обращение к L.чему-то, а в конфиге ключа нет,
# приложение сломается уже у пользователя — ловим это здесь.
def config_keys(text):
    """Пути вида alphabet.note из объекта L в config.js."""
    paths, stack = set(), []
    for line in text.split('\n'):
        body = line.split('//')[0]
        m = re.match(r'\s*([A-Za-z_]\w*)\s*:\s*(\{?)', body)
        if m:
            paths.add('.'.join(stack + [m.group(1)]))
            if m.group(2):
                stack.append(m.group(1))
                continue
        stack = stack[:max(0, len(stack) - body.count('}'))] if '}' in body else stack
    return paths

cfg = open(f'{ROOT}/config.js', encoding='utf-8').read() if os.path.exists(f'{ROOT}/config.js') else ''

# config.js — это JavaScript, и ошибка в нём валит приложение целиком: объект L
# не создаётся, и загрузка замирает на «загружаю словарь». Проверка поймала бы
# случай, когда комментарий был вписан питоновской решёткой вместо //.
def js_syntax_errors(text):
    bad, depth, in_str, quote, esc = [], 0, False, '', False
    for n, line in enumerate(text.split('\n'), 1):
        i = 0
        while i < len(line):
            c = line[i]
            if in_str:
                if esc: esc = False
                elif c == '\\': esc = True
                elif c == quote: in_str = False
            elif c in '"\'`':
                in_str, quote = True, c
            elif c == '/' and i + 1 < len(line) and line[i + 1] == '/':
                break                                   # дальше комментарий
            elif c == '#':
                bad.append(f'config.js:{n} — решётка вместо // : это синтаксис Python, JavaScript так не умеет')
                break
            elif c == '{': depth += 1
            elif c == '}': depth -= 1
            i += 1
        in_str = False
    if depth != 0:
        bad.append(f'config.js — фигурные скобки не сходятся (разница {depth})')
    return bad

for e in js_syntax_errors(cfg):
    errors.append(e)
if not cfg:
    errors.append('нет config.js — в нём живут все языковые различия')
else:
    have = config_keys(cfg)
    used = set()
    for f in ['app.js', 'sw.js']:
        used |= set(re.findall(r'\bL\.([A-Za-z_][\w.]*)', open(f'{ROOT}/{f}', encoding='utf-8').read()))
    for path in sorted(used - have):
        errors.append(f'код обращается к L.{path}, но такого ключа нет в config.js')

# в общий код не должно просачиваться название конкретного языка
# Значения с пометами сниженного стиля в учебный словарь не идут: среди них
# попадается обидная лексика, и однажды такое значение уже пришло вторым к
# нейтральному слову. Сборщик их отбрасывает, но данные правятся и руками,
# поэтому проверка стоит и здесь.
# Тренажёром пользуются и дети: слова про ненависть, террор и репрессии
# в нём неуместны, даже когда это обычная общественная лексика.
DRUGS = re.compile(r'наркотик|наркоман|героин|кокаин|марихуан|конопл|гашиш|опиум|морфин|амфетамин|каннабис|метадон', re.I)
for _w in words:
    if DRUGS.search(_w['ru']):
        errors.append(f"{_w['id']}: наркотики в учебном словаре не нужны")

HEAVY = re.compile(r'фашиз|фашист|нациз|нацист|национализм|националист|расиз|расист|шовиниз|'
                   r'экстремиз|антисемит|ксенофоб|апартеид|геноцид|холокост|сегрегац|'
                   r'дискриминац|террор|теракт|диктатур|тоталитар|репресс|концлагер|цензур|пропаганд', re.I)
for _w in words:
    if HEAVY.search(_w['ru']):
        errors.append(f"{_w['id']}: тяжёлая общественная лексика — тренажёру не нужна")

EXPLICIT_RU = re.compile(r'гетеросексуал|гомосексуал|бисексуал|сексизм|сексолог|сексуальн\w*\s+(ориентац|насил|домогат)|женская грудь|\bпенис|половой член|вагин|ягодиц|задниц|порногр|проститу|бордел|презерватив|мастурб|оргазм|эрекц|\bсперм|\bсекс\b|(оральн|анальн|вагинальн|групп\w*)\w*\s+секс', re.I)
for _w in words:
    if EXPLICIT_RU.search(_w['ru']):
        errors.append(f"{_w['id']}: значение про секс или связанную анатомию — учебному словарю не нужно")

DEMEANING = re.compile(r'(^|[;(]\s*)(вульг|груб|бран|обсц|неценз|презр|уничиж|пренебр|оскорб|неодобр|табу)\.', re.I)
for _w in words:
    if DEMEANING.search(_w['ru']):
        errors.append(f"{_w['id']}: значение с пометой сниженного стиля — такому не место в учебном словаре")

lang_marks = re.compile(r'грузин|Грузин|румын|Румын|kartuli|romana|ka-GE|ro-RO|мхедрули|[Ⴀ-ჿ]')
for f in ['app.js', 'sw.js']:
    for n, line in enumerate(open(f'{ROOT}/{f}', encoding='utf-8'), 1):
        m = lang_marks.search(line.replace('Georgian', ''))
        if m:
            errors.append(f'{f}:{n} — «{m.group(0)}» в общем коде, такому место в config.js')

if errors:
    print('ПРОВЕРКА НЕ ПРОЙДЕНА:')
    for e in errors: print(' •', e)
    sys.exit(1)

print(f'всё на месте: {len(words)} лексем, {sum(w["q"] for w in words)} в тренировках, '
      f'{len(idx)} озвучек, {len(alphabet)} букв')
