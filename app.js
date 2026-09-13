/* Română — тренажёр румынского. Данные: data/*.json, озвучка: audio/<voice>/<hash>.mp3 */
'use strict';

const LS_KEY = 'romana_progress_v1';
const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1'];
// интервалы SRS: после 5-го верного ответа слово считается выученным
const STEPS = [10 * 60e3, 6 * 3600e3, 24 * 3600e3, 3 * 864e5, 7 * 864e5];
const MASTER_REPS_DEFAULT = 5;
const masterReps = () => (S.prog && S.prog.set.masterReps) || MASTER_REPS_DEFAULT;

const S = {
  words: [], byId: new Map(), cats: [], alphabet: [], audio: {},
  prog: null, route: 'home', session: null, audioEl: null,
};

/* ---------------- прогресс ---------------- */
const dateKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => dateKey(new Date());   // местная дата, а не UTC: занятия после полуночи — это новый день

function defaultProgress() {
  return {
    w: {},                       // id -> {s,r,d,lr,e}
    days: {},                    // 'YYYY-MM-DD' -> {rev,new,known}
    streak: 0, best: 0, lastActive: null, onboarded: false,
    set: {
      cats: ['greetings', 'phrases', 'numbers', 'pronouns', 'questions', 'verbs',
             'adjectives', 'family', 'food', 'time', 'adverbs'],
      levels: ['A1', 'A2', 'B1'],
      voice: 'f', autoplay: true, translit: true, refresh: true,
      speed: 1, invertSwipe: false, reviewScope: 'selected', masterReps: 5,
      autoNext: true,              // верный ответ уходит сам; при ошибке всегда ждём
      newPerDay: 12, reviewPerDay: 60,
      reviewMode: 'choose',        // choose — выбираешь способ сам; recall / choice / mix — фиксированные
    },
  };
}

function loadProgress() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      p.set = Object.assign(defaultProgress().set, p.set || {});
      p.w = p.w || {}; p.days = p.days || {};
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
  if (!S.prog.days[d]) S.prog.days[d] = { rev: 0, new: 0, known: 0, started: 0 };
  if (S.prog.days[d].started === undefined) S.prog.days[d].started = 0;
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
  return h ? `audio/${S.prog.set.voice}/${h}.mp3` : null;
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
      ? 'Браузер заблокировал звук: нажмите кнопку 🔊 ещё раз'
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
const catIcon = (id) => (S.cats.find(c => c.id === id) || { icon: '📖' }).icon;
const plural = (n, a, b, c) => { const m = n % 100, k = n % 10; return n + ' ' + (m > 10 && m < 20 ? c : k === 1 ? a : k > 1 && k < 5 ? b : c); };

function toast(msg) {
  $$('.toast').forEach(t => t.remove());
  const t = el(`<div class="toast">${esc(msg)}</div>`);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

/* ---------------- роутер ---------------- */
const ROUTES = {};
/* нижняя панель: три раздела, остальные экраны — вложенные в них */
const TAB_OF = {
  home: 'home', learn: 'home', review: 'home', mixed: 'home', browse: 'home',
  cats: 'home', welcome: 'home',
  dict: 'dict', dictcat: 'dict',
  menu: 'menu', alphabet: 'menu', stats: 'menu', about: 'menu',
};
function go(route) {
  S.route = route; S.session = null;
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
function subHead(title, back) {
  return `<div class="sub-head">
    <button class="back-link" data-back="${back || 'home'}">‹ Назад</button>
    <h1>${esc(title)}</h1></div>`;
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
        <span class="mi">⚙️</span>
        <span class="mt"><b>Настройки</b><i>Норма, режимы, голос и скорость речи, тема</i></span>
        <span class="ma">›</span></button>
      <button class="menu-row" data-go="stats">
        <span class="mi accent">📊</span>
        <span class="mt"><b>Подробная статистика</b>
          <i>Выучено ${c.mastered} · в процессе ${c.learning} · известно ${c.known}</i></span>
        <span class="ma">›</span></button>
      <button class="menu-row" data-go="alphabet">
        <span class="mi gold">🔤</span>
        <span class="mt"><b>Алфавит</b><i>31 буква с озвучкой и тренажёром</i></span>
        <span class="ma">›</span></button>
    </div>

    <div class="menu-card" style="margin-top:16px">
      <button class="menu-row" id="m-sound">
        <span class="mi">${S.prog.set.autoplay ? '🔊' : '🔇'}</span>
        <span class="mt"><b>Автоозвучка</b>
          <i>${S.prog.set.autoplay ? 'слово произносится при показе' : 'выключена, кнопка 🔊 работает'}</i></span>
        <span class="ma">${S.prog.set.autoplay ? 'вкл' : 'выкл'}</span></button>
      <button class="menu-row" data-go="about">
        <span class="mi">ℹ️</span>
        <span class="mt"><b>Источники и лицензии</b><i>Откуда словарь, частотность и озвучка</i></span>
        <span class="ma">›</span></button>
      <button class="menu-row" id="m-theme">
        <span class="mi">${document.documentElement.dataset.theme === 'dark' ? '🌙' : '☀️'}</span>
        <span class="mt"><b>Тема</b><i>${themePref() === 'system' ? 'как в системе' : themePref() === 'dark' ? 'тёмная' : 'светлая'}</i></span>
        <span class="ma">›</span></button>
    </div>

    <p class="sub" style="margin-top:20px;text-align:center">
      Словарь: ${S.words.length} лексем, ${S.trainable.length} в тренировках · озвучка Microsoft ro-RO
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
    localStorage.setItem('romana_theme', next);
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
      (румынские новости и Википедия).</p>

      <h2>Произношение</h2>
      <p class="sub" style="margin-bottom:14px">Озвучка — синтез Microsoft Neural, голоса ro-RO
      (Алина и Эмиль). Под каждым словом даётся русская транскрипция, собранная по правилам
      румынского чтения.</p>

      <h2>Проверка</h2>
      <p class="sub">Написание сверено с корпусами и Викисловарём, словоформы и узкие термины отсеяны.</p>
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
      <div style="font-size:46px">Română</div>
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
  /* Счётчик цели считается только по новым словам: сколько взято в изучение из дневной нормы.
     Повторения в процент не входят — их число диктует расписание, а не усердие, и «половина
     выполнена» на пустом месте только сбивала с толку. Они показаны отдельной строкой. */
  const donePct = goalNew ? Math.min(100, Math.round(t.started / goalNew * 100)) : 0;
  const hour = new Date().getHours();
  const hi = hour < 5 ? 'Доброй ночи' : hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер';

  // кружки текущей недели
  const mon = startOfWeek(new Date());
  const week = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((nm, i) => {
    const d = new Date(mon); d.setDate(d.getDate() + i);
    const key = dateKey(d), rec = S.prog.days[key];
    return { nm, key, active: !!(rec && (rec.rev || rec.started || rec.known)),
             today: key === today(), future: d > new Date() };
  });

  const box = el(`<div>
    <div class="page-head">
      <div><h1>${hi}!</h1>
        <p class="sub">${S.prog.streak > 0
          ? `🔥 Серия: ${plural(S.prog.streak, 'день', 'дня', 'дней')} подряд`
          : 'Начните серию — позанимайтесь сегодня'}</p></div>
      <div class="page-meta">В работе: <b>${plural(S.prog.set.cats.length, 'категория', 'категории', 'категорий')}</b>
        · уровни <b>${S.prog.set.levels.join(' ')}</b></div>
    </div>

    <div class="home-grid">
      <div>
        <h2 class="sect">Интервальное повторение</h2>
        <div class="menu-card">
          <button class="menu-row" data-go="cats">
            <span class="mi">🗂</span>
            <span class="mt"><b>Выбрано ${plural(S.prog.set.cats.length, 'категория', 'категории', 'категорий')}</b>
              <i>${poolWords().length} слов в работе · уровни ${S.prog.set.levels.join(' ')}</i></span>
            <span class="ma">›</span></button>
          <button class="menu-row" data-act="learn">
            <span class="mi accent">✨</span>
            <span class="mt"><b>Учить новые слова</b>
              <i>Взято сегодня: ${t.started} из ${goalNew}${c.fresh ? ` · доступно ${c.fresh}` : ''}</i></span>
            <span class="ma">${newLeftToday() || ''} ›</span></button>
          <button class="menu-row" data-act="review">
            <span class="mi gold">🔄</span>
            <span class="mt"><b>Повторить слова</b>
              <i>Слов для повторения: ${c.due}${t.rev ? ` · сегодня повторено ${t.rev}` : ''}</i></span>
            <span class="ma">${c.due || ''} ›</span></button>
          <button class="menu-row" data-act="mixed">
            <span class="mi green">💡</span>
            <span class="mt"><b>Смешанный режим</b>
              <i>Новые слова и повторение вперемешку</i></span>
            <span class="ma">›</span></button>
        </div>

        <h2 class="sect">Дополнительно <i>не влияет на статистику</i></h2>
        <div class="menu-card">
          <button class="menu-row" data-act="browse">
            <span class="mi">🔁</span>
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
              <div class="val" title="Половина цели — новые слова, половина — повторения на сегодня">
                <b class="num">${donePct}%</b><span>цель дня</span></div>
            </div>
            <div class="goal-list">
              <div class="goal-row"><span>Новых слов взято</span><b>${t.started} / ${goalNew}</b></div>
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
      <p class="cap">Взято новых, повторено уникальных и выучено полностью · листается вбок</p>
      <div class="chart-scroll"><canvas id="home-chart" height="158"></canvas></div>
      <div class="legend">
        <span><i class="dot" style="background:var(--gold)"></i>взято новых</span>
        <span><i class="dot" style="background:var(--accent)"></i>повторено</span>
        <span><i class="dot" style="background:var(--green)"></i>выучено полностью</span>
      </div>
    </div>
  </div>`);
  $$('[data-act]', box).forEach(b => b.onclick = () => { S.session = null; go(b.dataset.act); });
  $$('[data-go]', box).forEach(b => b.onclick = () => go(b.dataset.go));
  setTimeout(() => drawActivity($('#home-chart'), statsBuckets('day', 14)), 0);
  return box;
};

/* ---------------- шаг назад: снимок состояния и откат ---------------- */
function snapshot(w) {
  const t = today();
  return {
    id: w.id,
    prev: S.prog.w[w.id] ? JSON.parse(JSON.stringify(S.prog.w[w.id])) : null,
    day: JSON.parse(JSON.stringify(dayRec(t))),
    date: t,
    streak: S.prog.streak, lastActive: S.prog.lastActive,
  };
}
function restore(snap) {
  if (snap.prev) S.prog.w[snap.id] = snap.prev; else delete S.prog.w[snap.id];
  S.prog.days[snap.date] = snap.day;
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
  if (h.drillRemoved) s.toTrain.splice(h.drillRemoved.at, 0, h.drillRemoved.word);
  if (h.phase === 'drill' && s.pending && s.drill && s.drill[h.i]) s.pending.add(s.drill[h.i].id);
  if (h.right) s.right--;
  if (h.wrong) s.wrong--;
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

/* Ждём, пока договорит озвучка, и только потом листаем дальше — иначе слово
   обрывается на полуслове. Если звука нет, работает обычная короткая пауза. */
function afterAudio(cb, fallback) {
  const a = S.audioEl;
  if (!a || a.paused || a.ended) { setTimeout(cb, fallback || 650); return; }
  let fired = false;
  const fire = () => { if (fired) return; fired = true; setTimeout(cb, 260); };
  a.addEventListener('ended', fire, { once: true });
  setTimeout(fire, 4000);                    // страховка, если звук не доиграет
}

/* После ответа: при ошибке ждём, пока разберёшься, и даём выбрать — дальше
   или показать слово ещё раз в этой же сессии. */
function afterAnswer(box, card, ok, w, done) {
  const auto = S.prog.set.autoNext !== false;
  if (ok && auto) { afterAudio(() => done(false)); return; }
  const panel = el(`<div class="after-answer ${ok ? 'ok' : 'no'}">
    <button class="btn ghost" data-a="again">↺ Показать ещё раз</button>
    <button class="btn primary" data-a="next">Дальше →</button>
  </div>`);
  const go = (again) => { panel.remove(); done(again); };
  panel.querySelector('[data-a=next]').onclick = () => go(false);
  panel.querySelector('[data-a=again]').onclick = () => go(true);
  box.appendChild(panel);
  if (card) bindSwipe(card, {                       // смахивание в любую сторону — дальше
    rightLabel: 'дальше →', leftLabel: '← дальше',
    onRight: () => go(false), onLeft: () => go(false),
  });
  S.session.keys = (e) => {
    if (e.key === 'Enter' || e.code === 'Space' || /^[1-4]$/.test(e.key)) { e.preventDefault(); go(false); }
    else if (e.key === 'r') go(true);
  };
}

/* Наглядный счётчик: сколько верных ответов из пяти уже набрано */
function repDots(done) {
  return `<div class="reps" title="Слово считается выученным после ${masterReps()} верных ответов">
    ${Array.from({ length: masterReps() }, (_, i) =>
      `<i class="${i < done ? 'on' : ''}"></i>`).join('')}
    <span>${done} из ${masterReps()}</span></div>`;
}

/* ---------------- общие элементы тренировок ---------------- */
function wordCardHTML(w, opts = {}) {
  const tr = S.prog.set.translit ? `<div class="word-tr">${esc(w.tr)}</div>` : '';
  return `<div class="word-card">
    <span class="lvl">${w.lvl}</span>
    <span class="cat">${catIcon(w.cats[0])} ${esc(catName(w.cats[0]))}</span>
    <div class="word-ka ka">${opts.hideKa ? '•••' : esc(w.ka)}</div>
    ${opts.hideKa ? '' : tr}
    <button class="speak ${opts.bigSpeak ? 'lg' : ''}" title="Произношение (пробел)">🔊</button>
    ${opts.ru ? `<div class="word-ru">${esc(w.ru)}</div>` : ''}
  </div>`;
}
/* Ассоциация для запоминания: подсказка по созвучию. Необязательный слой —
   если для слова её нет, тренировка работает ровно как раньше. */
function mnemoHTML() {
  return `<div class="mnemo-wrap">
    <button class="btn ghost sm mnemo-btn">💡 Ассоциация</button>
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
      ? `💡 ${esc(text)}`
      : '<span style="color:var(--muted)">Для этого слова ассоциации пока нет — они добавляются постепенно.</span>';
    btn.disabled = true;
  };
}
function hasMnemo(w) { return !!(S.mnemo || {})[w.ka]; }

function bindSpeak(root, text) {
  const b = root.querySelector('.speak');
  if (b) b.onclick = () => speak(text);
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
function answerGrade(w, ok) {
  const p = Object.assign({}, wp(w.id));
  const t = today();
  if (p.lr !== t) { dayRec(t).rev++; p.lr = t; }
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
    const q = newQueue();
    if (!q.length) return emptyScreen('✨', 'Новых слов нет',
      'В выбранных категориях и уровнях всё уже пройдено. Добавьте категории или уровни — и новые слова появятся.',
      'Выбрать категории', () => go('cats'));
    const left = newLeftToday();
    if (left <= 0 && !S.extraNew) {
      return emptyScreen('🎯', 'Дневная норма выполнена',
        `Вы прошли ${plural(S.prog.set.newPerDay, 'новое слово', 'новых слова', 'новых слов')} за сегодня. ` +
        'Можно повторить пройденное или продолжить сверх нормы.',
        'Повторять', () => go('review'),
        'Учить сверх нормы', () => { S.extraNew = true; go('learn'); });
    }
    const perBatch = Math.min(S.prog.set.newPerDay, 20);   // за один заход — не больше 20 карточек подряд
    const size = Math.min(q.length, Math.max(1, S.extraNew ? perBatch : Math.min(left, perBatch)));
    S.session = { kind: 'learn', queue: q.slice(0, size), i: 0, toTrain: [], phase: 'intro' };
  }
  const s = S.session;
  if (s.phase === 'intro') return learnIntro();
  return learnDrill();
};

function learnIntro() {
  const s = S.session, w = s.queue[s.i];
  if (!w) {
    if (!s.toTrain.length) { S.session = null; return ROUTES.learn(); }
    s.phase = 'drill'; s.i = 0; s.drill = shuffle(s.toTrain.slice()); s.hist = [];
    return learnDrill();
  }
  return newWordCard(w, {
    progress: s.i / s.queue.length,
    title: `Новое слово ${s.i + 1} из ${s.queue.length}`,
    onPick: (a) => {
      const snap = snapshot(w);
      s.hist = s.hist || [];
      s.hist.push({ snap, i: s.i, phase: 'intro',
                    drillRemoved: a === 'learn' ? { at: s.toTrain.length, word: w } : null });
      applyNewWordChoice(w, a);
      if (a === 'learn') s.toTrain.push(w);
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
      <button class="speak" title="Произношение (пробел)">🔊</button>
      <div class="word-ru">${esc(w.ru)}</div>
      ${mnemoHTML()}
      <div class="grade-row">
        <button data-a="known"><b>Уже знаю</b><span>больше не показывать</span></button>
        <button data-a="learn"><b>Учить это слово</b><span>вернётся на повторение</span></button>
      </div>
    </div>
    <p class="hint">Смахните карточку: влево — уже знаю, <b>вправо — учить</b> ·
      <kbd>1</kbd> / <kbd>2</kbd> с клавиатуры · <kbd>пробел</kbd> — послушать</p>
  </div>`);
  bindSpeak(box, w.ka);
  bindMnemo(box, w);
  bindBack(box);
  if (S.prog.set.autoplay) setTimeout(() => speak(w.ka), 180);
  let used = false;
  const act = (a) => { if (used) return; used = true; o.onPick(a); };
  box.querySelector('[data-a=known]').onclick = () => act('known');
  box.querySelector('[data-a=learn]').onclick = () => act('learn');
  bindSwipe(box.querySelector('.word-card'), {
    rightLabel: '📚 Учить', leftLabel: '✓ Уже знаю',
    onRight: () => act('learn'), onLeft: () => act('known'),
  });
  S.session.keys = (e) => {
    if (e.key === '1') act('known');
    else if (e.key === '2') act('learn');
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
    return emptyScreen('🎉', 'Порция пройдена!',
      `Взято в изучение: ${plural(n, 'слово', 'слова', 'слов')}. Они вернутся на повторение по расписанию.`,
      'Следующая порция', () => { go('learn'); }, 'На главную', () => go('home'));
  }
  // чередуем направления: румынский → русский, затем русский → румынский
  const mode = s.i % 2 === 0 ? 'ka2ru' : 'ru2ka';
  const left = s.pending.size;
  return exerciseChoice(w, mode, {
    title: `Закрепление · осталось ${plural(left, 'слово', 'слова', 'слов')} · ` +
           `${mode === 'ka2ru' ? 'выберите перевод' : 'выберите слово по-румынски'}`,
    progress: (s.drill.length - left) / s.drill.length,
    onDone: (ok, again) => {
      s.hist = s.hist || [];
      s.hist.push({ snap: snapshot(w), i: s.i, phase: 'drill' });
      answerGrade(w, ok);
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
    const q = dueQueue().slice(0, S.prog.set.reviewPerDay);
    if (!q.length) {
      const c = counts();
      const nextDue = S.words.map(w => wp(w.id)).filter(p => p.s === 'learning' && p.d > Date.now())
        .sort((a, b) => a.d - b.d)[0];
      const when = nextDue ? formatIn(nextDue.d - Date.now()) : null;
      return emptyScreen('🔄', 'Повторять пока нечего',
        when ? `Ближайшее повторение через ${when}. Пока можно взять новые слова.`
             : 'Возьмите новые слова — и они появятся здесь на повторение.',
        c.fresh ? 'Учить новые слова' : 'К категориям', () => go(c.fresh ? 'learn' : 'cats'));
    }
    S.session = { kind: 'review', queue: shuffle(q), i: 0, right: 0, wrong: 0, total: q.length, method: null };
  }
  const s = S.session, w = s.queue[s.i];
  if (!w) {
    const { right, wrong, total } = s;
    S.session = null;
    return emptyScreen(right === total ? '🏆' : '✅', 'Повторение завершено',
      `Правильно: ${right} из ${total}${wrong ? ` · с ошибками: ${wrong}` : ''}`,
      'Ещё повторять', () => go('review'), 'На главную', () => go('home'));
  }
  const p = wp(w.id);
  const rep = p.r || 0;
  const opts = {
    title: s.i ? `Повторено ${plural(s.i, 'слово', 'слова', 'слов')} из ${s.total}`
               : `К повторению: ${plural(s.total, 'слово', 'слова', 'слов')}`,
    progress: s.i / s.total,
    backwards: rep % 2 === 1,            // чередуем: румынский→русский, затем русский→румынский
    reps: rep,
    onDone: (ok, again) => {
      s.hist = s.hist || [];
      s.hist.push({ snap: snapshot(w), i: s.i, right: ok, wrong: !ok });
      const res = answerGrade(w, ok);
      ok ? s.right++ : s.wrong++;
      if (res.s === 'mastered') toast(`🎓 «${w.ka}» выучено полностью!`);
      if (again) { s.queue.push(w); s.total++; }
      s.i++; render();
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
      return emptyScreen('🌿', 'На сегодня всё',
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
    S.session = { kind: 'mixed', queue, i: 0, right: 0, wrong: 0, total: queue.length, hist: [] };
  }
  const s = S.session, item = s.queue[s.i];
  if (!item) {
    const { right, wrong, total } = s;
    S.session = null;
    return emptyScreen('✅', 'Занятие завершено',
      `Пройдено карточек: ${total}${right + wrong ? ` · верных ответов: ${right} из ${right + wrong}` : ''}`,
      'Ещё', () => go('mixed'), 'На главную', () => go('home'));
  }
  const w = item.w;
  const head = { progress: s.i / s.total, title: `Карточка ${s.i + 1} из ${s.total}` };
  if (item.type === 'new') {
    return newWordCard(w, Object.assign({}, head, {
      onPick: (a) => {
        s.hist.push({ snap: snapshot(w), i: s.i });
        applyNewWordChoice(w, a);
        s.i++; render();
      },
    }));
  }
  const p = wp(w.id), rep = p.r || 0;
  return exerciseReview(w, Object.assign({}, head, {
    reps: rep, backwards: rep % 2 === 1, mastered: p.s === 'mastered',
    onDone: (ok, again) => {
      s.hist.push({ snap: snapshot(w), i: s.i, right: ok, wrong: !ok });
      const res = answerGrade(w, ok);
      ok ? s.right++ : s.wrong++;
      if (res.s === 'mastered') toast(`🎓 «${w.ka}» выучено полностью!`);
      if (again) { s.queue.push({ type: 'review', w }); s.total++; }
      s.i++; render();
    },
  }));
};

/* ---------------- пролистать слова (без влияния на прогресс) ---------------- */
ROUTES.browse = function () {
  if (!S.session || S.session.kind !== 'browse') {
    const pool = poolWords().filter(w => w.q);
    if (!pool.length) return emptyScreen('🗂', 'Нет слов для просмотра',
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
      <button class="speak lg" title="Произношение">🔊</button>
      <div class="word-ru">${esc(w.ru)}</div>
      ${mnemoHTML()}
    </div>
    <div class="answer-actions">
      <button class="btn ghost" data-a="prev">← Назад</button>
      <button class="btn primary" data-a="next">Дальше →</button>
    </div>
    <p class="hint">Режим просмотра: на статистику и прогресс не влияет · <kbd>пробел</kbd> — послушать</p>
  </div>`);
  bindSpeak(box, w.ka);
  bindMnemo(box, w);
  if (S.prog.set.autoplay) setTimeout(() => speak(w.ka), 180);
  const step = (d) => { s.i = Math.max(0, s.i + d); render(); };
  box.querySelector('[data-a=next]').onclick = () => step(1);
  box.querySelector('[data-a=prev]').onclick = () => step(-1);
  bindSwipe(box.querySelector('.word-card'), {
    rightLabel: '→ дальше', leftLabel: '← назад',
    onRight: () => step(1), onLeft: () => step(-1),
  });
  S.session.keys = (e) => {
    if (e.key === 'ArrowRight' || e.key === 'Enter') step(1);
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
         <button class="speak lg" title="Повторить">🔊</button></div>`
    : askKa
      ? `<div class="word-card"><span class="lvl">${w.lvl}</span>
           <span class="cat">${catIcon(w.cats[0])} ${esc(catName(w.cats[0]))}</span>
           <div class="word-ka" style="font-size:30px">${esc(w.ru)}</div>
           <div class="word-tr">выберите перевод на румынском</div></div>`
      : wordCardHTML(w, {});
  const box = el(`<div class="trainer">
    ${trainerHead(o)}
    ${promptHTML}
    <div class="options">${options.map((x, i) =>
      `<button class="opt ${askKa ? 'ka' : ''}" data-i="${i}">${i + 1}. ${esc(x[field])}</button>`).join('')}</div>
    <p class="hint"><kbd>1</kbd>–<kbd>4</kbd> ответ · <kbd>пробел</kbd> или 🔊 — послушать ещё раз</p>
  </div>`);
  bindSpeak(box, w.ka);
  if (S.prog.set.autoplay || mode === 'listen') setTimeout(() => speak(w.ka), 200);

  let answered = false;
  const answer = (idx) => {
    if (answered) return;
    answered = true;
    const ok = options[idx].id === w.id;
    $$('.opt', box).forEach((b, i) => {
      b.disabled = true;
      if (options[i].id === w.id) b.classList.add('right');
      else if (i === idx) b.classList.add('wrong');
    });
    if (!ok) {
      speak(w.ka);
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
    else if (e.code === 'Space') { e.preventDefault(); speak(w.ka); }
  };
  return box;
}

/* ---------------- упражнение: вспомнил / не вспомнил ---------------- */
function exerciseRecall(w, o) {
  const backwards = o.backwards;                       // true: показываем русский, вспоминаем румынский
  const front = backwards
    ? `<div class="word-ka" style="font-size:30px">${esc(w.ru)}</div>
       <div class="word-tr">вспомните слово по-румынски</div>`
    : `<div class="word-ka ka">${esc(w.ka)}</div>
       ${S.prog.set.translit ? `<div class="word-tr">${esc(w.tr)}</div>` : ''}`;
  const box = el(`<div class="trainer">
    ${trainerHead(o)}
    <div class="word-card">
      <span class="lvl">${w.lvl}</span>
      <span class="cat">${catIcon(w.cats[0])} ${esc(catName(w.cats[0]))}</span>
      ${front}
      <button class="speak lg" title="Произношение (пробел)">🔊</button>
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
      <button class="btn ghost" data-a="no" style="color:var(--clay);border-color:var(--clay)">✗ Не вспомнил</button>
      <button class="btn success" data-a="yes">✓ Вспомнил</button>
    </div>
    ${repDots(o.reps || 0)}
    <p class="hint" id="hint">Вспомните ${backwards ? 'слово' : 'перевод'} и нажмите <kbd>Enter</kbd> или «Показать ответ» · <kbd>пробел</kbd> — послушать</p>
  </div>`);
  const speakWord = () => speak(w.ka);
  box.querySelector('.speak').onclick = speakWord;
  if (S.prog.set.autoplay && !backwards) setTimeout(speakWord, 180);

  let shown = false, done = false;
  const show = () => {
    if (shown) return;
    shown = true;
    $('#answer', box).hidden = false;
    $('#stage-show', box).hidden = true;
    $('#stage-grade', box).hidden = false;
    const slot = $('#mnemo-slot', box);
    if (slot && hasMnemo(w)) { slot.hidden = false; bindMnemo(slot, w); }
    $('#hint', box).innerHTML = 'Смахните <b>вправо — вспомнил</b>, влево — не вспомнил · <kbd>1</kbd> / <kbd>2</kbd> с клавиатуры';
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
    if (e.code === 'Space') { e.preventDefault(); speakWord(); }
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
      <div class="word-tr">напишите по-румынски</div>
      <button class="speak lg" title="Произношение">🔊</button>
      <div class="typing">
        <input type="text" id="ans" autocomplete="off" autocorrect="off" autocapitalize="off"
               spellcheck="false" placeholder="напишите слово">
        <div class="typing-verdict" hidden></div>
      </div>
    </div>
    ${repDots(o.reps || 0)}
    <div class="answer-actions">
      <button class="btn ghost" data-a="skip">Не помню</button>
      <button class="btn primary" data-a="check">Проверить</button>
    </div>
    <p class="hint">Принимается и румынское написание, и латиница · <kbd>Enter</kbd> — проверить</p>
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
      ? `✓ Верно — <b class="ka">${esc(w.ka)}</b> <span>${esc(w.tr)}</span>`
      : `✗ Правильно так: <b class="ka">${esc(w.ka)}</b> <span>${esc(w.tr)}</span>` +
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
  const askKa = !backwards;                       // показываем румынское, вспоминаем перевод
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
      <button class="speak" title="Произношение (пробел)">🔊</button>
      <div class="reveal" id="reveal" hidden>
        <div class="word-ru ${askKa ? '' : 'ka'}">${esc(answer)}</div>
        ${!askKa && S.prog.set.translit ? `<div class="word-tr">${esc(w.tr)}</div>` : ''}
      </div>
      <div class="zone" id="zone" hidden></div>
      <div class="tools" id="tools">
        <button data-t="type" title="Написать слово">⌨︎</button>
        <button data-t="look" title="Посмотреть ответ">👁</button>
        <button data-t="pick" title="Выбрать из четырёх">▦</button>
      </div>
      ${repDots(o.reps || 0)}
      <div class="grade-row" id="grade">
        <button data-g="no"><b>Я не вспомнил</b><span>это слово</span></button>
        <button data-g="yes"><b>Я вспомнил</b><span>это слово</span></button>
      </div>
    </div>
    <p class="hint" id="hint">Смахните карточку: влево — не вспомнил, <b>вправо — вспомнил</b> ·
      <kbd>1</kbd> написать · <kbd>2</kbd> посмотреть · <kbd>3</kbd> выбрать</p>
  </div>`);
  bindSpeak(box, w.ka);
  if (S.prog.set.autoplay && askKa) setTimeout(() => speak(w.ka), 180);

  const zone = $('#zone', box), reveal = $('#reveal', box), tools = $('#tools', box);
  let done = false;
  const finish = (ok, delay) => {
    if (done) return;
    done = true;
    reveal.hidden = false;
    speak(w.ka);
    $$('#grade button, #tools button', box).forEach(b => b.disabled = true);
    const card = box.querySelector('.review-card');
    card.classList.add(ok ? 'said-yes' : 'said-no');
    afterAnswer(box, card, ok, w, (again) => o.onDone(ok, again));
  };

  const look = () => { reveal.hidden = false; speak(w.ka); tools.querySelector('[data-t=look]').classList.add('used'); };

  const typing = () => {
    if (zone.dataset.mode === 'type') return;
    zone.dataset.mode = 'type'; zone.hidden = false;
    zone.innerHTML = `<div class="typing">
      <input type="text" id="ans" autocomplete="off" autocorrect="off" autocapitalize="off"
             spellcheck="false" placeholder="${askKa ? 'перевод по-русски' : 'по-румынски'}">
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
      finish(ok, ok ? 900 : 2000);
    };
    $('#check', zone).onclick = check;
    input.onkeydown = (e) => { if (e.key === 'Enter') check(); };
    S.session.keys = () => {};
  };

  const picking = () => {
    if (zone.dataset.mode === 'pick') return;
    zone.dataset.mode = 'pick'; zone.hidden = false;
    const field = askKa ? 'ru' : 'ka';
    const options = shuffle([w, ...distractors(w, field, 3)]);
    zone.innerHTML = `<div class="options">${options.map((x, i) =>
      `<button class="opt ${field === 'ka' ? 'ka' : ''}" data-i="${i}">${esc(x[field])}</button>`).join('')}</div>`;
    $$('.opt', zone).forEach(b => b.onclick = () => {
      const ok = options[+b.dataset.i].id === w.id;
      $$('.opt', zone).forEach((x, i) => {
        x.disabled = true;
        if (options[i].id === w.id) x.classList.add('right');
        else if (x === b) x.classList.add('wrong');
      });
      finish(ok, ok ? 800 : 1800);
    });
  };

  $$('#tools button', box).forEach(b => b.onclick = () => {
    const t = b.dataset.t;
    if (t === 'look') look(); else if (t === 'type') typing(); else picking();
  });
  $('#grade', box).querySelector('[data-g=yes]').onclick = () => finish(true);
  $('#grade', box).querySelector('[data-g=no]').onclick = () => finish(false);
  bindSwipe(box.querySelector('.review-card'), {
    rightLabel: '✓ Вспомнил', leftLabel: '✗ Не вспомнил',
    onRight: () => finish(true, 700), onLeft: () => finish(false, 1500),
  });
  bindBack(box);
  S.session.keys = (e) => {
    if (e.key === '1') typing();
    else if (e.key === '2') look();
    else if (e.key === '3') picking();
    else if (e.key === 'Backspace') { e.preventDefault(); stepBack(); }
    else if (e.code === 'Space') { e.preventDefault(); speak(w.ka); }
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
      <button class="speak lg">🔊</button>
      <div class="slot ka" id="slot"></div>
      <div class="letters ka">${chars.map((c, i) => `<button data-c="${esc(c)}" data-i="${i}">${esc(c)}</button>`).join('')}</div>
    </div>
    <div class="answer-actions">
      <button class="btn ghost" data-a="back">← Стереть</button>
      <button class="btn ghost" data-a="skip">Не помню</button>
    </div>
  </div>`);
  bindSpeak(box, w.ka);
  if (S.prog.set.autoplay) setTimeout(() => speak(w.ka), 200);
  const slot = $('#slot', box);
  const finish = (ok) => {
    slot.classList.add(ok ? 'ok' : 'no');
    if (!ok) { slot.textContent = target; speak(w.ka); }
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
    if (e.code === 'Space') { e.preventDefault(); speak(w.ka); }
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
        <div class="top"><span class="ic">${c.icon}</span>
          <div class="cat-title"><div class="nm">${esc(c.name)}</div>
            <div class="cnt">${s.total} слов на выбранных уровнях</div></div>
          <span class="check">✓</span></div>
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
      <div class="wstatus">${label}${hasMnemo(w) ? ' · 💡' : ''}<span class="wlvl">${w.lvl}</span></div>
      <div class="wword ka">${esc(w.ka)}</div>
      ${S.prog.set.translit ? `<div class="wtr">${esc(w.tr)}</div>` : ''}
      <div class="wru">${esc(w.ru)}</div>
    </div>
    <button class="wplay" data-a="speak" title="Произношение">▶</button>
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
        ${hasMnemo(w) ? `<div class="mnemo">💡 ${esc(S.mnemo[w.ka])}</div>` : ''}
        <div class="wactions">
          <button class="btn ghost sm" data-a="learn">📚 Учить</button>
          <button class="btn ghost sm" data-a="known">✓ Уже знаю</button>
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
        <span class="ic">${r.c.icon}</span>
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
    ${subHead(`${cat.icon} ${cat.name}`, 'dict')}
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
    ${subHead('Румынский алфавит', 'menu')}
    <div class="page-head">
      <div><p class="sub">31 буква. Нажмите на карточку, чтобы услышать букву</p></div>
      <button class="btn primary" id="a-quiz">🎯 Тренировка букв</button>
    </div>
    <div class="card" style="margin-bottom:16px;font-size:13.5px;line-height:1.6;color:var(--muted)">
      Румынская орфография почти фонетическая: слова читаются так, как пишутся. Главное — запомнить
      пять особых букв: ă (нейтральное «э»), â и î (звук «ы»), ș («ш») и ț («ц»). Ещё c и g перед e и i
      читаются как «ч» и «дж», а ch и gh — как твёрдые «к» и «г».
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
  $('#a-quiz', box).onclick = () => { S.alphaQuiz = { i: 0, right: 0, total: 12, queue: pick(S.alphabet, 12) }; render(); };
  return box;
};

function alphabetQuiz() {
  const q = S.alphaQuiz, a = q.queue[q.i];
  if (!a) {
    const r = q.right, t = q.total; S.alphaQuiz = null;
    return emptyScreen(r === t ? '🏆' : '👍', 'Тренировка букв завершена', `Правильно: ${r} из ${t}`,
      'Ещё раз', () => { S.alphaQuiz = { i: 0, right: 0, total: 12, queue: pick(S.alphabet, 12) }; render(); },
      'К алфавиту', () => render());
  }
  const opts = shuffle([a, ...pick(S.alphabet.filter(x => x[0] !== a[0]), 3)]);
  const box = el(`<div class="trainer">
    <div class="progress-line"><i style="width:${q.i / q.total * 100}%"></i></div>
    <p class="sub" style="text-align:center;margin-bottom:14px">Буква ${q.i + 1} из ${q.total}</p>
    <div class="word-card">
      <div class="word-ka ka" style="font-size:64px">${a[0]}</div>
      <button class="speak lg">🔊</button>
      <div class="word-tr">какой это звук?</div>
    </div>
    <div class="options">${opts.map((o, i) => `<button class="opt" data-i="${i}">${i + 1}. <b>${esc(o[3])}</b> — ${esc(o[4])}</button>`).join('')}</div>
  </div>`);
  box.querySelector('.speak').onclick = () => speak(a[1]);
  setTimeout(() => speak(a[1]), 150);
  let done = false;
  const answer = (i) => {
    if (done) return; done = true;
    const ok = opts[i][0] === a[0];
    if (ok) q.right++;
    $$('.opt', box).forEach((b, j) => {
      b.disabled = true;
      if (opts[j][0] === a[0]) b.classList.add('right');
      else if (j === i) b.classList.add('wrong');
    });
    setTimeout(() => { q.i++; render(); }, ok ? 600 : 1500);
  };
  $$('.opt', box).forEach(b => b.onclick = () => answer(+b.dataset.i));
  S.alphaKeys = (e) => { if (/^[1-4]$/.test(e.key)) answer(+e.key - 1); };
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
    out.push({ date: d, ...(S.prog.days[d] || { rev: 0, new: 0, known: 0, started: 0 }) });
  }
  return out;
}

/* Агрегация дневных записей в периоды: день, неделя, месяц, год.
   Считает всю активность целиком — по всем категориям и уровням без исключения. */
function statsBuckets(scale, count) {
  const buckets = [], now = new Date();
  const push = (key, label, full) => buckets.push({ key, label, full, rev: 0, new: 0, known: 0, started: 0 });
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
    if (b) { b.rev += rec.rev || 0; b.new += rec.new || 0; b.known += rec.known || 0; b.started += rec.started || 0; }
  }
  return buckets;
}

/* всплывающая подсказка над графиком */
function chartTooltip(cv, zones, onHover) {
  const wrap = cv.parentElement;
  if (!wrap.classList.contains('chart-wrap')) wrap.classList.add('chart-wrap');
  let tip = wrap.querySelector('.chart-tip');
  if (!tip) { tip = el('<div class="chart-tip" hidden></div>'); wrap.appendChild(tip); }
  let last = null;
  cv.onmousemove = (e) => {
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left;
    const z = zones.find(z => x >= z.x0 && x <= z.x1);
    if (!z) { if (last !== null) { last = null; tip.hidden = true; onHover && onHover(null); } return; }
    tip.hidden = false;
    tip.innerHTML = z.html;
    const tw = tip.offsetWidth;
    tip.style.left = Math.max(2, Math.min(r.width - tw - 2, z.cx - tw / 2)) + 'px';
    tip.style.top = Math.max(18, z.top - 6) + 'px';
    if (last !== z.i) { last = z.i; onHover && onHover(z.i); }
  };
  cv.onmouseleave = () => { tip.hidden = true; last = null; onHover && onHover(null); };
  cv.style.cursor = 'crosshair';
}

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

function drawActivity(cv, buckets, hover) {
  if (!cv) return;
  const wrap = cv.parentElement;
  const MIN_GROUP = 46;                    // ширина группы столбцов, при которой всё читается
  if (wrap && wrap.classList.contains('chart-scroll')) {
    const need = buckets.length * MIN_GROUP + 44;
    cv.style.width = Math.max(wrap.clientWidth, need) + 'px';
  }
  const { c, w, h } = prepCanvas(cv, 158);
  const pad = { l: 34, r: 10, t: 20, b: 22 };
  const max = Math.max(4, ...buckets.map(d => Math.max(d.started, d.rev, d.new)));
  const bw = (w - pad.l - pad.r) / buckets.length;
  const ih = h - pad.t - pad.b;
  c.strokeStyle = css('--line'); c.lineWidth = 1;
  c.fillStyle = css('--muted'); c.font = '10px system-ui';
  for (let i = 0; i <= 3; i++) {                          // сетка и шкала слева
    const y = Math.round(pad.t + ih * i / 3) + .5;
    c.beginPath(); c.moveTo(pad.l, y); c.lineTo(w - pad.r, y); c.stroke();
    c.fillText(String(Math.round(max * (1 - i / 3))), 4, y + 3);
  }
  const zones = [];
  buckets.forEach((d, i) => {
    const x = pad.l + i * bw;
    if (hover === i) { c.fillStyle = css('--surface-2'); c.fillRect(x, pad.t, bw, ih); }
    const bar = (val, color, off, wd) => {
      const bh = ih * (val / max);
      c.fillStyle = color;
      c.beginPath(); c.roundRect(x + off, h - pad.b - bh, wd, Math.max(bh, val ? 2 : 0), 3); c.fill();
    };
    // три серии: взято новых, повторено, выучено полностью
    const gap = Math.min(bw * 0.1, 4);
    const barW = Math.max(2, (bw - gap * 4) / 3);
    bar(d.started, css('--gold'), gap, barW);
    bar(d.rev, css('--accent'), gap * 2 + barW, barW);
    bar(d.new, css('--green'), gap * 3 + barW * 2, barW);
    if (bw > 40) {                                   // подписи, когда столбцы не жмутся
      c.font = '9.5px system-ui'; c.textAlign = 'center';
      const label = (val, color, cx) => {
        if (!val) return;
        c.fillStyle = color;
        c.fillText(String(val), cx, h - pad.b - ih * (val / max) - 4);
      };
      label(d.started, css('--gold'), x + gap + barW / 2);
      label(d.rev, css('--accent'), x + gap * 2 + barW * 1.5);
      label(d.new, css('--green'), x + gap * 3 + barW * 2.5);
      c.textAlign = 'start';
    }
    zones.push({
      i, x0: x, x1: x + bw, cx: x + bw / 2,
      top: h - pad.b - ih * (Math.max(d.started, d.rev, d.new) / max),
      html: `<b>${d.full}</b>` +
            `<br><i style="background:${css('--gold')}"></i>взято новых: ${d.started}` +
            `<br><i style="background:${css('--accent')}"></i>повторено: ${d.rev}` +
            `<br><i style="background:${css('--green')}"></i>выучено полностью: ${d.new}` +
            (d.known ? `<br><i style="background:${css('--slate')}"></i>отмечено «знаю»: ${d.known}` : ''),
    });
  });
  axisLabels(c, buckets, pad, w, h, (i) => pad.l + i * bw + bw / 2);
  chartTooltip(cv, zones, (i) => { if (i !== hover) drawActivity(cv, buckets, i); });
  // при первой отрисовке показываем свежие дни — правый край
  if (hover == null && wrap && wrap.classList.contains('chart-scroll') && !wrap.dataset.scrolled) {
    wrap.scrollLeft = wrap.scrollWidth;
    wrap.dataset.scrolled = '1';
  }
}

function drawCumulative(cv, buckets, hover) {
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
  if (hover != null && pts[hover]) {
    const p = pts[hover];
    c.strokeStyle = css('--line-strong'); c.lineWidth = 1;
    c.beginPath(); c.moveTo(p.x, pad.t); c.lineTo(p.x, h - pad.b); c.stroke();
    c.fillStyle = css('--accent');
    c.beginPath(); c.arc(p.x, y(p.v), 4, 0, 7); c.fill();
    c.strokeStyle = css('--surface'); c.lineWidth = 2; c.stroke();
  }
  axisLabels(c, buckets, pad, w, h, xOf);
  const half = (pts.length > 1 ? (pts[1].x - pts[0].x) : 12) / 2;
  const zones = pts.map((p, i) => ({
    i, x0: p.x - half, x1: p.x + half, cx: p.x, top: y(p.v),
    html: `<b>${p.b.full}</b><br>всего выучено: ${p.v}` + (p.b.new ? `<br>за период: +${p.b.new}` : ''),
  }));
  chartTooltip(cv, zones, (i) => { if (i !== hover) drawCumulative(cv, buckets, i); });
}

/* ---------------- статистика ---------------- */
const SCALES = {
  '7':   ['7 дней',    'day',   7,  'за 7 дней'],
  '30':  ['30 дней',   'day',   30, 'за 30 дней'],
  '90':  ['90 дней',   'week',  13, 'за 90 дней'],
  'all': ['Всё время', 'month', 24, 'за всё время'],
};

ROUTES.stats = function () {
  const c = counts();
  const key = S.statsScale || '7';
  const [, scale, count, periodLabel] = SCALES[key];
  const buckets = statsBuckets(scale, count);
  const sum = (f) => buckets.reduce((s, b) => s + b[f], 0);
  const activeDays = Object.values(S.prog.days || {}).filter(d => d.rev || d.new || d.known).length;
  const totalStarted = c.learning + c.mastered;

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
      <div class="stat"><div class="n num">🔥 ${S.prog.streak}</div><div class="l">Серия дней · рекорд ${S.prog.best || 0}</div></div>
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
        ${legendRow('var(--gold)', 'Взято новых слов', totalStarted, sum('started'))}
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
          <div class="cp-row"><span class="nm">${r.cat.icon} ${esc(r.cat.name)}</span>
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
      ${row('Показывать транслитерацию', 'Русская транскрипция под румынским словом', `<span data-sw="translit">${sw(st.translit)}</span>`)}
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
      ${row('Сразу к следующему слову', 'При верном ответе идти дальше без нажатия. При ошибке приложение ждёт всегда',
        `<span data-sw="autoNext">${sw(st.autoNext !== false)}</span>`)}
    </div>

    <div class="set-sect">Произношение</div>
    <div class="set-group">
      ${row('Голос', 'Microsoft Neural, румынский (ro-RO)', `<select id="s-voice">
        <option value="f" ${st.voice === 'f' ? 'selected' : ''}>Алина (женский)</option>
        <option value="m" ${st.voice === 'm' ? 'selected' : ''}>Эмиль (мужской)</option></select>`)}
      ${row('Произносить автоматически', 'Слово озвучивается при показе карточки',
        `<span data-sw="autoplay">${sw(st.autoplay)}</span>`)}
      ${row('Скорость речи', '<span id="s-speed-val">' + (st.speed || 1).toFixed(1) + '</span>×',
        `<input type="range" id="s-speed" min="0.5" max="1.5" step="0.1" value="${st.speed || 1}">`)}
    </div>

    <div class="set-sect">Данные</div>
    <p class="set-note">Прогресс хранится только на этом устройстве. Если удалить значок с экрана
      «Домой», iOS сотрёт его вместе с приложением — поэтому время от времени сохраняйте копию.</p>
    <div style="display:flex;gap:9px;margin-top:10px;flex-wrap:wrap">
      <button class="btn ghost sm" id="s-copy">📋 Скопировать код</button>
      <button class="btn ghost sm" id="s-paste">📥 Восстановить из кода</button>
      <button class="btn ghost sm" id="s-export">⬇︎ Файлом</button>
      <button class="btn ghost sm" id="s-import">⬆︎ Из файла</button>
      <button class="btn ghost sm" id="s-check">🔎 Проверить звук</button>
      <button class="btn ghost sm" id="s-reset" style="color:var(--clay)">Сбросить всё</button>
    </div>
    <div style="display:flex;margin-top:18px">
      <button class="btn primary" id="s-close" style="margin-left:auto">Готово</button>
    </div>
  </div></div>`);

  $$('[data-sw]', bg).forEach(node => node.onclick = () => {
    const k = node.dataset.sw;
    const tri = (k === 'refresh' || k === 'autoNext');
    st[k] = tri ? !(st[k] !== false) : !st[k];
    node.firstElementChild.classList.toggle('on', tri ? st[k] !== false : !!st[k]);
    saveProgress();

  });
  $('#s-theme', bg).onchange = (e) => { localStorage.setItem('romana_theme', e.target.value); applyTheme(); };
  $('#s-voice', bg).onchange = (e) => { st.voice = e.target.value; saveProgress(); speak('bună ziua'); };
  $('#s-rmode', bg).onchange = (e) => { st.reviewMode = e.target.value; saveProgress(); S.session = null; };
  $('#s-scope', bg).onchange = (e) => { st.reviewScope = e.target.value; saveProgress(); S.session = null; };
  $('#s-mreps', bg).onchange = (e) => { st.masterReps = +e.target.value; saveProgress(); S.session = null; };
  $('#s-new', bg).onchange = (e) => {
    st.newPerDay = Math.max(1, Math.min(200, +e.target.value || 12));
    S.extraNew = false; S.session = null; saveProgress();
  };
  $('#s-rev', bg).onchange = (e) => { st.reviewPerDay = Math.max(5, +e.target.value || 60); saveProgress(); };
  const speed = $('#s-speed', bg);
  speed.oninput = (e) => { st.speed = +e.target.value; $('#s-speed-val', bg).textContent = st.speed.toFixed(1); };
  speed.onchange = () => { saveProgress(); speak('bună ziua'); };

  $('#s-check', bg).onclick = async () => {
    const word = 'bună ziua', lines = [];
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
  $('#s-copy', bg).onclick = async () => {
    let code;
    try { code = await progCode(); }
    catch (e) { toast('Не удалось собрать код'); return; }
    try {
      await navigator.clipboard.writeText(code);
      toast(`Код скопирован (${Math.round(code.length / 1024)} КБ) — вставьте его в Заметки`);
    } catch (e) {                                   // буфер недоступен — даём выделить руками
      showCode(code);
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
    a.download = `romana-progress-${today()}.json`;
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
    S.prog = defaultProgress(); saveProgress(); bg.remove(); render(); toast('Прогресс сброшен');
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
  S.prog.w = p.w || {}; S.prog.days = p.days || {};
  S.session = null;
  saveProgress();
}

/* показать код, когда буфер обмена недоступен */
function showCode(code) {
  const w = el(`<div class="modal-bg"><div class="modal">
    <h2>Код прогресса</h2>
    <p class="set-note">Скопируйте текст целиком и сохраните его, например в Заметках.</p>
    <textarea id="s-code-out" rows="6" readonly></textarea>
    <div style="display:flex;margin-top:14px">
      <button class="btn primary sm" id="s-code-done" style="margin-left:auto">Готово</button>
    </div>
  </div></div>`);
  $('#s-code-out', w).value = code;
  $('#s-code-done', w).onclick = () => w.remove();
  w.onclick = (e) => { if (e.target === w) w.remove(); };
  document.body.appendChild(w);
  const ta = $('#s-code-out', w);
  ta.focus(); ta.setSelectionRange(0, code.length);
}

/* ---------------- оформление ---------------- */
function themePref() { return localStorage.getItem('romana_theme') || 'system'; }
function applyTheme() {
  const pref = themePref();
  const dark = pref === 'dark' ||
    (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const btn = $('#theme-btn');
  if (btn) {
    btn.textContent = dark ? '☀️' : '🌙';
    btn.title = pref === 'system' ? 'Тема: как в системе' : (dark ? 'Тёмная тема' : 'Светлая тема');
  }
  return dark;
}

/* ---------------- запуск ---------------- */
async function boot() {
  S.prog = loadProgress();
  applyTheme();
  // следим за переключением тёмной темы в системе, пока пользователь не выбрал явно
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', () => {
    if ((localStorage.getItem('romana_theme') || 'system') === 'system') { applyTheme(); render(); }
  });
  try {
    const [wd, al, ai, mn] = await Promise.all([
      fetch('data/words-ro.json').then(r => r.json()),
      fetch('data/alphabet-ro.json').then(r => r.json()),
      fetch('data/audio_index.json').then(r => r.json()).catch(() => ({})),
      fetch('data/mnemonics-ro.json').then(r => r.json()).catch(() => ({})),
    ]);
    S.words = wd.words; S.cats = wd.categories; S.alphabet = al; S.audio = ai; S.mnemo = mn || {};
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
    $('#main').innerHTML = `<div class="empty"><div class="ico">⚠️</div><h3>Не удалось загрузить словарь</h3>
      <p>Откройте приложение через локальный сервер — ярлыком «Грузинский тренажёр» на Рабочем столе.</p></div>`;
    return;
  }
  $$('.tab').forEach(b => b.onclick = () => go(b.dataset.go));
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input,select,textarea')) return;
    if (S.alphaQuiz && S.alphaKeys) S.alphaKeys(e);
    else if (S.session && S.session.keys) S.session.keys(e);
  });
  window.addEventListener('resize', () => { if (S.route === 'stats' || S.route === 'home') render(); });
  go(S.prog.onboarded ? 'home' : 'welcome');
}
boot();
