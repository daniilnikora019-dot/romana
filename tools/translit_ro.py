# -*- coding: utf-8 -*-
"""Румынское слово → русская практическая транскрипция.
Румынская орфография почти фонетическая, поэтому правила короткие и предсказуемые."""

VOWELS = 'aăâeiîou'
SOFT = 'ei'          # перед этими c и g читаются как ч и дж


def transcribe(word):
    s = word.lower().strip()
    out, i, n = [], 0, len(s)
    while i < n:
        c = s[i]
        nxt = s[i + 1] if i + 1 < n else ''
        nxt2 = s[i + 2] if i + 2 < n else ''

        # диграфы ch/gh: буква i или e после них только смягчает, сама не звучит
        if c == 'c' and nxt == 'h' and nxt2 and nxt2 in SOFT:
            out.append('к'); i += 2; continue
        if c == 'g' and nxt == 'h' and nxt2 and nxt2 in SOFT:
            out.append('г'); i += 2; continue

        # c и g перед e, i
        if c in 'cg' and nxt and nxt in SOFT:
            base = 'ч' if c == 'c' else 'дж'
            # ci/gi перед гласной: i не читается (ciocolată → чоколатэ)
            if nxt == 'i' and nxt2 in 'aăâou':
                out.append(base); i += 2; continue
            out.append(base); i += 1; continue

        # i между гласными читается как й: pâine → пыйне
        if c == 'i' and i > 0 and s[i - 1] in VOWELS and nxt and nxt in VOWELS:
            out.append('й'); i += 1; continue

        # дифтонги
        pair = c + nxt
        if pair == 'ea': out.append('я'); i += 2; continue
        if pair == 'oa': out.append('оа'); i += 2; continue
        if pair == 'ia': out.append('я'); i += 2; continue
        if pair == 'ie' and i == 0: out.append('е'); i += 2; continue
        if pair == 'uă': out.append('уэ'); i += 2; continue

        # финальное -i: после гласной — й (mai → май), после согласной — мягкость
        # (но только если в слове есть другой гласный: și читается «ши», а не «шь»)
        if c == 'i' and i == n - 1 and i > 0:
            if s[i - 1] in VOWELS:
                out.append('й'); i += 1; continue
            if any(ch in VOWELS for ch in s[:i]):
                out.append('ь'); i += 1; continue

        out.append({
            'a': 'а', 'ă': 'э', 'â': 'ы', 'î': 'ы', 'b': 'б', 'c': 'к', 'd': 'д',
            'e': 'е', 'f': 'ф', 'g': 'г', 'h': 'х', 'i': 'и', 'j': 'ж', 'k': 'к',
            'l': 'л', 'm': 'м', 'n': 'н', 'o': 'о', 'p': 'п', 'q': 'к', 'r': 'р',
            's': 'с', 'ș': 'ш', 'ş': 'ш', 't': 'т', 'ț': 'ц', 'ţ': 'ц', 'u': 'у',
            'v': 'в', 'w': 'в', 'x': 'кс', 'y': 'и', 'z': 'з', ' ': ' ', '-': '-',
        }.get(c, c))
        i += 1
    return ''.join(out)


if __name__ == '__main__':
    tests = ['bună', 'mulțumesc', 'ce', 'ciocolată', 'gheață', 'îmi', 'bine', 'ziua',
             'copii', 'ochi', 'geam', 'cheie', 'șapte', 'țară', 'pâine', 'lucrează']
    for t in tests:
        print(f'{t:<12} → {transcribe(t)}')
