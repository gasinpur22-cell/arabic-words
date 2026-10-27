(() => {
  "use strict";

  const WORDS = window.WORDS || [];
  const PATTERNS = window.PATTERNS || [];
  const byId = Object.fromEntries(WORDS.map(w => [w.id, w]));
  const weeks = [...new Set(WORDS.map(w => w.week))].sort((a, b) => a - b);

  // Интервальные повторы: после изучения — через 2 дня, затем 5 (недельный зачёт),
  // 14 дней, 30 дней, 90 дней. Ошибка возвращает слово на начало цикла.
  const INTERVALS = [2, 5, 14, 30, 90];
  const DONE = INTERVALS.length;
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
    try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) {}
    if (CLOUD && uid && me()) {
      clearTimeout(syncTimer);
      syncTimer = setTimeout(() => {
        db.collection("users").doc(uid).set(Object.assign({}, me(), { updated: Date.now() })).catch(err => console.error(err));
      }, 600);
    }
  }
  const me = () => store.profiles[store.current];

  // ── Аккаунты и общая таблица (Firebase). Без firebase-config.js сайт работает с локальными профилями. ──
  const CLOUD = !!(window.FIREBASE_CONFIG && window.firebase);
  // Вход только по имени: прогресс лежит в документе users/<имя>, поэтому с тем же именем он откроется на любом телефоне.
  let db = null, uid = null, syncTimer = null;
  if (CLOUD) {
    firebase.initializeApp(window.FIREBASE_CONFIG);
    db = firebase.firestore();
  }
  const docKey = n => n.trim().toLowerCase().replace(/[\/.#$\[\]]/g, "_");
  async function openProfile(n) {
    if (CLOUD) {
      uid = docKey(n);
      try {
        const snap = await db.collection("users").doc(uid).get();
        if (snap.exists) { const d = snap.data(); store.profiles[n] = { name: n, words: d.words || {}, tests: d.tests || [] }; }
      } catch (e) { console.error(e); }
    }
    if (!store.profiles[n]) store.profiles[n] = { name: n, words: {}, tests: [] };
    store.current = n; save(); home();
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
  function grade(id, ok) {
    const s = me().words[id];
    if (!s) return learn(id, ok ? 1 : 0);
    if (ok) {
      s.stage = Math.min(s.stage + 1, DONE);
      s.due = today() + (s.stage >= DONE ? 180 : INTERVALS[s.stage]);
      s.lapse = false;
    } else {
      s.stage = 0;
      s.due = today() + 1;
      s.lapses = (s.lapses || 0) + 1;
      s.lapse = true;
    }
  }
  // Зачёт засчитывает недельный повтор: следующий — через 2 недели.
  function gradeTest(id, ok) {
    const s = me().words[id];
    if (ok && (!s || s.stage < 2)) {
      me().words[id] = Object.assign(s || { learned: today(), lapses: 0 }, { stage: 2, due: today() + INTERVALS[2], lapse: false });
    } else grade(id, ok);
  }
  const dueIds = () => WORDS.filter(w => { const s = me().words[w.id]; return s && s.due <= today(); }).map(w => w.id);
  function nextDue() {
    const ds = Object.values(me().words).map(s => s.due).filter(d => d > today());
    return ds.length ? Math.min(...ds) : null;
  }

  // ── Утилиты ──
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const strip = s => s.replace(/[ً-ٰٟـ]/g, "");
  const norm = s => strip(s).replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/\s+/g, "").trim();
  const dayKey = w => w.week + "-" + w.day;

  function distractors(id, n = 3) {
    const w = byId[id];
    const same = shuffle(WORDS.filter(x => x.id !== id && x.week === w.week));
    const rest = shuffle(WORDS.filter(x => x.id !== id && x.week !== w.week));
    return [...same, ...rest].slice(0, n);
  }

  // ── Озвучка ──
  let arVoice = null;
  const canSpeak = "speechSynthesis" in window;
  function initVoices() {
    try { arVoice = speechSynthesis.getVoices().find(v => /^ar/i.test(v.lang)) || null; } catch (e) {}
  }
  if (canSpeak) { initVoices(); try { speechSynthesis.onvoiceschanged = initVoices; } catch (e) {} }
  function speak(text) {
    if (!canSpeak) return;
    try {
      const u = new SpeechSynthesisUtterance(strip(text));
      u.lang = "ar-SA"; if (arVoice) u.voice = arVoice; u.rate = 0.8;
      speechSynthesis.cancel(); speechSynthesis.speak(u);
    } catch (e) {}
  }
  const speakBtn = ar => canSpeak ? `<button class="speak" data-say="${esc(ar)}" aria-label="Послушать">🔊</button>` : "";

  // Общие обработчики по data-атрибутам
  app.addEventListener("click", e => {
    const say = e.target.closest("[data-say]");
    if (say) { e.stopPropagation(); speak(say.dataset.say); return; }
    const reveal = e.target.closest("[data-reveal]");
    if (reveal) { reveal.closest(".wcard").classList.add("open"); reveal.setAttribute("aria-expanded", "true"); return; }
    const word = e.target.closest("[data-word]");
    if (word) showWord(word.dataset.word, currentBack);
  });
  let currentBack = home;

  function dotClass(id) {
    const s = me().words[id];
    if (!s) return "dot";
    if (s.lapse) return "dot lapse";
    return "dot s" + s.stage;
  }

  // ── Профили ──
  function profileModal(first) {
    const names = Object.keys(store.profiles);
    const m = document.createElement("div");
    m.className = "modal";
    m.innerHTML = `
      <div class="panel" role="dialog" aria-modal="true">
        <h2>${first ? "Кто учит слова?" : "Профили"}</h2>
        <p class="muted small">${CLOUD ? "Напиши своё имя. С этим же именем твой прогресс откроется на любом телефоне, а результаты попадут в общую таблицу." : "У каждого свой прогресс и свои результаты зачётов."}</p>
        ${names.map(n => `<div class="profile-row"><button class="btn ${n === store.current ? "" : "ghost"}" data-p="${esc(n)}">${esc(n)}</button></div>`).join("")}
        <form id="pf" class="row">
          <input id="pname" class="field" maxlength="30" placeholder="Имя" autocomplete="off" required>
          <button class="btn" type="submit">${first ? "Войти" : "Добавить"}</button>
        </form>
        ${first ? "" : `<button class="btn ghost" id="pclose">Закрыть</button>`}
      </div>`;
    document.body.appendChild(m);
    m.querySelectorAll("[data-p]").forEach(b => b.onclick = () => { m.remove(); openProfile(b.dataset.p); });
    m.querySelector("#pf").onsubmit = e => {
      e.preventDefault();
      const n = m.querySelector("#pname").value.trim();
      if (!n) return;
      m.remove(); openProfile(n);
    };
    const c = m.querySelector("#pclose");
    if (c) c.onclick = () => m.remove();
  }

  function topBar() {
    return `<div class="top">
      <div class="brand"><span class="ar">كَلِمَات</span><h1>Калимат</h1></div>
      <button class="chip" id="prof">👤 ${esc(store.current)}</button>
    </div>`;
  }
  function bindTop() { const p = document.getElementById("prof"); if (p) p.onclick = () => profileModal(false); }

  // ── Общая таблица ──
  function loadBoard() {
    const el = document.getElementById("board");
    if (!el || !CLOUD) return;
    db.collection("users").get().then(snap => {
      // Свою строку берём из памяти: запись в базу уходит с небольшой задержкой.
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(r => r.id !== uid);
      if (me()) rows.push({ id: uid, ...me() });
      const wkList = weeks;
      rows.sort((a, b) => strong(b) - strong(a));
      el.innerHTML = `<div style="overflow-x:auto"><table class="board">
        <thead><tr><th>Имя</th><th>Слов</th><th>Закреплено</th>${wkList.map(w => `<th>Зачёт ${w}</th>`).join("")}</tr></thead>
        <tbody>${rows.map(r => {
          const ws = Object.values(r.words || {});
          return `<tr class="${r.id === uid ? "mine" : ""}"><td>${esc(r.name || "—")}</td><td>${ws.length}</td><td>${strong(r)}</td>
            ${wkList.map(w => { const best = (r.tests || []).filter(t => t.week === w).reduce((m, t) => Math.max(m, pct(t.correct, t.total)), -1); return `<td>${best >= 0 ? best + "%" : "—"}</td>`; }).join("")}</tr>`;
        }).join("")}</tbody></table></div>
        <p class="muted small">«Закреплено» — слова, которые прошли повтор через 2 недели и дальше.</p>`;
    }).catch(() => { el.innerHTML = `<p class="muted">Таблица не загрузилась. Проверь интернет.</p>`; });
  }
  const strong = r => Object.values(r.words || {}).filter(s => s.stage >= 3).length;

  // ── Главная ──
  function home() {
    currentBack = home;
    if (!store.current || !me()) { app.innerHTML = `<div class="wrap">${topBarEmpty()}</div>`; profileModal(true); return; }
    const due = dueIds();
    const nd = nextDue();
    const groups = [];
    WORDS.forEach(w => { const k = dayKey(w); let g = groups.find(x => x.k === k); if (!g) groups.push(g = { k, week: w.week, day: w.day, ids: [] }); g.ids.push(w.id); });
    const fresh = groups.find(g => g.ids.some(id => !me().words[id]));
    const tests = me().tests || [];

    app.innerHTML = `<div class="wrap">
      ${topBar()}

      <section class="panel due">
        <span class="label">Повторение на сегодня</span>
        ${due.length ? `
          <div class="bignum">${due.length}</div>
          <p>${plural(due.length, "слово ждёт", "слова ждут", "слов ждут")} повторения. Это 2–3 минуты.</p>
          <button class="btn block" id="review">Повторить</button>` : `
          <h2>Всё повторено</h2>
          <p>${nd ? "Следующий повтор: " + inDays(nd) + "." : "Отметь выученные слова, и они появятся здесь в нужный день."}</p>`}
      </section>

      <section class="panel">
        <span class="label">Новые слова</span>
        ${fresh ? `
          <h2>Неделя ${fresh.week}, день ${fresh.day}</h2>
          <div class="day-words" style="justify-content:flex-start">${fresh.ids.map(id => `<button class="wchip" data-word="${id}">${byId[id].ar}</button>`).join("")}</div>
          <button class="btn block" id="learn" data-k="${fresh.k}">Учить</button>` : `
          <h2>Новых слов пока нет</h2>
          <p class="muted">Когда пришлёшь новые 3 слова, они появятся здесь.</p>`}
      </section>

      ${weeks.slice().reverse().map(wk => weekPanel(wk, groups.filter(g => g.week === wk), tests)).join("")}

      <div class="legend">
        <span><i class="dot"></i>не начато</span>
        <span><i class="dot s1"></i>учу</span>
        <span><i class="dot s3"></i>закрепляю</span>
        <span><i class="dot s5"></i>выучено надолго</span>
        <span><i class="dot lapse"></i>забыл, повторю</span>
      </div>

      ${PATTERNS.length ? `<section class="panel">
        <span class="label">Закономерности</span>
        <p class="muted small">Одна модель — один смысл. Узнал модель, и новое слово угадывается наполовину.</p>
        ${PATTERNS.map(p => `<div class="phr"><span class="ar">${p.wazn}</span><span>${esc(p.meaning)}<br><span class="ar">${p.ids.map(id => byId[id] ? byId[id].ar : "").join("، ")}</span></span></div>`).join("")}
      </section>` : ""}

      ${CLOUD ? `<section class="panel"><span class="label">Общая таблица</span><div id="board"><p class="muted">Загружаю…</p></div></section>` : ""}

      <section class="panel">
        <span class="label">Мои результаты</span>
        ${tests.length ? tests.slice().reverse().map(t => `<div class="hist"><span>Зачёт, неделя ${t.week} · ${fmtDay(t.date)}</span><strong>${t.correct}/${t.total} · ${pct(t.correct, t.total)}%</strong></div>`).join("") : `<p class="muted">Здесь появятся результаты зачётов.</p>`}
        ${CLOUD ? "" : `<div class="row"><button class="btn ghost" id="backup">Резервная копия</button></div>`}
      </section>
    </div>`;

    bindTop();
    on("review", () => startReview());
    on("learn", e => learnDay(e.currentTarget.dataset.k));
    on("backup", backupModal);
    loadBoard();
    app.querySelectorAll("[data-test]").forEach(b => b.onclick = () => startTest(+b.dataset.test));
    app.querySelectorAll("[data-markweek]").forEach(b => b.onclick = () => {
      WORDS.filter(w => w.week === +b.dataset.markweek && !me().words[w.id]).forEach(w => { learn(w.id, 1); me().words[w.id].due = today() + 1; });
      save(); home();
    });
    window.scrollTo(0, 0);
  }
  function topBarEmpty() { return `<div class="top"><div class="brand"><span class="ar">كَلِمَات</span><h1>Калимат</h1></div></div>`; }
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  const pct = (a, b) => b ? Math.round(a / b * 100) : 0;
  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    const f = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
    return n + " " + f;
  }

  function weekPanel(wk, groups, tests) {
    const ids = groups.flatMap(g => g.ids);
    const learned = ids.filter(id => me().words[id]).length;
    const best = tests.filter(t => t.week === wk).reduce((b, t) => Math.max(b, pct(t.correct, t.total)), -1);
    return `<section class="panel">
      <div class="top"><h2>Неделя ${wk}</h2><span class="muted small">${learned} из ${ids.length} начато${best >= 0 ? " · лучший зачёт " + best + "%" : ""}</span></div>
      <div>${groups.map(g => `<div class="day"><span class="day-n">День ${g.day}</span>
        <div class="day-words">${g.ids.map(id => `<button class="wchip" data-word="${id}"><i class="${dotClass(id)}"></i>${byId[id].ar}</button>`).join("")}</div></div>`).join("")}</div>
      <div class="row">
        <button class="btn" data-test="${wk}">Зачёт недели ${wk}</button>
        ${learned < ids.length ? `<button class="btn ghost" data-markweek="${wk}">Я уже знаю эти слова</button>` : ""}
      </div>
    </section>`;
  }

  // ── Карточка слова ──
  // Закрытая карточка показывает только слово: сначала вспомни, потом тап раскрывает остальное.
  function ayahHtml(q) {
    const words = q.ar.split(" ");
    const mark = (ws, at) => ws.map((x, i) => i === at ? `<mark>${x}</mark>` : x).join(" ");
    const from = Math.max(0, q.hl - 3), to = Math.min(words.length, q.hl + 4);
    const frag = (from > 0 ? "… " : "") + mark(words.slice(from, to), q.hl - from) + (to < words.length ? " …" : "");
    return `<details class="ayah">
      <summary><span class="ar">${frag}</span><span class="small muted">${esc(q.ref)} · весь аят</span></summary>
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
        ${w.photo ? `<figure class="photo"><img src="${w.photo.src}" alt="${esc(w.ru)}" loading="lazy"><figcaption>Фото: ${esc(w.photo.credit)}</figcaption></figure>` : ""}
        <div class="tr">${esc(w.ru)}</div>
        <div class="kv">
          <span class="label">Корень</span>
          <div class="roots">${w.root.map(l => `<span class="root-l">${l}</span>`).join("")}</div>
          <p style="text-align:center">${esc(w.rootMeaning)}</p>
        </div>
        <div class="kv"><span class="label">Как запомнить</span>${[].concat(w.assoc).map(a => `<p>${rich(a)}</p>`).join("")}</div>
        <div class="kv"><span class="label">Словосочетания</span>${pairs(w.phrases)}</div>
        <details>
          <summary>Подробнее</summary>
          <div class="kv" style="gap:16px">
            <div class="kv"><span class="label">Как образовано</span><p>${rich(w.pattern)}</p></div>
            ${w.plural ? `<div class="kv"><span class="label">Множественное число</span><p class="ar" style="font-size:1.4rem;text-align:right">${w.plural}</p></div>` : ""}
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

  function showWord(id, back) {
    const w = byId[id]; if (!w) return;
    const s = me().words[id];
    app.innerHTML = `<div class="wrap">
      <div class="top"><button class="chip" id="back">← Назад</button><span class="muted small">Неделя ${w.week}, день ${w.day}</span></div>
      ${cardHtml(w)}
      <p class="muted small">${s ? (s.stage >= DONE ? "Выучено надолго. " : "") + "Следующий повтор: " + inDays(s.due) + "." : "Слово ещё не отмечено как выученное."}</p>
    </div>`;
    on("back", () => (back || home)());
    window.scrollTo(0, 0);
  }

  // ── Изучение дня ──
  function learnDay(k) {
    const ids = WORDS.filter(w => dayKey(w) === k).map(w => w.id);
    const w0 = byId[ids[0]];
    currentBack = () => learnDay(k);
    app.innerHTML = `<div class="wrap">
      <div class="top"><button class="chip" id="back">← Назад</button><span class="muted small">Неделя ${w0.week}, день ${w0.day}</span></div>
      <p class="muted">Прочитай карточки, послушай слова, потом закрепи коротким упражнением.</p>
      ${ids.map(id => cardHtml(byId[id], !me().words[id])).join("")}
      <button class="btn block" id="drill">Закрепить (1 минута)</button>
      <button class="btn ghost block" id="mark">Отметить выученными без упражнения</button>
    </div>`;
    on("back", home);
    on("mark", () => { ids.forEach(id => { if (!me().words[id]) learn(id, 0); }); save(); home(); });
    on("drill", () => {
      const tasks = shuffle(ids.map(id => ({ type: "ar2ru", id }))).concat(shuffle(ids.map(id => ({ type: "ru2ar", id }))));
      runSession({
        title: "Новые слова", tasks,
        finish: res => {
          ids.forEach(id => { if (!me().words[id]) learn(id, 0); });
          save();
          resultScreen({ title: "Слова добавлены в повторение", res, note: "Первый повтор через 2 дня." });
        }
      });
    });
    window.scrollTo(0, 0);
  }

  // ── Повторение ──
  function startReview() {
    const ids = shuffle(dueIds()).slice(0, 20);
    const tasks = ids.map(id => {
      const st = me().words[id].stage;
      const types = st < 2 ? ["ar2ru", "ru2ar", "cloze", "flip"] : ["ru2ar", "cloze", "build", "type"];
      if (arVoice && st < 2) types.push("listen");
      return { type: pick(types), id };
    });
    runSession({
      title: "Повторение", tasks,
      finish: res => {
        const agg = aggregate(res);
        Object.entries(agg).forEach(([id, ok]) => grade(id, ok));
        save();
        resultScreen({ title: "Повторение готово", res, note: "Слова с ошибками вернутся завтра." });
      }
    });
  }

  // ── Зачёт ──
  function startTest(wk) {
    const ids = WORDS.filter(w => w.week === wk).map(w => w.id);
    const recog = ["ar2ru", "cloze"]; if (arVoice) recog.push("listen");
    const prod = ["ru2ar", "build", "type"];
    const a = shuffle(ids).map(id => ({ type: pick(recog), id }));
    const b = shuffle(ids).map(id => ({ type: pick(prod), id }));
    const tasks = a.concat(b);
    tasks.push({ type: "match", ids: shuffle(ids).slice(0, 5) });
    runSession({
      title: "Зачёт · неделя " + wk, tasks,
      finish: res => {
        const agg = aggregate(res);
        Object.entries(agg).forEach(([id, ok]) => gradeTest(id, ok));
        const correct = res.filter(r => r.ok).length;
        const mistakes = Object.keys(agg).filter(id => !agg[id]);
        me().tests = me().tests || [];
        me().tests.push({ week: wk, date: today(), correct, total: res.length, mistakes });
        save();
        resultScreen({ title: "Зачёт, неделя " + wk, res, test: { week: wk, correct, total: res.length, mistakes },
          note: "Следующий повтор этих слов через 2 недели. Слова с ошибками вернутся завтра." });
      }
    });
  }

  function aggregate(res) {
    const agg = {};
    res.forEach(r => { agg[r.id] = (agg[r.id] !== undefined ? agg[r.id] : true) && r.ok; });
    return agg;
  }

  // ── Движок упражнений ──
  function runSession({ title, tasks, finish }) {
    if (!tasks.length) return home();
    let i = 0;
    const res = [];
    const next = () => { i++; if (i >= tasks.length) finish(res); else show(); };
    function show() {
      const t = tasks[i];
      app.innerHTML = `<div class="wrap">
        <div class="top"><button class="chip" id="quit">✕ Выйти</button><span class="muted small">${esc(title)} · ${i + 1}/${tasks.length}</span></div>
        <div class="progress"><i style="width:${(i / tasks.length) * 100}%"></i></div>
        <div id="task" class="panel"></div>
        <div id="fb"></div>
      </div>`;
      on("quit", home);
      const box = document.getElementById("task");
      const done = (results, answerHtml) => {
        results.forEach(r => res.push(r));
        const ok = results.every(r => r.ok);
        const fb = document.getElementById("fb");
        fb.innerHTML = `<div class="feedback ${ok ? "ok" : "no"}"><span>${ok ? "Верно" : "Правильно:"} ${answerHtml || ""}</span>
          <button class="btn" id="nx">Дальше</button></div>`;
        const nx = document.getElementById("nx");
        nx.onclick = next; nx.focus();
      };
      TASKS[t.type](box, t, done);
      window.scrollTo(0, 0);
    }
    show();
  }

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
      choice(box, `<span class="label">Что значит слово?</span><div class="q"><div class="ar">${w.ar}</div>${speakBtn(w.ar)}</div>`, opts, w.id, false,
        ok => { if (ok) speak(w.ar); done([{ id: w.id, ok }], ansAr(w)); });
    },
    ru2ar(box, t, done) {
      const w = byId[t.id];
      const opts = shuffle([w, ...distractors(t.id)]);
      choice(box, `<span class="label">Выбери арабское слово</span><div class="q"><div style="font-size:2rem">${w.emoji || ""}</div><div class="tr">${esc(w.ru)}</div></div>`, opts, w.id, true,
        ok => { speak(w.ar); done([{ id: w.id, ok }], ansAr(w)); });
    },
    listen(box, t, done) {
      const w = byId[t.id];
      const opts = shuffle([w, ...distractors(t.id)]);
      choice(box, `<span class="label">Послушай и выбери перевод</span><div class="q"><button class="btn soft" data-say="${esc(w.ar)}">🔊 Послушать ещё раз</button></div>`, opts, w.id, false,
        ok => done([{ id: w.id, ok }], ansAr(w)));
      setTimeout(() => speak(w.ar), 250);
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
        <div class="flip" id="fl"><div class="q"><div class="ar">${w.ar}</div><p class="muted">Нажми, чтобы проверить</p></div></div>`;
      document.getElementById("fl").onclick = () => {
        speak(w.ar);
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
        <div class="q"><div style="font-size:2rem">${w.emoji || ""}</div><div class="tr">${esc(w.ru)}</div></div>
        <div class="built" id="built">&nbsp;</div>
        <div class="tiles">${tiles.map((l, k) => `<button class="tile" data-k="${k}">${l}</button>`).join("")}</div>
        <div class="row"><button class="btn ghost" id="bs">⌫ Стереть</button><button class="btn" id="chk">Проверить</button></div>`;
      const built = document.getElementById("built");
      const tileBtns = [...box.querySelectorAll(".tile")];
      const draw = () => { built.textContent = used.map(k => tiles[k]).join("") || " "; tileBtns.forEach(b => b.disabled = used.includes(+b.dataset.k)); };
      tileBtns.forEach(b => b.onclick = () => { used.push(+b.dataset.k); draw(); });
      on("bs", () => { used.pop(); draw(); });
      on("chk", () => {
        const ok = norm(used.map(k => tiles[k]).join("")) === norm(w.ar);
        box.querySelectorAll("button").forEach(b => b.disabled = true);
        speak(w.ar);
        done([{ id: w.id, ok }], ansAr(w));
      });
    },
    type(box, t, done) {
      const w = byId[t.id];
      box.innerHTML = `<span class="label">Напиши по-арабски</span>
        <div class="q"><div style="font-size:2rem">${w.emoji || ""}</div><div class="tr">${esc(w.ru)}</div></div>
        <form id="tf" class="kv" style="gap:8px">
          <input id="tin" class="input-ar" lang="ar" dir="rtl" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="اُكْتُبْ هُنَا">
          <p class="muted small">Огласовки можно не ставить. Нужна арабская раскладка на телефоне.</p>
          <div class="row"><button class="btn ghost" type="button" id="idk">Не знаю</button><button class="btn" type="submit">Проверить</button></div>
        </form>`;
      const inp = document.getElementById("tin");
      const finish = ok => { box.querySelectorAll("button, input").forEach(b => b.disabled = true); speak(w.ar); done([{ id: w.id, ok }], ansAr(w)); };
      document.getElementById("tf").onsubmit = e => { e.preventDefault(); if (inp.value.trim()) finish(norm(inp.value) === norm(w.ar)); };
      on("idk", () => finish(false));
      inp.focus();
    },
    match(box, t, done) {
      const ws = t.ids.map(id => byId[id]);
      const left = shuffle(ws), right = shuffle(ws);
      const errs = {};
      let sel = null, left_ = ws.length;
      box.innerHTML = `<span class="label">Соедини пары</span>
        <div class="match"><div class="col">${left.map(w => `<button class="opt ar" data-l="${w.id}">${w.ar}</button>`).join("")}</div>
        <div class="col">${right.map(w => `<button class="opt" data-r="${w.id}">${esc(w.ru)}</button>`).join("")}</div></div>`;
      const L = [...box.querySelectorAll("[data-l]")], R = [...box.querySelectorAll("[data-r]")];
      L.forEach(b => b.onclick = () => { L.forEach(x => x.classList.remove("sel")); b.classList.add("sel"); sel = b.dataset.l; speak(byId[sel].ar); });
      R.forEach(b => b.onclick = () => {
        if (!sel) return;
        if (b.dataset.r === sel) {
          b.classList.add("done"); box.querySelector(`[data-l="${sel}"]`).classList.add("done");
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
  function resultScreen({ title, res, note, test }) {
    const correct = res.filter(r => r.ok).length;
    const agg = aggregate(res);
    const bad = Object.keys(agg).filter(id => !agg[id]);
    const p = pct(correct, res.length);
    app.innerHTML = `<div class="wrap">
      <section class="panel">
        <div class="score"><span class="label">${esc(title)}</span><div class="bignum">${p}%</div><p>${correct} из ${res.length} заданий верно</p></div>
        ${note ? `<p class="muted small">${esc(note)}</p>` : ""}
      </section>
      ${bad.length ? `<section class="panel"><span class="label">Повтори эти слова</span>
        ${bad.map(id => `<div class="mist"><span style="font-size:1.4rem">${byId[id].emoji || ""}</span><span>${esc(byId[id].ru)}</span><button class="wchip" data-word="${id}">${byId[id].ar}</button></div>`).join("")}
      </section>` : ""}
      ${test ? `<section class="panel"><span class="label">Поделиться с другом</span>
        <textarea class="field" id="share" readonly>${esc(shareText(test))}</textarea>
        <button class="btn soft" id="copy">Скопировать результат</button></section>` : ""}
      <button class="btn block" id="home">На главную</button>
    </div>`;
    currentBack = home;
    on("home", home);
    on("copy", () => {
      const ta = document.getElementById("share");
      const txt = ta.value;
      if (navigator.share) { navigator.share({ text: txt }).catch(() => {}); return; }
      (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(
        () => { document.getElementById("copy").textContent = "Скопировано"; },
        () => { ta.focus(); ta.select(); });
    });
    window.scrollTo(0, 0);
  }
  function shareText(t) {
    const miss = t.mistakes.map(id => byId[id].ar + " (" + byId[id].ru + ")").join(", ");
    return `${store.current} · Зачёт, неделя ${t.week}: ${t.correct}/${t.total} (${pct(t.correct, t.total)}%)` + (miss ? `\nОшибки: ${miss}` : "\nБез ошибок!");
  }

  // ── Резервная копия ──
  function backupModal() {
    const m = document.createElement("div");
    m.className = "modal";
    m.innerHTML = `<div class="panel" role="dialog" aria-modal="true">
      <h2>Резервная копия</h2>
      <p class="muted small">Прогресс хранится только в этом браузере. Скопируй текст ниже и сохрани в заметках. Чтобы перенести прогресс на другой телефон, вставь этот текст туда и нажми «Восстановить».</p>
      <textarea class="field" id="bk">${esc(JSON.stringify(me()))}</textarea>
      <div class="row"><button class="btn soft" id="bcopy">Скопировать</button><button class="btn ghost" id="brest">Восстановить</button></div>
      <p class="small" id="bmsg"></p>
      <button class="btn ghost" id="bclose">Закрыть</button>
    </div>`;
    document.body.appendChild(m);
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
        m.remove(); home();
      } catch (e) { msg.textContent = "Текст не похож на резервную копию. Вставь его целиком."; }
    };
    m.querySelector("#bclose").onclick = () => m.remove();
  }

  if (CLOUD && store.current) openProfile(store.current); else home();
})();