# -*- coding: utf-8 -*-
"""Озвучка словаря голосами Microsoft (ka-GE) через edge-tts."""
import asyncio, hashlib, json, os, sys, time
import edge_tts

BASE = os.path.expanduser('~/Library/Application Support/romana')
VOICES = {'f': 'ro-RO-AlinaNeural', 'm': 'ro-RO-EmilNeural'}
CONCURRENCY = 10

def key(text):
    return hashlib.sha1(text.encode('utf-8')).hexdigest()[:16]

def collect():
    texts = []
    data = json.load(open(f'{BASE}/data/words-ro.json', encoding='utf-8'))
    for w in data['words']:
        texts.append(w['ka'])
    for row in json.load(open(f'{BASE}/data/alphabet-ro.json', encoding='utf-8')):
        texts.append(row[1])          # сама буква
        texts.append(row[5])          # слово-пример
    seen, out = set(), []
    for t in texts:
        t = t.strip()
        if t and t not in seen:
            seen.add(t); out.append(t)
    return out

async def one(text, voice, path, sem, stats):
    async with sem:
        for attempt in range(4):
            try:
                comm = edge_tts.Communicate(text, voice)
                tmp = path + '.part'
                await comm.save(tmp)
                if os.path.getsize(tmp) < 500:
                    raise RuntimeError('too small')
                os.replace(tmp, path)
                stats['done'] += 1
                if stats['done'] % 250 == 0:
                    el = time.time() - stats['t0']
                    print(f"  {stats['done']}/{stats['total']}  {el:.0f}s", flush=True)
                return
            except Exception as e:
                if attempt == 3:
                    stats['fail'] += 1
                    stats['failed'].append(text)
                    print(f'  ОШИБКА: {text!r} {e}', flush=True)
                else:
                    await asyncio.sleep(1.5 * (attempt + 1))

async def main(which):
    voice = VOICES[which]
    outdir = f'{BASE}/audio/{which}'
    os.makedirs(outdir, exist_ok=True)
    texts = collect()
    todo = [(t, f'{outdir}/{key(t)}.mp3') for t in texts]
    todo = [(t, p) for t, p in todo if not (os.path.exists(p) and os.path.getsize(p) > 500)]
    print(f'голос {voice}: всего {len(texts)}, к генерации {len(todo)}', flush=True)
    sem = asyncio.Semaphore(CONCURRENCY)
    stats = {'done': 0, 'fail': 0, 'total': len(todo), 't0': time.time(), 'failed': []}
    await asyncio.gather(*[one(t, voice, p, sem, stats) for t, p in todo])
    print(f"готово: {stats['done']}, ошибок: {stats['fail']}, {time.time()-stats['t0']:.0f}s", flush=True)
    if stats['failed']:
        json.dump(stats['failed'], open(f'{BASE}/audio/failed_{which}.json', 'w'), ensure_ascii=False)
    # индекс текст -> файл
    json.dump({t: key(t) for t in texts},
              open(f'{BASE}/data/audio_index.json', 'w', encoding='utf-8'),
              ensure_ascii=False, separators=(',', ':'))

if __name__ == '__main__':
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else 'f'))
