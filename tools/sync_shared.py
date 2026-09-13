# -*- coding: utf-8 -*-
"""Синхронизирует общий код с грузинским проектом.

Логика тренажёров одинакова, различия целиком вынесены в config.js. Поэтому
app.js, style.css и sw.js переносятся побайтово, без единой подстановки —
раньше здесь был список из трёх десятков замен, и каждая молча ломалась,
стоило переформулировать строку в исходнике.

  python3 tools/sync_shared.py          перенести и проверить
  python3 tools/sync_shared.py --check  только проверить (для CI)
"""
import hashlib, os, re, shutil, sys

RO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KA = os.path.expanduser('~/Library/Application Support/kartuli')
SHARED = ['app.js', 'style.css', 'sw.js']

# в общем коде не должно остаться ничего, привязанного к конкретному языку
FORBIDDEN = re.compile(
    r'грузин|Грузин|румын|Румын|kartuli|romana|ka-GE|ro-RO|мхедрули|'
    r'[Ⴀ-ჿ]|[ăâîșțĂÂÎȘȚ]', re.U)


def digest(path):
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


def lint(path):
    """Ловит язык, случайно вшитый в общий файл вместо config.js."""
    bad = []
    with open(path, encoding='utf-8') as f:
        for n, line in enumerate(f, 1):
            m = FORBIDDEN.search(line)
            if m:
                bad.append((n, m.group(0), line.strip()[:70]))
    return bad


def main():
    check_only = '--check' in sys.argv
    if not check_only:
        if not os.path.isdir(KA):
            sys.exit(f'не найден грузинский проект: {KA}')
        for f in SHARED:
            shutil.copyfile(f'{KA}/{f}', f'{RO}/{f}')

    problems = []
    for f in SHARED:
        local = f'{RO}/{f}'
        for n, tok, line in lint(local):
            problems.append(f'{f}:{n} — «{tok}» в общем коде, место таким в config.js\n    {line}')
        if os.path.isdir(KA):
            a, b = digest(f'{KA}/{f}'), digest(local)
            mark = 'совпадает' if a == b else 'РАСХОДИТСЯ'
            if a != b:
                problems.append(f'{f} — расходится с грузинским проектом')
            print(f'  {f:<11} {b[:12]}  {mark}')
        else:
            print(f'  {f:<11} {digest(local)[:12]}')

    if problems:
        print('\nпроблемы:')
        for p in problems:
            print(' ·', p)
        sys.exit(1)
    print('общий код синхронизирован' if not check_only else 'общий код в порядке')


if __name__ == '__main__':
    main()
