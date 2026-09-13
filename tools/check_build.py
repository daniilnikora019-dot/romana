# -*- coding: utf-8 -*-
"""Проверка перед публикацией: словарь на месте, озвучка не разъехалась с ним."""
import json, os, sys

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

if errors:
    print('ПРОВЕРКА НЕ ПРОЙДЕНА:')
    for e in errors: print(' •', e)
    sys.exit(1)

print(f'всё на месте: {len(words)} лексем, {sum(w["q"] for w in words)} в тренировках, '
      f'{len(idx)} озвучек, {len(alphabet)} букв')
