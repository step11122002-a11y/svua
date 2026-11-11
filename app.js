// SVUA — выбираем кино вдвоём (веб-версия для телефонов). Степан ♥ Юлия.
"use strict";

const CFG = window.SVUA_CONFIG || {};
const SYNC = !!(CFG.supabaseUrl && CFG.supabaseKey);
const NAMES = { stepan: "Степан", yulia: "Юлия" };
const INITIALS = { stepan: "SV", yulia: "UA" };
const other = p => (p === "stepan" ? "yulia" : "stepan");
const $ = s => document.querySelector(s);

// ---------- Хранилище на телефоне ----------
const LS = {
  get(k, d) { try { const v = localStorage.getItem("svua." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("svua." + k, JSON.stringify(v)); } catch {} },
};

const S = {
  films: [], byId: new Map(), order: new Map(),
  me: LS.get("me", null),
  origin: LS.get("origin", "all"),
  tab: LS.get("tab", "deck"),
  mineFilter: "like",
  // ratings[player][kp] = { l: true|false, at: ms }
  ratings: LS.get("ratings", { stepan: {}, yulia: {} }),
  hidden: new Set(LS.get("hidden", [])),
  queue: LS.get("queue", []),          // неотправленные изменения
  seenMatches: new Set(LS.get("seenMatches", [])),
  history: [],                          // для «Вернуть» (только эта сессия)
  deck: [],
  sync: SYNC ? "wait" : "local",        // ok | wait | off | local
  lastSync: LS.get("lastSync", 0),
};

function persist() {
  LS.set("ratings", S.ratings); LS.set("hidden", [...S.hidden]); LS.set("queue", S.queue);
  LS.set("seenMatches", [...S.seenMatches]);
}

// ---------- Фильмы ----------
const posterURL = kp => `https://st.kp.yandex.net/images/film_big/${kp}.jpg`;
const q = f => encodeURIComponent(`${f.t} ${f.y}`);
const linksHTML = f => `
  <a class="kp" href="https://www.kinopoisk.ru/film/${f.kp}/" target="_blank" rel="noopener">Кинопоиск</a>
  <a class="rt" href="https://rutube.ru/search/?query=${q(f)}" target="_blank" rel="noopener">Rutube</a>
  <a class="vk" href="https://vkvideo.ru/?q=${q(f)}" target="_blank" rel="noopener">VK Видео</a>`;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const longText = f => (f.dl && f.dl.length > f.d.length + 40 ? f.dl : null);

function img(kp, alt = "") {
  return `<img src="${posterURL(kp)}" alt="${esc(alt)}" referrerpolicy="no-referrer" loading="lazy" decoding="async" onerror="this.remove()">`;
}

// Перемешивание с постоянным зерном: у каждого телефона свой порядок, но он не скачет между запусками.
function seededOrder(ids) {
  let seed = LS.get("seed", 0);
  if (!seed) { seed = Math.floor(Math.random() * 2 ** 31) + 1; LS.set("seed", seed); }
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const a = ids.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return new Map(a.map((id, i) => [id, i]));
}

// ---------- Оценки ----------
const likes = p => Object.keys(S.ratings[p]).filter(k => S.ratings[p][k].l).map(Number);
const nopes = p => Object.keys(S.ratings[p]).filter(k => !S.ratings[p][k].l).map(Number);
const rating = (p, kp) => S.ratings[p][kp];

function matches() {
  const o = S.ratings[other("stepan")];
  return likes("stepan").filter(kp => o[kp]?.l && !S.hidden.has(kp) && S.byId.has(kp))
    .map(kp => S.byId.get(kp)).sort((a, b) => a.t.localeCompare(b.t, "ru"));
}

function rebuildDeck(keepTop = true) {
  const me = S.me; if (!me) return;
  const top = keepTop ? S.deck[0] : null;
  const partner = S.ratings[other(me)];
  S.deck = S.films
    .filter(f => !S.ratings[me][f.kp])
    .filter(f => S.origin === "all" || (S.origin === "ru" ? f.ru : !f.ru))
    // сначала то, что уже понравилось второму — так совпадения находятся быстрее
    .sort((a, b) => {
      const pa = partner[a.kp]?.l ? 1 : 0, pb = partner[b.kp]?.l ? 1 : 0;
      return pb - pa || S.order.get(a.kp) - S.order.get(b.kp);
    });
  // Не подменяем карточку прямо под пальцем, если синхронизация пересобрала колоду.
  if (top && S.deck.includes(top) && S.deck[0] !== top) { S.deck.splice(S.deck.indexOf(top), 1); S.deck.unshift(top); }
}

function setRating(p, kp, value /* true | false | null */) {
  if (value === null) delete S.ratings[p][kp];
  else S.ratings[p][kp] = { l: value, at: Date.now() };
  S.queue.push(value === null ? { op: "del", p, kp } : { op: "set", p, kp, l: value });
  persist(); flushSoon();
}

// ---------- Синхронизация (Supabase REST) ----------
const API = SYNC ? CFG.supabaseUrl.replace(/\/$/, "") + "/rest/v1" : "";
const HDR = SYNC ? { apikey: CFG.supabaseKey, "Content-Type": "application/json" } : {};

async function api(path, opts = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(API + path, { ...opts, headers: { ...HDR, ...(opts.headers || {}) }, signal: ctl.signal, cache: "no-store" });
    if (!r.ok) throw new Error(r.status + " " + (await r.text()).slice(0, 200));
    return r.status === 204 ? null : r.json().catch(() => null);
  } finally { clearTimeout(t); }
}

let flushing = false, flushTimer = 0;
function flushSoon() { if (!SYNC) return; clearTimeout(flushTimer); flushTimer = setTimeout(flush, 400); setSync(S.queue.length ? "wait" : S.sync); }

async function flush() {
  if (!SYNC || flushing || !S.queue.length) return;
  flushing = true;
  try {
    while (S.queue.length) {
      const it = S.queue[0];
      if (it.op === "set") {
        await api("/ratings?on_conflict=player,kp", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify([{ player: it.p, kp: it.kp, liked: it.l, updated_at: new Date().toISOString() }]) });
      } else if (it.op === "del") {
        await api(`/ratings?player=eq.${it.p}&kp=eq.${it.kp}`, { method: "DELETE" });
      } else if (it.op === "hide") {
        await api("/hidden?on_conflict=kp", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify([{ kp: it.kp }]) });
      } else if (it.op === "unhide") {
        await api(`/hidden?kp=eq.${it.kp}`, { method: "DELETE" });
      } else if (it.op === "reset") {
        await api(`/ratings?player=eq.${it.p}`, { method: "DELETE" });
      }
      S.queue.shift(); persist();
    }
    setSync("ok");
  } catch (e) {
    console.warn("sync push", e); setSync("off");
  } finally { flushing = false; }
}

async function pull() {
  if (!SYNC) return;
  try {
    await flush();
    const rows = [];
    for (let off = 0; ; off += 1000) {
      const page = await api(`/ratings?select=player,kp,liked,updated_at&order=player.asc,kp.asc&limit=1000&offset=${off}`);
      rows.push(...page); if (page.length < 1000) break;
    }
    const hidden = await api("/hidden?select=kp");
    const fresh = { stepan: {}, yulia: {} };
    for (const r of rows) if (fresh[r.player]) fresh[r.player][r.kp] = { l: r.liked, at: Date.parse(r.updated_at) || 0 };
    // Поверх — то, что ещё не успело уйти на сервер.
    for (const it of S.queue) {
      if (it.op === "set") fresh[it.p][it.kp] = { l: it.l, at: Date.now() };
      else if (it.op === "del") delete fresh[it.p][it.kp];
      else if (it.op === "reset") fresh[it.p] = {};
    }
    const before = new Set(matches().map(f => f.kp));
    S.ratings = fresh;
    S.hidden = new Set(hidden.map(h => h.kp));
    for (const it of S.queue) { if (it.op === "hide") S.hidden.add(it.kp); if (it.op === "unhide") S.hidden.delete(it.kp); }
    S.lastSync = Date.now(); LS.set("lastSync", S.lastSync);
    persist();
    if (!S.queue.length) setSync("ok");
    // Новое совпадение, которое появилось из-за оценки второго участника.
    const fresh_m = matches().filter(f => !before.has(f.kp) && !S.seenMatches.has(f.kp));
    rebuildDeck(); render();
    if (fresh_m.length && S.me && document.visibilityState === "visible" && $("#match-overlay").hidden) showMatch(fresh_m[0]);
    else fresh_m.forEach(f => S.seenMatches.add(f.kp));
    persist();
  } catch (e) {
    console.warn("sync pull", e); setSync("off");
  }
}

function setSync(st) {
  S.sync = st;
  const dot = $("#sync-dot"); if (dot) dot.className = "dot " + (st === "local" ? "" : st);
}

// ---------- Отрисовка ----------
function render() {
  const hasMe = !!S.me;
  $("#who").hidden = hasMe;
  for (const id of ["#top", "#main", "#tabs"]) $(id).hidden = !hasMe;
  if (!hasMe) return;
  $("#me-initials").textContent = INITIALS[S.me];
  document.querySelectorAll("#origin button").forEach(b => b.classList.toggle("on", b.dataset.origin === S.origin));
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === S.tab));
  $("#origin").style.visibility = S.tab === "deck" ? "visible" : "hidden";
  $("#view-deck").hidden = S.tab !== "deck";
  $("#view-matches").hidden = S.tab !== "matches";
  $("#view-mine").hidden = S.tab !== "mine";
  const m = matches();
  $("#match-n").hidden = !m.length; $("#match-n").textContent = m.length;
  if (S.tab === "deck") renderDeck();
  if (S.tab === "matches") renderMatches(m);
  if (S.tab === "mine") renderMine();
}

let renderedTop = null;
function renderDeck(force = false) {
  const deck = $("#deck");
  const top3 = S.deck.slice(0, 3);
  const key = top3.map(f => f.kp).join(",");
  if (!force && deck.dataset.key === key) { updateButtons(); return; }
  deck.dataset.key = key;
  deck.innerHTML = "";
  if (!top3.length) {
    deck.innerHTML = `<div class="empty"><div class="badge badge-lg"><span>SV</span><i class="heart"></i><span>UA</span></div>
      <h2>${NAMES[S.me]}, фильмы закончились</h2>
      <p class="muted">${S.origin === "all" ? "Вы оценили весь каталог. Загляните в «Совпадения»." : "Попробуйте другой фильтр сверху или загляните в «Совпадения»."}</p></div>`;
    updateButtons(); return;
  }
  top3.slice().reverse().forEach((f, ri) => {
    const i = top3.length - 1 - ri;
    const el = document.createElement("article");
    el.className = "card" + (i === 1 ? " back1" : i === 2 ? " back2" : "");
    el.dataset.kp = f.kp;
    const lt = longText(f);
    el.innerHTML = `
      <div class="ph"><div class="badge badge-lg" style="opacity:.5"><span>SV</span><i class="heart"></i><span>UA</span></div></div>
      ${img(f.kp, f.t)}
      <div class="shade"></div>
      <div class="stamp stamp-like">ХОЧУ</div><div class="stamp stamp-nope">НЕТ</div>
      <div class="info">
        <h2>${esc(f.t)}</h2>
        <div class="tags"><span class="tag">${f.y}</span>${f.g ? `<span class="tag">${esc(f.g)}</span>` : ""}<span class="tag">${f.ru ? "Наше кино" : "Дубляж"}</span></div>
        <div class="desc">${esc(f.d)}</div>
        ${lt || f.d.length > 220 ? `<button class="more">Ещё ▾</button>` : ""}
        <div class="links">${linksHTML(f)}</div>
      </div>`;
    deck.appendChild(el);
    if (i === 0) { renderedTop = el; attachDrag(el, f); }
  });
  // заранее подгружаем следующие постеры
  S.deck.slice(3, 6).forEach(f => { const im = new Image(); im.referrerPolicy = "no-referrer"; im.src = posterURL(f.kp); });
  updateButtons();
}

function updateButtons() {
  const empty = !S.deck.length;
  $("#btn-like").disabled = empty || flying; $("#btn-nope").disabled = empty || flying;
  $("#btn-undo").disabled = !S.history.length;
}

function tileHTML(f, { mark = false, sub = true } = {}) {
  return `<button class="tile" data-kp="${f.kp}">
    <div class="pic"><div class="ph">${esc(f.t)}</div>${img(f.kp, f.t)}${mark ? `<span class="mark"><svg viewBox="0 0 24 24"><path class="fill" d="M12 21s-7.5-4.6-9.6-9.3C.9 8.3 3 4.5 6.7 4.5c2.1 0 3.6 1.1 4.6 2.6 1-1.5 2.5-2.6 4.6-2.6 3.7 0 5.8 3.8 4.3 7.2C19.5 16.4 12 21 12 21z"/></svg></span>` : ""}</div>
    <h4>${esc(f.t)}</h4>${sub ? `<small>${f.y}${f.g ? " · " + esc(f.g) : ""}</small>` : ""}</button>`;
}

function renderMatches(m) {
  const box = $("#matches");
  if (!m.length) {
    box.innerHTML = `<div class="list-empty"><div class="badge badge-lg"><span>SV</span><i class="heart"></i><span>UA</span></div>
      <h3>Пока нет общих фильмов</h3><p class="muted">Когда Степан и Юлия оба выберут «Хочу», фильм появится здесь.</p></div>`;
    return;
  }
  box.innerHTML = `<p class="muted small" style="margin:4px 0 12px">Оба хотят посмотреть · ${m.length}. Нажмите на фильм, чтобы открыть ссылки или убрать просмотренный.</p>
    <div class="grid big">${m.map(f => tileHTML(f)).join("")}</div>`;
}

function renderMine() {
  const ids = S.mineFilter === "like" ? likes(S.me) : nopes(S.me);
  $("#mine-like-n").textContent = likes(S.me).length;
  $("#mine-nope-n").textContent = nopes(S.me).length;
  document.querySelectorAll("#mine-filter button").forEach(b => b.classList.toggle("on", b.dataset.mine === S.mineFilter));
  const list = ids.map(kp => S.byId.get(kp)).filter(Boolean)
    .sort((a, b) => (rating(S.me, b.kp)?.at || 0) - (rating(S.me, a.kp)?.at || 0));
  const box = $("#mine");
  if (!list.length) {
    box.innerHTML = `<div class="list-empty"><h3>${S.mineFilter === "like" ? "Здесь будут фильмы, которые вы хотите посмотреть" : "Здесь будут фильмы, от которых вы отказались"}</h3>
      <p class="muted">Свайпайте на вкладке «Выбор».</p></div>`;
    return;
  }
  const partner = S.ratings[other(S.me)];
  box.innerHTML = `<div class="grid">${list.map(f => tileHTML(f, { mark: S.mineFilter === "like" && partner[f.kp]?.l, sub: false })).join("")}</div>`;
}

// ---------- Свайп ----------
let flying = false;
const glowLike = $("#glow-like"), glowNope = $("#glow-nope");
const btnLike = $("#btn-like"), btnNope = $("#btn-nope");

function paintDrag(el, dx, dy) {
  el.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 18}deg)`;
  const a = Math.min(1, Math.max(0, dx) / 120), b = Math.min(1, Math.max(0, -dx) / 120);
  el.querySelector(".stamp-like").style.opacity = a;
  el.querySelector(".stamp-nope").style.opacity = b;
  glowLike.style.opacity = a; glowNope.style.opacity = b;
  glowLike.firstElementChild.style.transform = `scale(${0.7 + 0.3 * a})`;
  glowNope.firstElementChild.style.transform = `scale(${0.7 + 0.3 * b})`;
  btnLike.style.transform = `scale(${1 + 0.22 * a})`; btnNope.style.transform = `scale(${1 + 0.22 * b})`;
  // карточка под верхней чуть «подъезжает»
  const next = el.previousElementSibling;
  if (next && next.classList.contains("back1")) {
    const k = Math.min(1, Math.abs(dx) / 140);
    next.style.transform = `translateY(${10 - 10 * k}px) scale(${0.96 + 0.04 * k})`;
    next.style.filter = `brightness(${0.7 + 0.3 * k})`;
  }
}
function clearGlow() {
  for (const g of [glowLike, glowNope]) { g.style.transition = "opacity .25s"; g.style.opacity = 0; setTimeout(() => (g.style.transition = ""), 260); }
  btnLike.style.transform = btnNope.style.transform = "";
}

function attachDrag(el, film) {
  let sx = 0, sy = 0, dx = 0, dy = 0, id = null, t0 = 0, dragging = false;
  el.addEventListener("pointerdown", e => {
    if (flying || e.button > 0) return;
    if (e.target.closest("a, button")) return;
    if (el.classList.contains("expanded") && e.target.closest(".desc")) return; // прокрутка описания
    id = e.pointerId; sx = e.clientX; sy = e.clientY; dx = dy = 0; t0 = performance.now(); dragging = false;
    el.style.transition = "none";
    el.setPointerCapture(id);
  });
  el.addEventListener("pointermove", e => {
    if (e.pointerId !== id) return;
    dx = e.clientX - sx; dy = e.clientY - sy;
    if (!dragging && Math.hypot(dx, dy) > 6) dragging = true;
    if (dragging) paintDrag(el, dx, dy * 0.35);
  });
  const end = e => {
    if (e.pointerId !== id) return;
    id = null;
    const v = dx / Math.max(1, performance.now() - t0); // px/ms
    if (Math.abs(dx) > 110 || (Math.abs(dx) > 40 && Math.abs(v) > 0.6)) { fling(dx > 0, dy * 0.35); return; }
    el.style.transition = "transform .35s cubic-bezier(.2,1.4,.4,1)";
    paintDrag(el, 0, 0); clearGlow();
    const next = el.previousElementSibling; if (next) { next.style.transform = ""; next.style.filter = ""; }
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.querySelector(".more")?.addEventListener("click", ev => {
    ev.stopPropagation();
    const lt = longText(film);
    const open = el.classList.toggle("expanded");
    el.querySelector(".desc").textContent = open && lt ? lt : film.d;
    ev.currentTarget.textContent = open ? "Свернуть ▴" : "Ещё ▾";
  });
}

function fling(like, dy = 0) {
  const film = S.deck[0]; const el = renderedTop;
  if (!film || !el || flying) return;
  flying = true; updateButtons();
  const w = window.innerWidth;
  el.style.transition = "transform .28s ease-in";
  paintDrag(el, like ? w * 1.2 : -w * 1.2, dy + 40);
  setTimeout(() => {
    clearGlow();
    commitSwipe(film, like);
    flying = false;
    renderDeck(true);
  }, 260);
}

function commitSwipe(film, like) {
  const prev = rating(S.me, film.kp) || null;
  S.history.push({ kp: film.kp, prev });
  setRating(S.me, film.kp, like);
  S.deck = S.deck.filter(f => f !== film);
  if (like && S.ratings[other(S.me)][film.kp]?.l && !S.hidden.has(film.kp)) showMatch(film);
  updateCounts();
}

function undo() {
  const h = S.history.pop(); if (!h) return;
  setRating(S.me, h.kp, h.prev ? h.prev.l : null);
  if (lastMatchKp === h.kp) closeMatch();
  rebuildDeck(false);
  const f = S.byId.get(h.kp);
  const i = S.deck.indexOf(f); if (i > 0) { S.deck.splice(i, 1); S.deck.unshift(f); }
  render(); renderDeck(true);
}

function updateCounts() {
  const m = matches(); $("#match-n").hidden = !m.length; $("#match-n").textContent = m.length;
}

// ---------- Совпадение ----------
let lastMatchKp = null;
function showMatch(f) {
  lastMatchKp = f.kp;
  S.seenMatches.add(f.kp); persist();
  $("#match-poster").innerHTML = img(f.kp, f.t);
  $("#match-title").textContent = f.t;
  $("#match-links").innerHTML = linksHTML(f);
  $("#match-overlay").hidden = false;
  if (navigator.vibrate) try { navigator.vibrate([30, 40, 30]); } catch {}
}
function closeMatch() { $("#match-overlay").hidden = true; lastMatchKp = null; }

// ---------- Карточка фильма из списка ----------
function openSheet(kp) {
  const f = S.byId.get(kp); if (!f) return;
  const r = rating(S.me, kp);
  const partnerLikes = S.ratings[other(S.me)][kp]?.l && r?.l;
  const isMatch = matches().some(m => m.kp === kp);
  $("#sheet-body").innerHTML = `
    <div class="film-head"><div class="pic">${img(kp, f.t)}</div>
      <div><h3>${esc(f.t)}</h3><div class="tags"><span class="tag">${f.y}</span>${f.g ? `<span class="tag">${esc(f.g)}</span>` : ""}<span class="tag">${f.ru ? "Наше кино" : "Дубляж"}</span></div>
      ${partnerLikes ? `<p class="partner">♥ ${NAMES[other(S.me)]} тоже хочет</p>` : ""}</div></div>
    <p class="text">${esc(longText(f) || f.d)}</p>
    <div class="links">${linksHTML(f)}</div>
    <p class="muted small" style="margin:6px 0 0">Ваша оценка</p>
    <div class="choice">
      <button data-set="like" class="${r?.l === true ? "on-like" : ""}">♥ Хочу</button>
      <button data-set="nope" class="${r?.l === false ? "on-nope" : ""}">✕ Не хочу</button>
      <button data-set="none">↩ В колоду</button>
    </div>
    ${isMatch ? `<button class="menu-item" data-hide="${kp}">Уже посмотрели — убрать из совпадений</button>` : ""}`;
  $("#sheet").hidden = false;
  $("#sheet-body").onclick = e => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.set) {
      const v = b.dataset.set === "like" ? true : b.dataset.set === "nope" ? false : null;
      setRating(S.me, kp, v);
      if (v === true && S.ratings[other(S.me)][kp]?.l) S.seenMatches.add(kp);
      closeSheet(); rebuildDeck(); render();
      toast(v === null ? "Фильм вернулся в колоду" : v ? "Отмечено: хочу" : "Отмечено: не хочу");
    } else if (b.dataset.hide) {
      S.hidden.add(kp); S.queue.push({ op: "hide", kp }); persist(); flushSoon();
      closeSheet(); render();
      toast("Убрано из совпадений", "Вернуть", () => { S.hidden.delete(kp); S.queue.push({ op: "unhide", kp }); persist(); flushSoon(); render(); });
    }
  };
}
function closeSheet() { $("#sheet").hidden = true; }

// ---------- Меню ----------
function openMenu() {
  $("#menu-name").textContent = NAMES[S.me];
  const st = { ok: "🟢 Синхронизировано", wait: "🟡 Отправляю оценки…", off: "🔴 Нет связи — оценки сохранены на телефоне и уйдут позже", local: "⚪ Синхронизация не настроена — оценки только на этом телефоне" }[S.sync];
  $("#menu-sync").textContent = st + (S.queue.length ? ` (в очереди: ${S.queue.length})` : "");
  $("#menu-stats").textContent = `В каталоге ${S.films.length} фильмов. Вы оценили ${Object.keys(S.ratings[S.me]).length}, ${NAMES[other(S.me)]} — ${Object.keys(S.ratings[other(S.me)]).length}.`;
  $("#reset-confirm").hidden = true;
  $("#menu-debug").textContent = screenInfo();
  $("#menu").hidden = false;
  pull();
}

// ---------- Тост ----------
let toastTimer = 0;
function toast(text, action, fn) {
  const t = $("#toast");
  t.innerHTML = `<span>${esc(text)}</span>${action ? `<button>${esc(action)}</button>` : ""}`;
  t.hidden = false;
  if (action) t.querySelector("button").onclick = () => { fn(); t.hidden = true; };
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 4000);
}

// ---------- События ----------
function bind() {
  document.querySelectorAll(".who-btn").forEach(b => b.addEventListener("click", () => {
    S.me = b.dataset.who; LS.set("me", S.me); S.history = []; S.tab = "deck"; LS.set("tab", "deck");
    rebuildDeck(false); render(); renderDeck(true); pull();
  }));
  $("#origin").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    S.origin = b.dataset.origin; LS.set("origin", S.origin); rebuildDeck(false); render();
  });
  $("#tabs").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    S.tab = b.dataset.tab; LS.set("tab", S.tab); render();
    if (S.tab !== "deck") document.querySelector(".list-view:not([hidden])")?.scrollTo(0, 0);
  });
  $("#mine-filter").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return; S.mineFilter = b.dataset.mine; renderMine();
  });
  $("#matches").addEventListener("click", e => { const t = e.target.closest(".tile"); if (t) openSheet(+t.dataset.kp); });
  $("#mine").addEventListener("click", e => { const t = e.target.closest(".tile"); if (t) openSheet(+t.dataset.kp); });
  $("#btn-like").addEventListener("click", () => fling(true));
  $("#btn-nope").addEventListener("click", () => fling(false));
  $("#btn-undo").addEventListener("click", undo);
  $("#match-close").addEventListener("click", closeMatch);
  $("#match-overlay").addEventListener("click", e => { if (e.target.id === "match-overlay" || e.target.classList.contains("match-box")) closeMatch(); });
  $("#sheet").addEventListener("click", e => { if (e.target.id === "sheet") closeSheet(); });
  $("#menu").addEventListener("click", e => { if (e.target.id === "menu") $("#menu").hidden = true; });
  $("#me-btn").addEventListener("click", openMenu);
  $("#menu-close").addEventListener("click", () => ($("#menu").hidden = true));
  $("#menu-switch").addEventListener("click", () => { $("#menu").hidden = true; S.me = null; LS.set("me", null); render(); });
  $("#menu-reset").addEventListener("click", () => ($("#reset-confirm").hidden = false));
  $("#reset-no").addEventListener("click", () => ($("#reset-confirm").hidden = true));
  $("#reset-yes").addEventListener("click", () => {
    S.ratings[S.me] = {}; S.queue.push({ op: "reset", p: S.me }); S.history = []; persist(); flushSoon();
    $("#menu").hidden = true; rebuildDeck(false); render(); renderDeck(true); toast("Ваш выбор стёрт");
  });

  document.addEventListener("keydown", e => {
    if (!S.me) return;
    if (!$("#match-overlay").hidden) { if (["Enter", "Escape", " "].includes(e.key)) { e.preventDefault(); closeMatch(); } return; }
    if (!$("#sheet").hidden || !$("#menu").hidden) { if (e.key === "Escape") { closeSheet(); $("#menu").hidden = true; } return; }
    if (S.tab !== "deck") return;
    if (e.key === "ArrowRight") { e.preventDefault(); fling(true); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); fling(false); }
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); }
  });

  // Синхронизация: при открытии, возврате в приложение, появлении сети и раз в 20 секунд.
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") pull(); });
  window.addEventListener("online", pull);
  setInterval(() => { if (document.visibilityState === "visible") pull(); }, 20000);
}


// ---------- iOS 26: в режиме «с экрана Домой» окно считается ниже экрана — растягиваем на весь экран ----------
const VERSION = 5;
const STANDALONE = window.navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
const IOS = /iP(hone|od|ad)/.test(navigator.platform) || (navigator.userAgent.includes("Mac") && "ontouchend" in document);
function fitHeight() {
  // iOS 26 не рисует веб-приложение у самого низа экрана: окно короче экрана, и место под полоской «Домой» уже оставлено системой.
  // Тогда собственный отступ под вкладками (safe-area-inset-bottom) лишний — обнуляем его.
  const root = document.documentElement;
  if (!(STANDALONE && IOS)) { root.style.removeProperty("--safe-b"); return; }
  const landscape = Math.abs(window.orientation || 0) === 90;
  const full = landscape ? Math.min(screen.width, screen.height) : Math.max(screen.width, screen.height);
  if (window.innerHeight < full - 20) root.style.setProperty("--safe-b", "0px");
  else root.style.removeProperty("--safe-b");
}
function screenInfo() {
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;top:0;height:env(safe-area-inset-bottom,0px);width:0;visibility:hidden";
  document.body.appendChild(probe); const sb = probe.getBoundingClientRect().height; probe.remove();
  const r = $("#app").getBoundingClientRect();
  return `v${VERSION} · экран ${screen.width}×${screen.height} · окно ${innerWidth}×${innerHeight} · vv ${Math.round(visualViewport?.height || 0)} · app ${Math.round(r.top)}–${Math.round(r.bottom)} · низ ${sb} · ${STANDALONE ? "домой" : "браузер"}`;
}

// ---------- Запуск ----------
async function start() {
  bind();
  setSync(S.sync);
  fitHeight(); addEventListener("resize", fitHeight); addEventListener("orientationchange", () => setTimeout(fitHeight, 300));
  try {
    const r = await fetch("films.json");
    S.films = await r.json();
  } catch {
    document.body.innerHTML = `<p style="padding:40px;text-align:center">Не удалось загрузить каталог. Проверьте интернет и откройте приложение ещё раз.</p>`;
    return;
  }
  S.byId = new Map(S.films.map(f => [f.kp, f]));
  S.order = seededOrder(S.films.map(f => f.kp));
  rebuildDeck(false);
  render();
  pull();
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadController) location.reload(); });
    navigator.serviceWorker.register("sw.js").then(r => r.update()).catch(() => {});
  }
}
start();
