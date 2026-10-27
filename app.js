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
          store.profiles[n] = { name: n, words: d.words || {}, tests: d.tests || [], days: d.days || [], updated: d.updated || 0 };
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

  // Общие обработчики по data-атрибутам
  app.addEventListener("click", e => {
    const reveal = e.target.closest("[data-reveal]");
    if (reveal) { reveal.closest(".wcard").classList.add("open"); reveal.setAttribute("aria-expanded", "true"); return; }
    const word = e.target.closest("[data-word]");
    if (word) showWord(word.dataset.word, currentBack);
  });
  let currentBack = home;
  let screen = null; // какой экран сейчас открыт: главную можно перерисовать, когда придут данные

  function dotClass(id) {
    const s = me().words[id];
    if (!s) return "dot";
    if (s.lapse) return "dot lapse";
    return "dot s" + s.stage;
  }

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

  // ── Тема и состояние экрана ──
  const MOON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>';
  const SUN = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  const BULB = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/></svg>';
  const CHEV = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>';
  function isDark() {
    const t = document.documentElement.getAttribute("data-theme");
    return t ? t === "dark" : !!(window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches);
  }
  function paintThemeColor() {
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
    document.querySelectorAll('meta[name="theme-color"]').forEach(m => { m.content = bg; m.removeAttribute("media"); });
  }
  function toggleTheme() {
    const t = isDark() ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem("kalimat.theme", t); } catch (e) {}
    paintThemeColor();
    const b = document.getElementById("theme");
    if (b) { b.innerHTML = isDark() ? SUN : MOON; b.setAttribute("aria-label", isDark() ? "Светлая тема" : "Тёмная тема"); }
  }
  paintThemeColor();

  // Какие недели развёрнуты. По умолчанию открыта только последняя.
  const UI_KEY = "kalimat.ui";
  let ui = {};
  try { ui = JSON.parse(localStorage.getItem(UI_KEY)) || {}; } catch (e) {}
  ui.open = ui.open || {};
  const saveUi = () => { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch (e) {} };
  const isOpen = key => key in ui.open ? ui.open[key] : key === "w" + weeks[weeks.length - 1];

  function topBar() {
    return `<div class="top">
      <div class="brand"><h1>калимат</h1><span class="ar" aria-hidden="true">كَلِمَات</span></div>
      <div class="tools">
        <button class="btn ghost sm hacks" id="hacks" aria-label="Лайфхаки">${BULB}<span>Лайфхаки</span></button>
        <button class="ibtn" id="theme" aria-label="${isDark() ? "Светлая тема" : "Тёмная тема"}">${isDark() ? SUN : MOON}</button>
        <button class="ibtn me" id="prof" aria-label="Профиль: ${esc(store.current)}" title="${esc(store.current)}">${esc(store.current.trim().charAt(0).toUpperCase())}</button>
      </div>
    </div>`;
  }
  function bindTop() {
    on("prof", () => profileModal(false));
    on("theme", toggleTheme);
    on("hacks", hacks);
  }

  // ── Общая таблица ──
  // На телефоне помещаются четыре столбца: имя, слов, закреплено и последний недельный зачёт.
  function loadBoard() {
    const el = document.getElementById("board");
    if (!el || !CLOUD) return;
    if (!db) { el.innerHTML = `<p class="muted small">${cloud === "failed" ? "Нет связи с базой. Таблица появится, когда будет интернет." : "Загружаю…"}</p>`; return; }
    db.collection("users").get().then(snap => {
      // Свою строку берём из памяти: запись в базу уходит с небольшой задержкой.
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(r => r.id !== uid);
      if (me()) rows.push({ id: uid, ...me() });
      const wk = weeks[weeks.length - 1];
      rows.sort((a, b) => strong(b) - strong(a) || Object.keys(b.words || {}).length - Object.keys(a.words || {}).length);
      el.innerHTML = `<table class="board">
        <thead><tr><th>Имя</th><th>Слов</th><th>Закреп&shy;лено</th><th>Зачёт ${wk}</th></tr></thead>
        <tbody>${rows.map(r => {
          const best = (r.tests || []).filter(t => testKind(t) === "week" && testNum(t) === wk).reduce((m, t) => Math.max(m, pct(t.correct, t.total)), -1);
          return `<tr class="${r.id === uid ? "mine" : ""}"><td><span class="nm">${esc(r.name || "—")}</span></td><td>${Object.keys(r.words || {}).length}</td><td>${strong(r)}</td><td>${best >= 0 ? best + "%" : "—"}</td></tr>`;
        }).join("")}</tbody></table>
        <p class="muted small">«Закреплено» — слова, которые прошли повтор через 2 недели и дальше.</p>`;
    }).catch(() => { el.innerHTML = `<p class="muted small">Таблица не загрузилась. Проверь интернет.</p>`; });
  }
  const strong = r => Object.values(r.words || {}).filter(s => s.stage >= 3).length;

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
  const WD = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
  function weekDots() {
    const t = today(), mon = t - (t + 3) % 7, d = new Set(me().days || []);
    return `<div class="wdots" aria-label="Занятия на этой неделе">${WD.map((name, i) => {
      const n = mon + i;
      return `<span class="wd${d.has(n) ? " on" : ""}${n === t ? " now" : ""}"><i></i>${name}</span>`;
    }).join("")}</div>`;
  }

  // ── Главная ──
  function home() {
    currentBack = home;
    screen = home;
    if (!store.current || !me()) {
      app.innerHTML = `<div class="wrap">${topBarEmpty()}</div>`;
      if (!document.querySelector(".modal")) profileModal(true);
      return;
    }
    const due = dueIds();
    const nd = nextDue();
    const groups = [];
    WORDS.forEach(w => { const k = dayKey(w); let g = groups.find(x => x.k === k); if (!g) groups.push(g = { k, week: w.week, day: w.day, ids: [] }); g.ids.push(w.id); });
    const fresh = groups.find(g => g.ids.some(id => !me().words[id]));
    const tests = me().tests || [];
    const nRev = Math.min(due.length, REVIEW_LIMIT);
    const mins = Math.max(1, Math.ceil(nRev / 3) + (fresh ? 2 : 0));
    const st = streak();

    app.innerHTML = `<div class="wrap">
      ${topBar()}
      ${cloud === "failed" ? `<p class="note">Нет связи с базой: прогресс сохраняется на телефоне и уйдёт в базу, когда появится интернет. <button class="link" id="retry">Повторить</button></p>` : ""}

      <section class="today">
        <div class="today-top">
          <span class="label">Сегодня</span>
          <span class="streak${st ? " on" : ""}">${st ? plural(st, "день", "дня", "дней") + " подряд" : "Начни серию"}</span>
        </div>
        ${weekDots()}
        ${nRev || fresh ? `
          <div class="plan">
            ${nRev ? `<div class="plan-row"><span class="hero-num">${nRev}</span><span>${plural(nRev, "слово", "слова", "слов").replace(/^\d+ /, "")} на повтор${due.length > REVIEW_LIMIT ? `<span class="muted small"> · ещё ${due.length - REVIEW_LIMIT} завтра</span>` : ""}</span></div>` : ""}
            ${fresh ? `<div class="plan-row"><span class="hero-num">${fresh.ids.filter(id => !me().words[id]).length}</span><span>новых · неделя ${fresh.week}, день ${fresh.day}</span></div>
              <div class="ws">${fresh.ids.map(id => `<button class="w ar" data-word="${id}">${byId[id].ar}</button>`).join("")}</div>` : ""}
          </div>
          <button class="btn block" id="go">Начать · ~${plural(mins, "минута", "минуты", "минут")}</button>` : `
          <h2 class="head">Всё сделано</h2>
          <p class="muted">${nd ? "Следующий повтор: " + inDays(nd) + "." : "Новые слова появятся, когда их добавят в словарь."}</p>`}
      </section>

      <div class="weeks">
        ${weeks.slice().reverse().map(wk => weekBlock(wk, groups.filter(g => g.week === wk), tests)).join("")}
        <div class="legend">
          <span><i class="dot"></i>не начато</span>
          <span><i class="dot s1"></i>учу</span>
          <span><i class="dot s3"></i>закрепляю</span>
          <span><i class="dot s5"></i>надолго</span>
          <span><i class="dot lapse"></i>забыл</span>
        </div>
      </div>

      <section class="sec">
        <span class="label">Зачёты</span>
        ${bigTests().reverse().map(({ kind, n }) => testRow(kind, n, tests)).join("")}
        ${weeks.slice().reverse().map(wk => testRow("week", wk, tests)).join("")}
        ${bigTests().length ? "" : `<p class="muted small">Месячный зачёт по 4 неделям откроется после недели ${Math.ceil(((weeks[weeks.length - 1] || 0) + 1) / 4) * 4}, зачёт за 3 месяца — после недели 12.</p>`}
        ${CLOUD ? "" : `<button class="btn ghost sm" id="backup">Резервная копия</button>`}
      </section>

      ${CLOUD ? `<div class="week" data-open="${isOpen("board")}">
        <div class="wk-head"><button class="wk-toggle" data-fold="board" aria-expanded="${isOpen("board")}">${CHEV}<span><h3>Общая таблица</h3></span></button></div>
        <div class="wk-body" id="board"><p class="muted small">Загружаю…</p></div>
      </div>` : ""}
    </div>`;

    bindTop();
    on("go", () => due.length ? startReview(fresh ? fresh.k : null) : learnDay(fresh.k));
    on("retry", connect);
    on("backup", backupModal);
    if (isOpen("board")) loadBoard();
    app.querySelectorAll("[data-test]").forEach(b => b.onclick = () => { const [k, n] = b.dataset.test.split(":"); startTest(k, +n); });
    app.querySelectorAll("[data-fold]").forEach(b => b.onclick = () => {
      const key = b.dataset.fold, box = b.closest(".week"), open = !isOpen(key);
      ui.open[key] = open; saveUi();
      box.dataset.open = open; b.setAttribute("aria-expanded", open);
      if (key === "board" && open) loadBoard();
    });
    app.querySelectorAll("[data-markweek]").forEach(b => b.onclick = () => {
      const wk = +b.dataset.markweek;
      if (!confirm(`Отметить все слова недели ${wk} как знакомые? Они сразу пойдут в повторение, отменить это нельзя.`)) return;
      WORDS.filter(w => w.week === wk && !me().words[w.id]).forEach(w => { learn(w.id, 1); me().words[w.id].due = today() + 1; });
      save(); home();
    });
    window.scrollTo(0, 0);
  }
  function topBarEmpty() { return `<div class="top"><div class="brand"><h1>калимат</h1><span class="ar" aria-hidden="true">كَلِمَات</span></div></div>`; }
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
  // Большой зачёт открывается, когда все его недели уже в словаре.
  function bigTests() {
    const last = weeks.length ? weeks[weeks.length - 1] : 0;
    const list = [];
    ["month", "quarter"].forEach(kind => {
      for (let n = 1; n * TEST_KINDS[kind].weeks <= last; n++) list.push({ kind, n });
    });
    return list;
  }

  function weekBlock(wk, groups, tests) {
    const ids = groups.flatMap(g => g.ids);
    const learned = ids.filter(id => me().words[id]).length;
    const best = bestScore(tests, "week", wk);
    const key = "w" + wk;
    // Зачёт сдаётся из раздела «Зачёты», здесь только результат.
    return `<div class="week" data-open="${isOpen(key)}">
      <div class="wk-head">
        <button class="wk-toggle" data-fold="${key}" aria-expanded="${isOpen(key)}">${CHEV}<span><h3>Неделя ${wk}</h3>
          <span class="wk-meta">${learned} из ${ids.length}${best >= 0 ? ` · зачёт <b>${best}%</b>` : ""}</span></span></button>
      </div>
      <div class="wk-body">
        ${groups.map(g => `<div class="wk-day"><span class="dn">${g.day}</span>
          <div class="wgrid">${g.ids.map(id => `<button class="wcell" data-word="${id}"><span class="ar">${byId[id].ar}</span><span class="wru"><i class="${dotClass(id)}"></i>${esc(byId[id].ru)}</span></button>`).join("")}</div></div>`).join("")}
        ${learned < ids.length ? `<button class="link small" data-markweek="${wk}">Я уже знаю слова этой недели</button>` : ""}
      </div>
    </div>`;
  }

  function testRow(kind, n, tests) {
    const done = tests.filter(t => testKind(t) === kind && testNum(t) === n);
    const best = bestScore(tests, kind, n);
    const last = done[done.length - 1];
    const ws = testWeeks(kind, n);
    const name = TEST_KINDS[kind].name(n);
    return `<div class="trow">
      <span>${esc(name[0].toUpperCase() + name.slice(1))}${kind === "week" ? "" : ` <span class="muted small">· недели ${ws[0]}–${ws[ws.length - 1]}</span>`}<span class="when">${last ? fmtDay(last.date) + " · " + plural(done.length, "попытка", "попытки", "попыток") : "ещё не сдан"}</span></span>
      <span class="pct">${best >= 0 ? best + "%" : "—"}</span>
      <button class="btn ghost sm" data-test="${kind}:${n}">${done.length ? "Пересдать" : "Сдать"}</button>
    </div>`;
  }

  // ── Лайфхаки ──
  function hacks() {
    currentBack = hacks;
    screen = hacks;
    app.innerHTML = `<div class="wrap">
      <div class="top"><button class="btn ghost sm" id="back">← На главную</button></div>
      <section class="sec">
        <span class="label">Лайфхаки · закономерности</span>
        <p class="muted">Одна модель слова — один смысл. Узнал модель, и новое слово наполовину понятно.</p>
      </section>
      ${PATTERNS.map(p => `<section class="hack">
        <span class="wz ar">${p.wazn}</span>
        <strong>${esc(p.meaning)}</strong>
        <div class="ws">${p.ids.filter(id => byId[id]).map(id => `<button class="w ar" data-word="${id}">${byId[id].ar}</button>`).join("")}</div>
      </section>`).join("") || `<p class="muted">Пока пусто.</p>`}
    </div>`;
    on("back", home);
    window.scrollTo(0, 0);
  }

  // ── Карточка слова ──
  // Закрытая карточка показывает только слово: сначала вспомни, потом тап раскрывает остальное.
  function ayahHtml(q) {
    const words = q.ar.split(" ");
    const mark = (ws, at) => ws.map((x, i) => i === at ? `<mark>${x}</mark>` : x).join(" ");
    const from = Math.max(0, q.hl - 3), to = Math.min(words.length, q.hl + 4);
    const frag = (from > 0 ? "… " : "") + mark(words.slice(from, to), q.hl - from) + (to < words.length ? " …" : "");
    return `<details class="ayah">
      <summary><span class="ar">${frag}</span><span class="small muted">${esc(q.ref)} · <span class="more">весь аят</span><span class="less">свернуть</span></span></summary>
      <p class="ar">${mark(words, q.hl)}</p><p>${esc(q.ru)}</p>
    </details>`;
  }
  // Русский текст с арабскими вставками: каждую вставку изолируем, чтобы стрелки и тире не путали порядок.
  const rich = t => esc(t).replace(/[\u0600-\u06FF](?:[\u0600-\u06FF\s–-]*[\u0600-\u06FF])?/g, m => `<bdi class="ar">${m}</bdi>`);
  const pairs = list => list.map(p => `<div class="phr"><span class="ar">${p[0]}</span><span>${esc(p[1])}</span></div>`).join("");

  function cardHtml(w, open) {
    const quran = w.quran || [];
    return `<section class="panel wcard${open ? " open" : ""}">
      <button class="card-hero" data-reveal aria-expanded="${open ? "true" : "false"}">
        <span class="ar">${w.ar}</span>
        <span class="hint muted small">Вспомни перевод и нажми</span>
      </button>
      <div class="card-body">
        <div class="tr">${esc(w.ru)}</div>
        ${w.photo ? `<figure class="photo"><img src="${w.photo.src}" alt="${esc(w.ru)}" decoding="async"><figcaption>Фото: ${esc(w.photo.credit)}</figcaption></figure>` : ""}
        <div class="kv">
          <span class="label">Корень</span>
          <div class="roots">${w.root.map(l => `<span class="root-l">${l}</span>`).join("")}</div>
          <p class="center">${esc(w.rootMeaning)}</p>
        </div>
        <div class="kv"><span class="label">Как запомнить</span>${[].concat(w.assoc).map(a => `<p>${rich(a)}</p>`).join("")}</div>
        <div class="kv"><span class="label">Словосочетания</span>${pairs(w.phrases)}</div>
        <details>
          <summary>${CHEV}Подробнее</summary>
          <div class="kv more-body">
            <div class="kv"><span class="label">Как образовано</span><p>${rich(w.pattern)}</p></div>
            ${w.plural ? `<div class="kv"><span class="label">Множественное число</span><p class="ar plural">${w.plural}</p></div>` : ""}
            ${w.related && w.related.length ? `<div class="kv"><span class="label">Однокоренные слова</span>${pairs(w.related)}</div>` : ""}
            ${w.examples && w.examples.length ? `<div class="kv"><span class="label">Примеры из жизни</span>${w.examples.map(p => `<div class="ex"><p class="ar">${p[0]}</p><p class="muted">${esc(p[1])}</p></div>`).join("")}</div>` : ""}
            ${w.facts && w.facts.length ? `<div class="kv"><span class="label">Интересно</span><ul class="facts">${w.facts.map(f => `<li>${rich(f)}</li>`).join("")}</ul></div>` : ""}
            <div class="kv"><span class="label">В Коране</span>
              ${quran.map(ayahHtml).join("")}
              ${w.qnote ? `<p class="small muted">${rich(w.qnote)}</p>` : ""}
            </div>
          </div>
        </details>
      </div>
    </section>`;
  }

  const STAGE = s => !s ? "не начато" : s.lapse ? "забыл" : s.stage >= DONE ? "надолго" : s.stage >= 3 ? "закрепляю" : "учу";
  function showWord(id, back) {
    const w = byId[id]; if (!w) return;
    const s = me().words[id];
    screen = showWord;
    app.innerHTML = `<div class="wrap">
      <div class="top"><button class="btn ghost sm" id="back">← Назад</button><span class="muted small">Неделя ${w.week}, день ${w.day}</span></div>
      <p class="stage"><i class="${dotClass(id)}"></i>${STAGE(s)}${s ? ` · следующий повтор: ${inDays(s.due)}` : ""}</p>
      ${cardHtml(w)}
    </div>`;
    on("back", () => (back || home)());
    window.scrollTo(0, 0);
  }

  // ── Изучение дня ──
  function learnDay(k) {
    const ids = WORDS.filter(w => dayKey(w) === k).map(w => w.id);
    const w0 = byId[ids[0]];
    currentBack = () => learnDay(k);
    screen = learnDay;
    app.innerHTML = `<div class="wrap">
      <div class="top"><button class="btn ghost sm" id="back">← Назад</button><span class="muted small">Неделя ${w0.week}, день ${w0.day}</span></div>
      <p class="muted">Вспомни перевод, открой карточку и прочитай её. Потом закрепи коротким упражнением.</p>
      ${ids.map(id => cardHtml(byId[id], !me().words[id])).join("")}
      <button class="btn block" id="drill">Закрепить · 1 минута</button>
      <button class="link" id="mark">Отметить выученными без упражнения</button>
    </div>`;
    on("back", home);
    on("mark", () => { ids.forEach(id => { if (!me().words[id]) learn(id, 0); }); markDay(); save(); home(); });
    on("drill", () => {
      const tasks = shuffle(ids.map(id => ({ type: "ar2ru", id }))).concat(shuffle(ids.map(id => ({ type: "ru2ar", id }))));
      runSession({
        title: "Новые слова", tasks,
        finish: res => {
          ids.forEach(id => { if (!me().words[id]) learn(id, 0); });
          markDay(); save();
          resultScreen({ title: "Слова добавлены в повторение", res, note: "Первый повтор через 2 дня." });
        }
      });
    });
    window.scrollTo(0, 0);
  }

  // ── Повторение ──
  // nextK — день с новыми словами: после повторения предложим перейти к нему.
  function startReview(nextK) {
    const ids = shuffle(dueIds().slice(0, REVIEW_LIMIT));
    const tasks = ids.map(id => {
      const st = me().words[id].stage;
      const types = st < 2 ? ["ar2ru", "ru2ar", "cloze", "flip"] : ["ru2ar", "cloze", "build", "type"];
      return { type: pick(types), id };
    });
    runSession({
      title: "Повторение", tasks,
      finish: res => {
        const agg = aggregate(res);
        Object.entries(agg).forEach(([id, ok]) => grade(id, ok));
        markDay(); save();
        const left = dueIds().length;
        const more = nextK && WORDS.some(w => dayKey(w) === nextK && !me().words[w.id]);
        resultScreen({ title: "Повторение готово", res, note: "Слова с ошибками вернутся завтра." + (left ? " Ещё " + plural(left, "слово ждёт", "слова ждут", "слов ждут") + " — можно завтра." : ""),
          next: more ? { label: "Дальше: новые слова", fn: () => learnDay(nextK) } : null });
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
  function startTest(kind, n) {
    const ids = shuffle(testIds(kind, n));
    const recog = ["ar2ru", "cloze"];
    const prod = ["ru2ar", "build", "type"];
    const tasks = ids.map((id, i) => ({ type: pick(i % 3 === 2 ? recog : prod), id }));
    if (ids.length >= 4) tasks.push({ type: "match", ids: shuffle(ids).slice(0, 5) });
    const spec = TEST_KINDS[kind];
    const title = "Зачёт, " + spec.name(n);
    runSession({
      title, tasks,
      finish: res => {
        const agg = aggregate(res);
        Object.entries(agg).forEach(([id, ok]) => gradeTest(id, ok, spec.stage));
        const correct = res.filter(r => r.ok).length;
        const mistakes = Object.keys(agg).filter(id => !agg[id]);
        const t = { kind, n, date: today(), correct, total: res.length, mistakes };
        if (kind === "week") t.week = n;
        me().tests = me().tests || [];
        me().tests.push(t);
        markDay(); save();
        resultScreen({ title, res, test: t,
          note: `Следующий повтор этих слов через ${spec.stage === 2 ? "2 недели" : spec.stage === 3 ? "месяц" : "3 месяца"}. Слова с ошибками вернутся завтра. Зачёт можно пересдать в любой момент.` });
      }
    });
  }

  function aggregate(res) {
    const agg = {};
    res.forEach(r => { agg[r.id] = (agg[r.id] !== undefined ? agg[r.id] : true) && r.ok; });
    return agg;
  }

  // ── Движок упражнений ──
  // Ошибку повторяем один раз в конце занятия («работа над ошибками»). В оценку идёт только первая попытка.
  // Счётчик считает основные задания отдельно, чтобы полоска не откатывалась назад.
  function runSession({ title, tasks, finish }) {
    if (!tasks.length) return home();
    tasks = tasks.slice();
    const main = tasks.length;
    let i = 0;
    const res = [];
    const next = () => { i++; if (i >= tasks.length) finish(res); else show(); };
    const again = (t, results) => {
      results.filter(r => !r.ok).forEach(r => tasks.push({ type: t.type === "match" ? "ar2ru" : t.type, id: r.id, retry: true }));
    };
    function show() {
      const t = tasks[i];
      screen = runSession;
      const retry = i >= main;
      const count = retry ? `Работа над ошибками · ${i - main + 1}/${tasks.length - main}` : `${esc(title)} · ${i + 1}/${main}`;
      const prog = retry ? (i - main) / (tasks.length - main) : i / main;
      app.innerHTML = `<div class="wrap">
        <div class="top"><button class="btn ghost sm" id="quit">✕ Выйти</button><span class="muted small">${count}</span></div>
        <div class="progress${retry ? " retry" : ""}"><i style="width:${prog * 100}%"></i></div>
        <div id="task" class="panel"></div>
        <div id="fb" aria-live="polite"></div>
      </div>`;
      on("quit", () => { if (i === 0 || confirm("Выйти? Ответы этого занятия не сохранятся.")) home(); });
      const box = document.getElementById("task");
      const done = (results, answerHtml, typedHtml) => {
        if (!t.retry) { results.forEach(r => res.push(r)); again(t, results); }
        const ok = results.every(r => r.ok);
        if (!ok && navigator.vibrate) { try { navigator.vibrate(60); } catch (e) {} }
        const fb = document.getElementById("fb");
        fb.innerHTML = `<div class="feedback ${ok ? "ok" : "no"}">
          <div>${ok ? "Верно" + (answerHtml ? ": " : "") : "Правильно: "}${answerHtml || ""}${typedHtml ? `<div class="typed">Ты написал: ${typedHtml}</div>` : ""}</div>
          <button class="btn block" id="nx">Дальше</button></div>`;
        const nx = document.getElementById("nx");
        nx.onclick = next;
        try { nx.focus({ preventScroll: true, focusVisible: false }); } catch (e) { nx.focus(); }
        fb.scrollIntoView({ block: "nearest", behavior: "smooth" });
      };
      TASKS[t.type](box, t, done);
      window.scrollTo(0, 0);
    }
    show();
  }

  // В заданиях и в списке ошибок — фото слова (если есть), иначе эмодзи.
  const pic = (w, cls = "qpic") => w.photo && w.photo.src
    ? `<img class="${cls}" src="${esc(w.photo.src)}" alt="" decoding="async">`
    : `<span class="${cls} emo">${w.emoji || ""}</span>`;
  const ansAr = w => `<span class="ar">${w.ar}</span> — ${esc(w.ru)}`;

  function choice(box, prompt, options, correctId, isAr, onPick) {
    box.innerHTML = prompt + `<div class="opts">${options.map(o => `<button class="opt ${isAr ? "ar" : ""}" data-o="${o.id}">${isAr ? o.ar : esc(o.ru)}</button>`).join("")}</div>`;
    const btns = [...box.querySelectorAll("[data-o]")];
    btns.forEach(b => b.onclick = () => {
      btns.forEach(x => { x.disabled = true; if (x.dataset.o === correctId) x.classList.add("ok"); });
      if (b.dataset.o !== correctId) b.classList.add("no");
      onPick(b.dataset.o === correctId);
    });
  }

  const TASKS = {
    ar2ru(box, t, done) {
      const w = byId[t.id];
      const opts = shuffle([w, ...distractors(t.id)]);
      choice(box, `<span class="label">Что значит слово?</span><div class="q"><div class="ar">${w.ar}</div></div>`, opts, w.id, false,
        ok => { done([{ id: w.id, ok }], ansAr(w)); });
    },
    ru2ar(box, t, done) {
      const w = byId[t.id];
      const opts = shuffle([w, ...distractors(t.id)]);
      choice(box, `<span class="label">Выбери арабское слово</span><div class="q">${pic(w)}<div class="tr">${esc(w.ru)}</div></div>`, opts, w.id, true,
        ok => { done([{ id: w.id, ok }], ansAr(w)); });
    },
    cloze(box, t, done) {
      const w = byId[t.id];
      const opts = shuffle([w, ...distractors(t.id)]);
      const sent = w.cloze.ar.replace("___", `<span class="blank">&nbsp;</span>`);
      choice(box, `<span class="label">Какое слово подходит?</span><div class="q"><p class="ar sent">${sent}</p></div>`, opts, w.id, true,
        ok => done([{ id: w.id, ok }], `<span class="ar">${w.cloze.ar.replace("___", w.ar)}</span><br><span class="small">${esc(w.cloze.ru)}</span>`));
    },
    flip(box, t, done) {
      const w = byId[t.id];
      box.innerHTML = `<span class="label">Вспомни перевод, потом открой</span>
        <button class="flip" id="fl"><span class="q"><span class="ar">${w.ar}</span><span class="muted">Нажми, чтобы проверить</span></span></button>`;
      document.getElementById("fl").onclick = () => {
        box.innerHTML = `<span class="label">Ты вспомнил?</span>
          <div class="q"><div class="ar">${w.ar}</div><div class="tr">${esc(w.ru)}</div></div>
          <div class="row"><button class="btn ghost" id="no">Не вспомнил</button><button class="btn" id="yes">Вспомнил</button></div>`;
        on("yes", () => { box.querySelectorAll("button").forEach(b => b.disabled = true); done([{ id: w.id, ok: true }], ""); });
        on("no", () => { box.querySelectorAll("button").forEach(b => b.disabled = true); done([{ id: w.id, ok: false }], ansAr(w)); });
      };
    },
    build(box, t, done) {
      const w = byId[t.id];
      const letters = Array.from(strip(w.ar));
      const extra = shuffle(Array.from(new Set(distractors(t.id, 4).flatMap(x => Array.from(strip(x.ar))))).filter(l => !letters.includes(l))).slice(0, 2);
      const tiles = shuffle(letters.concat(extra));
      let used = [];
      box.innerHTML = `<span class="label">Собери слово из букв</span>
        <div class="q">${pic(w)}<div class="tr">${esc(w.ru)}</div></div>
        <button class="built" id="built" aria-label="Собранное слово, нажми чтобы стереть букву">&nbsp;</button>
        <div class="tiles">${tiles.map((l, k) => `<button class="tile" data-k="${k}">${l}</button>`).join("")}</div>
        <div class="row"><button class="btn ghost" id="bs">⌫ Стереть</button><button class="btn" id="chk">Проверить</button></div>`;
      const built = document.getElementById("built");
      const tileBtns = [...box.querySelectorAll(".tile")];
      const draw = () => { built.textContent = used.map(k => tiles[k]).join("") || " "; tileBtns.forEach(b => b.disabled = used.includes(+b.dataset.k)); };
      tileBtns.forEach(b => b.onclick = () => { used.push(+b.dataset.k); draw(); });
      on("bs", () => { used.pop(); draw(); });
      built.onclick = () => { used.pop(); draw(); };
      on("chk", () => {
        const ok = norm(used.map(k => tiles[k]).join("")) === norm(w.ar);
        box.querySelectorAll("button").forEach(b => b.disabled = true);
        done([{ id: w.id, ok }], ansAr(w));
      });
    },
    type(box, t, done) {
      const w = byId[t.id];
      box.innerHTML = `<span class="label">Напиши по-арабски</span>
        <div class="q">${pic(w)}<div class="tr">${esc(w.ru)}</div></div>
        <form id="tf" class="kv tform">
          <input id="tin" class="input-ar" lang="ar" dir="rtl" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Нажми и напиши">
          <p class="muted small">Огласовки можно не ставить. Подойдёт арабская клавиатура или голосовой ввод на арабском.</p>
          <div class="row"><button class="btn ghost" type="button" id="idk">Не знаю</button><button class="btn" type="submit">Проверить</button></div>
        </form>`;
      const inp = document.getElementById("tin");
      const finish = (ok, typed) => {
        box.querySelectorAll("button, input").forEach(b => b.disabled = true);
        done([{ id: w.id, ok }], ansAr(w), !ok && typed ? `<bdi class="ar">${esc(typed)}</bdi>` : "");
      };
      document.getElementById("tf").onsubmit = e => { e.preventDefault(); const v = inp.value.trim(); if (v) finish(norm(v) === norm(w.ar), v); };
      on("idk", () => finish(false));
      // На телефоне клавиатура не выезжает сама, чтобы не закрывать фото и кнопки.
      if (!matchMedia("(pointer: coarse)").matches) inp.focus();
    },
    match(box, t, done) {
      const ws = t.ids.map(id => byId[id]);
      const left = shuffle(ws), right = shuffle(ws);
      const errs = {};
      let sel = null, left_ = ws.length;
      box.innerHTML = `<span class="label">Соедини пары</span>
        <p class="muted small">Нажми арабское слово, потом его перевод.</p>
        <div class="match"><div class="col">${left.map(w => `<button class="opt ar" data-l="${w.id}">${w.ar}</button>`).join("")}</div>
        <div class="col">${right.map(w => `<button class="opt" data-r="${w.id}">${esc(w.ru)}</button>`).join("")}</div></div>`;
      const L = [...box.querySelectorAll("[data-l]")], R = [...box.querySelectorAll("[data-r]")];
      L.forEach(b => b.onclick = () => { L.forEach(x => x.classList.remove("sel")); b.classList.add("sel"); sel = b.dataset.l; });
      R.forEach(b => b.onclick = () => {
        if (!sel) return;
        if (b.dataset.r === sel) {
          [b, box.querySelector(`[data-l="${sel}"]`)].forEach(x => { x.classList.remove("sel"); x.classList.add("done"); x.disabled = true; });
          sel = null; left_--;
          if (left_ === 0) done(ws.map(w => ({ id: w.id, ok: !errs[w.id] })), Object.keys(errs).map(id => ansAr(byId[id])).join("<br>"));
        } else {
          errs[sel] = true;
          b.classList.add("no"); setTimeout(() => b.classList.remove("no"), 500);
        }
      });
    }
  };

  // ── Результат ──
  // practice — тренировка ошибок: результат не идёт в повторы.
  function resultScreen({ title, res, note, test, next, practice }) {
    const correct = res.filter(r => r.ok).length;
    const agg = aggregate(res);
    const bad = Object.keys(agg).filter(id => !agg[id]);
    const p = pct(correct, res.length);
    const great = p >= 80;
    screen = resultScreen;
    app.innerHTML = `<div class="wrap">
      <section class="panel${great ? " great" : ""}">
        <div class="score"><span class="label">${esc(title)}</span>
          ${great ? `<p class="cheer">${p === 100 ? "Без единой ошибки!" : "Отлично!"}</p>` : ""}
          <div class="bignum">${p}%</div><p>${correct} из ${res.length} заданий верно</p></div>
        ${note ? `<p class="muted small">${esc(note)}</p>` : ""}
      </section>
      ${next ? `<button class="btn block" id="next">${esc(next.label)}</button>` : ""}
      ${bad.length ? `<button class="btn ${next ? "ghost" : ""} block" id="fix">Повторить ошибки сейчас · ${plural(bad.length, "слово", "слова", "слов")}</button>` : ""}
      ${bad.length ? `<section class="panel"><span class="label">${practice ? "Ещё путаются" : "Ошибки"}</span>
        ${bad.map(id => `<button class="mist" data-word="${id}">${pic(byId[id], "mpic")}<span>${esc(byId[id].ru)}</span><span class="ar">${byId[id].ar}</span></button>`).join("")}
      </section>` : ""}
      ${test ? `<button class="btn ghost block" id="share">${navigator.share ? "Поделиться результатом" : "Скопировать результат"}</button>` : ""}
      <button class="btn ${next || bad.length ? "ghost" : ""} block" id="home">На главную</button>
    </div>`;
    currentBack = () => resultScreen({ title, res, note, test, next, practice });
    on("home", home);
    if (next) on("next", next.fn);
    on("fix", () => {
      const tasks = shuffle(bad.map(id => ({ type: pick(["ar2ru", "ru2ar"]), id })));
      runSession({ title: "Работа над ошибками", tasks,
        finish: r => resultScreen({ title: "Работа над ошибками", res: r, practice: true, note: "Это тренировка: расписание повторов не меняется." }) });
    });
    on("share", () => {
      const txt = shareText(test), btn = document.getElementById("share");
      if (navigator.share) { navigator.share({ text: txt }).catch(() => {}); return; }
      (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(
        () => { btn.textContent = "Скопировано"; },
        () => { btn.textContent = "Не получилось скопировать"; });
    });
    window.scrollTo(0, 0);
  }
  function shareText(t) {
    const miss = t.mistakes.map(id => byId[id].ar + " (" + byId[id].ru + ")").join(", ");
    return `${store.current} · Зачёт, ${testName(t)}: ${t.correct}/${t.total} (${pct(t.correct, t.total)}%)` + (miss ? `\nОшибки: ${miss}` : "\nБез ошибок!");
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