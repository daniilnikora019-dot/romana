/* Тренажёр языка. Язык задаётся в config.js, данные: data/*.json, озвучка: audio/<voice>/<hash>.mp3 */
'use strict';

const LS_KEY = `${L.key}_progress_v1`;
const THEME_KEY = `${L.key}_theme`;
const SESSION_KEY = `${L.key}_session_v1`;
const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1'];
// интервалы SRS: после 5-го верного ответа слово считается выученным
const STEPS = [10 * 60e3, 6 * 3600e3, 24 * 3600e3, 3 * 864e5, 7 * 864e5];
const MASTER_REPS_DEFAULT = 5;
const masterReps = () => (S.prog && S.prog.set.masterReps) || MASTER_REPS_DEFAULT;

const S = {
  words: [], byId: new Map(), cats: [], alphabet: [], audio: {},
  prog: null, route: 'home', session: null, audioEl: null, lessons: null,
};

/* ---------------- прогресс ---------------- */
const dateKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => dateKey(new Date());   // местная дата, а не UTC: занятия после полуночи — это новый день

function defaultProgress() {
  return {
    w: {},                       // id -> {s,r,d,lr,e}
    days: {},                    // 'YYYY-MM-DD' -> {rev,new,known}
    streak: 0, best: 0, lastActive: null, onboarded: false, les: {},
    set: {
      cats: ['greetings', 'phrases', 'numbers', 'pronouns', 'questions', 'verbs',
             'adjectives', 'family', 'food', 'time', 'adverbs'],
      levels: ['A1', 'A2', 'B1'],
      voice: 'f', autoplay: true, translit: true, refresh: true,
      speed: 1, invertSwipe: false, reviewScope: 'selected', masterReps: 5,
      newPerDay: 12, reviewPerDay: 60,
      reviewMode: 'choose',        // choose — выбираешь способ сам; recall / choice / mix — фиксированные
    },
  };
}

/* Слова, взятые в изучение, но ни разу не названные верно в закреплении.
   Хранится в прогрессе, а не в сессии: раньше выход из закрепления на полпути
   оставлял такие слова в пустоте — новыми они больше не предлагались, на
   повторение ещё не пришли, а сессия с ними терялась. */
/* Норма — план на день, а не потолок: размер порции выбирается вручную и может
   её перекрыть. Дробь «11 из 10» при этом читается как ошибка, поэтому сверх
   нормы показываем прибавкой, а не невозможным знаменателем. */
function goalText(done, goal) {
  return done > goal ? `${goal} + ${done - goal} сверх` : `${done} / ${goal}`;
}

function pendingDrill() {
  const ids = S.prog.pend || [];
  return ids.map(id => S.byId.get(id)).filter(w => w && wp(w.id).s === 'learning' && !(wp(w.id).r > 0));
}
function markPending(id, on) {
  const ids = new Set(S.prog.pend || []);
  on ? ids.add(id) : ids.delete(id);
  S.prog.pend = [...ids];
  saveProgress();
}

function loadProgress() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      p.set = Object.assign(defaultProgress().set, p.set || {});
      p.w = p.w || {}; p.days = p.days || {}; p.pend = p.pend || []; p.les = p.les || {};
      return p;
    }
  } catch (e) { console.warn('прогресс не прочитан', e); }
  return defaultProgress();
}
let saveTimer = null;
function saveProgress() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(S.prog)); }
    catch (e) { toast('Не удалось сохранить прогресс'); }
  }, 250);
}

function wp(id) {                                   // состояние слова
  return S.prog.w[id] || { s: 'new', r: 0, d: 0, lr: null, e: 0 };
}
function setWp(id, v) { S.prog.w[id] = v; saveProgress(); }

function dayRec(d) {
  if (!S.prog.days[d]) S.prog.days[d] = { rev: 0, new: 0, known: 0, started: 0, drilled: 0 };
  if (S.prog.days[d].started === undefined) S.prog.days[d].started = 0;
  if (S.prog.days[d].drilled === undefined) S.prog.days[d].drilled = 0;
  return S.prog.days[d];
}
/* сколько новых слов ещё осталось до дневной нормы */
function newLeftToday() {
  return Math.max(0, S.prog.set.newPerDay - dayRec(today()).started);
}
function touchStreak() {
  const t = today(), last = S.prog.lastActive;
  if (last === t) return;
  const y = dateKey(new Date(Date.now() - 864e5));
  S.prog.streak = (last === y) ? S.prog.streak + 1 : 1;
  S.prog.best = Math.max(S.prog.best || 0, S.prog.streak);
  S.prog.lastActive = t;
}

/* ---------------- выборки ---------------- */
function inScope(w) {
  const st = S.prog.set;
  return w.cats.some(c => st.cats.includes(c)) && st.levels.includes(w.lvl);
}
function poolWords() { return S.words.filter(inScope); }

function newQueue() {
  return poolWords().filter(w => w.q && wp(w.id).s === 'new')
    .sort((a, b) => LEVELS.indexOf(a.lvl) - LEVELS.indexOf(b.lvl) || b.f - a.f);
}
const REFRESH_FIRST = 30 * 864e5;      // первая проверка выученного слова — через месяц
const REFRESH_NEXT = 90 * 864e5;       // дальше — раз в три месяца

function dueQueue() {
  const now = Date.now();
  const refresh = S.prog.set.refresh !== false;
  const onlySelected = S.prog.set.reviewScope !== 'all';
  return S.words.filter(w => {
    if (onlySelected && !inScope(w)) return false;
    const p = wp(w.id);
    if (p.s === 'learning') return p.d <= now;
    if (p.s === 'mastered' && refresh) return p.d && p.d <= now;   // поддерживающее повторение
    return false;
  }).sort((a, b) => wp(a.id).d - wp(b.id).d);
}
function counts() {
  let learning = 0, mastered = 0, known = 0;
  for (const id in S.prog.w) {
    const s = S.prog.w[id].s;
    if (s === 'learning') learning++; else if (s === 'mastered') mastered++; else if (s === 'known') known++;
  }
  return { learning, mastered, known, total: S.words.length, due: dueQueue().length, fresh: newQueue().length };
}

/* ---------------- озвучка ---------------- */
function audioUrl(text) {
  const h = S.audio[text];
  // у некоторых языков доступен всего один голос — выбора нет, папка всегда одна
  const voice = L.voice.single ? 'f' : S.prog.set.voice;
  return h ? `audio/${voice}/${h}.mp3` : null;
}
function speak(text) {
  const url = audioUrl(text);
  if (!url) {
    toast(Object.keys(S.audio).length ? `Нет озвучки для «${text}»`
                                      : 'Файл озвучки не загружен — обновите страницу (Cmd+Shift+R)');
    return;
  }
  if (S.audioEl) { S.audioEl.pause(); }
  const a = new Audio(url);
  a.playbackRate = S.prog.set.speed || 1;
  S.audioEl = a;
  a.onerror = () => toast('Звуковой файл не открылся: ' + url.split('/').pop());
  a.play().catch(err => {
    // Safari и Chrome блокируют звук без жеста пользователя — сообщаем, а не молчим
    toast(err.name === 'NotAllowedError'
      ? 'Браузер заблокировал звук: нажмите кнопку проигрывания ещё раз'
      : 'Не удалось воспроизвести: ' + err.name);
  });
}

/* ---------------- утилиты ---------------- */
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0;[a[i], a[j]] = [a[j], a[i]]; } return a; };
const pick = (a, n) => shuffle(a.slice()).slice(0, n);
const catName = (id) => (S.cats.find(c => c.id === id) || { name: id }).name;
/* Значок раздела словаря — цветной, из открытого набора Fluent Emoji (Microsoft,
   лицензия MIT), файлы лежат в icons/cat. Разделы у всех языков одни и те же,
   поэтому файл называется по идентификатору раздела и общий код обходится без
   таблицы соответствий. */
const catIcon = (id) => `<img class="cat-ic" src="icons/cat/${encodeURIComponent(id)}.svg" alt="" loading="lazy">`;
const plural = (n, a, b, c) => { const m = n % 100, k = n % 10; return n + ' ' + (m > 10 && m < 20 ? c : k === 1 ? a : k > 1 && k < 5 ? b : c); };

function toast(msg) {
  $$('.toast').forEach(t => t.remove());
  const t = el(`<div class="toast">${esc(msg)}</div>`);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

/* ---------------- значки ----------------
   Свой набор вместо эмодзи: эмодзи рисует система, они разные на разных
   устройствах и выдают чужой стиль. Здесь один язык формы: сетка 24×24,
   только контур, скруглённые концы, ничего лишнего. Цвет наследуется от
   текста, поэтому значок сам подстраивается под тему и под акцент. */
const ICONS = {
  play:    '<path d="M8.5 5.6v12.8L19 12z"/>',
  pause:   '<path d="M9.3 5.5v13M14.7 5.5v13"/>',
  eye:     '<path d="M2.6 12S6.2 6.2 12 6.2 21.4 12 21.4 12 17.8 17.8 12 17.8 2.6 12 2.6 12z"/><circle cx="12" cy="12" r="2.7"/>',
  keyboard:'<rect x="2.6" y="6" width="18.8" height="12" rx="2.4"/><path d="M6.4 10h.01M9.8 10h.01M13.2 10h.01M16.6 10h.01M6.4 13.4h.01M9.8 13.4h.01M13.2 13.4h.01M16.6 13.4h.01M8.6 16.4h6.8"/>',
  grid:    '<rect x="3.2" y="3.2" width="7.6" height="7.6" rx="1.6"/><rect x="13.2" y="3.2" width="7.6" height="7.6" rx="1.6"/><rect x="3.2" y="13.2" width="7.6" height="7.6" rx="1.6"/><rect x="13.2" y="13.2" width="7.6" height="7.6" rx="1.6"/>',
  bulb:    '<path d="M12 3a6 6 0 0 0-3.6 10.8c.7.5 1.1 1.2 1.1 2h5a2.6 2.6 0 0 1 1.1-2A6 6 0 0 0 12 3z"/><path d="M9.8 19h4.4M10.7 21.3h2.6"/>',
  check:   '<path d="M4.8 12.6 9.6 17.4 19.2 6.9"/>',
  cross:   '<path d="M6.4 6.4 17.6 17.6M17.6 6.4 6.4 17.6"/>',
  right:   '<path d="M4.5 12h14.2M12.8 6.1 18.7 12l-5.9 5.9"/>',
  left:    '<path d="M19.5 12H5.3M11.2 6.1 5.3 12l5.9 5.9"/>',
  again:   '<path d="M20.4 12a8.4 8.4 0 1 1-2.5-6"/><path d="M20.8 3.8v5.6h-5.6"/>',
  moon:    '<path d="M20.2 14.6A8.6 8.6 0 0 1 9.4 3.8a8.6 8.6 0 1 0 10.8 10.8z"/>',
  sun:     '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.4v2.3M12 19.3v2.3M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.4 12h2.3M19.3 12h2.3M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6"/>',
  cap:     '<path d="M12 4 2.6 8.9 12 13.8l9.4-4.9z"/><path d="M6.6 11.2v4.5c0 1.7 2.4 3 5.4 3s5.4-1.3 5.4-3v-4.5"/>',
  book:    '<path d="M4 4.6h5.4A2.6 2.6 0 0 1 12 7.2v12.6a2.1 2.1 0 0 0-2.1-1.6H4z"/><path d="M20 4.6h-5.4A2.6 2.6 0 0 0 12 7.2v12.6a2.1 2.1 0 0 1 2.1-1.6H20z"/>',
  sliders: '<path d="M3 7h9M16 7h5M3 12h13M20 12h1M3 17h5M12 17h9"/><circle cx="14" cy="7" r="2"/><circle cx="18" cy="12" r="2"/><circle cx="10" cy="17" r="2"/>',
  folder:  '<path d="M3.2 7.4a2 2 0 0 1 2-2h3.6l2 2.6h8a2 2 0 0 1 2 2v7.6a2 2 0 0 1-2 2H5.2a2 2 0 0 1-2-2z"/>',
  spark:   '<path d="M10.2 3.2 12 8.4l5.2 1.8-5.2 1.8-1.8 5.2-1.8-5.2L3.2 10.2 8.4 8.4z"/><path d="M17.8 15.2l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  refresh: '<path d="M20.4 11.2A8.4 8.4 0 0 0 5.9 6.4M3.6 12.8a8.4 8.4 0 0 0 14.5 4.8"/><path d="M20.8 5.4v5.8h-5.8M3.2 18.6v-5.8H9"/>',
  shuffle: '<path d="M4 8.6h11.6a3.6 3.6 0 0 1 0 7.2H7.6"/><path d="M6.6 6 4 8.6 6.6 11.2M10.2 13.2 7.6 15.8l2.6 2.6"/>',
  target:  '<circle cx="12" cy="12" r="8.4"/><circle cx="12" cy="12" r="4.4"/><circle cx="12" cy="12" r=".9"/>',
  done:    '<circle cx="12" cy="12" r="8.4"/><path d="M8.3 12.3l2.6 2.6 4.9-5.4"/>',
  trophy:  '<path d="M7.6 4.6h8.8v4.6a4.4 4.4 0 0 1-8.8 0z"/><path d="M7.6 6.2H5.1v1.5a3.2 3.2 0 0 0 2.9 3.2M16.4 6.2h2.5v1.5a3.2 3.2 0 0 1-2.9 3.2"/><path d="M12 13.6v3.4M8.4 19.6h7.2"/>',
  clip:    '<path d="M9 4.6H7a2 2 0 0 0-2 2v12.4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6.6a2 2 0 0 0-2-2h-2"/><rect x="9" y="2.6" width="6" height="4" rx="1.3"/>',
  chart:   '<path d="M4.4 19.6h15.2M7.6 16.4v-4.8M12 16.4V7.2M16.4 16.4V9.9"/>',
  abc:     '<path d="M2.8 16.4 6.4 7.2l3.6 9.2M4 13.6h4.8"/><path d="M13.6 7.2h3.5a2.3 2.3 0 0 1 0 4.6h-3.5zM13.6 11.8h4a2.3 2.3 0 0 1 0 4.6h-4z"/>',
  burst:   '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.6v3.2M12 18.2v3.2M2.6 12h3.2M18.2 12h3.2M5.3 5.3l2.3 2.3M16.4 16.4l2.3 2.3M18.7 5.3l-2.3 2.3M7.6 16.4l-2.3 2.3"/>',
  leaf:    '<path d="M20.4 3.8c0 9.2-5.6 13.4-11.2 13.4a6.1 6.1 0 0 1 0-12.2c4.1 0 6.1-1 11.2-1.2z"/><path d="M4.4 20.2C7 15.4 11.2 12.2 15.8 10.2"/>',
  thumb:   '<path d="M7.2 10.6H5a1.6 1.6 0 0 0-1.6 1.6v6.6A1.6 1.6 0 0 0 5 20.4h2.2z"/><path d="M7.2 10.6 11.4 3.4a2.2 2.2 0 0 1 2.2 2.2v3.6h4.7a2 2 0 0 1 2 2.4l-1.4 6.4a2 2 0 0 1-2 1.6H7.2z"/>',
  fire:    '<path d="M12 21c3.6 0 6.4-2.7 6.4-6 0-4.6-4.4-6.6-3.9-11-2.6 1.5-4.1 4-4.1 6.1 0 1.5-1 2-1.6 1.2-.7-1-.9-2-.9-2.9C6.3 9.9 5.6 12.2 5.6 15c0 3.3 2.8 6 6.4 6z"/>',
  down:    '<path d="M12 3.6v11.2M8 10.8l4 4 4-4"/><path d="M4.6 16.2v2.2a2 2 0 0 0 2 2h10.8a2 2 0 0 0 2-2v-2.2"/>',
  up:      '<path d="M12 14.8V3.6M8 7.6l4-4 4 4"/><path d="M4.6 16.2v2.2a2 2 0 0 0 2 2h10.8a2 2 0 0 0 2-2v-2.2"/>',
  search:  '<circle cx="10.8" cy="10.8" r="6.4"/><path d="M15.6 15.6l4.8 4.8"/>',
  warn:    '<path d="M12 3.6 21 19.6H3z"/><path d="M12 9.8v4.2M12 17h.01"/>',
  clock:   '<circle cx="12" cy="12" r="8.6"/><path d="M12 6.8V12l3.4 2"/>',
  info:    '<circle cx="12" cy="12" r="8.6"/><path d="M12 11.2v5M12 7.9h.01"/>',
};
/* значок вставляется в разметку строкой; размер задаётся из CSS кеглем места,
   куда он попал, поэтому один и тот же значок годится и для кнопки, и для строки */
const ico = (n, cls) => `<svg class="icn${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ''}</svg>`;

/* ---------------- подсказки «i» ----------------
   Кнопка рядом с действием, по нажатию — всплывающая записка. Так объяснение
   не занимает места, пока его не спросили, а спросить можно не уходя с экрана.
   Записка закрывается повторным нажатием, нажатием мимо, Esc и прокруткой:
   на телефоне промахнуться мимо мелкой кнопки легко, и залипшая подсказка
   раздражала бы сильнее, чем её отсутствие. */
const HINTS = {
  copy: `Складывает весь прогресс в текстовый код. Скопируйте его и сохраните где угодно —
    в заметках, письме самому себе, переписке. Из этого кода прогресс потом восстанавливается,
    в том числе на другом устройстве.`,
  paste: `Вставьте сюда код, скопированный раньше, — прогресс станет таким, каким был в момент
    копирования. Нынешний при этом пропадёт, поэтому сначала скопируйте его.`,
  export: `То же, что код, только файлом. В приложении, запущенном с экрана «Домой», iOS не всегда
    разрешает сохранять файлы — если не получилось, пользуйтесь кодом.`,
  import: `Загружает прогресс из ранее сохранённого файла. Нынешний прогресс будет заменён.`,
  check: `Проверяет, скачивается ли озвучка и играет ли звук. Пригодится, если слова молчат:
    покажет, дело в файлах приложения или в самом устройстве.`,
  reset: `Стирает всё: выученные слова, серию дней, настройки и выбранные категории.
    Отменить нельзя — сначала сохраните копию.`,
};
const hintBtn = (n) => `<button class="hint-btn" data-hint="${n}" aria-label="Зачем это нужно"
  aria-expanded="false">${ico('info')}</button>`;

function bindHints(root) {
  let pop = null, cur = null;
  const close = () => {
    if (!pop) return;
    cur.setAttribute('aria-expanded', 'false');
    pop.remove(); pop = null; cur = null;
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onEsc);
    window.removeEventListener('scroll', close, true);
    window.removeEventListener('resize', close);
  };
  const onEsc = (e) => { if (e.key === 'Escape') close(); };
  const outside = (e) => { if (pop && !pop.contains(e.target) && e.target !== cur && !cur.contains(e.target)) close(); };
  const open = (btn) => {
    close();
    cur = btn;
    btn.setAttribute('aria-expanded', 'true');
    pop = el(`<div class="hint-pop" role="tooltip">${esc(HINTS[btn.dataset.hint] || '').replace(/\s+/g, ' ')}</div>`);
    document.body.appendChild(pop);
    const r = btn.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
    const left = Math.max(12, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 12));
    // снизу, если помещается; иначе сверху — иначе записка уехала бы за край экрана
    const below = r.bottom + 10 + h <= window.innerHeight - 12;
    pop.style.left = `${left}px`;
    pop.style.top = `${below ? r.bottom + 10 : Math.max(12, r.top - h - 10)}px`;
    pop.style.setProperty('--arrow', `${r.left + r.width / 2 - left}px`);
    pop.classList.toggle('above', !below);
    setTimeout(() => {
      document.addEventListener('pointerdown', outside, true);
      document.addEventListener('keydown', onEsc);
      window.addEventListener('scroll', close, true);
      window.addEventListener('resize', close);
    }, 0);
  };
  $$('[data-hint]', root).forEach(b => b.onclick = (e) => {
    e.stopPropagation();
    (pop && cur === b) ? close() : open(b);
  });
}

/* ---------------- роутер ---------------- */
const ROUTES = {};
/* нижняя панель: три раздела, остальные экраны — вложенные в них */
const TAB_OF = {
  home: 'home', learn: 'home', review: 'home', mixed: 'home', browse: 'home',
  cats: 'home', welcome: 'home', lessons: 'home', lesson: 'home',
  dict: 'dict', dictcat: 'dict',
  menu: 'menu', alphabet: 'menu', stats: 'menu', about: 'menu',
};
function go(route) {
  S.route = route; S.session = null;
  if (route !== 'lesson') S.quiz = null;
  const tab = TAB_OF[route] || 'home';
  $$('.tab').forEach(b => b.classList.toggle('on', b.dataset.go === tab));
  window.scrollTo(0, 0);
  render();
}
function render() {
  const main = $('#main');
  main.innerHTML = '';
  main.appendChild(ROUTES[S.route]());
  main.firstElementChild.classList.add('fade');
  const c = counts();
  const badge = $('#b-due');
  if (badge) badge.hidden = !(c.due || c.fresh);
}

/* шапка вложенного раздела: возврат туда, откуда пришли */
/* Заголовок вложенного экрана. Значок передаётся отдельным доводом и вставляется
   как есть: сам заголовок всегда экранируется, поэтому склеивать их в одну строку
   нельзя — разметка значка напечаталась бы текстом. */
function subHead(title, back, mark) {
  return `<div class="sub-head">
    <button class="back-link" data-back="${back || 'home'}">‹ Назад</button>
    <h1>${mark ? mark + ' ' : ''}${esc(title)}</h1></div>`;
}
function bindSubHead(box) {
  const b = box.querySelector('[data-back]');
  if (b) b.onclick = () => go(b.dataset.back);
}

/* ---------------- меню ---------------- */
ROUTES.menu = function () {
  const c = counts();
  const box = el(`<div>
    <div class="page-head"><div><h1>Меню</h1>
      <p class="sub">Настройки, алфавит и подробная статистика</p></div></div>

    <div class="menu-card">
      <button class="menu-row" data-act="settings">
        <span class="mi">${ico('sliders')}</span>
        <span class="mt"><b>Настройки</b><i>Норма, режимы, голос и скорость речи, тема</i></span>
        <span class="ma">›</span></button>
      <button class="menu-row" data-go="stats">
        <span class="mi accent">${ico('chart')}</span>
        <span class="mt"><b>Подробная статистика</b>
          <i>Выучено ${c.mastered} · в процессе ${c.learning} · известно ${c.known}</i></span>
        <span class="ma">›</span></button>
      <button class="menu-row" data-go="alphabet">
        <span class="mi gold">${ico('abc')}</span>
        <span class="mt"><b>Алфавит</b><i>${L.alphabet.menu}</i></span>
        <span class="ma">›</span></button>
    </div>

    <div class="menu-card" style="margin-top:16px">
      <button class="menu-row" id="m-sound">
        <span class="mi">${ico(S.prog.set.autoplay ? 'play' : 'pause')}</span>
        <span class="mt"><b>Автоозвучка</b>
          <i>${S.prog.set.autoplay ? 'слово произносится при показе' : 'выключена, кнопка проигрывания работает'}</i></span>
        <span class="ma">${S.prog.set.autoplay ? 'вкл' : 'выкл'}</span></button>
      <button class="menu-row" data-go="about">
        <span class="mi">ℹ️</span>
        <span class="mt"><b>Источники и лицензии</b><i>Откуда словарь, частотность и озвучка</i></span>
        <span class="ma">›</span></button>
      <button class="menu-row" id="m-theme">
        <span class="mi">${ico(document.documentElement.dataset.theme === 'dark' ? 'moon' : 'sun')}</span>
        <span class="mt"><b>Тема</b><i>${themePref() === 'system' ? 'как в системе' : themePref() === 'dark' ? 'тёмная' : 'светлая'}</i></span>
        <span class="ma">›</span></button>
    </div>

    <p class="sub" style="margin-top:20px;text-align:center">
      Словарь: ${S.words.length} лексем, ${S.trainable.length} в тренировках · озвучка Microsoft ${L.ttsTag}
    </p>
  </div>`);
  $$('[data-go]', box).forEach(b => b.onclick = () => go(b.dataset.go));
  box.querySelector('[data-act=settings]').onclick = openSettings;
  box.querySelector('#m-sound').onclick = () => {
    S.prog.set.autoplay = !S.prog.set.autoplay;
    saveProgress(); render();
    toast(S.prog.set.autoplay ? 'Автоозвучка включена' : 'Автоозвучка выключена');
  };
  box.querySelector('#m-theme').onclick = () => {
    const order = ['system', 'dark', 'light'];
    const next = order[(order.indexOf(themePref()) + 1) % order.length];
    localStorage.setItem(THEME_KEY, next);
    applyTheme(); render();
  };
  return box;
};

/* ---------------- источники ---------------- */
ROUTES.about = function () {
  const core = S.words.filter(w => w.src === 'core').length;
  const box = el(`<div>
    ${subHead('Источники и лицензии', 'menu')}
    <div class="card" style="line-height:1.6;font-size:14px">
      <h2>Словарь</h2>
      <p class="sub" style="margin-bottom:14px">${S.words.length} лексем. Из них ${core} написаны вручную
      для этого приложения, остальные извлечены из русского Викисловаря и переработаны:
      отобраны по употребимости, очищены от узкой терминологии и имён собственных,
      разложены по темам и уровням.</p>
      <p class="sub" style="margin-bottom:14px">Материалы Викисловаря распространяются по лицензии
      <a href="https://creativecommons.org/licenses/by-sa/4.0/deed.ru" target="_blank" rel="noopener">CC BY-SA 4.0</a>
      — с указанием авторства и сохранением условий. Источник:
      <a href="https://ru.wiktionary.org" target="_blank" rel="noopener">ru.wiktionary.org</a>.
      Извлечение выполнено через <a href="https://kaikki.org" target="_blank" rel="noopener">kaikki.org</a>.
      Этот словарь — производная работа и распространяется на тех же условиях.</p>

      <h2>Частотность и уровни</h2>
      <p class="sub" style="margin-bottom:14px">Уровни A1–C1 расставлены по тому, насколько часто слово
      встречается в живом языке. Использованы корпуса
      <a href="https://wortschatz.uni-leipzig.de" target="_blank" rel="noopener">Leipzig Corpora Collection</a>
      ${L.about.corpus}</p>

      ${L.about.tts}

      <h2>Значки</h2>
      <p class="sub">Значки разделов словаря — из открытого набора Fluent Emoji
      (Microsoft, лицензия MIT). Остальные значки интерфейса нарисованы для этого
      приложения.</p>

      <h2>Проверка</h2>
      <p class="sub">${L.about.check}</p>
    </div>
  </div>`);
  bindSubHead(box);
  return box;
};

/* ---------------- первый запуск: дневная норма ---------------- */
ROUTES.welcome = function () {
  const total = S.trainable.length;
  const plans = [
    [5,  'Спокойно',   'по 10–15 минут в день'],
    [10, 'Обычный темп', 'около 20 минут в день'],
    [15, 'Интенсивно', 'примерно полчаса в день'],
    [20, 'Быстро',     '40 минут и больше'],
    [30, 'Максимум',   'час в день, для отпуска или подготовки'],
  ];
  const months = (n) => {
    const m = Math.round(total / n / 30);
    return m < 12 ? plural(m, 'месяц', 'месяца', 'месяцев')
                  : (total / n / 365).toFixed(1).replace('.', ',') + ' года';
  };
  const box = el(`<div class="trainer" style="max-width:720px">
    <div style="text-align:center;margin-bottom:26px">
      <div style="font-size:46px" class="${L.script}">${L.name}</div>
      <h1 style="margin:10px 0 6px">Сколько новых слов учить в день?</h1>
      <p class="sub">В словаре ${total} слов и выражений с озвучкой. Норму можно поменять в любой момент в настройках.</p>
    </div>
    <div class="cats-grid" style="grid-template-columns:repeat(auto-fill,minmax(200px,1fr))">
      ${plans.map(([n, name, hint]) => `
        <button class="cat-card" data-n="${n}" style="text-align:left">
          <div class="top"><span class="ic" style="font-size:26px;font-weight:750;color:var(--accent)">${n}</span>
            <div><div class="nm">${name}</div><div class="cnt">${hint}</div></div></div>
          <div class="cat-legend"><span>весь словарь за ${months(n)}</span></div>
        </button>`).join('')}
    </div>
    <div class="card" style="margin-top:16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <span style="font-size:14px">Свой вариант:</span>
      <input type="number" id="own" min="1" max="200" value="12" style="width:90px">
      <span class="sub" style="margin:0">слов в день</span>
      <button class="btn primary" id="own-go" style="margin-left:auto">Начать</button>
    </div>
  </div>`);
  const start = (n) => {
    S.prog.set.newPerDay = Math.max(1, Math.min(200, n));
    S.prog.onboarded = true;
    saveProgress();
    toast(`Дневная норма: ${plural(S.prog.set.newPerDay, 'слово', 'слова', 'слов')}`);
    go('home');
  };
  $$('[data-n]', box).forEach(b => b.onclick = () => start(+b.dataset.n));
  $('#own-go', box).onclick = () => start(+$('#own', box).value || 12);
  $('#own', box).onkeydown = (e) => { if (e.key === 'Enter') start(+e.target.value || 12); };
  return box;
};

/* ---------------- главная ---------------- */
ROUTES.home = function () {
  const c = counts(), t = dayRec(today());
  const goalNew = S.prog.set.newPerDay;
  const unfinished = pendingDrill().length;         // взяли, но ещё не закрепили
  /* В цель дня идут новые слова, впервые названные верно в закреплении, — то есть результат,
     а не намерение: взять слово в работу ещё ничего не значит. Повторения в процент не входят,
     их число диктует расписание, а не усердие; они показаны отдельной строкой. */
  const donePct = goalNew ? Math.min(100, Math.round(t.drilled / goalNew * 100)) : 0;

  // кружки текущей недели
  const mon = startOfWeek(new Date());
  const week = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((nm, i) => {
    const d = new Date(mon); d.setDate(d.getDate() + i);
    const key = dateKey(d), rec = S.prog.days[key];
    return { nm, key, active: !!(rec && (rec.rev || rec.started || rec.known)),
             today: key === today(), future: d > new Date() };
  });

  const box = el(`<div>
    <div class="home-grid">
      <div>
        <h2 class="sect">Интервальное повторение</h2>
        <div class="menu-card">
          <button class="menu-row" data-go="cats">
            <span class="mi">${ico('folder')}</span>
            <span class="mt"><b>Выбрано ${plural(S.prog.set.cats.length, 'категория', 'категории', 'категорий')}</b>
              <i>${poolWords().length} слов в работе · уровни ${S.prog.set.levels.join(' ')}</i></span>
            <span class="ma">›</span></button>
          <button class="menu-row" data-act="learn">
            <span class="mi accent">${ico('spark')}</span>
            <span class="mt"><b>${unfinished ? 'Закрепить начатое' : 'Учить новые слова'}</b>
              <i>${unfinished
                ? `${plural(unfinished, 'слово ждёт', 'слова ждут', 'слов ждут')} закрепления`
                : `Закреплено сегодня: ${goalText(t.drilled, goalNew)}`}</i></span>
            <span class="ma">${unfinished || newLeftToday() || ''} ›</span></button>
          <button class="menu-row" data-act="review">
            <span class="mi gold">${ico('refresh')}</span>
            <span class="mt"><b>Повторить слова</b>
              <i>Слов для повторения: ${c.due}${t.rev ? ` · сегодня повторено ${t.rev}` : ''}</i></span>
            <span class="ma">${c.due || ''} ›</span></button>
          <button class="menu-row" data-act="mixed">
            <span class="mi green">${ico('bulb')}</span>
            <span class="mt"><b>Смешанный режим</b>
              <i>Новые слова и повторение вперемешку</i></span>
            <span class="ma">›</span></button>
          ${S.lessons ? `<button class="menu-row" data-go="lessons">
            <span class="mi slate">${ico('book')}</span>
            <span class="mt"><b>${esc(S.lessons.title)}</b>
              <i>Грамматика с примерами · пройдено ${lessonsDone()} из ${S.lessons.lessons.length} уроков</i></span>
            <span class="ma">›</span></button>` : ''}
        </div>

        <h2 class="sect">Дополнительно <i>не влияет на статистику</i></h2>
        <div class="menu-card">
          <button class="menu-row" data-act="browse">
            <span class="mi">${ico('shuffle')}</span>
            <span class="mt"><b>Пролистать слова</b><i>Просмотр карточек без оценок</i></span>
            <span class="ma">›</span></button>
        </div>
      </div>

      <div>
        <div class="card">
          <div class="ring-wrap">
            <div class="ring">
              <svg width="106" height="106" viewBox="0 0 106 106">
                <circle cx="53" cy="53" r="45" fill="none" stroke="var(--surface-2)" stroke-width="9"/>
                <circle cx="53" cy="53" r="45" fill="none" stroke="var(--accent)" stroke-width="9" stroke-linecap="round"
                  stroke-dasharray="${(2 * Math.PI * 45).toFixed(1)}"
                  stroke-dashoffset="${(2 * Math.PI * 45 * (1 - donePct / 100)).toFixed(1)}"/>
              </svg>
              <div class="val" title="В цель идёт новое слово, впервые названное верно в закреплении. Повторения показаны отдельной строкой">
                <b class="num">${donePct}%</b><span>цель дня</span></div>
            </div>
            <div class="goal-list">
              <div class="goal-row"><span>Новых слов закреплено</span><b>${goalText(t.drilled, goalNew)}</b></div>
              <div class="goal-row"><span>Выучено полностью сегодня</span><b>${t.new}</b></div>
              <div class="goal-row"><span>Повторено сегодня</span>
                <b>${t.rev}${c.due ? ` · ждёт ${c.due}` : ''}</b></div>
            </div>
          </div>
          <div class="week">${week.map(d => `
            <div class="wd ${d.active ? 'on' : ''} ${d.today ? 'now' : ''} ${d.future ? 'future' : ''}">
              <span>${d.nm}</span></div>`).join('')}</div>
          <div class="tiles">
            <div class="tile"><b class="num">${plural(S.prog.streak, 'день', 'дня', 'дней')}</b><span>вы учите слова</span></div>
            <div class="tile"><b class="num">${plural(S.prog.best || 0, 'день', 'дня', 'дней')}</b><span>рекорд подряд</span></div>
          </div>
        </div>
      </div>
    </div>

    <div class="grid stats-grid" style="margin:16px 0">
      <div class="stat green"><div class="n num">${c.mastered}</div><div class="l">Выучено полностью</div>
        <div class="bar"><i style="width:${(c.mastered / c.total * 100).toFixed(1)}%"></i></div></div>
      <div class="stat orange"><div class="n num">${c.learning}</div><div class="l">В процессе изучения</div>
        <div class="bar"><i style="width:${(c.learning / c.total * 100).toFixed(1)}%"></i></div></div>
      <div class="stat purple"><div class="n num">${c.known}</div><div class="l">Уже знал(а)</div>
        <div class="bar"><i style="width:${(c.known / c.total * 100).toFixed(1)}%"></i></div></div>
      <div class="stat blue"><div class="n">${c.learning + c.mastered + c.known}<small>/ ${c.total}</small></div>
        <div class="l">Охвачено из словаря</div>
        <div class="bar"><i style="width:${((c.learning + c.mastered + c.known) / c.total * 100).toFixed(1)}%"></i></div></div>
    </div>

    <div class="chart-card">
      <h3>Активность за 14 дней</h3>
      <p class="cap">Закреплено новых, повторено уникальных, выучено полностью и отмечено «уже знаю» · листается вбок</p>
      <div class="chart-scroll"><canvas id="home-chart" height="158"></canvas></div>
      <div class="legend">
        <span><i class="dot" style="background:var(--gold)"></i>закреплено новых</span>
        <span><i class="dot" style="background:var(--accent)"></i>повторено</span>
        <span><i class="dot" style="background:var(--green)"></i>выучено полностью</span>
        <span><i class="dot" style="background:var(--slate)"></i>уже знаю</span>
      </div>
    </div>
  </div>`);
  $$('[data-act]', box).forEach(b => b.onclick = () => { S.session = null; go(b.dataset.act); });
  $$('[data-go]', box).forEach(b => b.onclick = () => go(b.dataset.go));
  setTimeout(() => drawActivity($('#home-chart'), statsBuckets('day', 14)), 0);
  return box;
};

/* ---------------- незаконченное повторение ----------------
   Сессия повторения жила только в памяти вкладки. iOS выгружает приложение,
   пока оно в фоне, и после возвращения счётчик начинался заново, хотя слова
   были не пройдены: со стороны это выглядело как обнуление на ровном месте
   (особенно заметно ночью — приложение стоит открытым, а утром оно уже другое).
   Сами слова при этом не терялись: оценка каждого сохраняется сразу.
   Здесь сохраняется только ход сессии — очередь и счётчики. */
function saveSession(s) {
  if (!s || s.kind !== 'review') return;
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      kind: s.kind, ids: s.queue.map(w => w.id), i: s.i, right: s.right, wrong: s.wrong,
      total: s.total, words: s.words, left: [...s.left], missed: [...s.missed], at: Date.now(),
    }));
  } catch (e) { /* переполненное хранилище не должно ломать занятие */ }
}
function dropSession() { try { localStorage.removeItem(SESSION_KEY); } catch (e) {} }
function loadSession(kind) {
  let d;
  try { d = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { return null; }
  // Через полсуток продолжать уже нечего: слова успели уйти на новый срок,
  // и человек возвращается не к прерванному занятию, а к новому.
  if (!d || d.kind !== kind || Date.now() - d.at > 12 * 3600e3) return null;
  const queue = d.ids.map(id => S.byId.get(id)).filter(Boolean);
  if (d.i >= queue.length) return null;              // сессия и так была пройдена
  return { kind, queue, i: d.i, right: d.right, wrong: d.wrong, total: d.total, words: d.words,
           left: new Set(d.left), missed: new Set(d.missed), method: null, hist: [] };
}

/* ---------------- шаг назад: снимок состояния и откат ---------------- */
function snapshot(w) {
  const t = today();
  return {
    id: w.id,
    prev: S.prog.w[w.id] ? JSON.parse(JSON.stringify(S.prog.w[w.id])) : null,
    day: JSON.parse(JSON.stringify(dayRec(t))),
    pend: [...(S.prog.pend || [])],        // иначе шаг назад снова терял недозакреплённое слово
    date: t,
    streak: S.prog.streak, lastActive: S.prog.lastActive,
  };
}
function restore(snap) {
  if (snap.prev) S.prog.w[snap.id] = snap.prev; else delete S.prog.w[snap.id];
  S.prog.days[snap.date] = snap.day;
  if (snap.pend) S.prog.pend = [...snap.pend];
  S.prog.streak = snap.streak; S.prog.lastActive = snap.lastActive;
  saveProgress();
}
/* шапка тренажёра: прогресс, подпись и кнопка возврата к предыдущему слову */
function trainerHead(o) {
  const can = S.session && S.session.hist && S.session.hist.length;
  return `<div class="progress-line"><i style="width:${o.progress * 100}%"></i></div>
    <div class="trainer-head">
      <button class="btn ghost sm back-btn" ${can ? '' : 'disabled'} title="Backspace">← Назад</button>
      <p class="sub">${esc(o.title)}</p>
      <span class="head-spacer"></span>
    </div>`;
}
function bindBack(box) {
  const b = box.querySelector('.back-btn');
  if (b) b.onclick = () => stepBack();
}
function stepBack() {
  const s = S.session;
  if (!s || !s.hist || !s.hist.length) return;
  const h = s.hist.pop();
  restore(h.snap);
  s.method = null;
  s.i = h.i;
  if (h.phase) s.phase = h.phase;
  if (h.tookAt != null && s.toTrain) s.toTrain.splice(h.tookAt, 1);
  if (h.topUp && s.queue && s.poolIdx) { s.queue.pop(); s.poolIdx--; }
  if (h.phase === 'drill' && s.pending && s.drill && s.drill[h.i]) s.pending.add(s.drill[h.i].id);
  if (h.right) s.right--;
  if (h.wrong) s.wrong--;
  if (h.newDone && s.newDone) s.newDone--;
  if (s.left && h.leftHad !== undefined) h.leftHad ? s.left.add(h.snap.id) : s.left.delete(h.snap.id);
  if (s.missed && h.missedHad !== undefined) h.missedHad ? s.missed.add(h.snap.id) : s.missed.delete(h.snap.id);
  saveSession(s);
  render();
}

/* Свайпы по карточке: вправо — знаю/вспомнил, влево — не знаю/учить.
   Мышью работает тоже, но основной сценарий — телефон. */
function bindSwipe(card, o) {
  if (!card) return;
  card.querySelectorAll(':scope > .swipe-badge').forEach(b => b.remove());
  card.style.transform = ''; card.style.opacity = '';
  const badge = el('<div class="swipe-badge"></div>');
  card.appendChild(badge);
  let x0 = 0, y0 = 0, dx = 0, active = false, fired = false;
  const start = (x, y) => { x0 = x; y0 = y; dx = 0; active = true; card.style.transition = 'none'; };
  const move = (x, y) => {
    if (!active || fired) return;
    dx = x - x0;
    if (Math.abs(y - y0) > Math.abs(dx) + 12) return;      // вертикальная прокрутка — не мешаем
    card.style.transform = `translateX(${dx}px) rotate(${dx / 45}deg)`;
    badge.textContent = dx > 0 ? o.rightLabel : o.leftLabel;
    badge.className = 'swipe-badge ' + (dx > 0 ? 'right' : 'left');
    badge.style.opacity = String(Math.min(1, Math.abs(dx) / 90));
  };
  const end = () => {
    if (!active || fired) return;
    active = false;
    card.style.transition = 'transform .25s ease, opacity .25s ease';
    if (Math.abs(dx) > 70) {
      fired = true;
      if (S.prog.set.invertSwipe) dx = -dx;
      card.style.transform = `translateX(${dx > 0 ? 520 : -520}px) rotate(${dx > 0 ? 14 : -14}deg)`;
      card.style.opacity = '0';
      const go = dx > 0 ? o.onRight : o.onLeft;
      setTimeout(go, 150);
    } else {
      card.style.transform = '';
      badge.style.opacity = '0';
    }
  };
  card.addEventListener('touchstart', (e) => start(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
  card.addEventListener('touchmove', (e) => move(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
  card.addEventListener('touchend', end);
  card.addEventListener('touchcancel', end);
  card.addEventListener('mousedown', (e) => { start(e.clientX, e.clientY); e.preventDefault(); });
  window.addEventListener('mousemove', (e) => active && move(e.clientX, e.clientY));
  window.addEventListener('mouseup', end);
}

/* Что происходит после ответа.

   Переход только по явному нажатию. Автопереход уводил с экрана раньше, чем
   человек успевал заметить, верным был ответ или нет, — а именно в этот момент
   и запоминается слово. Смахивание здесь тоже убрано: случайный жест смахивал
   красный ответ, не дав его разглядеть.

   При верном ответе кнопка называется «Я запомнил» — это осознанное
   подтверждение, а не просто перелистывание. При неверном есть только
   «Повторить ещё раз»: слово в любом случае вернётся в этой же сессии.
   В карточке повторения этой панели нет: там вердикт всегда за человеком,
   и после проверки остаётся та же пара кнопок «вспомнил / не вспомнил». */
function afterAnswer(box, card, ok, w, done) {
  const panel = el(`<div class="after-answer ${ok ? 'ok' : 'no'}">
    ${ok
      ? `<button class="btn ghost" data-a="again">↺ Показать ещё раз</button>
         <button class="btn success" data-a="next">${ico('check')} Я запомнил</button>`
      : `<button class="btn primary block" data-a="again">↺ Повторить ещё раз</button>`}
  </div>`);
  const go = (again) => { panel.remove(); done(again); };
  const next = panel.querySelector('[data-a=next]');
  if (next) next.onclick = () => go(false);
  // при ошибке слово возвращается само, просить об этом ещё раз не нужно
  panel.querySelector('[data-a=again]').onclick = () => go(ok);
  box.appendChild(panel);
  S.session.keys = (e) => {
    if (e.key === 'Enter' || e.code === 'Space') { e.preventDefault(); go(ok ? false : false); }
  };
}

/* ---------------- общие элементы тренировок ---------------- */
function wordCardHTML(w, opts = {}) {
  const tr = S.prog.set.translit ? `<div class="word-tr">${esc(w.tr)}</div>` : '';
  return `<div class="word-card">
    <span class="lvl">${w.lvl}</span>
    <span class="cat">${catIcon(w.cats[0])} ${esc(catName(w.cats[0]))}</span>
    <div class="word-ka ka">${opts.hideKa ? '•••' : esc(w.ka)}</div>
    ${opts.hideKa ? '' : tr}
    <button class="speak ${opts.bigSpeak ? 'lg' : ''}" title="Произношение (пробел)">${ico('play')}</button>
    ${opts.ru ? `<div class="word-ru">${esc(w.ru)}</div>` : ''}
  </div>`;
}
/* Ассоциация для запоминания: подсказка по созвучию. Необязательный слой —
   если для слова её нет, тренировка работает ровно как раньше. */
function mnemoHTML() {
  return `<div class="mnemo-wrap">
    <button class="btn ghost sm mnemo-btn">${ico('bulb')} Ассоциация</button>
    <div class="mnemo" hidden></div>
  </div>`;
}
function bindMnemo(root, w) {
  const btn = root.querySelector('.mnemo-btn');
  if (!btn) return;
  const box = root.querySelector('.mnemo');
  btn.onclick = () => {
    const text = (S.mnemo || {})[w.ka];
    box.hidden = false;
    box.innerHTML = text
      ? `${ico('bulb')} ${esc(text)}`
      : '<span style="color:var(--muted)">Для этого слова ассоциации пока нет — они добавляются постепенно.</span>';
    btn.disabled = true;
  };
}
function hasMnemo(w) { return !!(S.mnemo || {})[w.ka]; }

/* Перевод под глазком. Карточка должна сперва дать шанс вспомнить слово самому:
   если перевод виден сразу, проверки знания не получается — глаз читает его раньше,
   чем успеваешь вспомнить. Тот же приём, что глазок в режиме повторения. */
function revealHTML(text, label = 'Показать перевод') {
  return `<div class="reveal">
    <button class="btn ghost sm reveal-btn">${ico('eye')} ${label}</button>
    <div class="word-ru reveal-text" hidden>${esc(text)}</div>
  </div>`;
}
/* Примеры употребления. В карточке знакомства их до трёх: столько, сколько
   нашлось живых предложений с этим словом. У каждого своя озвучка и свой
   перевод, свёрнутый до нажатия — иначе глаз читает русский раньше, чем
   разбирает само предложение. */
function examplesHTML(w) {
  const list = (S.examples || {})[w.id];
  if (!list || !list.length) return '';
  const mark = (t) => esc(t).replace(esc(w.ka), `<b>${esc(w.ka)}</b>`);
  return `<div class="examples">${list.map((p, i) => `
    <div class="ex">
      <button class="ex-toggle" data-i="${i}"><i></i><span>${mark(p[0])}</span></button>
      ${audioUrl(p[0]) ? `<button class="ex-play" data-i="${i}" title="Послушать">${ico('play')}</button>` : ''}
      <div class="ex-ru" hidden>${esc(p[1])}</div>
    </div>`).join('')}</div>`;
}
function bindExamples(root, w) {
  const list = (S.examples || {})[w.id] || [];
  $$('.ex-toggle', root).forEach(b => b.onclick = () => {
    const box = b.parentElement.querySelector('.ex-ru');
    box.hidden = !box.hidden;
    b.classList.toggle('open', !box.hidden);
  });
  $$('.ex-play', root).forEach(b => b.onclick = (e) => {
    e.stopPropagation();
    speak(list[+b.dataset.i][0]);
  });
}

function bindReveal(root, after) {
  const btn = root.querySelector('.reveal-btn');
  if (!btn) return () => {};
  const open = () => {
    if (btn.hidden) return;
    btn.hidden = true;
    root.querySelector('.reveal-text').hidden = false;
    if (after) after();
  };
  btn.onclick = open;
  return open;
}


function bindSpeak(root, text) {
  const b = root.querySelector('.speak');
  if (b) b.onclick = () => speak(text);
}

/* Звук не должен выдавать ответ. Если на карточке показано русское слово, а вспомнить
   нужно изучаемое, то произнести его вслух — то же самое, что показать: и автоозвучка,
   и кнопка проигрывания, и пробел молчат, пока ответ не открыт. */
/* Варианты ответа. Если они на изучаемом языке, у каждого своя кнопка проигрывания:
   послушать все четыре полезно и до ответа — на слух слова и путаются чаще
   всего, — а какой из них верный, звук не выдаёт. Для русских переводов
   кнопки нет: озвучки для них не существует. */
function optionsHTML(options, field, numbered) {
  const playable = field === 'ka';
  return `<div class="options">${options.map((x, i) => {
    const label = numbered ? `${i + 1}. ${esc(x[field])}` : esc(x[field]);
    const btn = `<button class="opt ${playable ? 'ka' : ''}" data-i="${i}">${label}</button>`;
    if (!playable || !audioUrl(x.ka)) return btn;
    return `<div class="opt-row">${btn}` +
           `<button class="opt-play" data-p="${i}" title="Послушать">${ico('play')}</button></div>`;
  }).join('')}</div>`;
}
function bindOptionPlay(root, options) {
  $$('.opt-play', root).forEach(b => b.onclick = (e) => {
    e.stopPropagation();
    speak(options[+b.dataset.p].ka);
  });
}

function holdAudio(box) {
  const b = box.querySelector('.speak');
  if (b) b.hidden = true;
}
function releaseAudio(box) {
  const b = box.querySelector('.speak');
  if (b) b.hidden = false;
}
/* Значимые корни перевода — чтобы не подсунуть синоним правильного ответа */
function ruStems(text) {
  return new Set(String(text).toLowerCase().replace(/[^а-яёa-z]+/g, ' ').split(' ')
    .filter(x => x.length > 3).map(x => x.slice(0, 5)));
}

/* Подбор похожих, но однозначно неверных вариантов:
   та же тема → близкий уровень → та же часть речи → похожая длина и употребимость. */
function distractors(w, field, n = 3) {
  const targetStems = ruStems(w.ru);
  const lvl = LEVELS.indexOf(w.lvl);
  const usable = (x) => {
    if (x.id === w.id || !x.q) return false;
    if (x[field] === w[field] || x.ru === w.ru || x.ka === w.ka) return false;
    for (const st of ruStems(x.ru)) if (targetStems.has(st)) return false;  // синонимы отсекаем
    return true;
  };
  const multi = w.ka.includes(' ');
  const score = (x) =>
      -Math.abs(LEVELS.indexOf(x.lvl) - lvl) * 10
      + (x.pos && w.pos && x.pos === w.pos ? 14 : 0)
      + (x.ka.includes(' ') === multi ? 12 : 0)      // слово к слову, фраза к фразе
      - Math.abs(x.ru.length - w.ru.length) * 0.25
      - Math.abs(Math.log10(x.f || 0.3) - Math.log10(w.f || 0.3)) * 4
      + Math.random() * 9;                       // лёгкая случайность: варианты не повторяются

  // 1) своя тема, 2) свой уровень, 3) весь тренируемый словарь — каскад до заполнения
  const seen = new Set([w.id]);
  let cands = [];
  for (const c of w.cats) for (const x of (S.byCat.get(c) || [])) {
    if (!seen.has(x.id) && usable(x)) { seen.add(x.id); cands.push(x); }
  }
  if (cands.length < n * 4) {
    for (const x of S.trainable) {
      if (x.lvl === w.lvl && !seen.has(x.id) && usable(x)) { seen.add(x.id); cands.push(x); }
      if (cands.length >= n * 6) break;
    }
  }
  if (cands.length < n) {
    for (const x of S.trainable) {
      if (!seen.has(x.id) && usable(x)) { seen.add(x.id); cands.push(x); }
      if (cands.length >= n * 4) break;
    }
  }
  cands.sort((a, b) => score(b) - score(a));
  const best = cands.slice(0, Math.max(n, Math.min(10, cands.length)));
  const out = shuffle(best).slice(0, n);
  // страховка: вариантов всегда ровно n
  if (out.length < n) {
    for (const x of shuffle(S.trainable.slice())) {
      if (out.length >= n) break;
      if (!out.includes(x) && x.id !== w.id && x[field] !== w[field]) out.push(x);
    }
  }
  return out;
}
function answerGrade(w, ok, drill) {
  const p = Object.assign({}, wp(w.id));
  const t = today();
  // Закрепление — это первое знакомство, а не повторение: считать его повторением
  // значило бы показывать «сегодня повторено 6», когда режим повторения не открывали.
  if (p.lr !== t && !drill) { dayRec(t).rev++; p.lr = t; }
  if (p.s === 'mastered') {
    // слово уже выучено: это поддерживающая проверка, а не путь к освоению
    if (ok) { p.d = Date.now() + REFRESH_NEXT; }
    else { p.s = 'learning'; p.r = Math.max(2, masterReps() - 2); p.d = Date.now() + 10 * 60e3; p.e = (p.e || 0) + 1; }
  } else if (ok) {
    p.r = (p.r || 0) + 1;
    if (p.r >= masterReps()) { p.s = 'mastered'; p.d = Date.now() + REFRESH_FIRST; dayRec(t).new++; }
    else { p.s = 'learning'; p.d = Date.now() + STEPS[Math.min(p.r, STEPS.length - 1)]; }
  } else {
    p.e = (p.e || 0) + 1;
    p.r = Math.max(0, (p.r || 0) - 1);
    p.s = 'learning'; p.d = Date.now() + 10 * 60e3;
  }
  touchStreak(); setWp(w.id, p);
  return p;
}

/* ---------------- новые слова ---------------- */
ROUTES.learn = function () {
  if (!S.session || S.session.kind !== 'learn') {
    const unfinished = pendingDrill();
    if (unfinished.length) {              // сначала доводим до конца начатое
      S.session = { kind: 'learn', queue: [], i: 0, toTrain: [], phase: 'drill',
                    drill: shuffle(unfinished), hist: [],
                    pending: new Set(unfinished.map(w => w.id)) };
      return learnDrill();
    }
    const q = newQueue();
    if (!q.length) return emptyScreen(ico('spark'), 'Новых слов нет',
      'В выбранных категориях и уровнях всё уже пройдено. Добавьте категории или уровни — и новые слова появятся.',
      'Выбрать категории', () => go('cats'));
    const left = newLeftToday();
    if (left <= 0 && !S.extraNew) {
      return emptyScreen(ico('target'), 'Дневная норма выполнена',
        `Сегодня закреплено ${plural(dayRec(today()).drilled, 'новое слово', 'новых слова', 'новых слов')}. ` +
        'Можно повторить пройденное или продолжить сверх нормы.',
        'Повторять', () => go('review'),
        'Учить сверх нормы', () => { S.extraNew = true; S.batch = null; go('learn'); });
    }
    // Размер порции спрашиваем каждый раз: дневная норма — это план на день,
    // а сколько слов взять прямо сейчас, зависит от того, сколько есть времени.
    if (!S.batch) return batchPicker(q.length, left);
    const size = Math.min(q.length, Math.max(1, S.batch));
    S.batch = null;
    // В порции считаются слова, которые вы будете учить. Отмеченное «уже знаю»
    // места в ней не занимает — на его место подставляется следующее из запаса,
    // иначе порция из десяти знакомых слов заканчивалась, не начав ничего учить.
    S.session = { kind: 'learn', queue: q.slice(0, size), pool: q, poolIdx: size,
                  target: size, i: 0, toTrain: [], phase: 'intro' };
  }
  const s = S.session;
  if (s.phase === 'intro') return learnIntro();
  return learnDrill();
};

/* Сколько новых слов взять прямо сейчас. По умолчанию предлагается остаток
   дневной нормы, но человек волен взять меньше или больше — норма остаётся
   планом на день, а не ограничением на один заход. */
function batchPicker(available, left) {
  const suggested = Math.max(1, Math.min(left > 0 ? left : 10, available));
  const sizes = [...new Set([5, 10, 15, 20, suggested])]
    .filter(n => n >= 1 && n <= available).sort((a, b) => a - b);
  const done = dayRec(today()).drilled;
  const box = el(`<div class="trainer" style="max-width:560px">
    ${subHead('Новая порция', 'home')}
    <div style="text-align:center;margin:6px 0 22px">
      <h1 style="margin:0 0 6px">Сколько слов возьмём?</h1>
      <p class="sub">По дневной норме закреплено ${goalText(done, S.prog.set.newPerDay)} ·
        доступно ${plural(available, 'новое слово', 'новых слова', 'новых слов')}</p>
    </div>
    <div class="cats-grid" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr))">
      ${sizes.map(n => `
        <button class="cat-card" data-n="${n}" style="text-align:left">
          <div class="top"><span class="ic" style="font-size:26px;font-weight:750;color:var(--accent)">${n}</span>
            <div><div class="nm">${n === suggested ? 'Как по норме' : 'слов'}</div>
              <div class="cnt">${n === suggested ? 'остаток на сегодня' : '&nbsp;'}</div></div></div>
        </button>`).join('')}
    </div>
    <div class="card" style="margin-top:16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <span style="font-size:14px">Своё число:</span>
      <input type="number" id="own" min="1" max="${available}" value="${suggested}" style="width:90px">
      <button class="btn primary" id="own-go" style="margin-left:auto">Начать</button>
    </div>
  </div>`);
  const start = (n) => { S.batch = Math.max(1, Math.min(available, n || suggested)); render(); };
  bindSubHead(box);
  $$('[data-n]', box).forEach(b => b.onclick = () => start(+b.dataset.n));
  $('#own-go', box).onclick = () => start(+$('#own', box).value);
  $('#own', box).onkeydown = (e) => { if (e.key === 'Enter') start(+e.target.value); };
  return box;
}

function learnIntro() {
  const s = S.session, w = s.queue[s.i];
  if (!w) {
    if (!s.toTrain.length) { S.session = null; return ROUTES.learn(); }
    s.phase = 'drill'; s.i = 0; s.drill = shuffle(s.toTrain.slice()); s.hist = [];
    return learnDrill();
  }
  const taken = s.toTrain.length;
  return newWordCard(w, {
    progress: taken / s.target,
    title: `Новое слово ${taken + 1} из ${s.target}`,
    onPick: (a) => {
      const snap = snapshot(w);
      s.hist = s.hist || [];
      // если слово знакомо, дотягиваем очередь следующим из запаса
      const short = s.toTrain.length + (s.queue.length - s.i - 1) < s.target;
      const topUp = a === 'known' && short && s.poolIdx < s.pool.length;
      // индекс, по которому слово встанет в список на закрепление, — чтобы шаг назад
      // мог его оттуда убрать; раньше откат вставлял слово повторно и оно задваивалось
      s.hist.push({ snap, i: s.i, phase: 'intro', topUp,
                    tookAt: a === 'learn' ? s.toTrain.length : null });
      applyNewWordChoice(w, a);
      if (a === 'learn') s.toTrain.push(w);
      if (topUp) s.queue.push(s.pool[s.poolIdx++]);
      s.i++; render();
    },
  });
}

/* что происходит с новым словом после выбора */
function applyNewWordChoice(w, a) {
  if (a === 'known') {
    setWp(w.id, { s: 'known', r: 0, d: 0, lr: today(), e: 0 });
    dayRec(today()).known++;
  } else {
    setWp(w.id, { s: 'learning', r: 0, d: Date.now() + STEPS[0], lr: null, e: 0 });
    dayRec(today()).started++;
    markPending(w.id, true);
  }
  touchStreak();
}

/* Карточка знакомства со словом: только «уже знаю» или «учить». */
function newWordCard(w, o) {
  const box = el(`<div class="trainer">
    ${trainerHead(o)}
    <div class="word-card new-card">
      <div class="rep-label"><i class="new"></i>новое слово
        <span class="cat">${catIcon(w.cats[0])} ${esc(catName(w.cats[0]))}</span></div>
      <div class="word-ka ka">${esc(w.ka)}</div>
      ${S.prog.set.translit ? `<div class="word-tr">${esc(w.tr)}</div>` : ''}
      <button class="speak" title="Произношение (пробел)">${ico('play')}</button>
      ${revealHTML(w.ru)}
      <div id="ex-slot" hidden>${examplesHTML(w)}</div>
      ${mnemoHTML()}
      <div class="grade-row">
        <button data-a="known"><b>Уже знаю</b><span>больше не показывать</span></button>
        <button data-a="learn"><b>Учить это слово</b><span>вернётся на повторение</span></button>
      </div>
    </div>
  </div>`);
  bindSpeak(box, w.ka);
  bindMnemo(box, w);
  bindBack(box);
  const exSlot = $('#ex-slot', box);
  // примеры открываются вместе с переводом: до него они подсказали бы значение
  const reveal = bindReveal(box, () => {
    if (exSlot && exSlot.firstElementChild) { exSlot.hidden = false; bindExamples(exSlot, w); }
  });
  if (S.prog.set.autoplay) setTimeout(() => speak(w.ka), 180);
  let used = false;
  const act = (a) => { if (used) return; used = true; o.onPick(a); };
  box.querySelector('[data-a=known]').onclick = () => act('known');
  box.querySelector('[data-a=learn]').onclick = () => act('learn');
  bindSwipe(box.querySelector('.word-card'), {
    rightLabel: 'Учить', leftLabel: 'Уже знаю',
    onRight: () => act('learn'), onLeft: () => act('known'),
  });
  S.session.keys = (e) => {
    if (e.key === '1') act('known');
    else if (e.key === '2') act('learn');
    else if (e.key === 'Enter') { e.preventDefault(); reveal(); }
    else if (e.key === 'Backspace') { e.preventDefault(); stepBack(); }
    else if (e.code === 'Space') { e.preventDefault(); speak(w.ka); }
  };
  return box;
}

function learnDrill() {
  const s = S.session, w = s.drill[s.i];
  if (!s.pending) s.pending = new Set(s.drill.map(x => x.id));
  if (!w) {
    const n = s.toTrain.length;
    S.session = null;
    return emptyScreen(ico('burst'), 'Порция пройдена!',
      `Взято в изучение: ${plural(n, 'слово', 'слова', 'слов')}. Они вернутся на повторение по расписанию.`,
      'Следующая порция', () => { S.batch = null; go('learn'); }, 'На главную', () => go('home'));
  }
  // чередуем направления: изучаемый → русский, затем русский → изучаемый
  const mode = s.i % 2 === 0 ? 'ka2ru' : 'ru2ka';
  const left = s.pending.size;
  return exerciseChoice(w, mode, {
    title: `Закрепление · осталось ${plural(left, 'слово', 'слова', 'слов')} · ` +
           `${mode === 'ka2ru' ? 'выберите перевод' : L.ask.choice}`,
    progress: (s.drill.length - left) / s.drill.length,
    onDone: (ok, again) => {
      s.hist = s.hist || [];
      s.hist.push({ snap: snapshot(w), i: s.i, phase: 'drill' });
      answerGrade(w, ok, true);
      // Слово идёт в зачёт дня, когда впервые названо верно здесь, в закреплении:
      // смахнуть «учить» — ещё не результат. Взятые считаются отдельным счётчиком,
      // по нему определяется размер порции. Отметка «не закреплено» снимается тут же,
      // поэтому одно слово попадает в зачёт ровно один раз, даже если его счётчик
      // верных ответов потом снова упадёт до нуля.
      if (ok && (S.prog.pend || []).includes(w.id)) {
        dayRec(today()).drilled++;
        markPending(w.id, false);
      }
      // закрепление не заканчивается, пока каждое слово не будет названо верно
      if (ok) s.pending.delete(w.id); else s.drill.push(w);
      if (again && ok) { s.drill.push(w); s.pending.add(w.id); }
      s.i++; render();
    },
  });
}

/* ---------------- повторение ---------------- */
ROUTES.review = function () {
  if (!S.session || S.session.kind !== 'review') {
    S.session = loadSession('review');               // продолжаем прерванное занятие
  }
  if (!S.session) {
    dropSession();
    const q = dueQueue().slice(0, S.prog.set.reviewPerDay);
    if (!q.length) {
      const c = counts();
      const nextDue = S.words.map(w => wp(w.id)).filter(p => p.s === 'learning' && p.d > Date.now())
        .sort((a, b) => a.d - b.d)[0];
      const when = nextDue ? formatIn(nextDue.d - Date.now()) : null;
      return emptyScreen(ico('refresh'), 'Повторять пока нечего',
        when ? `Ближайшее повторение через ${when}. Пока можно взять новые слова.`
             : 'Возьмите новые слова — и они появятся здесь на повторение.',
        c.fresh ? 'Учить новые слова' : 'К категориям', () => go(c.fresh ? 'learn' : 'cats'));
    }
    // Считаем слова, а не карточки: слово с ошибкой выходит несколько раз,
    // и «15 из 19» читалось бы как девятнадцать слов, которых не было.
    S.session = { kind: 'review', queue: shuffle(q), i: 0, right: 0, wrong: 0, total: q.length, method: null,
                  words: q.length, left: new Set(q.map(w => w.id)), missed: new Set() };
  }
  const s = S.session, w = s.queue[s.i];
  if (!w) {
    const words = s.words, missed = s.missed.size;
    S.session = null; dropSession();
    return emptyScreen(ico(missed ? 'done' : 'trophy'), 'Повторение завершено',
      `Повторено ${plural(words, 'слово', 'слова', 'слов')}` +
      (missed ? ` · сразу вспомнили ${words - missed}, с ошибкой ${missed}`
              : ' — все с первого раза'),
      'Ещё повторять', () => go('review'), 'На главную', () => go('home'));
  }
  const p = wp(w.id);
  const rep = p.r || 0;
  const opts = {
    title: s.left.size < s.words
      ? `Повторено ${s.words - s.left.size} из ${plural(s.words, 'слова', 'слов', 'слов')}`
      : `К повторению: ${plural(s.words, 'слово', 'слова', 'слов')}`,
    progress: (s.words - s.left.size) / s.words,
    backwards: rep % 2 === 1,            // чередуем: изучаемый→русский, затем русский→изучаемый
    reps: rep,
    onDone: (ok, again) => {
      s.hist = s.hist || [];
      s.hist.push({ snap: snapshot(w), i: s.i, right: ok, wrong: !ok,
                    leftHad: s.left.has(w.id), missedHad: s.missed.has(w.id) });
      const res = answerGrade(w, ok);
      ok ? s.right++ : s.wrong++;
      ok ? s.left.delete(w.id) : s.missed.add(w.id);
      if (res.s === 'mastered') toast(`«${w.ka}» выучено полностью!`);
      // Слово не покидает сессию, пока не будет названо верно: иначе повторение
      // заканчивалось с неотработанными ошибками — ровно то же правило, что в
      // закреплении новых слов. Возвращается в конец очереди, а не сразу.
      if (!ok || again) { s.queue.push(w); s.total++; }
      s.i++; saveSession(s); render();
    },
  };
  const setting = S.prog.set.reviewMode || 'choose';
  opts.mastered = p.s === 'mastered';
  if (setting === 'choose') return exerciseReview(w, opts);
  const useRecall = setting === 'recall' || (setting === 'mix' && s.i % 2 === 0);
  if (useRecall) return exerciseRecall(w, opts);
  const mode = ['ka2ru', 'ru2ka', 'listen', 'ka2ru', 'build'][Math.min(rep, 4)];
  return mode === 'build' ? exerciseBuild(w, opts) : exerciseChoice(w, mode, opts);
};

/* ---------------- смешанный режим ---------------- */
ROUTES.mixed = function () {
  const st = S.prog.set;
  if (!S.session || S.session.kind !== 'mixed') {
    const left = S.extraNew ? st.newPerDay : newLeftToday();
    const fresh = newQueue().slice(0, Math.max(0, Math.min(left, st.newPerDay)));
    const due = dueQueue().slice(0, st.reviewPerDay);
    if (!fresh.length && !due.length) {
      return emptyScreen(ico('leaf'), 'На сегодня всё',
        'Новых слов по норме больше нет, и повторять пока нечего. Возвращайтесь позже — или добавьте категории.',
        'К категориям', () => go('cats'), 'На главную', () => go('home'));
    }
    // вперемешку: новое слово примерно на каждые три повторения
    const queue = [];
    const R = due.slice(), N = fresh.slice();
    while (R.length || N.length) {
      for (let k = 0; k < 3 && R.length; k++) queue.push({ type: 'review', w: R.shift() });
      if (N.length) queue.push({ type: 'new', w: N.shift() });
    }
    S.session = { kind: 'mixed', queue, i: 0, right: 0, wrong: 0, total: queue.length, hist: [],
                  newWords: fresh.length, words: due.length, newDone: 0,
                  left: new Set(due.map(w => w.id)), missed: new Set() };
  }
  const s = S.session, item = s.queue[s.i];
  if (!item) {
    const { newWords, words, missed } = { ...s, missed: s.missed.size };
    S.session = null;
    return emptyScreen(ico('done'), 'Занятие завершено',
      (() => {
        const parts = [newWords ? `новых слов: ${newWords}` : '',
                       words ? `повторено: ${plural(words, 'слово', 'слова', 'слов')}` : '',
                       missed ? `с ошибкой: ${missed}` : ''].filter(Boolean).join(' · ');
        return parts.charAt(0).toUpperCase() + parts.slice(1);
      })(),
      'Ещё', () => go('mixed'), 'На главную', () => go('home'));
  }
  const w = item.w;
  // прогресс по словам: карточек больше, чем слов, — слово с ошибкой выходит снова
  const allWords = s.newWords + s.words;
  const doneWords = s.newDone + (s.words - s.left.size);
  const head = { progress: allWords ? doneWords / allWords : 0,
                 title: `Пройдено ${doneWords} из ${plural(allWords, 'слова', 'слов', 'слов')}` };
  if (item.type === 'new') {
    return newWordCard(w, Object.assign({}, head, {
      onPick: (a) => {
        s.hist.push({ snap: snapshot(w), i: s.i, newDone: true });
        applyNewWordChoice(w, a);
        s.newDone++;
        s.i++; render();
      },
    }));
  }
  const p = wp(w.id), rep = p.r || 0;
  return exerciseReview(w, Object.assign({}, head, {
    reps: rep, backwards: rep % 2 === 1, mastered: p.s === 'mastered',
    onDone: (ok, again) => {
      s.hist.push({ snap: snapshot(w), i: s.i, right: ok, wrong: !ok,
                    leftHad: s.left.has(w.id), missedHad: s.missed.has(w.id) });
      const res = answerGrade(w, ok);
      ok ? s.right++ : s.wrong++;
      ok ? s.left.delete(w.id) : s.missed.add(w.id);
      if (res.s === 'mastered') toast(`«${w.ka}» выучено полностью!`);
      if (!ok || again) { s.queue.push({ type: 'review', w }); s.total++; }
      s.i++; render();
    },
  }));
};

/* ---------------- раздел грамматики ----------------
   Уроки лежат в данных (L.lessons), а не в коде: общий код не знает, о каком
   языке они и сколько их. Порядок вопросов и вариантов задан при сборке файла,
   поэтому урок выглядит одинаково при каждом открытии — это его свойство,
   а не случайность: к вопросу можно вернуться и увидеть тот же вопрос.
   Прогресс живёт в общем объекте прогресса, значит попадает и в резервную копию. */
const lessonProg = (id) => S.prog.les[id] || { read: 0, best: 0, tries: 0 };
const lessonDone = (id) => lessonProg(id).best >= LESSON_PASS;
const LESSON_PASS = 8;                       // сколько верных из десяти считается сдачей

function lessonsDone() {
  return (S.lessons ? S.lessons.lessons : []).filter(l => lessonDone(l.id)).length;
}

ROUTES.lessons = function () {
  const data = S.lessons;
  if (!data) { go('home'); return el('<div></div>'); }
  const total = data.lessons.length, done = lessonsDone();
  const rows = data.lessons.map((l) => {
    const p = lessonProg(l.id);
    const ok = lessonDone(l.id);
    const state = ok ? `пройден · ${p.best} из 10`
                     : p.tries ? `лучший результат ${p.best} из 10`
                     : p.read ? 'прочитан, тест не сдан' : 'не начат';
    return `<button class="les-row${ok ? ' done' : ''}" data-les="${esc(l.id)}">
      <span class="les-n">${ok ? ico('check') : l.n}</span>
      <span class="les-t"><b>${esc(l.title)}</b><i>${esc(l.short)} · ${state}</i></span>
      <span class="ma">›</span></button>`;
  }).join('');
  const box = el(`<div>
    ${subHead(data.title, 'home')}
    <p class="sub" style="margin:-4px 2px 16px">${esc(data.lead)}</p>
    <div class="les-total">
      <div class="bar"><i style="width:${total ? done / total * 100 : 0}%"></i></div>
      <span>Пройдено ${done} из ${total}</span>
    </div>
    <div class="menu-card">${rows}</div>
  </div>`);
  bindSubHead(box);
  $$('[data-les]', box).forEach(b => b.onclick = () => { S.lessonId = b.dataset.les; go('lesson'); });
  return box;
};

function lessonBlocks(l) {
  return l.blocks.map(([kind, body]) => {
    if (kind === 'h') return `<h3 class="les-h">${esc(body)}</h3>`;
    if (kind === 'p') return `<p class="les-p">${esc(body)}</p>`;
    if (kind === 'note') return `<div class="les-note">${esc(body)}</div>`;
    if (kind === 'ex') return `<div class="les-ex">${body.map(([ka, tr, ru], i) => `
      <div class="lex">
        <div class="lex-ka">
          <b class="${L.script}">${esc(ka)}</b>
          ${audioUrl(ka) ? `<button class="lex-play" data-p="${i}" title="Послушать">${ico('play')}</button>` : ''}
        </div>
        ${S.prog.set.translit ? `<div class="lex-tr">${esc(tr)}</div>` : ''}
        <div class="lex-ru">${esc(ru)}</div>
      </div>`).join('')}</div>`;
    if (kind === 't') {
      const [head, rows] = body;
      return `<div class="les-table"><table>
        <thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(r => `<tr>${r.map(([c, native]) => `<td class="${native ? L.script : ''}">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>`;
    }
    return '';
  }).join('');
}

ROUTES.lesson = function () {
  const data = S.lessons;
  const l = data && data.lessons.find(x => x.id === S.lessonId);
  if (!l) { go('lessons'); return el('<div></div>'); }
  if (S.quiz && S.quiz.id === l.id) return lessonQuiz(l);
  const p = lessonProg(l.id);
  const box = el(`<div>
    ${subHead(`${l.n}. ${l.title}`, 'lessons')}
    <div class="les-body">${lessonBlocks(l)}</div>
    <div class="les-foot">
      <p class="sub">${p.tries ? `Вы уже проходили тест, лучший результат — ${p.best} из 10.`
                               : 'Дальше десять вопросов по этому уроку. Их можно перепроходить.'}</p>
      <button class="btn primary big" id="les-go">${p.tries ? 'Пройти тест ещё раз' : 'Проверить себя'}</button>
    </div>
  </div>`);
  bindSubHead(box);
  // сам факт открытия урока запоминается: список отличает прочитанное от нетронутого
  if (!p.read) { S.prog.les[l.id] = Object.assign({}, p, { read: 1 }); saveProgress(); }
  const ex = [];
  l.blocks.forEach(([kind, body]) => { if (kind === 'ex') ex.push(body); });
  $$('.les-ex', box).forEach((zone, zi) => {
    $$('.lex-play', zone).forEach(b => b.onclick = () => speak(ex[zi][+b.dataset.p][0]));
  });
  $('#les-go', box).onclick = () => { S.quiz = { id: l.id, i: 0, right: 0, answered: null }; render(); };
  return box;
};

function lessonQuiz(l) {
  const q = S.quiz;
  if (q.i >= l.quiz.length) {
    const right = q.right, ok = right >= LESSON_PASS;
    const prev = lessonProg(l.id);
    S.prog.les[l.id] = { read: 1, best: Math.max(prev.best || 0, right), tries: (prev.tries || 0) + 1 };
    saveProgress();
    S.quiz = null;
    return emptyScreen(ico(ok ? 'trophy' : 'refresh'),
      ok ? 'Урок пройден' : 'Ещё не сдан',
      `Верных ответов: ${right} из ${l.quiz.length}.` +
      (ok ? '' : ` Для зачёта нужно ${LESSON_PASS}.`),
      ok ? 'К списку уроков' : 'Пройти ещё раз',
      ok ? () => go('lessons') : () => { S.quiz = { id: l.id, i: 0, right: 0, answered: null }; render(); },
      ok ? 'Перечитать урок' : 'Перечитать урок',
      () => { S.quiz = null; render(); });
  }
  const item = l.quiz[q.i];
  const box = el(`<div class="trainer">
    ${trainerHead({ progress: q.i / l.quiz.length, title: `Вопрос ${q.i + 1} из ${l.quiz.length}` })}
    <div class="word-card quiz-card">
      <div class="rep-label"><i class="two"></i>${esc(l.title)}</div>
      <div class="quiz-q">${esc(item.q)}</div>
      <div class="options" id="qopts">${item.o.map(([o, native], i) => `
        <button class="opt${native ? ' ' + L.script : ''}" data-i="${i}">${esc(o)}</button>`).join('')}</div>
      <div class="quiz-why" id="qwhy" hidden></div>
    </div>
  </div>`);
  // кнопка «назад» шапки в тесте не нужна: шага назад здесь нет
  const back = box.querySelector('.back-btn');
  if (back) { back.disabled = false; back.onclick = () => { S.quiz = null; render(); }; }
  $$('.opt', box).forEach(b => b.onclick = () => {
    if (q.answered !== null) return;
    q.answered = +b.dataset.i;
    const ok = q.answered === item.a;
    if (ok) q.right++;
    $$('.opt', box).forEach((x, i) => {
      x.classList.add('done');
      if (i === item.a) x.classList.add('right');
      else if (x === b) x.classList.add('wrong');
    });
    const why = $('#qwhy', box);
    why.hidden = false;
    why.className = 'quiz-why ' + (ok ? 'ok' : 'no');
    why.innerHTML = `<b>${ok ? 'Верно' : 'Неверно'}</b><span>${esc(item.why)}</span>
      <button class="btn primary block" id="q-next">${q.i + 1 < l.quiz.length ? 'Дальше →' : 'Итог'}</button>`;
    $('#q-next', why).onclick = () => { q.i++; q.answered = null; render(); };
    why.scrollIntoView({ block: 'end', behavior: 'smooth' });
  });
  return box;
}

/* ---------------- пролистать слова (без влияния на прогресс) ---------------- */
ROUTES.browse = function () {
  if (!S.session || S.session.kind !== 'browse') {
    const pool = poolWords().filter(w => w.q);
    if (!pool.length) return emptyScreen(ico('folder'), 'Нет слов для просмотра',
      'Выберите категории и уровни — и слова появятся здесь.', 'К категориям', () => go('cats'));
    S.session = { kind: 'browse', queue: shuffle(pool.slice()), i: 0, hist: [] };
  }
  const s = S.session, w = s.queue[s.i % s.queue.length];
  const p = wp(w.id);
  const box = el(`<div class="trainer">
    ${trainerHead({ progress: (s.i % s.queue.length) / s.queue.length, title: `Просмотр · слово ${s.i + 1}` })}
    <div class="word-card">
      <div class="rep-label"><i class="${p.s === 'mastered' ? 'five' : p.s === 'learning' ? 'two' : 'new'}"></i>
        ${p.s === 'mastered' ? 'выучено' : p.s === 'learning' ? 'в процессе' : p.s === 'known' ? 'уже знаю' : 'новое'}
        <span class="cat">${catIcon(w.cats[0])} ${esc(catName(w.cats[0]))}</span></div>
      <div class="word-ka ka">${esc(w.ka)}</div>
      ${S.prog.set.translit ? `<div class="word-tr">${esc(w.tr)}</div>` : ''}
      <button class="speak lg" title="Произношение">${ico('play')}</button>
      ${revealHTML(w.ru)}
      ${mnemoHTML()}
    </div>
    <div class="answer-actions">
      <button class="btn ghost" data-a="prev">← Назад</button>
      <button class="btn primary" data-a="next">Дальше →</button>
    </div>
  </div>`);
  bindSpeak(box, w.ka);
  bindMnemo(box, w);
  const revealBrowse = bindReveal(box);
  if (S.prog.set.autoplay) setTimeout(() => speak(w.ka), 180);
  const step = (d) => { s.i = Math.max(0, s.i + d); render(); };
  box.querySelector('[data-a=next]').onclick = () => step(1);
  box.querySelector('[data-a=prev]').onclick = () => step(-1);
  bindSwipe(box.querySelector('.word-card'), {
    rightLabel: '→ дальше', leftLabel: '← назад',
    onRight: () => step(1), onLeft: () => step(-1),
  });
  S.session.keys = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); revealBrowse(); }
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.code === 'Space') { e.preventDefault(); speak(w.ka); }
  };
  return box;
};

function formatIn(ms) {
  const m = Math.round(ms / 60e3);
  if (m < 60) return plural(m, 'минуту', 'минуты', 'минут');
  const h = Math.round(m / 60);
  if (h < 24) return plural(h, 'час', 'часа', 'часов');
  return plural(Math.round(h / 24), 'день', 'дня', 'дней');
}

/* ---------------- упражнение: выбор варианта ---------------- */
function exerciseChoice(w, mode, o) {
  const askKa = mode === 'ru2ka';
  const field = askKa ? 'ka' : 'ru';
  const options = shuffle([w, ...distractors(w, field, 3)]);
  const promptHTML = mode === 'listen'
    ? `<div class="word-card"><span class="lvl">${w.lvl}</span>
         <div class="word-ka" style="font-size:30px;color:var(--muted)">Послушайте слово</div>
         <button class="speak lg" title="Повторить">${ico('play')}</button></div>`
    : askKa
      ? `<div class="word-card"><span class="lvl">${w.lvl}</span>
           <span class="cat">${catIcon(w.cats[0])} ${esc(catName(w.cats[0]))}</span>
           <div class="word-ka" style="font-size:30px">${esc(w.ru)}</div>
           <div class="word-tr">${L.ask.choiceTr}</div></div>`
      : wordCardHTML(w, {});
  const box = el(`<div class="trainer">
    ${trainerHead(o)}
    ${promptHTML}
    ${optionsHTML(options, field, true)}
  </div>`);
  bindSpeak(box, w.ka);
  bindOptionPlay(box, options);
  if (askKa) holdAudio(box);                      // ответ — изучаемое слово, озвучка назвала бы его
  else if (S.prog.set.autoplay || mode === 'listen') setTimeout(() => speak(w.ka), 200);

  let answered = false;
  const answer = (idx) => {
    if (answered) return;
    answered = true;
    const ok = options[idx].id === w.id;
    $$('.opt', box).forEach((b, i) => {
      b.classList.add('done');                     // не отключаем: кнопка ещё должна звучать
      if (options[i].id === w.id) b.classList.add('right');
      else if (i === idx) b.classList.add('wrong');
    });
    releaseAudio(box);                            // ответ открыт — слово можно и нужно услышать
    speak(w.ka);                                  // ровно один раз: два вызова подряд обрывали друг друга
    if (!ok) {
      box.appendChild(el(`<div class="word-card" style="margin-top:14px;padding:18px">
        <div class="word-ka ka" style="font-size:26px;margin:0">${esc(w.ka)}</div>
        <div class="word-tr">${esc(w.tr)}</div>
        <div class="word-ru" style="font-size:17px;margin-top:8px">${esc(w.ru)}</div></div>`));
    }
    afterAnswer(box, null, ok, w, (again) => o.onDone(ok, again));
  };
  $$('.opt', box).forEach(b => b.onclick = () => answer(+b.dataset.i));
  bindBack(box);
  S.session.keys = (e) => {
    if (/^[1-4]$/.test(e.key)) answer(+e.key - 1);
    else if (e.key === 'Backspace') { e.preventDefault(); stepBack(); }
    else if (e.code === 'Space' && !(askKa && !answered)) { e.preventDefault(); speak(w.ka); }
  };
  return box;
}

/* ---------------- упражнение: вспомнил / не вспомнил ---------------- */
function exerciseRecall(w, o) {
  const backwards = o.backwards;                       // true: показываем русский, вспоминаем изучаемый
  const front = backwards
    ? `<div class="word-ka" style="font-size:30px">${esc(w.ru)}</div>
       <div class="word-tr">${L.ask.recall}</div>`
    : `<div class="word-ka ka">${esc(w.ka)}</div>
       ${S.prog.set.translit ? `<div class="word-tr">${esc(w.tr)}</div>` : ''}`;
  const box = el(`<div class="trainer">
    ${trainerHead(o)}
    <div class="word-card">
      <span class="lvl">${w.lvl}</span>
      <span class="cat">${catIcon(w.cats[0])} ${esc(catName(w.cats[0]))}</span>
      ${front}
      <button class="speak lg" title="Произношение (пробел)">${ico('play')}</button>
      <div id="answer" hidden>
        <div class="word-ru">${esc(backwards ? w.ka : w.ru)}</div>
        ${backwards && S.prog.set.translit ? `<div class="word-tr">${esc(w.tr)}</div>` : ''}
        ${backwards ? '' : `<div class="word-tr" style="margin-top:6px">${esc(w.cats.map(catName).join(' · '))}</div>`}
      </div>
    </div>
    <div class="answer-actions" id="stage-show">
      <button class="btn primary block big" data-a="show">Показать ответ</button>
    </div>
    <div id="mnemo-slot" hidden>${mnemoHTML()}</div>
    <div class="answer-actions" id="stage-grade" hidden>
      <button class="btn ghost" data-a="no" style="color:var(--clay);border-color:var(--clay)">${ico('cross')} Не вспомнил</button>
      <button class="btn success" data-a="yes">${ico('check')} Вспомнил</button>
    </div>
  </div>`);
  const speakWord = () => speak(w.ka);
  box.querySelector('.speak').onclick = speakWord;
  if (backwards) holdAudio(box);                  // показано русское, вспомнить надо изучаемое
  else if (S.prog.set.autoplay) setTimeout(speakWord, 180);

  let shown = false, done = false;
  const show = () => {
    if (shown) return;
    shown = true;
    $('#answer', box).hidden = false;
    $('#stage-show', box).hidden = true;
    $('#stage-grade', box).hidden = false;
    const slot = $('#mnemo-slot', box);
    if (slot && hasMnemo(w)) { slot.hidden = false; bindMnemo(slot, w); }
    releaseAudio(box);
    if (backwards || !S.prog.set.autoplay) speakWord();
  };
  const grade = (ok) => {
    if (!shown || done) return;
    done = true;
    $$('#stage-grade .btn', box).forEach(b => b.disabled = true);
    o.onDone(ok);
  };
  box.querySelector('[data-a=show]').onclick = show;
  box.querySelector('[data-a=yes]').onclick = () => grade(true);
  box.querySelector('[data-a=no]').onclick = () => grade(false);
  bindSwipe(box.querySelector('.word-card'), {
    rightLabel: '✓ Вспомнил', leftLabel: '✗ Не вспомнил',
    // свайп сразу оценивает, но ответ успевает показаться — чтобы было видно, верно ли вспомнил
    onRight: () => { show(); setTimeout(() => grade(true), 700); },
    onLeft: () => { show(); setTimeout(() => grade(false), 1400); },
  });
  bindBack(box);
  S.session.keys = (e) => {
    if (e.code === 'Space' && !(backwards && !shown)) { e.preventDefault(); speakWord(); }
    else if (e.key === 'Backspace') { e.preventDefault(); stepBack(); }
    else if (!shown && (e.key === 'Enter' || e.key === '3')) show();
    else if (shown && e.key === '1') grade(false);
    else if (shown && e.key === '2') grade(true);
  };
  return box;
}

/* ---------------- упражнение: ввести слово руками ---------------- */
const normalizeAnswer = (x) => String(x).toLowerCase().replace(/[\s'’`-]/g, '');

function exerciseTyping(w, o) {
  const box = el(`<div class="trainer">
    ${trainerHead(o)}
    <div class="word-card">
      <span class="lvl">${w.lvl}</span>
      <span class="cat">${catIcon(w.cats[0])} ${esc(catName(w.cats[0]))}</span>
      <div class="word-ka" style="font-size:27px">${esc(w.ru)}</div>
      <div class="word-tr">${L.ask.type}</div>
      <button class="speak lg" title="Произношение">${ico('play')}</button>
      <div class="typing">
        <input type="text" id="ans" autocomplete="off" autocorrect="off" autocapitalize="off"
               spellcheck="false" placeholder="напишите слово">
        <div class="typing-verdict" hidden></div>
      </div>
    </div>
    <div class="answer-actions">
      <button class="btn ghost" data-a="skip">Не помню</button>
      <button class="btn primary" data-a="check">Проверить</button>
    </div>
  </div>`);
  bindSpeak(box, w.ka);
  const input = $('#ans', box), verdict = $('.typing-verdict', box);
  setTimeout(() => input.focus(), 120);
  let done = false;
  const finish = (ok, typed) => {
    if (done) return;
    done = true;
    input.disabled = true;
    input.classList.add(ok ? 'ok' : 'no');
    verdict.hidden = false;
    verdict.className = 'typing-verdict ' + (ok ? 'ok' : 'no');
    verdict.innerHTML = ok
      ? `${ico('check')} Верно — <b class="ka">${esc(w.ka)}</b> <span>${esc(w.tr)}</span>`
      : `${ico('cross')} Правильно так: <b class="ka">${esc(w.ka)}</b> <span>${esc(w.tr)}</span>` +
        (typed ? `<br><span class="was">вы написали: ${esc(typed)}</span>` : '');
    speak(w.ka);
    $$('.answer-actions .btn', box).forEach(b => b.disabled = true);
    afterAnswer(box, null, ok, w, (again) => o.onDone(ok, again));
  };
  const check = () => {
    const typed = input.value.trim();
    if (!typed) return;
    const t = normalizeAnswer(typed);
    finish(t === normalizeAnswer(w.ka) || t === normalizeAnswer(w.tr), typed);
  };
  box.querySelector('[data-a=check]').onclick = check;
  box.querySelector('[data-a=skip]').onclick = () => finish(false, '');
  input.onkeydown = (e) => { if (e.key === 'Enter') check(); };
  bindBack(box);
  S.session.keys = () => {};                      // ввод занимает клавиатуру целиком
  return box;
}

/* ---------------- экран повторения ----------------
   Слово, три способа проверить себя (написать / посмотреть / выбрать)
   и две оценки внизу. Свайп вправо — вспомнил, влево — нет. */
function exerciseReview(w, o) {
  const backwards = o.backwards;
  const askKa = !backwards;                       // показываем изучаемое слово, вспоминаем перевод
  const front = askKa ? w.ka : w.ru;
  const answer = askKa ? w.ru : w.ka;
  const repNo = (o.reps || 0) + 1;
  const repClass = o.mastered ? 'done' : ['one', 'two', 'three', 'four', 'five'][Math.min(o.reps || 0, 4)];
  const box = el(`<div class="trainer">
    ${trainerHead(o)}
    <div class="word-card review-card">
      <div class="rep-label"><i class="${repClass}"></i>
        ${o.mastered ? 'проверка выученного' : `${repNo}-е повторение`}
        <span class="cat">${catIcon(w.cats[0])} ${esc(catName(w.cats[0]))}</span></div>
      <div class="word-ka ${askKa ? 'ka' : ''}" style="${askKa ? '' : 'font-size:30px'}">${esc(front)}</div>
      ${askKa && S.prog.set.translit ? `<div class="word-tr">${esc(w.tr)}</div>` : ''}
      <button class="speak" title="Произношение (пробел)">${ico('play')}</button>
      <div class="reveal" id="reveal" hidden>
        <div class="word-ru ${askKa ? '' : 'ka'}">${esc(answer)}</div>
        ${!askKa && S.prog.set.translit ? `<div class="word-tr">${esc(w.tr)}</div>` : ''}
      </div>
      <div class="zone" id="zone" hidden></div>
      <div id="mnemo-slot" hidden>${mnemoHTML()}</div>
      <div class="tools" id="tools">
        <button data-t="type" title="Написать слово">${ico('keyboard')}</button>
        <button data-t="look" title="Посмотреть ответ">${ico('eye')}</button>
        <button data-t="pick" title="Выбрать из четырёх">${ico('grid')}</button>
      </div>
      <div class="grade-row" id="grade">
        <button data-g="no"><b>Я не вспомнил</b><span>это слово</span></button>
        <button data-g="yes"><b>Я вспомнил</b><span>это слово</span></button>
      </div>
    </div>
  </div>`);
  bindSpeak(box, w.ka);
  if (!askKa) holdAudio(box);                     // на лицевой стороне русское слово
  else if (S.prog.set.autoplay) setTimeout(() => speak(w.ka), 180);

  const zone = $('#zone', box), reveal = $('#reveal', box), tools = $('#tools', box);
  let done = false, checked = false;
  // Вердикт всегда за человеком: автопроверка только показывает ответ и
  // подсвечивает выбранный вариант, а засчитывает слово та же пара кнопок,
  // что и без проверки. Угадать вариант наугад и честно нажать «не вспомнил»
  // должно быть можно, поэтому отдельной кнопки «Дальше» здесь нет.
  const grade = (ok) => { if (done) return; done = true; o.onDone(ok, false); };
  const finish = (ok) => {
    if (checked) return;
    checked = true;
    reveal.hidden = false;
    releaseAudio(box);
    showMnemo();
    speak(w.ka);
    // Инструменты проверки после ответа не нужны, а место занимают: убираем их,
    // чтобы карточка вместе с оценкой помещалась на экран без прокрутки.
    tools.hidden = true;
    // Если у вариантов есть свои кнопки звука, верхняя их дублирует —
    // убираем и её, это ещё сорок с лишним пикселей в пользу строки оценки.
    if (zone.querySelector('.opt-play')) {
      const top = box.querySelector('.review-card > .speak');
      if (top) top.hidden = true;
    }
    const card = box.querySelector('.review-card');
    card.classList.add(ok ? 'said-yes' : 'said-no');
    // Высота карточки гуляет от длины слова, названия категории и наличия
    // ассоциации, поэтому не подгоняем пиксели, а подводим строку оценки
    // под глаз: искать кнопки прокруткой пользователю не приходится.
    // Подводим дважды: сразу и после того, как раскрытый ответ и ассоциация
    // достроятся — иначе первая подводка целится по ещё не сложившейся вёрстке.
    const row = $('#grade', box);
    const bring = () => row.scrollIntoView({ block: 'end', behavior: 'smooth' });
    setTimeout(bring, 60);
    setTimeout(bring, 450);
  };

  // глазок только открывает ответ; произнести — отдельная кнопка, она тут же появляется
  // ассоциация открывается вместе с ответом: подсказка по созвучию имеет смысл,
  // когда слово уже перед глазами, а до ответа она его выдала бы
  const showMnemo = () => {
    const slot = $('#mnemo-slot', box);
    if (slot && slot.hidden && hasMnemo(w)) { slot.hidden = false; bindMnemo(slot, w); }
  };
  // Глазок работает в обе стороны: нажал — открыл, нажал ещё раз — закрыл.
  // Вместе с ответом прячется и озвучка, если на лицевой стороне русское слово,
  // иначе закрытый ответ можно было бы просто послушать.
  const closeReveal = () => {
    reveal.hidden = true;
    if (!askKa) holdAudio(box);
    tools.querySelector('[data-t=look]').classList.remove('used');
  };
  const look = () => {
    if (!reveal.hidden) { closeReveal(); return; }
    reveal.hidden = false; releaseAudio(box); showMnemo();
    tools.querySelector('[data-t=look]').classList.add('used');
  };

  const typing = () => {
    if (zone.dataset.mode === 'type') return;
    closeReveal();                                 // проверять себя с открытым ответом бессмысленно
    zone.dataset.mode = 'type'; zone.hidden = false;
    zone.innerHTML = `<div class="typing">
      <input type="text" id="ans" autocomplete="off" autocorrect="off" autocapitalize="off"
             spellcheck="false" placeholder="${askKa ? 'перевод по-русски' : L.ask.placeholder}">
      <button class="btn primary sm" id="check">Проверить</button>
    </div>`;
    const input = $('#ans', zone);
    setTimeout(() => input.focus(), 80);
    const check = () => {
      const typed = input.value.trim();
      if (!typed) return;
      const t = normalizeAnswer(typed);
      const ok = askKa
        ? w.ru.split(/[;,]/).some(x => normalizeAnswer(x) === t)
        : (t === normalizeAnswer(w.ka) || t === normalizeAnswer(w.tr));
      input.classList.add(ok ? 'ok' : 'no');
      finish(ok);
    };
    $('#check', zone).onclick = check;
    input.onkeydown = (e) => { if (e.key === 'Enter') check(); };
    S.session.keys = () => {};
  };

  const picking = () => {
    if (zone.dataset.mode === 'pick') return;
    closeReveal();                                 // иначе верный вариант виден прямо над списком
    zone.dataset.mode = 'pick'; zone.hidden = false;
    const field = askKa ? 'ru' : 'ka';
    const options = shuffle([w, ...distractors(w, field, 3)]);
    zone.innerHTML = optionsHTML(options, field, false);
    bindOptionPlay(zone, options);
    $$('.opt', zone).forEach(b => b.onclick = () => {
      const ok = options[+b.dataset.i].id === w.id;
      $$('.opt', zone).forEach((x, i) => {
        x.classList.add('done');
        if (options[i].id === w.id) x.classList.add('right');
        else if (x === b) x.classList.add('wrong');
      });
      finish(ok);
    });
  };

  $$('#tools button', box).forEach(b => b.onclick = () => {
    const t = b.dataset.t;
    if (t === 'look') look(); else if (t === 'type') typing(); else picking();
  });
  $('#grade', box).querySelector('[data-g=yes]').onclick = () => grade(true);
  $('#grade', box).querySelector('[data-g=no]').onclick = () => grade(false);
  bindSwipe(box.querySelector('.review-card'), {
    rightLabel: '✓ Вспомнил', leftLabel: '✗ Не вспомнил',
    onRight: () => grade(true), onLeft: () => grade(false),
  });
  bindBack(box);
  S.session.keys = (e) => {
    if (e.key === '1') typing();
    else if (e.key === '2') look();
    else if (e.key === '3') picking();
    else if (e.key === 'Backspace') { e.preventDefault(); stepBack(); }
    else if (e.code === 'Space' && !(!askKa && reveal.hidden)) { e.preventDefault(); speak(w.ka); }
  };
  return box;
}

/* ---------------- упражнение: собрать слово ---------------- */
function exerciseBuild(w, o) {
  const target = w.ka;
  const chars = shuffle(target.replace(/\s/g, '').split(''));
  let built = '';
  const box = el(`<div class="trainer">
    ${trainerHead(o)}
    <div class="word-card">
      <span class="lvl">${w.lvl}</span>
      <div class="word-ka" style="font-size:26px">${esc(w.ru)}</div>
      <div class="word-tr">соберите слово по буквам${S.prog.set.translit ? ' · ' + esc(w.tr) : ''}</div>
      <button class="speak lg">${ico('play')}</button>
      <div class="slot ka" id="slot"></div>
      <div class="letters ka">${chars.map((c, i) => `<button data-c="${esc(c)}" data-i="${i}">${esc(c)}</button>`).join('')}</div>
    </div>
    <div class="answer-actions">
      <button class="btn ghost" data-a="back">← Стереть</button>
      <button class="btn ghost" data-a="skip">Не помню</button>
    </div>
  </div>`);
  bindSpeak(box, w.ka);
  holdAudio(box);                                 // слово собирают по буквам — звук назвал бы ответ
  const slot = $('#slot', box);
  let shown = false;
  const finish = (ok) => {
    shown = true;
    slot.classList.add(ok ? 'ok' : 'no');
    releaseAudio(box);
    if (ok) speak(w.ka);
    else { slot.textContent = target; speak(w.ka); }
    $$('.letters button', box).forEach(b => b.disabled = true);
    $$('.answer-actions .btn', box).forEach(b => b.disabled = true);   // ответ уже показан — не даём его стереть
    afterAnswer(box, null, ok, w, (again) => o.onDone(ok, again));
  };
  const redraw = () => { slot.textContent = built || '…'; };
  redraw();
  $$('.letters button', box).forEach(b => b.onclick = () => {
    b.style.visibility = 'hidden';
    built += b.dataset.c;
    redraw();
    const flat = target.replace(/\s/g, '');
    if (built.length === flat.length) finish(built === flat);
    else if (!flat.startsWith(built)) finish(false);
  });
  box.querySelector('[data-a=back]').onclick = () => {
    if (!built) return;
    const last = built.slice(-1); built = built.slice(0, -1);
    const btn = $$('.letters button', box).reverse().find(b => b.dataset.c === last && b.style.visibility === 'hidden');
    if (btn) btn.style.visibility = '';
    redraw();
  };
  box.querySelector('[data-a=skip]').onclick = () => finish(false);
  bindBack(box);
  S.session.keys = (e) => {
    if (e.code === 'Space' && shown) { e.preventDefault(); speak(w.ka); }
    else if (e.key === 'Backspace') { e.preventDefault(); stepBack(); }
  };
  return box;
}

/* ---------------- пустой экран ---------------- */
function emptyScreen(ico, title, text, btn1, fn1, btn2, fn2) {
  const box = el(`<div class="empty">
    <div class="ico">${ico}</div><h3>${esc(title)}</h3><p>${esc(text)}</p>
    <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
      ${btn1 ? `<button class="btn primary big" data-b="1">${esc(btn1)}</button>` : ''}
      ${btn2 ? `<button class="btn ghost big" data-b="2">${esc(btn2)}</button>` : ''}
    </div></div>`);
  if (btn1) box.querySelector('[data-b="1"]').onclick = fn1;
  if (btn2) box.querySelector('[data-b="2"]').onclick = fn2;
  return box;
}

/* ---------------- категории ---------------- */
ROUTES.cats = function () {
  const st = S.prog.set;
  const stats = {};
  for (const c of S.cats) stats[c.id] = { total: 0, m: 0, l: 0, k: 0 };
  for (const w of S.words) {
    const p = wp(w.id);
    for (const c of w.cats) {
      if (!stats[c]) continue;
      if (!st.levels.includes(w.lvl)) continue;
      stats[c].total++;
      if (p.s === 'mastered') stats[c].m++;
      else if (p.s === 'learning') stats[c].l++;
      else if (p.s === 'known') stats[c].k++;
    }
  }
  const box = el(`<div>
    ${subHead('Категории', 'home')}
    <div class="page-head">
      <div><p class="sub">Отметьте темы, которые изучаете сейчас — новые слова будут браться только из них</p></div>
      <div class="page-meta">Выбрано тем: <b id="cat-n">${st.cats.length}</b> · слов в работе: <b id="pool-n">${poolWords().length}</b></div>
    </div>
    <div class="toolbar">
      <span class="lbl">Уровни:</span>
      ${LEVELS.map(l => `<button class="chip lvl ${st.levels.includes(l) ? 'on' : ''}" data-lvl="${l}">${l}</button>`).join('')}
      <span style="flex:1"></span>
      <button class="chip" data-all="1">Выбрать все</button>
      <button class="chip" data-all="0">Снять все</button>
      <button class="chip" data-base="1">Базовый набор</button>
    </div>
    <div class="cats-grid">${S.cats.map(c => {
      const s = stats[c.id] || { total: 0, m: 0, l: 0, k: 0 };
      const pc = (n) => s.total ? (n / s.total * 100).toFixed(1) + '%' : '0%';
      const done = s.total ? Math.round(s.m / s.total * 100) : 0;
      return `<div class="cat-card ${st.cats.includes(c.id) ? 'on' : ''}" data-cat="${c.id}">
        <div class="top"><span class="ic">${catIcon(c.id)}</span>
          <div class="cat-title"><div class="nm">${esc(c.name)}</div>
            <div class="cnt">${s.total} слов на выбранных уровнях</div></div>
          <span class="check">${ico('check')}</span></div>
        <div class="cat-bar">
          <i class="m" style="width:${pc(s.m)}"></i><i class="l" style="width:${pc(s.l)}"></i><i class="k" style="width:${pc(s.k)}"></i>
        </div>
        <div class="cat-foot">
          <span class="cat-pct ${done >= 100 ? 'full' : ''} num">${done}%</span>
          <span class="cat-done">выучено ${s.m} из ${s.total}</span>
          <span class="cat-rest">учу ${s.l} · знаю ${s.k}</span>
        </div>
      </div>`;
    }).join('')}</div>
    <p class="sub" style="margin-top:18px">
      Процент на карточке — доля <b>полностью выученных</b> слов темы (${masterReps()} верных повторений) ·
      <span class="dot" style="background:var(--green)"></span>выучено ·
      <span class="dot" style="background:var(--gold)"></span>в процессе ·
      <span class="dot" style="background:var(--slate)"></span>отмечено «уже знаю»
    </p>
  </div>`);
  bindSubHead(box);
  const refresh = () => { S.session = null; render(); };
  $$('.cat-card', box).forEach(c => c.onclick = () => {
    const id = c.dataset.cat, i = st.cats.indexOf(id);
    if (i >= 0) st.cats.splice(i, 1); else st.cats.push(id);
    saveProgress(); refresh();
  });
  $$('.chip.lvl', box).forEach(b => b.onclick = () => {
    const l = b.dataset.lvl, i = st.levels.indexOf(l);
    if (i >= 0) { if (st.levels.length > 1) st.levels.splice(i, 1); } else st.levels.push(l);
    st.levels.sort((a, b2) => LEVELS.indexOf(a) - LEVELS.indexOf(b2));
    saveProgress(); refresh();
  });
  $$('[data-all]', box).forEach(b => b.onclick = () => {
    st.cats = b.dataset.all === '1' ? S.cats.map(c => c.id) : [];
    saveProgress(); refresh();
  });
  box.querySelector('[data-base]').onclick = () => {
    st.cats = defaultProgress().set.cats.slice(); saveProgress(); refresh();
  };
  return box;
};

/* ---------------- словарь ---------------- */
/* ---------------- словарь: сначала категории ---------------- */
function wordStatus(w) {
  const st = wp(w.id).s;
  return st === 'mastered' ? ['выучено', 'mastered']
       : st === 'learning' ? ['в процессе', 'learning']
       : st === 'known' ? ['уже знаю', 'known'] : ['новое', 'new'];
}

/* строка слова: статус, само слово, перевод и озвучка */
function wordRowHTML(w) {
  const [label, cls] = wordStatus(w);
  return `<div class="wcard ${cls}" data-id="${w.id}">
    <div class="wmain">
      <div class="wstatus">${label}${hasMnemo(w) ? ' · ' + ico('bulb') : ''}<span class="wlvl">${w.lvl}</span></div>
      <div class="wword ka">${esc(w.ka)}</div>
      ${S.prog.set.translit ? `<div class="wtr">${esc(w.tr)}</div>` : ''}
      <div class="wru">${esc(w.ru)}</div>
    </div>
    <button class="wplay" data-a="speak" title="Произношение">${ico('play')}</button>
  </div>`;
}

function bindWordRows(root) {
  $$('.wcard', root).forEach(row => {
    const w = S.byId.get(row.dataset.id);
    row.onclick = (e) => {
      if (e.target.dataset.a === 'speak') { speak(w.ka); return; }
      const open = row.nextElementSibling;
      if (open && open.classList.contains('wdetails')) { open.remove(); return; }
      $$('.wdetails', root).forEach(x => x.remove());
      const det = el(`<div class="wdetails">
        ${hasMnemo(w) ? `<div class="mnemo">${ico('bulb')} ${esc(S.mnemo[w.ka])}</div>` : ''}
        <div class="wactions">
          <button class="btn ghost sm" data-a="learn">${ico('cap')} Учить</button>
          <button class="btn ghost sm" data-a="known">${ico('check')} Уже знаю</button>
          <button class="btn ghost sm" data-a="reset">↺ Сбросить</button>
        </div></div>`);
      det.onclick = (ev) => {
        const a = ev.target.dataset.a;
        if (!a) return;
        if (a === 'learn') { setWp(w.id, { s: 'learning', r: 0, d: Date.now(), lr: null, e: 0 }); toast('Добавлено в изучение'); }
        else if (a === 'known') { setWp(w.id, { s: 'known', r: 0, d: 0, lr: today(), e: 0 }); toast('Отмечено как известное'); }
        else { delete S.prog.w[w.id]; saveProgress(); toast('Прогресс слова сброшен'); }
        render();
      };
      row.after(det);
    };
  });
}

ROUTES.dict = function () {
  const f = S.dictFilter || (S.dictFilter = { q: '', limit: 60 });
  const box = el(`<div>
    <div class="page-head"><div><h1>Словарь</h1>
      <p class="sub">${S.words.length} слов и выражений с озвучкой</p></div></div>
    <div class="toolbar">
      <input type="search" id="d-q" placeholder="Искать слова…" value="${esc(f.q)}">
    </div>
    <div id="d-out"></div>
  </div>`);
  const out = $('#d-out', box);

  const drawCategories = () => {
    const rows = S.cats.map(c => {
      let total = 0, m = 0;
      for (const w of S.words) {
        if (!w.cats.includes(c.id)) continue;
        total++;
        if (wp(w.id).s === 'mastered') m++;
      }
      return { c, total, m, pct: total ? Math.round(m / total * 100) : 0 };
    }).filter(r => r.total);
    out.innerHTML = `<div class="cat-list">${rows.map(r => `
      <button class="cat-line" data-cat="${r.c.id}">
        <span class="ic">${catIcon(r.c.id)}</span>
        <span class="nm"><b>${esc(r.c.name)}</b><i>${plural(r.total, 'слово', 'слова', 'слов')}</i></span>
        <span class="pct ${r.pct ? '' : 'zero'}">${r.pct}%</span>
        <span class="chev">›</span>
      </button>`).join('')}</div>`;
    $$('.cat-line', out).forEach(b => b.onclick = () => { S.dictCat = b.dataset.cat; go('dictcat'); });
  };

  const drawSearch = () => {
    const q = f.q.trim().toLowerCase();
    /* Ранжируем: точное совпадение → начало слова → просто вхождение.
       Иначе запрос «вода» первым выдаёт «в качестве вывода». */
    const score = (w) => {
      const ru = w.ru.toLowerCase(), tr = w.tr.toLowerCase();
      const parts = ru.split(/[;,]/).map(x => x.trim());
      if (w.ka === q || parts.includes(q) || tr === q) return 100;
      if (parts.some(x => x.startsWith(q)) || w.ka.startsWith(q) || tr.startsWith(q)) return 60;
      if (parts.some(x => x.split(' ').some(word => word.startsWith(q)))) return 40;
      if (w.ka.includes(q) || tr.includes(q) || ru.includes(q)) return 10;
      return 0;
    };
    const found = S.words.map(w => ({ w, s: score(w) })).filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s || b.w.f - a.w.f).map(x => x.w);
    const shown = found.slice(0, f.limit);
    out.innerHTML = `<p class="sub" style="margin-bottom:10px">Найдено: ${found.length}</p>
      <div class="wlist">${shown.map(wordRowHTML).join('')}</div>
      ${found.length > f.limit ? `<button class="btn ghost load-more">Показать ещё (${found.length - f.limit})</button>` : ''}`;
    bindWordRows(out);
    const more = $('.load-more', out);
    if (more) more.onclick = () => { f.limit += 100; drawSearch(); };
  };

  const draw = () => (f.q.trim() ? drawSearch() : drawCategories());
  draw();
  let t = null;
  $('#d-q', box).oninput = (e) => { f.q = e.target.value; f.limit = 60; clearTimeout(t); t = setTimeout(draw, 180); };
  return box;
};

/* ---------------- словарь: слова одной категории ---------------- */
ROUTES.dictcat = function () {
  const cat = S.cats.find(c => c.id === S.dictCat);
  if (!cat) { go('dict'); return el('<div></div>'); }
  const order = S.dictOrder || 'default';
  let words = S.words.filter(w => w.cats.includes(cat.id));
  const counts = { mastered: 0, learning: 0, known: 0, new: 0 };
  for (const w of words) counts[wordStatus(w)[1]]++;
  if (order === 'alpha') words = words.slice().sort((a, b) => a.ka.localeCompare(b.ka, 'ka'));
  else if (order === 'ru') words = words.slice().sort((a, b) => a.ru.localeCompare(b.ru, 'ru'));
  else if (order === 'level') words = words.slice().sort((a, b) =>
    LEVELS.indexOf(a.lvl) - LEVELS.indexOf(b.lvl) || b.f - a.f);
  const limit = S.dictCatLimit || 80;

  const box = el(`<div>
    ${subHead(cat.name, 'dict', catIcon(cat.id))}
    <p class="sub" style="margin-bottom:14px">
      ${plural(words.length, 'слово', 'слова', 'слов')} ·
      выучено ${counts.mastered} · в процессе ${counts.learning} · знаю ${counts.known}</p>
    <div class="toolbar">
      <span class="lbl">Порядок:</span>
      <button class="chip sm ${order === 'default' ? 'on' : ''}" data-order="default">по умолчанию</button>
      <button class="chip sm ${order === 'alpha' ? 'on' : ''}" data-order="alpha">по алфавиту</button>
      <button class="chip sm ${order === 'ru' ? 'on' : ''}" data-order="ru">по переводу</button>
      <button class="chip sm ${order === 'level' ? 'on' : ''}" data-order="level">по уровню</button>
      <span style="flex:1"></span>
      <button class="chip sm" id="cat-reset">↺ Сбросить прогресс темы</button>
    </div>
    <div class="wlist">${words.slice(0, limit).map(wordRowHTML).join('')}</div>
    ${words.length > limit ? `<button class="btn ghost load-more">Показать ещё (${words.length - limit})</button>` : ''}
  </div>`);
  bindSubHead(box);
  bindWordRows(box);
  $$('[data-order]', box).forEach(b => b.onclick = () => { S.dictOrder = b.dataset.order; render(); });
  const more = $('.load-more', box);
  if (more) more.onclick = () => { S.dictCatLimit = limit + 150; render(); };
  $('#cat-reset', box).onclick = () => {
    if (!confirm(`Сбросить прогресс всех слов темы «${cat.name}»?`)) return;
    for (const w of words) delete S.prog.w[w.id];
    saveProgress(); render(); toast('Прогресс темы сброшен');
  };
  return box;
};

/* ---------------- алфавит ---------------- */
ROUTES.alphabet = function () {
  if (S.alphaQuiz) return alphabetQuiz();
  const box = el(`<div>
    ${subHead(L.alphabet.title, 'menu')}
    <div class="page-head">
      <div><p class="sub">${L.alphabet.lead}</p></div>
      <button class="btn primary" id="a-quiz">${ico('target')} Тренировка букв</button>
    </div>
    <div class="card" style="margin-bottom:16px;font-size:13.5px;line-height:1.6;color:var(--muted)">
      ${L.alphabet.note}
    </div>
    <div class="alpha-grid">${S.alphabet.map((a, i) => `
      <div class="letter-card" data-i="${i}">
        <div class="big ka">${a[0]}</div>
        <div class="nm ka">${a[1]}</div>
        <div class="tr">${esc(a[3])}</div>
        <div class="snd">${esc(a[4])}</div>
        <div class="ex"><b class="ka">${esc(a[5])}</b> — ${esc(a[6])}</div>
      </div>`).join('')}</div>
  </div>`);
  bindSubHead(box);
  $$('.letter-card', box).forEach(c => {
    const a = S.alphabet[+c.dataset.i];
    c.onclick = (e) => speak(e.target.closest('.ex') ? a[5] : a[1]);
  });
  $('#a-quiz', box).onclick = () => { startAlphaQuiz(); render(); };
  return box;
};

/* Тренировка букв идёт по кругу и сама не заканчивается: человек выходит,
   когда захочет, кнопкой «Назад». Буквы берутся перемешанной колодой по всему
   алфавиту — пока круг не пройден, повторов нет, поэтому за круг встречается
   каждая буква. Кончилась колода — тасуем заново, следя, чтобы первая буква
   нового круга не совпала с последней буквой прошлого. */
function alphaDeck(prev) {
  const deck = shuffle(S.alphabet.slice());
  if (prev && deck.length > 1 && deck[0][0] === prev) deck.push(deck.shift());
  return deck;
}
function startAlphaQuiz() {
  S.alphaQuiz = { deck: alphaDeck(), i: 0, right: 0, asked: 0, round: 1 };
}
function alphabetQuiz() {
  const q = S.alphaQuiz;
  if (q.i >= q.deck.length) {                       // круг пройден — начинаем новый
    q.deck = alphaDeck(q.deck[q.deck.length - 1][0]);
    q.i = 0; q.round++;
  }
  const a = q.deck[q.i];
  const opts = shuffle([a, ...pick(S.alphabet.filter(x => x[0] !== a[0]), 3)]);
  const box = el(`<div class="trainer">
    <div class="progress-line"><i style="width:${q.i / q.deck.length * 100}%"></i></div>
    <div class="trainer-head">
      <button class="btn ghost sm back-btn">← Назад</button>
      <p class="sub">${q.asked ? `Пройдено ${q.asked} · верно ${q.right}` : `Круг по всем ${q.deck.length} буквам`}</p>
      <span class="head-spacer"></span>
    </div>
    <div class="word-card">
      <div class="word-ka ka" style="font-size:64px">${a[0]}</div>
      <button class="speak lg">${ico('play')}</button>
      <div class="word-tr">какой это звук?</div>
    </div>
    <div class="options">${opts.map((o, i) => `<button class="opt" data-i="${i}">${i + 1}. <b>${esc(o[3])}</b> — ${esc(o[4])}</button>`).join('')}</div>
  </div>`);
  box.querySelector('.speak').onclick = () => speak(a[1]);
  setTimeout(() => speak(a[1]), 150);
  const leave = () => {
    const asked = q.asked, right = q.right;
    S.alphaQuiz = null; S.alphaKeys = null;
    render();
    if (asked) toast(`Тренировка букв: ${right} из ${asked}`);
  };
  box.querySelector('.back-btn').onclick = leave;
  let done = false;
  const answer = (i) => {
    if (done) return; done = true;
    const ok = opts[i][0] === a[0];
    q.asked++;
    if (ok) q.right++;
    $$('.opt', box).forEach((b, j) => {
      b.disabled = true;
      if (opts[j][0] === a[0]) b.classList.add('right');
      else if (j === i) b.classList.add('wrong');
    });
    setTimeout(() => { q.i++; render(); }, ok ? 600 : 1500);
  };
  $$('.opt', box).forEach(b => b.onclick = () => answer(+b.dataset.i));
  S.alphaKeys = (e) => {
    if (/^[1-4]$/.test(e.key)) answer(+e.key - 1);
    else if (e.key === 'Escape') leave();
  };
  return box;
}

/* ---------------- графики (canvas, без библиотек) ---------------- */
function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function prepCanvas(cv, h) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 600;
  cv.width = w * dpr; cv.height = h * dpr;
  cv.style.height = h + 'px';
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  return { c, w, h };
}
const MONTHS_SHORT = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];
const MONTHS_FULL = ['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];

function dayLabel(iso) {
  const [, m, d] = iso.split('-').map(Number);
  if (iso === today()) return 'сегодня';
  if (iso === dateKey(new Date(Date.now() - 864e5))) return 'вчера';
  return `${d} ${MONTHS_FULL[m - 1].replace(/ь$/, 'я').replace(/т$/, 'та').replace(/й$/, 'я')}`;
}
function startOfWeek(d) {
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));      // неделя с понедельника
  return x;
}
function lastDays(n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = dateKey(new Date(Date.now() - i * 864e5));
    out.push({ date: d, ...(S.prog.days[d] || { rev: 0, new: 0, known: 0, started: 0, drilled: 0 }) });
  }
  return out;
}

/* Агрегация дневных записей в периоды: день, неделя, месяц, год.
   Считает всю активность целиком — по всем категориям и уровням без исключения. */
function statsBuckets(scale, count) {
  const buckets = [], now = new Date();
  const push = (key, label, full) => buckets.push({ key, label, full, rev: 0, new: 0, known: 0, started: 0, drilled: 0 });
  const dm = (d) => `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}`;
  if (scale === 'week') {
    const s0 = startOfWeek(now);
    for (let i = count - 1; i >= 0; i--) {
      const d = new Date(s0); d.setDate(d.getDate() - i * 7);
      const e = new Date(d); e.setDate(e.getDate() + 6);
      push(dateKey(d), dm(d), `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} — ${e.getDate()} ${MONTHS_SHORT[e.getMonth()]}`);
    }
  } else if (scale === 'month') {
    for (let i = count - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
           MONTHS_SHORT[d.getMonth()], `${MONTHS_FULL[d.getMonth()]} ${d.getFullYear()}`);
    }
  } else if (scale === 'year') {
    for (let i = count - 1; i >= 0; i--) {
      const y = now.getFullYear() - i;
      push(String(y), String(y), `${y} год`);
    }
  } else {
    for (let i = count - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 864e5);
      push(dateKey(d), dm(d), dayLabel(dateKey(d)));
    }
  }
  const index = new Map(buckets.map(b => [b.key, b]));
  for (const [date, rec] of Object.entries(S.prog.days || {})) {
    let key = date;
    if (scale === 'week') key = dateKey(startOfWeek(new Date(date + 'T00:00:00')));
    else if (scale === 'month') key = date.slice(0, 7);
    else if (scale === 'year') key = date.slice(0, 4);
    const b = index.get(key);
    if (b) {
      b.rev += rec.rev || 0; b.new += rec.new || 0; b.known += rec.known || 0; b.started += rec.started || 0;
      // у дней до появления счётчика закреплённых берём взятые — иначе старая история обнулилась бы
      b.drilled += rec.drilled === undefined ? (rec.started || 0) : rec.drilled;
    }
  }
  return buckets;
}

/* всплывающая подсказка над графиком */
/* равномерные подписи оси: столько, сколько помещается без наложения */
function axisLabels(c, buckets, pad, w, h, xOf) {
  const fit = Math.max(2, Math.floor((w - pad.l - pad.r) / 46));
  const step = Math.ceil(buckets.length / fit);
  c.fillStyle = css('--muted'); c.font = '10px system-ui'; c.textAlign = 'center';
  buckets.forEach((b, i) => {
    const fromEnd = buckets.length - 1 - i;
    if (fromEnd % step !== 0) return;                    // равняем от последнего, чтобы «сегодня» всегда подписан
    c.fillText(b.label, Math.min(Math.max(xOf(i), pad.l + 12), w - pad.r - 12), h - 6);
  });
  c.textAlign = 'start';
}

/* контрастный цвет для числа поверх столбца: на светлой заливке — тёмный, на тёмной — белый */
function onBarColor(hex) {
  const m = String(hex).trim().match(/^#([\da-f]{6})$/i);
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  const lum = (0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? '#16201e' : '#fff';
}

/* Столбчатый график активности. Без всплывающих подсказок: на телефоне они
   срабатывали от случайного касания и закрывали сам график, поэтому число
   пишется прямо в столбце, а если столбец слишком низкий — над ним. */
function drawActivity(cv, buckets) {
  if (!cv) return;
  const wrap = cv.parentElement;
  const MIN_GROUP = 96;                    // ширина группы: четыре столбца и числа внутри них
  if (wrap && wrap.classList.contains('chart-scroll')) {
    const need = buckets.length * MIN_GROUP + 44;
    cv.style.width = Math.max(wrap.clientWidth, need) + 'px';
  }
  const { c, w, h } = prepCanvas(cv, 158);
  const pad = { l: 34, r: 10, t: 20, b: 22 };
  const max = Math.max(4, ...buckets.map(d => Math.max(d.drilled, d.rev, d.new, d.known)));
  const bw = (w - pad.l - pad.r) / buckets.length;
  const ih = h - pad.t - pad.b;
  c.strokeStyle = css('--line'); c.lineWidth = 1;
  c.fillStyle = css('--muted'); c.font = '10px system-ui';
  for (let i = 0; i <= 3; i++) {                          // сетка и шкала слева
    const y = Math.round(pad.t + ih * i / 3) + .5;
    c.beginPath(); c.moveTo(pad.l, y); c.lineTo(w - pad.r, y); c.stroke();
    c.fillText(String(Math.round(max * (1 - i / 3))), 4, y + 3);
  }
  buckets.forEach((d, i) => {
    const x = pad.l + i * bw;
    // Столбцы одной группы стоят вплотную, отступ остаётся между группами.
    // Серии с нулём не рисуются и не занимают место: иначе день с одной-двумя
    // непустыми серией выглядел как столбцы, разбросанные дырами.
    const gap = Math.min(bw * 0.22, 14);
    const barW = Math.max(3, (bw - gap) / 4);      // толщина постоянна, сколько бы серий ни было
    const draw = (val, color, off) => {
      const bh = ih * (val / max);
      c.fillStyle = color;
      c.beginPath();
      // скругляем только верх: снизу столбцы смыкаются в сплошную группу
      c.roundRect(x + off, h - pad.b - bh, barW, Math.max(bh, val ? 2 : 0), [3, 3, 0, 0]);
      c.fill();
      if (val) {                                   // контур отделяет соседние столбцы друг от друга
        c.lineWidth = 1;
        c.strokeStyle = '#000';
        c.stroke();
      }
      if (!val) return;
      const txt = String(val);
      c.textAlign = 'center';
      const cx = x + off + barW / 2;
      // подбираем кегль, чтобы трёхзначное число тоже поместилось внутрь столбца
      let size = 0;
      for (const px of [10, 9, 8]) {
        c.font = `600 ${px}px system-ui`;
        if (c.measureText(txt).width <= barW - 3) { size = px; break; }
      }
      if (size && bh >= size + 6) {
        c.font = `600 ${size}px system-ui`;
        c.fillStyle = onBarColor(color);                 // число внутри столбца
        c.fillText(txt, cx, h - pad.b - bh / 2 + size / 2 - 1);
      } else {
        c.fillStyle = color;                             // столбец слишком мал — подписываем сверху
        c.font = '9.5px system-ui';
        c.fillText(txt, cx, h - pad.b - bh - 4);
      }
      c.textAlign = 'start';
    };
    // четыре серии: закреплено новых, повторено, выучено полностью, отмечено «уже знаю»
    const series = [
      [d.drilled, css('--gold')],
      [d.rev, css('--accent')],
      [d.new, css('--green')],
      [d.known, css('--slate')],
    ].filter(([val]) => val > 0);
    const groupW = barW * series.length;
    series.forEach(([val, color], k) => draw(val, color, (bw - groupW) / 2 + barW * k));
  });
  axisLabels(c, buckets, pad, w, h, (i) => pad.l + i * bw + bw / 2);
  // при первой отрисовке показываем свежие дни — правый край
  if (wrap && wrap.classList.contains('chart-scroll') && !wrap.dataset.scrolled) {
    wrap.scrollLeft = wrap.scrollWidth;
    wrap.dataset.scrolled = '1';
  }
}

function drawCumulative(cv, buckets) {
  if (!cv) return;
  const { c, w, h } = prepCanvas(cv, 178);
  const pad = { l: 38, r: 10, t: 14, b: 22 };
  let acc = counts().mastered - buckets.reduce((s, b) => s + b.new, 0);
  const xOf = (i) => pad.l + (w - pad.l - pad.r) * i / Math.max(1, buckets.length - 1);
  const pts = buckets.map((b, i) => { acc += b.new; return { x: xOf(i), v: acc, b }; });
  const max = Math.max(5, ...pts.map(p => p.v)), min = Math.min(...pts.map(p => p.v), 0);
  const y = (v) => pad.t + (h - pad.t - pad.b) * (1 - (v - min) / Math.max(1, max - min));
  c.strokeStyle = css('--line'); c.lineWidth = 1; c.fillStyle = css('--muted'); c.font = '10px system-ui';
  for (let i = 0; i <= 3; i++) {
    const yy = Math.round(pad.t + (h - pad.t - pad.b) * i / 3) + .5;
    c.beginPath(); c.moveTo(pad.l, yy); c.lineTo(w - pad.r, yy); c.stroke();
    c.fillText(String(Math.round(max - (max - min) * i / 3)), 4, yy + 3);
  }
  const grad = c.createLinearGradient(0, pad.t, 0, h - pad.b);
  grad.addColorStop(0, css('--accent') + '40'); grad.addColorStop(1, css('--accent') + '00');
  c.beginPath(); c.moveTo(pts[0].x, y(pts[0].v));
  pts.forEach(p => c.lineTo(p.x, y(p.v)));
  c.lineTo(pts[pts.length - 1].x, h - pad.b); c.lineTo(pts[0].x, h - pad.b); c.closePath();
  c.fillStyle = grad; c.fill();
  c.beginPath(); c.moveTo(pts[0].x, y(pts[0].v));
  pts.forEach(p => c.lineTo(p.x, y(p.v)));
  c.strokeStyle = css('--accent'); c.lineWidth = 2; c.stroke();
  axisLabels(c, buckets, pad, w, h, xOf);
  // итог на конце линии вместо всплывающей подсказки
  const last = pts[pts.length - 1];
  c.fillStyle = css('--accent');
  c.beginPath(); c.arc(last.x, y(last.v), 3.5, 0, 7); c.fill();
  c.font = '600 11px system-ui'; c.textAlign = 'end';
  c.fillText(String(last.v), Math.min(last.x + 22, w - 4), Math.max(pad.t + 9, y(last.v) - 8));
  c.textAlign = 'start';
}

/* ---------------- статистика ---------------- */
/* Переключатель задаёт, чем меряется один столбец: днём, неделей, месяцем
   или всей историей. Раньше он смешивал период и шаг — «90 дней» молча
   рисовались неделями, и было непонятно, что означает столбец. */
const SCALES = {
  day:   ['День',      'day',   14, 'по дням'],
  week:  ['Неделя',    'week',  12, 'по неделям'],
  month: ['Месяц',     'month', 12, 'по месяцам'],
  all:   ['Всё время', 'month',  0, 'за всё время'],
};

/* сколько месяцев прошло с первого дня занятий — для шкалы «всё время» */
function monthsOfHistory() {
  const dates = Object.keys(S.prog.days || {}).sort();
  if (!dates.length) return 1;
  const first = new Date(dates[0] + 'T00:00:00'), now = new Date();
  return Math.max(1, (now.getFullYear() - first.getFullYear()) * 12 + now.getMonth() - first.getMonth() + 1);
}

ROUTES.stats = function () {
  const c = counts();
  const key = SCALES[S.statsScale] ? S.statsScale : 'day';
  const [, scale, count, periodLabel] = SCALES[key];
  const buckets = statsBuckets(scale, key === 'all' ? monthsOfHistory() : count);
  const sum = (f) => buckets.reduce((s, b) => s + b[f], 0);
  const activeDays = Object.values(S.prog.days || {}).filter(d => d.rev || d.new || d.known).length;
  // всего закреплено за всю историю — та же величина, что и в колонке периода
  const totalDrilled = Object.values(S.prog.days || {})
    .reduce((n, d) => n + (d.drilled === undefined ? (d.started || 0) : d.drilled), 0);

  const byLevel = {};
  for (const l of LEVELS) byLevel[l] = { total: 0, m: 0, l: 0, k: 0 };
  for (const w of S.words) {
    const p = wp(w.id), b = byLevel[w.lvl];
    b.total++;
    if (p.s === 'mastered') b.m++; else if (p.s === 'learning') b.l++; else if (p.s === 'known') b.k++;
  }
  const catRows = S.cats.map(cat => {
    let total = 0, m = 0, l = 0, k = 0;
    for (const w of S.words) {
      if (!w.cats.includes(cat.id)) continue;
      total++;
      const st = wp(w.id).s;
      if (st === 'mastered') m++; else if (st === 'learning') l++; else if (st === 'known') k++;
    }
    return { cat, total, m, l, k, done: m + k };
  }).sort((a, b) => (b.m / (b.total || 1)) - (a.m / (a.total || 1)));

  const legendRow = (color, name, total, period) => `<div class="mrow">
      <span class="mtot num">${total}</span><span class="mper num">${period}</span>
      <span class="mdot" style="background:${color}"></span><span class="mname">${name}</span></div>`;

  const box = el(`<div>
    ${subHead('Статистика', 'menu')}
    <div class="page-head">
      <div><p class="sub">Весь словарь: ${S.words.length} лексем, из них ${S.trainable.length} в тренировках</p></div>
      <div class="toolbar" style="margin:0">
        ${Object.entries(SCALES).map(([k, v]) =>
          `<button class="chip scale ${key === k ? 'on' : ''}" data-scale="${k}">${v[0]}</button>`).join('')}
      </div>
    </div>

    <div class="grid stats-grid" style="margin-bottom:16px">
      <div class="stat green"><div class="n num">${c.mastered}</div><div class="l">Полностью выучено</div></div>
      <div class="stat orange"><div class="n num">${c.learning}</div><div class="l">Изучается сейчас</div></div>
      <div class="stat purple"><div class="n num">${c.known}</div><div class="l">Уже известные</div></div>
      <div class="stat blue"><div class="n num">${((c.mastered + c.known + c.learning) / c.total * 100).toFixed(1)}%</div>
        <div class="l">Охват словаря</div></div>
      <div class="stat"><div class="n num">${ico('fire')} ${S.prog.streak}</div><div class="l">Серия дней · рекорд ${S.prog.best || 0}</div></div>
      <div class="stat"><div class="n num">${activeDays ? (sum('rev') / Math.max(1, activeDays)).toFixed(1) : 0}</div>
        <div class="l">Слов в активный день</div></div>
    </div>

    <div class="chart-card" style="margin-bottom:16px">
      <h3>Активность ${periodLabel}</h3>
      <p class="cap">Все категории и уровни · одно слово считается один раз в сутки</p>
      <div class="chart-scroll"><canvas id="c-rev" height="164"></canvas></div>
      <div class="metrics">
        <div class="mrow mhead"><span class="mtot">Всего</span><span class="mper">${periodLabel.replace('за ', '')}</span><span></span><span></span></div>
        ${legendRow('var(--green)', 'Полностью выучено', c.mastered, sum('new'))}
        ${legendRow('var(--accent)', 'Повторено (уникальных)', '—', sum('rev'))}
        ${legendRow('var(--gold)', 'Закреплено новых слов', totalDrilled, sum('drilled'))}
        ${legendRow('var(--slate)', 'Уже известные', c.known, sum('known'))}
      </div>
    </div>

    <div class="chart-card" style="margin-bottom:16px">
      <h3>Всего выучено слов</h3>
      <p class="cap">Накопительно · ${periodLabel}</p>
      <canvas id="c-cum" height="178"></canvas>
    </div>

    <div class="grid" style="grid-template-columns:1fr 1fr">
      <div class="chart-card"><h3>По уровням</h3><p class="cap">Сколько слов каждого уровня пройдено</p>
        <div class="cat-progress">${LEVELS.map(l => {
          const b = byLevel[l];
          return `<div class="cp-row"><span class="nm"><b>${l}</b></span>
            <span class="bar"><i style="width:${b.total ? b.m / b.total * 100 : 0}%;background:var(--green)"></i>
            <i style="width:${b.total ? b.l / b.total * 100 : 0}%;background:var(--gold)"></i>
            <i style="width:${b.total ? b.k / b.total * 100 : 0}%;background:var(--slate)"></i></span>
            <span class="val">${b.total ? Math.round(b.m / b.total * 100) : 0}% · ${b.m}/${b.total}</span></div>`;
        }).join('')}</div></div>
      <div class="chart-card"><h3>По категориям</h3><p class="cap">Доля полностью выученных слов темы · все ${S.cats.length} категорий</p>
        <div class="cat-progress">${catRows.map(r => `
          <div class="cp-row"><span class="nm">${catIcon(r.cat.id)} ${esc(r.cat.name)}</span>
            <span class="bar"><i style="width:${r.total ? r.m / r.total * 100 : 0}%;background:var(--green)"></i>
            <i style="width:${r.total ? r.l / r.total * 100 : 0}%;background:var(--gold)"></i>
            <i style="width:${r.total ? r.k / r.total * 100 : 0}%;background:var(--slate)"></i></span>
            <span class="val">${r.total ? Math.round(r.m / r.total * 100) : 0}% · ${r.m}/${r.total}</span></div>`).join('')}</div></div>
    </div>
  </div>`);
  bindSubHead(box);
  $$('.chip.scale', box).forEach(b => b.onclick = () => { S.statsScale = b.dataset.scale; render(); });
  setTimeout(() => { drawActivity($('#c-rev'), buckets); drawCumulative($('#c-cum'), buckets); }, 0);
  return box;
};

/* ---------------- настройки ---------------- */
function openSettings() {
  const st = S.prog.set;
  const sw = (on) => `<div class="switch ${on ? 'on' : ''}"><i></i></div>`;
  const row = (label, desc, control) => `<div class="set-row"><div><div class="lbl">${label}</div>
      <div class="desc">${desc}</div></div>${control}</div>`;
  const bg = el(`<div class="modal-bg"><div class="modal">
    <h2>Настройки</h2>

    <div class="set-sect">Внешний вид</div>
    <div class="set-group">
      ${row('Тема', 'Тёмная бережёт глаза вечером', `<select id="s-theme">
        <option value="system" ${themePref() === 'system' ? 'selected' : ''}>Как в системе</option>
        <option value="dark" ${themePref() === 'dark' ? 'selected' : ''}>Тёмная</option>
        <option value="light" ${themePref() === 'light' ? 'selected' : ''}>Светлая</option></select>`)}
      ${row('Показывать транслитерацию', L.translitNote, `<span data-sw="translit">${sw(st.translit)}</span>`)}
    </div>

    <div class="set-sect">Изучение слов</div>
    <div class="set-group">
      ${row('Новых слов в день', 'Дневная норма: столько слов даётся в порциях',
        `<input type="number" id="s-new" min="1" max="200" value="${st.newPerDay}">`)}
      ${row('Повторений за сессию', 'Ограничение одной сессии повторения',
        `<input type="number" id="s-rev" min="5" max="500" value="${st.reviewPerDay}">`)}
      ${row('Сколько верных ответов до «выучено»', 'Столько раз нужно ответить верно, чтобы слово считалось выученным',
        `<select id="s-mreps">${[3, 5, 7, 10].map(n =>
          `<option value="${n}" ${masterReps() === n ? 'selected' : ''}>${n}</option>`).join('')}</select>`)}
      ${row('Режим повторения', 'Как проверять себя, когда слово возвращается', `<select id="s-rmode">
        <option value="choose" ${st.reviewMode === 'choose' ? 'selected' : ''}>Выбирать способ каждый раз</option>
        <option value="recall" ${st.reviewMode === 'recall' ? 'selected' : ''}>Вспомнил / не вспомнил</option>
        <option value="choice" ${st.reviewMode === 'choice' ? 'selected' : ''}>Выбор из вариантов</option>
        <option value="mix" ${st.reviewMode === 'mix' ? 'selected' : ''}>Вперемешку</option></select>`)}
      ${row('Выдавать на повторение', 'Слова из всего словаря или только из выбранных тем', `<select id="s-scope">
        <option value="selected" ${st.reviewScope !== 'all' ? 'selected' : ''}>Только выбранные категории</option>
        <option value="all" ${st.reviewScope === 'all' ? 'selected' : ''}>Весь словарь</option></select>`)}
      ${row('Освежать выученные слова', 'Выученное вернётся через месяц, потом раз в три месяца',
        `<span data-sw="refresh">${sw(st.refresh !== false)}</span>`)}
      ${row('Инвертировать смахивания', 'Поменять местами «вспомнил» и «не вспомнил»',
        `<span data-sw="invertSwipe">${sw(st.invertSwipe)}</span>`)}
    </div>

    <div class="set-sect">Произношение</div>
    <div class="set-group">
      ${row('Голос', L.voice.note, L.voice.single
        ? `<b>${L.voice.f}</b>`
        : `<select id="s-voice">
        <option value="f" ${st.voice === 'f' ? 'selected' : ''}>${L.voice.f}</option>
        <option value="m" ${st.voice === 'm' ? 'selected' : ''}>${L.voice.m}</option></select>`)}
      ${row('Произносить автоматически', 'Слово озвучивается при показе карточки',
        `<span data-sw="autoplay">${sw(st.autoplay)}</span>`)}
      ${row('Скорость речи', '<span id="s-speed-val">' + (st.speed || 1).toFixed(1) + '</span>×',
        `<input type="range" id="s-speed" min="0.5" max="1.5" step="0.1" value="${st.speed || 1}">`)}
    </div>

    <div class="set-sect">Данные</div>
    <p class="set-note">Прогресс хранится только на этом устройстве. Если удалить значок с экрана
      «Домой», iOS сотрёт его вместе с приложением — поэтому время от времени сохраняйте копию.</p>
    <div class="data-acts">
      <span class="act"><button class="btn ghost sm" id="s-copy">${ico('clip')} Скопировать код</button>${hintBtn('copy')}</span>
      <span class="act"><button class="btn ghost sm" id="s-paste">${ico('down')} Восстановить из кода</button>${hintBtn('paste')}</span>
      <span class="act"><button class="btn ghost sm" id="s-export">${ico('down')} Файлом</button>${hintBtn('export')}</span>
      <span class="act"><button class="btn ghost sm" id="s-import">${ico('up')} Из файла</button>${hintBtn('import')}</span>
      <span class="act"><button class="btn ghost sm" id="s-check">${ico('search')} Проверить звук</button>${hintBtn('check')}</span>
      <span class="act"><button class="btn ghost sm" id="s-reset" style="color:var(--clay)">Сбросить всё</button>${hintBtn('reset')}</span>
    </div>
    <div style="display:flex;margin-top:18px">
      <button class="btn primary" id="s-close" style="margin-left:auto">Готово</button>
    </div>
  </div></div>`);

  bindHints(bg);
  $$('[data-sw]', bg).forEach(node => node.onclick = () => {
    const k = node.dataset.sw;
    const tri = (k === 'refresh');
    st[k] = tri ? !(st[k] !== false) : !st[k];
    node.firstElementChild.classList.toggle('on', tri ? st[k] !== false : !!st[k]);
    saveProgress();

  });
  $('#s-theme', bg).onchange = (e) => { localStorage.setItem(THEME_KEY, e.target.value); applyTheme(); };
  const voiceSel = $('#s-voice', bg);
  if (voiceSel) voiceSel.onchange = (e) => { st.voice = e.target.value; saveProgress(); speak(L.sample); };
  $('#s-rmode', bg).onchange = (e) => { st.reviewMode = e.target.value; saveProgress(); S.session = null; dropSession(); };
  $('#s-scope', bg).onchange = (e) => { st.reviewScope = e.target.value; saveProgress(); S.session = null; dropSession(); };
  $('#s-mreps', bg).onchange = (e) => { st.masterReps = +e.target.value; saveProgress(); S.session = null; dropSession(); };
  $('#s-new', bg).onchange = (e) => {
    st.newPerDay = Math.max(1, Math.min(200, +e.target.value || 12));
    S.extraNew = false; S.session = null; saveProgress();
  };
  $('#s-rev', bg).onchange = (e) => { st.reviewPerDay = Math.max(5, +e.target.value || 60); saveProgress(); };
  const speed = $('#s-speed', bg);
  speed.oninput = (e) => { st.speed = +e.target.value; $('#s-speed-val', bg).textContent = st.speed.toFixed(1); };
  speed.onchange = () => { saveProgress(); speak(L.sample); };

  $('#s-check', bg).onclick = async () => {
    const word = L.sample, lines = [];
    lines.push(`индекс озвучки: ${Object.keys(S.audio).length} записей`);
    const url = audioUrl(word);
    lines.push(`адрес файла: ${url || 'НЕ НАЙДЕН'}`);
    if (url) {
      try { const r = await fetch(url); lines.push(`загрузка файла: ${r.status} ${r.ok ? 'ок' : 'ошибка'}`); }
      catch (e) { lines.push('загрузка файла: сеть недоступна'); }
      const a = new Audio(url);
      a.playbackRate = st.speed || 1;
      try {
        await a.play();
        await new Promise(r => setTimeout(r, 600));
        lines.push(a.currentTime > 0 ? `воспроизведение: идёт (${a.currentTime.toFixed(1)} с)` : 'воспроизведение: не началось');
      } catch (e) { lines.push('воспроизведение: отказ — ' + e.name); }
    }
    const out = $('#s-check-out', bg) || el('<pre id="s-check-out"></pre>');
    out.textContent = lines.join('\n');
    $('.modal', bg).appendChild(out);
  };
  $('#s-close', bg).onclick = () => { bg.remove(); render(); };
  bg.onclick = (e) => { if (e.target === bg) { bg.remove(); render(); } };
  $('#s-copy', bg).onclick = () => {
    // Safari отдаёт буфер обмена только тому вызову, что начался прямо в обработчике
    // нажатия, а сжатие асинхронное. Поэтому буферу передаётся обещание, а не готовый
    // текст: разрешение удерживается, пока код собирается.
    const ready = progCode();
    ready.catch(() => {});                          // ошибку разбираем ниже, здесь глушим
    const done = (code) => toast(`Код скопирован (${codeSize(code)}) — вставьте его в Заметки`);
    const manual = () => ready.then(showCode, () => toast('Не удалось собрать код'));
    if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      const blob = ready.then(c => new Blob([c], { type: 'text/plain' }));
      navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })])
        .then(() => ready.then(done), manual);
    } else {
      ready.then(c => navigator.clipboard.writeText(c).then(() => done(c), manual), manual);
    }
  };
  $('#s-paste', bg).onclick = () => {
    const w = el(`<div class="modal-bg"><div class="modal">
      <h2>Восстановить из кода</h2>
      <p class="set-note">Вставьте сюда код, сохранённый раньше. Текущий прогресс будет заменён.</p>
      <textarea id="s-code-in" rows="6" placeholder="${CODE_TAG}1..."></textarea>
      <div style="display:flex;gap:9px;margin-top:14px">
        <button class="btn ghost sm" id="s-code-cancel">Отмена</button>
        <button class="btn primary sm" id="s-code-ok" style="margin-left:auto">Восстановить</button>
      </div>
    </div></div>`);
    $('#s-code-cancel', w).onclick = () => w.remove();
    w.onclick = (e) => { if (e.target === w) w.remove(); };
    $('#s-code-ok', w).onclick = async () => {
      try {
        const p = await fromCode($('#s-code-in', w).value);
        applyRestored(p);
        w.remove(); bg.remove(); render(); toast('Прогресс восстановлен');
      } catch (e) { toast('Код не распознан'); }
    };
    document.body.appendChild(w);
    $('#s-code-in', w).focus();
  };
  $('#s-export', bg).onclick = () => {
    const blob = new Blob([JSON.stringify(S.prog)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${L.key}-progress-${today()}.json`;
    a.click();
  };
  $('#s-import', bg).onclick = () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json';
    inp.onchange = () => {
      const fr = new FileReader();
      fr.onload = () => {
        try {
          applyRestored(JSON.parse(fr.result));
          bg.remove(); render(); toast('Прогресс загружен');
        } catch (e) { toast('Не удалось прочитать файл'); }
      };
      fr.readAsText(inp.files[0]);
    };
    inp.click();
  };
  $('#s-reset', bg).onclick = () => {
    if (!confirm('Удалить весь прогресс изучения? Это действие необратимо.')) return;
    S.prog = defaultProgress(); S.session = null; dropSession();
    saveProgress(); bg.remove(); render(); toast('Прогресс сброшен');
  };
  document.body.appendChild(bg);
}

/* ---------------- резервная копия прогресса ----------------
   Прогресс живёт в localStorage, а его iOS стирает вместе с веб-приложением,
   если убрать значок с экрана «Домой». Скачивание файла в standalone-режиме
   Safari игнорирует, поэтому копия отдаётся текстом: сжимаем JSON и кодируем
   в base64, чтобы код можно было просто скопировать в Заметки. */
const CODE_TAG = LS_KEY.slice(0, 2).toUpperCase();

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function unb64(str) {
  const bin = atob(str), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function progCode() {
  const json = JSON.stringify(S.prog);
  const raw = new TextEncoder().encode(json);
  if (!window.CompressionStream) return CODE_TAG + '0' + b64(raw);
  const packed = await new Response(
    new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  ).arrayBuffer();
  return CODE_TAG + '1' + b64(new Uint8Array(packed));
}

async function fromCode(code) {
  code = (code || '').replace(/\s+/g, '');
  const tag = code.slice(0, 2), ver = code[2], body = code.slice(3);
  if (tag !== CODE_TAG) throw new Error('код от другого приложения');
  let json;
  if (ver === '0') json = new TextDecoder().decode(unb64(body));
  else if (ver === '1') json = await new Response(
    new Blob([unb64(body)]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  ).text();
  else throw new Error('формат');
  return JSON.parse(json);
}

function applyRestored(p) {
  if (!p || typeof p !== 'object' || !p.w) throw new Error('формат');
  S.prog = p;
  S.prog.set = Object.assign(defaultProgress().set, p.set || {});
  S.prog.w = p.w || {}; S.prog.days = p.days || {}; S.prog.les = p.les || {};
  S.session = null;
  dropSession();
  saveProgress();
}

function codeSize(code) {
  return code.length < 1024 ? plural(code.length, 'символ', 'символа', 'символов')
                            : Math.round(code.length / 1024) + ' КБ';
}

/* показать код, когда буфер обмена недоступен */
function showCode(code) {
  const w = el(`<div class="modal-bg"><div class="modal">
    <h2>Код прогресса</h2>
    <p class="set-note">Скопируйте текст целиком и сохраните его, например в Заметках.</p>
    <textarea id="s-code-out" rows="6" readonly></textarea>
    <div style="display:flex;gap:9px;margin-top:14px">
      <button class="btn ghost sm" id="s-code-copy">${ico('clip')} Скопировать</button>
      <button class="btn primary sm" id="s-code-done" style="margin-left:auto">Готово</button>
    </div>
  </div></div>`);
  $('#s-code-out', w).value = code;
  $('#s-code-copy', w).onclick = () => {           // код уже собран — обычной записи хватает
    navigator.clipboard.writeText(code)
      .then(() => toast(`Код скопирован (${codeSize(code)})`),
            () => toast('Буфер обмена недоступен — выделите текст и скопируйте вручную'));
  };
  $('#s-code-done', w).onclick = () => w.remove();
  w.onclick = (e) => { if (e.target === w) w.remove(); };
  document.body.appendChild(w);
  const ta = $('#s-code-out', w);
  ta.focus(); ta.setSelectionRange(0, code.length);
}

/* ---------------- оформление ---------------- */
function themePref() { return localStorage.getItem(THEME_KEY) || 'system'; }
function applyTheme() {
  const pref = themePref();
  const dark = pref === 'dark' ||
    (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const btn = $('#theme-btn');
  if (btn) {
    btn.innerHTML = ico(dark ? 'sun' : 'moon');
    btn.title = pref === 'system' ? 'Тема: как в системе' : (dark ? 'Тёмная тема' : 'Светлая тема');
  }
  return dark;
}

/* ---------------- запуск ---------------- */
/* ---------------- фоновый узор ----------------
   Буквы родного письма мелкой сеткой — своя «монограмма» вместо однотонного
   фона. Общий код не знает, какое здесь письмо: буквы, шаг и кегль приходят
   из config.js, цвет — из темы. Слой лежит под содержимым и не прокручивается,
   поэтому узор виден только в промежутках между карточками. */
function paintWallpaper() {
  const p = L.pattern || {};
  const glyphs = String(p.glyphs || '').trim().split(/\s+/).filter(Boolean);
  let layer = document.getElementById('wallpaper');
  if (!glyphs.length) { if (layer) layer.remove(); return; }
  if (!layer) {
    layer = el('<div id="wallpaper" aria-hidden="true"></div>');
    document.body.insertBefore(layer, document.body.firstChild);
  }
  const step = p.step || 44;
  // слой шире экрана на клетку с каждой стороны, чтобы у краёв не было пустой полосы
  const cols = Math.ceil(window.innerWidth / step) + 2;
  const rows = Math.ceil(window.innerHeight / step) + 2;
  let html = '';
  for (let y = 0; y < rows; y++) {
    // каждый второй ряд сдвинут на половину шага: сетка читается ромбом,
    // а рядами буквы складывались бы в строку текста
    html += `<div class="wp-row"${y % 2 ? ` style="margin-left:${step / 2}px"` : ''}>`;
    for (let x = 0; x < cols; x++) {
      const ch = glyphs[(x + y * 3) % glyphs.length];
      const rev = p.flip && (x + y) % 2;
      html += `<span${rev ? ' class="rev"' : ''}>${esc(ch)}</span>`;
    }
    html += '</div>';
  }
  layer.className = L.script;
  layer.style.setProperty('--wp-step', step + 'px');
  layer.style.setProperty('--wp-size', (p.size || 21) + 'px');
  layer.innerHTML = html;
}

async function boot() {
  S.prog = loadProgress();
  applyTheme();
  paintWallpaper();
  // следим за переключением тёмной темы в системе, пока пользователь не выбрал явно
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', () => {
    if ((localStorage.getItem(THEME_KEY) || 'system') === 'system') { applyTheme(); render(); }
  });
  try {
    const [wd, al, ai, mn, ex, ls] = await Promise.all([
      fetch(L.data.words).then(r => r.json()),
      fetch(L.data.alphabet).then(r => r.json()),
      fetch(L.data.audio).then(r => r.json()).catch(() => ({})),
      fetch(L.data.mnemonics).then(r => r.json()).catch(() => ({})),
      // примеры употребления есть не у всех языков и не у всех слов — их отсутствие
      // не мешает приложению работать, блок просто не рисуется
      fetch(L.data.examples).then(r => r.json()).catch(() => ({})),
      // раздел грамматики есть не у всех языков; без него приложение работает как раньше
      L.lessons ? fetch(L.lessons).then(r => r.json()).catch(() => null) : Promise.resolve(null),
    ]);
    S.words = wd.words; S.cats = wd.categories; S.alphabet = al; S.audio = ai;
    S.mnemo = mn || {}; S.examples = ex || {}; S.lessons = ls;
    if (!Object.keys(S.audio).length) {
      setTimeout(() => toast('Озвучка не подгрузилась — обновите страницу (Cmd+Shift+R)'), 800);
    }
    for (const w of S.words) S.byId.set(w.id, w);
    S.trainable = S.words.filter(w => w.q);
    S.byCat = new Map();
    for (const w of S.trainable) for (const c of w.cats) {
      if (!S.byCat.has(c)) S.byCat.set(c, []);
      S.byCat.get(c).push(w);
    }
  } catch (e) {
    $('#main').innerHTML = `<div class="empty"><div class="ico">${ico('warn')}</div><h3>Не удалось загрузить словарь</h3>
      <p>${L.launcherHint}</p></div>`;
    return;
  }
  $$('.tab').forEach(b => b.onclick = () => go(b.dataset.go));
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input,select,textarea')) return;
    if (S.alphaQuiz && S.alphaKeys) S.alphaKeys(e);
    else if (S.session && S.session.keys) S.session.keys(e);
  });
  window.addEventListener('resize', () => {
    paintWallpaper();                               // сетка узора считается от размера экрана
    if (S.route === 'stats' || S.route === 'home') render();
  });
  go(S.prog.onboarded ? 'home' : 'welcome');
}
boot();
