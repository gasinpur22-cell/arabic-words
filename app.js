(() => {
  "use strict";

  const WORDS = window.WORDS || [];
  const PATTERNS = window.PATTERNS || [];
  const byId = Object.fromEntries(WORDS.map(w => [w.id, w]));
  const weeks = [...new Set(WORDS.map(w => w.week))].sort((a, b) => a - b);

  // Интервальные повторы: после изучения — через 2 дня, затем 5 (недельный зачёт),
  // 14 дней, 30 дней (месячный зачёт), 90 дней (зачёт за 3 месяца), дальше раз в полгода.
  // Ошибка откатывает слово на одну ступень назад, и оно приходит завтра.
  const INTERVALS = [2, 5, 14, 30, 90];
  const DONE = INTERVALS.length;
  const REVIEW_LIMIT = 15;
  // Зачёты: недельный, месячный (4 недели) и за 3 месяца (12 недель).
  // stage — до какой ступени зачёт поднимает верно названное слово.
  const TEST_KINDS = {
    week: { weeks: 1, size: Infinity, stage: 2, name: n => "неделя " + n },
    month: { weeks: 4, size: 20, stage: 3, name: n => "месяц " + n },
    quarter: { weeks: 12, size: 24, stage: 4, name: n => "3 месяца, часть " + n }
  };
  const KEY = "kalimat.v1";
  const app = document.getElementById("app");

  // ── Хранилище ──
  let store = load();
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (s && s.profiles) return s;
    } catch (e) {}
    return { profiles: {}, current: null };
  }
  function save() {
    if (me()) me().updated = Date.now();
    try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) {}
    push();
  }
  function push() {
    if (!db || !uid || !me()) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      db.collection("users").doc(uid).set(Object.assign({}, me(), { updated: me().updated || Date.now() })).catch(err => console.error(err));
    }, 600);
  }
  const me = () => store.profiles[store.current];

  // ── Аккаунты и общая таблица (Firebase). Без firebase-config.js сайт работает с локальными профилями. ──
  // Вход только по имени: прогресс лежит в документе users/<имя>, поэтому с тем же именем он откроется на любом телефоне.
  // Firebase грузится в фоне: сайт сразу рисуется из локальной копии и не ждёт серверов Google.
  const CLOUD = !!window.FIREBASE_CONFIG;
  let db = null, uid = null, syncTimer = null;
  let cloud = CLOUD ? "loading" : "off"; // loading | ready | failed | off
  const FB = "https://www.gstatic.com/firebasejs/10.12.2/";
  function loadScript(src) {
    return new Promise((ok, fail) => {
      const s = document.createElement("script");
      s.src = src; s.async = true; s.onload = ok; s.onerror = fail;
      document.head.appendChild(s);
    });
  }
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error("timeout")), ms))]);
  function connect() {
    if (!CLOUD) return;
    cloud = "loading";
    withTimeout(loadScript(FB + "firebase-app-compat.js").then(() => loadScript(FB + "firebase-firestore-compat.js")), 15000)
      .then(() => {
        if (!window.firebase) throw new Error("no firebase");
        if (!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
        db = firebase.firestore();
        // Офлайн-кеш базы: прогресс сохраняется без интернета, потом синхронизируется.
        db.enablePersistence({ synchronizeTabs: true }).catch(() => {});
        cloud = "ready";
        if (store.current) pull(store.current);
        if (screen === home) home();
      })
      .catch(() => { cloud = "failed"; if (screen === home) home(); });
  }
  const docKey = n => n.trim().toLowerCase().replace(/[\/.#$\[\]]/g, "_");
  // Берём из базы более свежую версию прогресса. Главную перерисовываем, остальные экраны не трогаем.
  function pull(n) {
    if (!db) return;
    uid = docKey(n);
    withTimeout(db.collection("users").doc(uid).get(), 10000).then(snap => {
      const local = store.profiles[n];
      if (snap.exists) {
        const d = snap.data();
        if (!local || (d.updated || 0) > (local.updated || 0)) {
          store.profiles[n] = { name: n, words: d.words || {}, tests: d.tests || [], days: d.days || [], stat: d.stat, updated: d.updated || 0 };
          try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) {}
          if (screen === home && store.current === n) home();
          return;
        }
      }
      push();
    }).catch(e => console.error(e));
  }
  function openProfile(n) {
    if (!store.profiles[n]) store.profiles[n] = { name: n, words: {}, tests: [], days: [], updated: 0 };
    store.current = n;
    try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) {}
    pull(n);
    home();
  }

  // ── Даты (номер дня по местному времени) ──
  function today() {
    const d = new Date();
    return Math.floor((d.getTime() - d.getTimezoneOffset() * 60000) / 864e5);
  }
  function fmtDay(n) {
    return new Date(n * 864e5).toLocaleDateString("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" });
  }
  function inDays(n) {
    const d = n - today();
    if (d <= 0) return "сегодня";
    if (d === 1) return "завтра";
    return fmtDay(n);
  }

  // ── Повторы ──
  function learn(id, stage) {
    me().words[id] = { stage, due: today() + (stage === 0 ? INTERVALS[0] : 0), learned: today(), lapses: 0 };
  }
  const gap = stage => stage >= DONE ? 180 : INTERVALS[stage];
  function grade(id, ok) {
    const s = me().words[id];
    if (!s) return learn(id, ok ? 1 : 0);
    if (ok) {
      // После ошибки слово сначала закрепляется на той ступени, куда откатилось.
      if (!s.lapse) s.stage = Math.min(s.stage + 1, DONE);
      s.due = today() + gap(s.stage);
      s.lapse = false;
    } else {
      s.stage = Math.max(s.stage - 1, 0);
      s.due = today() + 1;
      s.lapses = (s.lapses || 0) + 1;
      s.lapse = true;
    }
  }
  // Зачёт засчитывает повтор своей ступени. Пересдача не двигает слово вперёд раньше срока.
  function gradeTest(id, ok, stage) {
    const s = me().words[id];
    if (ok && (!s || s.stage < stage)) {
      me().words[id] = Object.assign(s || { learned: today(), lapses: 0 }, { stage, due: today() + gap(stage), lapse: false });
    } else if (!ok || s.due <= today()) grade(id, ok);
  }
  // Сначала забытые и самые просроченные.
  const dueIds = () => WORDS.filter(w => { const s = me().words[w.id]; return s && s.due <= today(); })
    .sort((a, b) => { const x = me().words[a.id], y = me().words[b.id]; return (y.lapse ? 1 : 0) - (x.lapse ? 1 : 0) || x.due - y.due; })
    .map(w => w.id);
  function nextDue() {
    const ds = Object.values(me().words).map(s => s.due).filter(d => d > today());
    return ds.length ? Math.min(...ds) : null;
  }

  // ── Утилиты ──
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const strip = s => s.replace(/[ً-ٰٟـ]/g, "");
  // Мягкое сравнение ответа: огласовки, точки и «؟» от голосового ввода, невидимые символы,
  // персидские ی и ک, разные алифы и артикль ال не считаются ошибкой.
  const norm = s => strip(s.normalize("NFKC"))
    .replace(/[یۍې]/g, "ي").replace(/[کڪ]/g, "ك").replace(/ە/g, "ه")
    .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه")
    .replace(/[^\u0621-\u064A]/g, "")
    .replace(/^ال(?=..)/, "");
  const dayKey = w => w.week + "-" + w.day;

  function distractors(id, n = 3) {
    const w = byId[id];
    const same = shuffle(WORDS.filter(x => x.id !== id && x.week === w.week));
    const rest = shuffle(WORDS.filter(x => x.id !== id && x.week !== w.week));
    return [...same, ...rest].slice(0, n);
  }


  // ── Экраны ──
  // Экран рисуется целиком. Анимация появления и прокрутка наверх — только при переходе на новый экран
  // или к новому заданию (key), а не при каждом нажатии, иначе экран дёргается.
  let screen = null; // функция открытого экрана: главную можно перерисовать, когда придут данные
  let viewKey = null;
  let acts = {}; // обработчики кнопок data-act текущего экрана
  let currentBack = () => home();
  function view(html, key, handlers) {
    const fresh = key !== viewKey;
    viewKey = key;
    acts = handlers || {};
    app.innerHTML = `<div class="scr${fresh ? " enter" : ""}">${html}</div>`;
    if (fresh) window.scrollTo(0, 0);
  }
  app.addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b || b.disabled) return;
    if (b.dataset.act && acts[b.dataset.act]) return acts[b.dataset.act](b);
    if (b.dataset.word) showWord(b.dataset.word, currentBack);
  });
  app.addEventListener("submit", e => {
    e.preventDefault();
    if (acts.submit) acts.submit(e.target);
  });

  const ICON = {
    back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    chev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>'
  };
  const backBtn = (act, label = "Назад") => `<button class="ibtn" data-act="${act}" aria-label="${label}">${act === "quit" ? ICON.close : ICON.back}</button>`;

  // ── Состояние слова ──
  // Три состояния: «новое» — урока ещё не было; «учу» — урок пройден, но слово не проверено временем
  // или недавно забылось; «знаю» — прошло два повтора в разные дни (ступень 2) или зачёт, без свежей ошибки.
  function status(id) {
    const s = me().words[id];
    if (!s) return "new";
    return s.stage >= 2 && !s.lapse ? "known" : "learn";
  }
  const ST_NAME = { new: "новое", learn: "учу", known: "знаю" };
  const stIcon = k => `<i class="st ${k}" aria-hidden="true">${k === "known" ? ICON.check : ""}</i>`;
  const chip = id => { const k = status(id); return `<span class="chip ${k}">${stIcon(k)}${ST_NAME[k]}</span>`; };
  const legend = () => `<div class="legend">${["new", "learn", "known"].map(k => `<span>${stIcon(k)}${ST_NAME[k]}</span>`).join("")}</div>`;

  // Тренировка — не повтор по расписанию: верный ответ засчитывается, только если слову и так пора,
  // а ошибка всегда возвращает слово в «учу».
  function practiceGrade(id, ok) {
    const s = me().words[id];
    if (s && (!ok || s.due <= today())) grade(id, ok);
  }
  function addStat(res) {
    const st = me().stat = me().stat || { n: 0, ok: 0 };
    st.n += res.length; st.ok += res.filter(r => r.ok).length;
  }

  // ── Дни и уроки ──
  // Одна группа — три слова одного дня недели. Новый урок открывается раз в календарный день.
  const groups = [];
  WORDS.forEach(w => { const k = dayKey(w); let g = groups.find(x => x.k === k); if (!g) groups.push(g = { k, week: w.week, day: w.day, ids: [] }); g.ids.push(w.id); });
  const groupDone = g => g.ids.every(id => me().words[id]);
  function todayGroup() {
    const learnedToday = groups.filter(g => groupDone(g) && g.ids.some(id => me().words[id].learned === today()));
    const fresh = groups.find(g => !groupDone(g));
    if (learnedToday.length) return { g: learnedToday[learnedToday.length - 1], done: true, next: fresh };
    if (fresh) return { g: fresh, done: false, next: fresh };
    return { g: groups[groups.length - 1], done: true, next: null };
  }

  // Зачёт показывается на главной только в свой день: когда все слова его недель пройдены, а сдачи ещё не было.
  function pendingTest() {
    const tests = me().tests || [];
    const ready = wks => wks.every(wk => weeks.includes(wk)) && WORDS.filter(w => wks.includes(w.week)).every(w => me().words[w.id]);
    for (const kind of ["quarter", "month", "week"]) {
      for (let n = 1; n * TEST_KINDS[kind].weeks <= (weeks[weeks.length - 1] || 0); n++) {
        if (ready(testWeeks(kind, n)) && bestScore(tests, kind, n) < 0) return { kind, n };
      }
    }
    return null;
  }
  const TEST_TITLE = { week: n => "Сегодня зачёт недели " + n, month: () => "Сегодня месячный зачёт", quarter: () => "Сегодня зачёт за 3 месяца" };
  function testSub(kind, n) {
    const k = testIds(kind, n).length;
    if (kind === "week") return `${plural(k, "слово", "слова", "слов")} вперемешку, около ${Math.max(2, Math.round(k / 4))} минут.`;
    const ws = testWeeks(kind, n);
    return `${plural(k, "слово", "слова", "слов")} из недель ${ws[0]}–${ws[ws.length - 1]}, около ${Math.max(2, Math.round(k / 4))} минут.`;
  }

  // ── Главная ──
  let selDay = null; // какой день недели открыт в плитках (сбрасывается при уходе с главной)
  function home() {
    currentBack = home;
    screen = home;
    if (!store.current || !me()) {
      view(`<div class="hdr"><div><span class="lbl">калимат</span><h1>Ахлян!</h1></div></div>`, "empty");
      if (!document.querySelector(".modal")) profileModal(true);
      return;
    }
    const tg = todayGroup(), wk = tg.g.week;
    const weekGroups = groups.filter(g => g.week === wk);
    if (!selDay || !weekGroups.some(g => g.day === selDay)) selDay = tg.g.day;
    const sel = weekGroups.find(g => g.day === selDay);
    const isToday = sel === tg.g;
    const locked = !groupDone(sel) && !isToday;
    const due = dueIds(), nRev = Math.min(due.length, REVIEW_LIMIT);
    const test = pendingTest();
    const name = store.current.trim();

    const days = weekGroups.map(g => {
      const d = groupDone(g), cls = ["day", d ? "done" : "", g === tg.g ? "today" : "", g === sel ? "sel" : ""].join(" ");
      return `<button class="${cls}" data-act="day" data-d="${g.day}" aria-label="День ${g.day}${d ? ", пройден" : ""}" aria-pressed="${g === sel}"><i>${d ? ICON.check : g.day}</i></button>`;
    }).join("");

    let hero = "";
    if (test) hero = `<section class="tile hero grad">
        <span class="lbl">${test.kind === "week" ? "Неделя пройдена" : test.kind === "month" ? "Прошло 4 недели" : "Прошло 12 недель"}</span>
        <h2>${TEST_TITLE[test.kind](test.n)}</h2>
        <span class="muted">${testSub(test.kind, test.n)}</span>
        <button class="btn inv press" data-act="test">Сдать зачёт</button>
      </section>`;
    else if (tg.done) hero = `<section class="tile hero">
        <span class="lbl">Сегодня</span>
        <h2>${tg.next ? "Слова дня выучены" : "Все слова пройдены"}</h2>
        <span class="muted">${tg.next ? "Новые три слова откроются завтра." : "Новые слова появятся, когда их добавят в словарь."}${nRev ? "" : nextDue() ? " Следующий повтор: " + inDays(nextDue()) + "." : ""}</span>
      </section>`;

    const tiles = sel.ids.map(id => {
      const w = byId[id];
      return locked
        ? `<button class="tile wtile locked" disabled><span class="ru"><b>откроется в день ${sel.day}</b></span><span class="ar" aria-hidden="true">${w.ar}</span></button>`
        : `<button class="tile wtile press" data-word="${id}"><span class="ru"><b>${esc(w.ru)}</b>${chip(id)}</span><span class="ar">${w.ar}</span></button>`;
    }).join("");
    const showTiles = !(test && tg.done);

    const mins = Math.max(1, Math.ceil(nRev / 3) + 2);
    let main;
    if (!tg.done) main = `<div class="row2 wide"><button class="btn press" data-act="go">${nRev ? "Повтор и урок" : "Начать урок"} · ${mins} мин</button><button class="btn ghost press" data-act="study">Заучивание</button></div>`;
    else if (nRev) main = `<div class="row2 wide"><button class="btn press" data-act="review">Повторить · ${plural(nRev, "слово", "слова", "слов")}</button><button class="btn ghost press" data-act="study">Заучивание</button></div>`;
    else main = `<button class="btn ${test ? "ghost" : ""} press" data-act="study">Заучивание</button>`;

    const rows = (gs, lockFrom) => gs.map(g => `<div class="wrow"><span class="dn">${g.day}</span>${g.ids.map(id => {
      const k = status(id);
      return lockFrom && g !== tg.g && !groupDone(g)
        ? `<button disabled aria-label="Ещё закрыто"><span>${byId[id].ar}</span></button>`
        : `<button class="${k}" data-word="${id}" aria-label="${esc(byId[id].ru)}, ${ST_NAME[k]}">${stIcon(k)}<span>${byId[id].ar}</span></button>`;
    }).join("")}</div>`).join("");
    const known = ids => ids.filter(id => status(id) === "known").length;
    const wIds = weekGroups.flatMap(g => g.ids);
    const older = weeks.filter(x => x !== wk).reverse().map(x => {
      const gs = groups.filter(g => g.week === x), ids = gs.flatMap(g => g.ids), key = "w" + x;
      return `<section class="tile weekrows" style="padding-block:4px">
        <button class="fold" data-act="fold" data-key="${key}" aria-expanded="${!!ui.open[key]}"><b>Неделя ${x}</b><span class="muted small" style="margin-left:auto">знаю ${known(ids)} из ${ids.length}</span>${ICON.chev}</button>
        ${ui.open[key] ? rows(gs, false) : ""}
      </section>`;
    }).join("");

    view(`
      <div class="hdr">
        <div style="min-width:0"><span class="lbl">Неделя ${wk} · день ${tg.g.day}</span><h1>Салам, ${esc(name)}</h1></div>
        <button class="ibtn av press" data-act="profile" aria-label="Профиль и общая таблица">${esc(name.charAt(0).toUpperCase())}</button>
      </div>
      ${cloud === "failed" ? `<p class="note">Нет связи с базой: прогресс сохраняется на телефоне и уйдёт в базу, когда появится интернет. <button class="link" data-act="retry">Повторить</button></p>` : ""}
      <div class="days">${days}</div>
      ${hero}
      ${showTiles ? `<div class="secthead"><b>${isToday ? "Слова дня" : "День " + sel.day}</b><span class="muted small">${locked ? "ещё закрыто" : isToday && !tg.done ? "3 новых" : ""}</span></div>
      <div class="words">${tiles}</div>` : ""}
      ${main}
      <div class="secthead" style="margin-top:4px"><b>Неделя ${wk}</b><span class="muted small">знаю ${known(wIds)} из ${wIds.length}</span></div>
      ${legend()}
      <section class="tile weekrows">${rows(weekGroups, true)}</section>
      ${wIds.some(id => !me().words[id]) ? `<button class="link" data-act="markweek">Я уже знаю слова этой недели</button>` : ""}
      ${older}
    `, "home", {
      day: b => { selDay = +b.dataset.d; home(); },
      go: () => due.length ? startReview(tg.g.k) : lesson(tg.g.k),
      review: () => startReview(null),
      study: studySetup,
      test: () => testIntro(test.kind, test.n),
      profile: profileScreen,
      retry: connect,
      fold: b => { const k = b.dataset.key; ui.open[k] = !ui.open[k]; saveUi(); home(); },
      markweek: () => {
        if (!confirm(`Отметить все слова недели ${wk} как знакомые? Они сразу пойдут в повторение, отменить это нельзя.`)) return;
        WORDS.filter(w => w.week === wk && !me().words[w.id]).forEach(w => { learn(w.id, 1); me().words[w.id].due = today() + 1; });
        save(); home();
      }
    });
  }

  // ── Карточка слова ──
  const rich = t => esc(t).replace(/[؀-ۿ](?:[؀-ۿ\s–-]*[؀-ۿ])?/g, m => `<bdi class="ar">${m}</bdi>`);
  const pairsHtml = list => list.map(p => `<div class="pair"><span class="ar">${p[0]}</span><span>${esc(p[1])}</span></div>`).join("");
  function ayahHtml(q) {
    const ws = q.ar.split(" ");
    const mark = (a, at) => a.map((x, i) => i === at ? `<mark>${x}</mark>` : x).join(" ");
    const from = Math.max(0, q.hl - 3), to = Math.min(ws.length, q.hl + 4);
    const frag = (from > 0 ? "… " : "") + mark(ws.slice(from, to), q.hl - from) + (to < ws.length ? " …" : "");
    return `<details class="ayah"><summary><span class="ar">${frag}</span><span class="ref">${esc(q.ref)} · <b class="more">весь аят</b><b class="less">свернуть</b></span></summary>
      <p class="ar full">${mark(ws, q.hl)}</p><p>${esc(q.ru)}</p></details>`;
  }
  function details(w) {
    const sec = (t, body) => `<section class="tile sec"><span class="lbl">${t}</span>${body}</section>`;
    const quran = w.quran || [];
    return [
      sec("Корень", `<div class="roots">${w.root.map(l => `<span>${l}</span>`).join("")}</div><p class="center">${esc(w.rootMeaning)}</p>`),
      sec("Как запомнить", [].concat(w.assoc).map(a => `<p>${rich(a)}</p>`).join("")),
      sec("Словосочетания", pairsHtml(w.phrases)),
      sec("Как образовано", `<p>${rich(w.pattern)}</p>`),
      w.plural ? sec("Множественное число", `<p class="ar plural">${w.plural}</p>`) : "",
      w.related && w.related.length ? sec("Однокоренные слова", pairsHtml(w.related)) : "",
      w.examples && w.examples.length ? sec("Примеры из жизни", w.examples.map(p => `<div class="ex"><p class="ar">${p[0]}</p><p class="muted">${esc(p[1])}</p></div>`).join("")) : "",
      w.facts && w.facts.length ? sec("Интересно", `<ul class="facts">${w.facts.map(f => `<li>${rich(f)}</li>`).join("")}</ul>`) : "",
      quran.length || w.qnote ? sec("В Коране", quran.map(ayahHtml).join("") + (w.qnote ? `<p class="muted small">${rich(w.qnote)}</p>` : "")) : ""
    ].join("");
  }
  const photo = w => w.photo && w.photo.src
    ? `<img src="${esc(w.photo.src)}" alt="${esc(w.ru)}" decoding="async">${w.photo.credit ? `<span class="cap">Фото: ${esc(w.photo.credit)}</span>` : ""}` : "";

  function showWord(id, back) {
    const w = byId[id]; if (!w) return;
    screen = showWord;
    back = back || home;
    // Листать можно по словам, которые уже открыты: пройденные и слова сегодняшнего урока.
    const tg = todayGroup();
    const ids = WORDS.filter(x => me().words[x.id] || tg.g.ids.includes(x.id)).map(x => x.id);
    const i = ids.indexOf(id);
    view(`
      <div class="top">${backBtn("back")}${chip(id)}<span class="count">нед. ${w.week} · день ${w.day}</span></div>
      <article class="tile wcard">${photo(w)}<div class="whead"><span class="ar">${w.ar}</span><span class="tr">${esc(w.ru)}</span></div></article>
      ${details(w)}
      ${ids.length > 1 && i >= 0 ? `<div class="row2">
        <button class="btn ghost press" data-act="prev" ${i > 0 ? "" : "disabled"}>← Предыдущее</button>
        <button class="btn ghost press" data-act="next" ${i < ids.length - 1 ? "" : "disabled"}>Следующее →</button>
      </div>` : ""}
    `, "word:" + id, {
      back: () => back(),
      prev: () => showWord(ids[i - 1], back),
      next: () => showWord(ids[i + 1], back)
    });
  }

  // ── Урок дня: слово закрыто, нажатие открывает перевод и всю карточку ──
  function lesson(k) {
    const ids = groups.find(g => g.k === k).ids;
    let li = 0, open = false;
    const draw = () => {
      screen = lesson;
      const w = byId[ids[li]];
      currentBack = draw;
      view(`
        <div class="top">${backBtn("quit", "Закрыть урок")}<div class="prog"><i style="width:${(li + (open ? 1 : 0)) / ids.length * 100}%"></i></div><span class="count">${li + 1}/${ids.length}</span></div>
        <article class="tile wcard">
          ${open ? photo(w) : ""}
          <button class="reveal" data-act="reveal" ${open ? "disabled" : ""} aria-expanded="${open}">
            <span class="whead${open ? "" : " closed"}">
              <span class="ar">${w.ar}</span>
              ${open ? `<span class="tr tr-show">${esc(w.ru)}</span>` : `<span class="tr hidden-tr" aria-hidden="true">${"•".repeat(Math.min(10, w.ru.length))}</span><span class="ask">Вспомни перевод и нажми</span>`}
            </span>
          </button>
        </article>
        ${open ? details(w) : `<div class="grow"></div>`}
        ${open ? `<button class="btn press" data-act="next">${li < ids.length - 1 ? "Следующее слово" : "Готово"}</button>` : ""}
      `, "lesson:" + k + ":" + li, {
        quit: home,
        reveal: () => { open = true; draw(); },
        next: () => {
          if (li < ids.length - 1) { li++; open = false; return draw(); }
          ids.forEach(id => { if (!me().words[id]) learn(id, 0); });
          markDay(); save();
          lessonDone(ids);
        }
      });
    };
    draw();
  }
  function lessonDone(ids) {
    screen = lessonDone;
    currentBack = () => lessonDone(ids);
    view(`
      <div class="donebox" id="donebox">
        <div class="medal">${ICON.check}</div>
        <h2>${ids.length} ${plural(ids.length, "слово", "слова", "слов").replace(/^\d+ /, "")} в «Учу»</h2>
        <div class="learned-row">${ids.map(id => `<span class="ar">${byId[id].ar}</span>`).join("")}</div>
        <p class="muted" style="max-width:290px">Закрепи их сейчас: короткая тренировка займёт около минуты. Первый повтор через 2 дня.</p>
      </div>
      <div class="row2"><button class="btn ghost press" data-act="home">На главную</button><button class="btn press" data-act="drill">Закрепить</button></div>
    `, "lessondone", { home, drill: () => startPractice(ids) });
    sparks();
  }

  // ── Заучивание ──
  // Тренировка всегда смешанная: пары на разогрев, потом на каждое слово одно задание «узнать»
  // (выбор перевода, выбор слова, вставить в предложение) и одно «вспомнить» (карточка, собрать из букв,
  // написать перевод). Слова «учу» получают третье задание. Секунды на задание подобраны так,
  // чтобы вся неделя (21 слово) шла не дольше 10 минут.
  const SEC = { match: 20, ar2ru: 7, ru2ar: 7, cloze: 9, flip: 8, build: 12, type: 10 };
  const chunk = (a, n) => a.reduce((r, x, i) => (i % n ? r[r.length - 1].push(x) : r.push([x]), r), []);
  const recog = id => ({ type: pick(["ar2ru", "ru2ar", "cloze"]), id });
  const recall = id => ({ type: pick(["flip", "build", "type"]), id });
  function practicePlan(ids) {
    const pairs = ids.length >= 3 ? chunk(shuffle(ids), 5).filter(g => g.length >= 3).map(g => ({ type: "match", ids: g })) : [];
    const extra = ids.filter(id => status(id) === "learn").map(id => pick([recog, recall])(id));
    return [...pairs, ...shuffle(ids.map(recog)), ...shuffle(ids.map(recall)), ...shuffle(extra)];
  }
  const minutes = tasks => Math.max(1, Math.round(tasks.reduce((s, t) => s + SEC[t.type], 0) / 60));
  let studyScope = "today";
  function studySetup() {
    screen = studySetup;
    currentBack = studySetup;
    const tg = todayGroup(), wk = tg.g.week;
    const opened = WORDS.filter(w => me().words[w.id]).map(w => w.id);
    const scopes = [
      ["today", "Слова дня", tg.done ? "три слова сегодняшнего урока" : "сначала пройди урок дня", tg.done ? tg.g.ids : []],
      ["learn", "Только «учу»", "слова, которые ещё не закрепились", opened.filter(id => status(id) === "learn")],
      ["week", "Вся неделя", "все пройденные слова недели " + wk, opened.filter(id => byId[id].week === wk)]
    ];
    if (!scopes.find(s => s[0] === studyScope)[3].length) studyScope = (scopes.find(s => s[3].length) || scopes[0])[0];
    const cur = scopes.find(s => s[0] === studyScope)[3];
    view(`
      <div class="top">${backBtn("back")}<b>Заучивание</b><span style="width:44px"></span></div>
      <div class="opts">${scopes.map(([k, t, d, ids]) => `<button class="tile opt press" data-act="scope" data-k="${k}" aria-pressed="${studyScope === k}" ${ids.length ? "" : "disabled"}>
        <span class="rd"></span><span><b>${t}</b><small>${d}</small></span>
        <span class="n">${plural(ids.length, "слово", "слова", "слов")}${ids.length ? `<small>≈ ${minutes(practicePlan(ids))} мин</small>` : ""}</span></button>`).join("")}</div>
      <div class="grow"></div>
      <button class="btn press" data-act="go" ${cur.length ? "" : "disabled"}>Начать</button>
    `, "study", {
      back: home,
      scope: b => { studyScope = b.dataset.k; studySetup(); },
      go: () => startPractice(cur)
    });
  }
  function startPractice(ids) {
    runSession({
      title: "Заучивание", tasks: practicePlan(ids), back: studySetup,
      finish: res => {
        const agg = aggregate(res);
        Object.entries(agg).forEach(([id, ok]) => practiceGrade(id, ok));
        addStat(res); markDay(); save();
        resultScreen({ title: "Заучивание", res, note: Object.values(agg).some(ok => !ok) ? "Слова с ошибками теперь в «Учу»." : "" });
      }
    });
  }

  // ── Повторение по расписанию ──
  // nextK — урок дня: после повторения сразу предложим перейти к нему.
  function startReview(nextK) {
    const ids = shuffle(dueIds().slice(0, REVIEW_LIMIT));
    const tasks = ids.map(id => me().words[id].stage < 2 ? pick([recog, () => ({ type: "flip", id })])(id) : recall(id));
    runSession({
      title: "Повторение", tasks, back: home,
      finish: res => {
        const agg = aggregate(res);
        Object.entries(agg).forEach(([id, ok]) => grade(id, ok));
        addStat(res); markDay(); save();
        const left = dueIds().length;
        resultScreen({ title: "Повторение", res,
          note: "Слова с ошибками вернутся завтра." + (left ? " Ещё " + plural(left, "слово ждёт", "слова ждут", "слов ждут") + " повтора." : ""),
          next: nextK ? { label: "Дальше: урок дня", fn: () => lesson(nextK) } : null });
      }
    });
  }

  // ── Зачёт ──
  // Каждое слово один раз: две трети заданий «вспомни сам», треть — узнавание, в конце пары.
  function testIds(kind, n) {
    const wks = testWeeks(kind, n);
    const ids = WORDS.filter(w => wks.includes(w.week)).map(w => w.id);
    const size = TEST_KINDS[kind].size;
    if (ids.length <= size) return ids;
    // В большой зачёт сначала попадают слова, которые забывались, остальные — случайно.
    const weak = shuffle(ids).sort((a, b) => ((me().words[b] || {}).lapses || 0) - ((me().words[a] || {}).lapses || 0));
    return weak.slice(0, size);
  }
  function testIntro(kind, n) {
    screen = testIntro;
    const k = testIds(kind, n).length, name = TEST_KINDS[kind].name(n);
    view(`
      <div class="top">${backBtn("back")}<span></span></div>
      <div class="donebox">
        <span class="lbl">Зачёт · ${esc(name)}</span>
        <div class="medal">${k}</div>
        <h2>${plural(k, "слово", "слова", "слов")} вперемешку</h2>
        <p class="muted" style="max-width:300px">Выбор ответа, предложения, сборка слова и перевод своими словами. Верные слова сразу становятся «знаю». Результат попадёт в профиль и общую таблицу.</p>
      </div>
      <button class="btn press" data-act="go">Начать зачёт</button>
    `, "testintro", { back: home, go: () => startTest(kind, n) });
  }
  function startTest(kind, n) {
    const ids = shuffle(testIds(kind, n));
    const tasks = ids.map((id, i) => i % 3 === 2 ? recog(id) : { type: pick(["ru2ar", "build", "type"]), id });
    if (ids.length >= 4) tasks.push({ type: "match", ids: shuffle(ids).slice(0, 5) });
    const spec = TEST_KINDS[kind];
    const title = "Зачёт, " + spec.name(n);
    runSession({
      title, tasks, back: home, test: true,
      finish: res => {
        const agg = aggregate(res);
        Object.entries(agg).forEach(([id, ok]) => gradeTest(id, ok, spec.stage));
        const correct = res.filter(r => r.ok).length;
        const mistakes = Object.keys(agg).filter(id => !agg[id]);
        const t = { kind, n, date: today(), correct, total: res.length, mistakes };
        if (kind === "week") t.week = n;
        me().tests = me().tests || [];
        me().tests.push(t);
        addStat(res); markDay(); save();
        resultScreen({ title, res, test: t,
          note: `Следующий повтор этих слов через ${spec.stage === 2 ? "2 недели" : spec.stage === 3 ? "месяц" : "3 месяца"}. Слова с ошибками вернутся завтра. Пересдать можно из профиля.` });
      }
    });
  }

  function aggregate(res) {
    const agg = {};
    res.forEach(r => { agg[r.id] = (agg[r.id] !== undefined ? agg[r.id] : true) && r.ok; });
    return agg;
  }

  // ── Движок упражнений ──
  // В оценку идёт первая попытка по каждому заданию. Верный ответ сам переходит дальше,
  // после ошибки показываем правильный ответ и кнопку «Дальше».
  let sessionNo = 0;
  const KIND = { match: "Соедини пары", ar2ru: "Выбери перевод", ru2ar: "Выбери слово", cloze: "Вставь слово", flip: "Вспомни", build: "Собери слово", type: "Напиши перевод" };
  const ruNorm = s => s.toLowerCase().replace(/ё/g, "е").replace(/\([^)]*\)/g, "").replace(/[^а-яa-z\s-]/g, "").replace(/\s+/g, " ").trim();
  function lev(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }
  // Перевод засчитывается, если совпал с любым из вариантов; в длинных словах прощаем одну опечатку.
  const ruOk = (typed, w) => { const v = ruNorm(typed); return !!v && w.ru.split(/[,;]/).map(ruNorm).some(x => x === v || (x.length >= 5 && lev(x, v) <= 1)); };

  function runSession({ title, tasks, finish, back, test }) {
    if (!tasks.length) return home();
    const sid = ++sessionNo;
    let i = 0;
    const res = [];
    tasks.forEach(t => { t.d = pick(["ar", "ru"]); });
    const advance = () => { i++; if (i >= tasks.length) finish(res); else draw(); };
    const record = (t, ok) => { res.push({ id: t.id, ok }); };
    function draw() {
      screen = runSession;
      const t = tasks[i];
      currentBack = draw;
      const body = TASKS[t.type].html(t);
      const fb = t.fb === "no" && t.type !== "match" ? wrongBox(t) : "";
      view(`
        <div class="top">${backBtn("quit", "Выйти")}<div class="prog"><i style="width:${i / tasks.length * 100}%"></i></div><span class="count">${i + 1}/${tasks.length}</span></div>
        <span class="lbl kind">${test ? esc(title) + " · " : ""}${KIND[t.type]}</span>
        ${body}${fb}
      `, "run:" + sid + ":" + i, Object.assign({
        quit: () => { if (i === 0 || confirm("Выйти? Ответы этого занятия не сохранятся.")) back(); },
        cont: advance
      }, TASKS[t.type].acts(t, (ok, auto) => {
        record(t, ok);
        if (auto === false) advance();
        else if (ok) { t.fb = "ok"; draw(); setTimeout(() => { if (tasks[i] === t) advance(); }, 650); }
        else { t.fb = "no"; if (navigator.vibrate) { try { navigator.vibrate(60); } catch (e) {} } draw(); }
      }, draw, ids => ids.forEach(x => res.push(x)))));
      const inp = app.querySelector("#tin");
      if (inp && !t.fb && !matchMedia("(pointer: coarse)").matches) inp.focus({ preventScroll: true });
    }
    draw();
  }
  // В заданиях с вариантами верный ответ уже подсвечен зелёным, повторять его не нужно: так «Дальше» помещается на экран.
  function wrongBox(t) {
    const w = byId[t.id];
    const cont = `<button class="btn press" data-act="cont">Дальше</button>`;
    if (["ar2ru", "ru2ar", "cloze"].includes(t.type)) return cont;
    const answer = t.type === "cloze"
      ? `<span class="ar">${w.cloze.ar.replace("___", w.ar)}</span><span>${esc(w.cloze.ru)}</span>`
      : `<span><span class="ar">${w.ar}</span> · ${esc(w.ru)}</span>`;
    return `<div class="fb no"><b>Правильный ответ</b>${answer}</div>${cont}`;
  }

  // Каждое задание: html(t) рисует, acts(t, done, redraw, push) даёт обработчики кнопок.
  // done(ok) — первая и единственная оценка задания; done(ok, false) — без паузы на «Верно».
  const optsFor = t => t.opts || (t.opts = shuffle([byId[t.id], ...distractors(t.id)]));
  const markOpt = (t, o) => t.ans ? (o.id === t.id ? " right" : o.id === t.ans ? " wrong" : "") : "";
  const choiceActs = (t, done) => ({ ans: b => { if (t.ans) return; t.ans = b.dataset.o; done(t.ans === t.id); } });
  const TASKS = {
    ar2ru: {
      html: t => `<div class="tile q"><span class="ar qa">${byId[t.id].ar}</span></div>
        <div class="choices">${optsFor(t).map(o => `<button class="tile choice press${markOpt(t, o)}" data-act="ans" data-o="${o.id}" ${t.ans ? "disabled" : ""}>${esc(o.ru)}</button>`).join("")}</div>`,
      acts: choiceActs
    },
    ru2ar: {
      html: t => `<div class="tile q"><span class="qr">${esc(byId[t.id].ru)}</span></div>
        <div class="choices grid">${optsFor(t).map(o => `<button class="tile choice press${markOpt(t, o)}" data-act="ans" data-o="${o.id}" ${t.ans ? "disabled" : ""}><span class="ar">${o.ar}</span></button>`).join("")}</div>`,
      acts: choiceActs
    },
    cloze: {
      html: t => {
        const w = byId[t.id];
        const sent = w.cloze.ar.replace("___", `<span class="gap">${t.ans ? w.ar : "؟"}</span>`);
        return `<div class="tile q"><p class="ar sent">${sent}</p><span class="muted small">${esc(w.cloze.ru)}</span></div>
          <div class="choices grid">${optsFor(t).map(o => `<button class="tile choice press${markOpt(t, o)}" data-act="ans" data-o="${o.id}" ${t.ans ? "disabled" : ""}><span class="ar">${o.ar}</span></button>`).join("")}</div>`;
      },
      acts: choiceActs
    },
    flip: {
      html: t => {
        const w = byId[t.id], ph = w.phrases && w.phrases[0];
        const front = t.d === "ar" ? `<span class="ar qa">${w.ar}</span><span class="muted small">как переводится?</span>` : `<span class="qr">${esc(w.ru)}</span><span class="muted small">как будет по-арабски?</span>`;
        const backSide = `<span class="ar a-ar">${w.ar}</span><span class="a-ru">${esc(w.ru)}</span>${ph ? `<span class="extra"><bdi class="ar">${ph[0]}</bdi> · ${esc(ph[1])}</span>` : ""}`;
        return `<button class="tile q big press${t.flipped ? " flipped" : ""}" data-act="flip" ${t.flipped ? "disabled" : ""}>${t.flipped ? backSide : front + `<span class="ask" style="margin-top:22px">вспомни и нажми</span>`}</button>
          <div class="grow"></div>
          ${t.flipped ? `<div class="row2"><button class="btn ghost press" data-act="no">Не вспомнил</button><button class="btn press" data-act="yes">Вспомнил</button></div>` : ""}`;
      },
      acts: (t, done, redraw) => ({ flip: () => { t.flipped = true; redraw(); }, yes: () => done(true, false), no: () => done(false, false) })
    },
    build: {
      html: t => {
        const w = byId[t.id], target = Array.from(strip(w.ar));
        if (!t.tiles) {
          const extra = shuffle(Array.from(new Set(distractors(t.id, 4).flatMap(x => Array.from(strip(x.ar))))).filter(l => !target.includes(l))).slice(0, 2);
          t.tiles = shuffle(target.concat(extra)); t.got = [];
        }
        const built = t.got.map(k => t.tiles[k]).join("");
        const res = t.fb === "ok" ? " right" : t.fb === "no" ? " wrong" : "";
        return `<div class="tile q"><span class="qr">${esc(w.ru)}</span><span class="muted small">собери слово по-арабски</span></div>
          <div class="slot${built ? "" : " empty"}${res}" aria-live="polite">${built || "нажимай буквы по порядку"}</div>
          ${t.fb ? "" : `<div class="letters">${t.tiles.map((c, k) => `<button class="tile press${t.got.includes(k) ? " used" : ""}" data-act="let" data-k="${k}" >${c}</button>`).join("")}</div>
          <div class="row2"><button class="btn ghost press" data-act="erase" ${t.got.length ? "" : "disabled"}>Стереть</button><button class="btn press" data-act="check" ${t.got.length ? "" : "disabled"}>Проверить</button></div>`}`;
      },
      acts: (t, done, redraw) => ({
        let: b => { t.got.push(+b.dataset.k); redraw(); },
        erase: () => { t.got.pop(); redraw(); },
        check: () => done(norm(t.got.map(k => t.tiles[k]).join("")) === norm(byId[t.id].ar))
      })
    },
    type: {
      html: t => {
        const w = byId[t.id], res = t.fb === "ok" ? " right" : t.fb === "no" ? " wrong" : "";
        return `<div class="tile q"><span class="ar qa">${w.ar}</span><span class="muted small">напиши перевод по-русски</span></div>
          <form class="tform" autocomplete="off">
            <label for="tin" class="lbl" style="padding:0 4px">Перевод</label>
            <input id="tin" class="field${res}" value="${esc(t.val || "")}" ${t.fb ? "disabled" : ""} autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="done">
            ${t.fb ? "" : `<div class="row2"><button class="btn ghost press" type="button" data-act="idk">Не знаю</button><button class="btn press" type="submit">Проверить</button></div>`}
          </form>`;
      },
      acts: (t, done) => ({
        submit: f => { const v = f.querySelector("#tin").value; if (!v.trim() || t.fb) return; t.val = v; done(ruOk(v, byId[t.id])); },
        idk: () => { t.val = ""; done(false); }
      })
    },
    // Пары: соединяешь все, номер связи виден на обеих плитках, нажатие на пару её разъединяет.
    // Проверка только когда соединено всё: верные зелёным, неверные красным.
    match: {
      html: t => {
        if (!t.cols) { t.cols = { ar: shuffle(t.ids), ru: shuffle(t.ids) }; t.links = {}; t.sel = null; }
        const order = Object.keys(t.links);
        const ruOf = ar => order.find(k => t.links[k] === ar);
        const tile = (side, id) => {
          const ru = side === "ru" ? (id in t.links ? id : null) : ruOf(id), n = ru ? order.indexOf(ru) + 1 : 0;
          const res = t.checked ? ((side === "ru" ? t.links[id] === id : ruOf(id) === id) ? " right" : " wrong") : "";
          const cls = ["tile", "mt", "press", side === "ar" ? "ar" : "", n ? "linked" : "", t.sel && t.sel.side === side && t.sel.id === id ? "pick" : ""].join(" ") + res;
          return `<button class="${cls}" data-act="m" data-side="${side}" data-id="${id}" ${t.checked ? "disabled" : ""}>${n && !t.checked ? `<span class="tag">${n}</span>` : ""}${side === "ar" ? byId[id].ar : esc(byId[id].ru)}</button>`;
        };
        // После проверки плитки встают верными парами: зелёные ты соединил правильно, красные — нет.
        const cells = t.checked
          ? t.ids.map(id => tile("ru", id).replace(/ (right|wrong)"/, t.links[id] === id ? ' right"' : ' wrong"') + tile("ar", id).replace(/ (right|wrong)"/, t.links[id] === id ? ' right"' : ' wrong"')).join("")
          : t.cols.ru.map((id, k) => tile("ru", id) + tile("ar", t.cols.ar[k])).join("");
        const bad = t.checked ? t.ids.filter(id => t.links[id] !== id) : [];
        return `<div class="match">${cells}</div>
          ${t.checked ? `<p class="small center ${bad.length ? "bad-ink" : "good-ink"}"><b>${bad.length ? "Ошибок: " + bad.length + ". Вот верные пары" : "Все пары верные"}</b></p>
            <button class="btn press" data-act="cont">Дальше</button>`
          : `<p class="muted small center">${order.length} из ${t.ids.length} соединено. Нажми на пару ещё раз, чтобы разъединить</p>`}`;
      },
      acts: (t, done, redraw, push) => ({
        m: b => {
          const side = b.dataset.side, id = b.dataset.id;
          const linkedRu = side === "ru" ? (id in t.links ? id : null) : Object.keys(t.links).find(k => t.links[k] === id);
          if (linkedRu && !t.sel) delete t.links[linkedRu];
          else if (!t.sel || t.sel.side === side) t.sel = t.sel && t.sel.id === id ? null : { side, id };
          else {
            const ru = side === "ru" ? id : t.sel.id, ar = side === "ar" ? id : t.sel.id;
            Object.keys(t.links).forEach(k => { if (k === ru || t.links[k] === ar) delete t.links[k]; });
            t.links[ru] = ar; t.sel = null;
            if (Object.keys(t.links).length === t.ids.length) {
              t.checked = true;
              push(t.ids.map(x => ({ id: x, ok: t.links[x] === x })));
            }
          }
          redraw();
        }
      })
    }
  };

  // ── Результат ──
  function resultScreen({ title, res, note, test, next }) {
    screen = resultScreen;
    const correct = res.filter(r => r.ok).length, p = pct(correct, res.length);
    const agg = aggregate(res), bad = Object.keys(agg).filter(id => !agg[id]);
    currentBack = () => resultScreen({ title, res, note, test, next });
    const head = test ? (p >= 80 ? "Зачёт сдан" : "Зачёт сдан, есть что подтянуть") : p === 100 ? "Без единой ошибки" : p >= 70 ? "Хорошо получилось" : "Надо повторить";
    view(`
      <div class="donebox" id="donebox">
        <span class="lbl">${esc(title)}</span>
        <div class="medal">${p}%</div>
        <h2>${head}</h2>
        <p class="muted">${correct} из ${res.length} верно${note ? ". " + esc(note) : ""}</p>
        ${bad.length ? `<div class="tile misses">${bad.map(id => `<button class="pair" data-word="${id}"><span class="ar">${byId[id].ar}</span><span>${esc(byId[id].ru)}</span></button>`).join("")}</div>` : ""}
      </div>
      ${next ? `<button class="btn press" data-act="next">${esc(next.label)}</button>` : ""}
      ${bad.length ? `<div class="row2"><button class="btn ghost press" data-act="home">На главную</button><button class="btn ${next ? "ghost " : ""}press" data-act="fix">Повторить ошибки</button></div>`
        : `<button class="btn ${next ? "ghost " : ""}press" data-act="home">На главную</button>`}
      ${test ? `<button class="btn ghost press" data-act="share">${navigator.share ? "Поделиться результатом" : "Скопировать результат"}</button>` : ""}
    `, "result:" + sessionNo, {
      home,
      next: () => next.fn(),
      fix: () => startPractice(bad),
      share: b => {
        const txt = shareText(test);
        if (navigator.share) { navigator.share({ text: txt }).catch(() => {}); return; }
        (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(
          () => { b.textContent = "Скопировано"; }, () => { b.textContent = "Не получилось скопировать"; });
      }
    });
    if (p >= 80) sparks();
  }
  function shareText(t) {
    const miss = t.mistakes.map(id => byId[id].ar + " (" + byId[id].ru + ")").join(", ");
    return `${store.current} · Зачёт, ${testName(t)}: ${t.correct}/${t.total} (${pct(t.correct, t.total)}%)` + (miss ? `\nОшибки: ${miss}` : "\nБез ошибок!");
  }
  function sparks() {
    const box = document.getElementById("donebox");
    if (!box || (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches)) return;
    for (let k = 0; k < 18; k++) {
      const s = document.createElement("i"), a = k / 18 * Math.PI * 2, r = 90 + Math.random() * 70;
      s.className = "spark";
      s.style.cssText = `left:50%;top:30%;--dx:${Math.cos(a) * r}px;--dy:${Math.sin(a) * r}px;animation-delay:${Math.random() * .15}s`;
      box.appendChild(s);
    }
  }

  // ── Профиль: коротко о прогрессе, зачёты и общая таблица ──
  const streakOf = days => {
    const d = new Set(days || []);
    let n = today(); if (!d.has(n)) n--;
    let k = 0; while (d.has(n)) { k++; n--; }
    return k;
  };
  function profileScreen() {
    screen = profileScreen;
    currentBack = profileScreen;
    const name = store.current.trim(), tg = todayGroup();
    const open = WORDS.filter(w => w.week <= tg.g.week).map(w => w.id);
    const known = open.filter(id => status(id) === "known").length;
    const learning = open.filter(id => status(id) === "learn").length;
    const st = me().stat, tests = me().tests || [];
    const acc = st && st.n ? pct(st.ok, st.n) : tests.length ? pct(tests.reduce((s, t) => s + t.correct, 0), tests.reduce((s, t) => s + t.total, 0)) : null;
    const last = tests.length ? pct(tests[tests.length - 1].correct, tests[tests.length - 1].total) : null;
    const taken = [];
    tests.forEach(t => { const k = testKind(t) + ":" + testNum(t); if (!taken.includes(k)) taken.push(k); });
    const C = 2 * Math.PI * 42, part = open.length ? known / open.length : 0, s = streak();
    view(`
      <div class="top">${backBtn("back")}<b>Профиль</b><span style="width:44px"></span></div>
      <section class="tile me">
        <div class="ring"><svg width="96" height="96" viewBox="0 0 96 96" aria-hidden="true"><defs><linearGradient id="rg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F0B144"/><stop offset="1" stop-color="#E0703F"/></linearGradient></defs>
          <circle cx="48" cy="48" r="42" fill="none" stroke="var(--soft)" stroke-width="9"/>
          <circle cx="48" cy="48" r="42" fill="none" stroke="url(#rg)" stroke-width="9" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - part)}"/></svg>
          <b>${known}<small>знаю из ${open.length}</small></b></div>
        <div class="who"><b>${esc(name)}</b><span class="muted small">Неделя ${tg.g.week} · день ${tg.g.day}</span>${learning ? `<span class="chip learn">${stIcon("learn")}${learning} в «учу»</span>` : ""}</div>
      </section>
      <div class="stats">
        <div class="tile stat"><b>${s}</b><span>${plural(s, "день", "дня", "дней").replace(/^\d+ /, "")} подряд</span></div>
        <div class="tile stat"><b>${acc != null ? acc + "%" : "—"}</b><span>точность</span></div>
        <div class="tile stat"><b>${last != null ? last + "%" : "—"}</b><span>последний зачёт</span></div>
      </div>
      ${taken.length ? `<div class="tchips">${taken.map(k => { const [kind, n] = k.split(":"); return `<button data-act="retake" data-k="${k}" aria-label="Пересдать: ${esc(TEST_KINDS[kind].name(+n))}">${esc(TEST_KINDS[kind].name(+n))} · ${bestScore(tests, kind, +n)}%</button>`; }).join("")}</div>` : ""}
      ${CLOUD ? `<section class="tile sec"><div class="secthead" style="padding:0"><b>Общая таблица</b></div><div id="board"><p class="muted small">Загружаю…</p></div></section>` : ""}
      <section class="tile menu">
        <button data-act="theme"><span>Тема</span><span>${isDark() ? "тёмная" : "светлая"}</span></button>
        <button data-act="hacks"><span>Лайфхаки: закономерности</span><span>→</span></button>
        <button data-act="switch"><span>Сменить профиль</span><span>${esc(name)}</span></button>
        ${CLOUD ? "" : `<button data-act="backup"><span>Резервная копия</span><span>→</span></button>`}
      </section>
    `, "profile", {
      back: home,
      retake: b => { const [kind, n] = b.dataset.k.split(":"); testIntro(kind, +n); },
      theme: () => { toggleTheme(); profileScreen(); },
      hacks,
      switch: () => profileModal(false),
      backup: backupModal
    });
    loadBoard();
  }

  // На телефоне помещаются четыре столбца: имя, слов, серия и последний недельный зачёт.
  function loadBoard() {
    const el = document.getElementById("board");
    if (!el || !CLOUD) return;
    if (!db) { el.innerHTML = `<p class="muted small">${cloud === "failed" ? "Нет связи с базой. Таблица появится, когда будет интернет." : "Загружаю…"}</p>`; return; }
    db.collection("users").get().then(snap => {
      if (!document.body.contains(el)) return;
      // Свою строку берём из памяти: запись в базу уходит с небольшой задержкой.
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(r => r.id !== uid);
      if (me()) rows.push({ id: uid, ...me() });
      const wk = weeks[weeks.length - 1];
      const count = r => Object.keys(r.words || {}).length;
      rows.sort((a, b) => count(b) - count(a) || streakOf(b.days) - streakOf(a.days));
      el.innerHTML = `<table class="board">
        <thead><tr><th>Имя</th><th>Слов</th><th>Серия</th><th>Зачёт ${wk}</th></tr></thead>
        <tbody>${rows.map((r, k) => {
          const best = (r.tests || []).filter(t => testKind(t) === "week" && testNum(t) === wk).reduce((m, t) => Math.max(m, pct(t.correct, t.total)), -1);
          return `<tr class="${r.id === uid ? "mine" : ""}"><td><span class="nm"><span class="pl">${k + 1}</span><span>${esc(r.name || "—")}</span></span></td><td>${count(r)}</td><td>${streakOf(r.days)}</td><td>${best >= 0 ? best + "%" : "—"}</td></tr>`;
        }).join("")}</tbody></table>`;
    }).catch(() => { el.innerHTML = `<p class="muted small">Таблица не загрузилась. Проверь интернет.</p>`; });
  }

  // ── Лайфхаки ──
  function hacks() {
    screen = hacks;
    currentBack = hacks;
    view(`
      <div class="top">${backBtn("back")}<b>Лайфхаки</b><span style="width:44px"></span></div>
      <p class="muted" style="padding:0 4px">Одна модель слова — один смысл. Узнал модель, и новое слово наполовину понятно.</p>
      ${PATTERNS.map(p => `<section class="tile hack">
        <span class="wz ar">${p.wazn}</span>
        <b>${esc(p.meaning)}</b>
        <div class="ws">${p.ids.filter(id => byId[id]).map(id => `<button class="w ar" data-word="${id}">${byId[id].ar}</button>`).join("")}</div>
      </section>`).join("") || `<p class="muted">Пока пусто.</p>`}
    `, "hacks", { back: profileScreen });
  }

  // ── Тема ──
  function isDark() {
    const t = document.documentElement.getAttribute("data-theme");
    return t ? t === "dark" : !!(window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches);
  }
  function paintThemeColor() {
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg-solid").trim();
    document.querySelectorAll('meta[name="theme-color"]').forEach(m => { m.content = bg; m.removeAttribute("media"); });
  }
  function toggleTheme() {
    const t = isDark() ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem("kalimat.theme", t); } catch (e) {}
    paintThemeColor();
  }
  paintThemeColor();

  // Какие прошлые недели развёрнуты на главной.
  const UI_KEY = "kalimat.ui";
  let ui = {};
  try { ui = JSON.parse(localStorage.getItem(UI_KEY)) || {}; } catch (e) {}
  ui.open = ui.open || {};
  const saveUi = () => { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch (e) {} };

  // ── Окна ──
  // Закрываются по Esc и тапу по затемнению, если не обязательные (первый вход).
  function modal(html, closable = true) {
    const m = document.createElement("div");
    m.className = "modal";
    m.innerHTML = `<div class="panel" role="dialog" aria-modal="true">${html}</div>`;
    document.body.appendChild(m);
    const close = () => { m.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = e => { if (e.key === "Escape" && closable) close(); };
    document.addEventListener("keydown", onKey);
    if (closable) m.addEventListener("click", e => { if (e.target === m) close(); });
    m.close = close;
    return m;
  }

  // ── Профили ──
  function profileModal(first) {
    const names = Object.keys(store.profiles);
    const m = modal(`
        <h2>${first ? "Кто учит слова?" : "Профили"}</h2>
        <p class="muted small">${CLOUD ? "Напиши своё имя. С этим же именем твой прогресс откроется на любом телефоне, а результаты попадут в общую таблицу." : "У каждого свой прогресс и свои результаты зачётов."}</p>
        ${names.length ? `<div class="profiles">${names.map(n => `<button class="profile${n === store.current ? " cur" : ""}" data-p="${esc(n)}"><span class="ava">${esc(n.trim().charAt(0).toUpperCase())}</span>${esc(n)}${n === store.current ? `<span class="muted small">сейчас</span>` : ""}</button>`).join("")}</div>` : ""}
        <form id="pf" class="row">
          <input id="pname" class="field" maxlength="30" placeholder="${names.length ? "Другое имя" : "Имя"}" autocomplete="off" autocapitalize="words" required>
          <button class="btn" type="submit">${first ? "Войти" : "Добавить"}</button>
        </form>
        ${first ? "" : `<button class="btn ghost" id="pclose">Закрыть</button>`}`, !first);
    m.querySelectorAll("[data-p]").forEach(b => b.onclick = () => { m.close(); openProfile(b.dataset.p); });
    m.querySelector("#pf").onsubmit = e => {
      e.preventDefault();
      const n = m.querySelector("#pname").value.trim();
      if (!n) return;
      m.close(); openProfile(n);
    };
    const c = m.querySelector("#pclose");
    if (c) c.onclick = m.close;
  }


  // ── Серия дней ──
  // Дни, когда было занятие, хранятся номерами дней. Серия не рвётся, пока сегодняшний день не закончился.
  function markDay() {
    const d = me().days = me().days || [];
    if (!d.includes(today())) d.push(today());
    if (d.length > 400) d.splice(0, d.length - 400);
  }
  function streak() {
    const d = new Set(me().days || []);
    let n = today();
    if (!d.has(n)) n--;
    let k = 0;
    while (d.has(n)) { k++; n--; }
    return k;
  }

  // ── Общие мелочи ──
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  const pct = (a, b) => b ? Math.round(a / b * 100) : 0;
  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    const f = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
    return n + " " + f;
  }

  // ── Зачёты: какие слова входят, лучший результат ──
  const testKind = t => t.kind || "week";
  const testNum = t => t.n || t.week;
  const testName = t => TEST_KINDS[testKind(t)].name(testNum(t));
  function testWeeks(kind, n) {
    const k = TEST_KINDS[kind].weeks;
    return Array.from({ length: k }, (_, i) => (n - 1) * k + i + 1);
  }
  function bestScore(tests, kind, n) {
    return tests.filter(t => testKind(t) === kind && testNum(t) === n).reduce((b, t) => Math.max(b, pct(t.correct, t.total)), -1);
  }



  // ── Резервная копия ──
  function backupModal() {
    const m = modal(`
      <h2>Резервная копия</h2>
      <p class="muted small">Прогресс хранится только в этом браузере. Скопируй текст ниже и сохрани в заметках. Чтобы перенести прогресс на другой телефон, вставь этот текст туда и нажми «Восстановить».</p>
      <textarea class="field" id="bk">${esc(JSON.stringify(me()))}</textarea>
      <div class="row"><button class="btn ghost" id="bcopy">Скопировать</button><button class="btn ghost" id="brest">Восстановить</button></div>
      <p class="small" id="bmsg"></p>
      <button class="btn ghost" id="bclose">Закрыть</button>`);
    const ta = m.querySelector("#bk"), msg = m.querySelector("#bmsg");
    m.querySelector("#bcopy").onclick = () => {
      (navigator.clipboard ? navigator.clipboard.writeText(ta.value) : Promise.reject()).then(
        () => { msg.textContent = "Скопировано."; }, () => { ta.focus(); ta.select(); msg.textContent = "Выдели текст и скопируй вручную."; });
    };
    m.querySelector("#brest").onclick = () => {
      try {
        const p = JSON.parse(ta.value);
        if (!p || !p.name || !p.words) throw 0;
        store.profiles[p.name] = p; store.current = p.name; save();
        m.close(); home();
      } catch (e) { msg.textContent = "Текст не похож на резервную копию. Вставь его целиком."; }
    };
    m.querySelector("#bclose").onclick = m.close;
  }

  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  // Сначала рисуем из локальной копии, потом в фоне подключаем базу.
  home();
  connect();
})();
