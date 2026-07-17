/* ============================================================
   BeQuant local — single-page app
   Progress + assessments persist to site/state.json via the
   local server (/api/state), with a localStorage mirror.
   ============================================================ */
(function () {
  "use strict";
  const app = document.getElementById("app");
  const LS_KEY = "bequant.state.v2";
  const LS_OLD = "bequant.progress.v1";
  const THEME_KEY = "bequant.theme";

  let DATA = null, FLAT = [], MARKER = "<!-- PLACEHOLDER -->";
  let RUNTIME = null; // { cpp, cppCompiler, python } from /api/run probe, or null if unavailable
  const bankCache = {}; // rid -> bank json | null

  /* ===================== Store (file-backed) ===================== */
  const Store = {
    state: { v: 2, progress: {}, assessments: [], settings: {} },
    hasApi: false,
    _t: null,
    async load() {
      const local = readLocal();
      let remote = null;
      try {
        const r = await fetch("/api/state", { cache: "no-store" });
        if (r.ok) remote = await r.json();
      } catch (e) { remote = null; }
      if (remote !== null) {
        this.hasApi = true;
        if (isEmptyState(remote) && local && !isEmptyState(local)) {
          this.state = normalize(local);   // seed the file from existing browser data
          this.saveNow();
        } else {
          this.state = normalize(remote);
        }
      } else {
        this.state = normalize(local || {});
      }
      writeLocal(this.state);
    },
    save() {
      writeLocal(this.state);
      clearTimeout(this._t);
      this._t = setTimeout(() => this.saveNow(), 300);
    },
    saveNow() {
      writeLocal(this.state);
      if (this.hasApi) {
        fetch("/api/state", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(this.state) }).catch(() => {});
      }
    },
  };
  function readLocal() {
    try { const v2 = JSON.parse(localStorage.getItem(LS_KEY)); if (v2) return v2; } catch (e) {}
    try {
      const old = JSON.parse(localStorage.getItem(LS_OLD));
      if (old && typeof old === "object") {
        const progress = {};
        Object.keys(old).forEach(k => { if (old[k]) progress[k] = Date.now(); });
        return { v: 2, progress, assessments: [], settings: {} };
      }
    } catch (e) {}
    return null;
  }
  function writeLocal(s) { try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) {} }
  function normalize(s) {
    s = s || {};
    return { v: 2, progress: s.progress || {}, assessments: Array.isArray(s.assessments) ? s.assessments : [], settings: s.settings || {} };
  }
  function isEmptyState(s) { return !s || ((!s.progress || !Object.keys(s.progress).length) && (!s.assessments || !s.assessments.length)); }

  /* ===================== helpers ===================== */
  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function key(rid, m, t) { return rid + "/" + m + "/" + t; }
  function isDone(k) { return !!Store.state.progress[k]; }
  function setDone(k, on) { if (on) Store.state.progress[k] = Date.now(); else delete Store.state.progress[k]; Store.save(); }
  function pct(done, total) { return total ? Math.round((done / total) * 100) : 0; }
  function md(src) { return window.marked ? window.marked.parse(src) : esc(src); }
  function mdInline(src) { return window.marked && window.marked.parseInline ? window.marked.parseInline(src) : esc(src); }
  function hl(root) { root.querySelectorAll("pre code").forEach(el => { try { window.hljs.highlightElement(el); } catch (e) {} }); }
  function parseCases(stdout) {
    return (stdout || "").split("\n").filter(l => l.startsWith("__CASE__|")).map(l => {
      const p = l.split("|"); return { name: p[1] || "case", pass: (p[2] || "").trim() === "PASS", detail: p.slice(3).join("|") };
    });
  }
  function extractCode(mdsrc) { const m = (mdsrc || "").match(/```[a-zA-Z0-9+]*\n([\s\S]*?)```/); return m ? m[1] : (mdsrc || ""); }
  function runResultHtml(c) {
    if (c._running) return `<div class="run-result"><div class="run-summary warn">⏳ Compiling &amp; running…</div></div>`;
    const res = c._result; if (!res) return "";
    if (!res.ok) {
      if (res.stage === "compile") return `<div class="run-result"><div class="run-summary bad">✗ Compile error (${esc(res.compiler || "")})</div><div class="run-output err">${esc(res.stderr || "")}</div></div>`;
      return `<div class="run-result"><div class="run-summary bad">✗ ${esc(res.error || res.stage || "error")}</div></div>`;
    }
    const cases = parseCases(res.stdout || "");
    let h = `<div class="run-result">`;
    if (cases.length) {
      const p = cases.filter(x => x.pass).length;
      h += `<div class="run-summary ${p === cases.length ? "ok" : p > 0 ? "warn" : "bad"}">${p === cases.length ? "✓" : p > 0 ? "◑" : "✗"} ${p}/${cases.length} tests passed${res.compileMs ? ` · compiled in ${res.compileMs}ms (${esc(res.compiler || "")})` : ""}</div>`;
      h += `<div class="case-table">` + cases.map(x => `<div class="case-row ${x.pass ? "pass" : "fail"}"><span class="ct">${x.pass ? "✓" : "✗"}</span><span class="cn">${esc(x.name)}</span><span class="cd">${esc(x.detail || "")}</span></div>`).join("") + `</div>`;
    } else {
      h += `<div class="run-summary ${res.exitCode === 0 ? "ok" : "warn"}">Ran (exit ${res.exitCode})${res.compileMs ? ` · compiled in ${res.compileMs}ms` : ""}</div>`;
      if ((res.stdout || "").trim()) h += `<div class="run-output-h">stdout</div><div class="run-output">${esc(res.stdout)}</div>`;
    }
    if ((res.stderr || "").trim()) h += `<div class="run-output-h">stderr</div><div class="run-output err">${esc(res.stderr)}</div>`;
    return h + `</div>`;
  }

  function rmProgress(rm) {
    let done = 0, total = 0;
    rm.modules.forEach(m => m.topics.forEach(t => { total++; if (isDone(key(rm.id, m.slug, t.slug))) done++; }));
    return { done, total, pct: pct(done, total) };
  }
  function modProgress(rid, m) {
    let done = 0; m.topics.forEach(t => { if (isDone(key(rid, m.slug, t.slug))) done++; });
    return { done, total: m.topics.length, pct: pct(done, m.topics.length) };
  }
  function dayStr(ts) { const d = new Date(ts); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function relTime(ts) {
    const s = (Date.now() - ts) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    const d = Math.floor(s / 86400);
    if (d === 1) return "yesterday";
    if (d < 30) return d + "d ago";
    return new Date(ts).toLocaleDateString();
  }

  /* ===================== theme ===================== */
  function applyTheme(t) { document.documentElement.setAttribute("data-theme", t); localStorage.setItem(THEME_KEY, t); }
  document.getElementById("theme-btn").addEventListener("click", () =>
    applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark"));
  applyTheme(localStorage.getItem(THEME_KEY) || "dark");

  function setActiveNav(name) { document.querySelectorAll(".top-nav a").forEach(a => a.classList.toggle("active", a.dataset.nav === name)); }

  /* ===================== Overview (track DAG) ===================== */
  function renderOverview() {
    setActiveNav("learn");
    const total = FLAT.length, doneAll = FLAT.filter(f => isDone(f.key)).length;
    const g = DATA.overviewGraph;
    app.innerHTML = `<div class="page">
      <div class="page-head"><div class="eyebrow">Learning Roadmap</div><h1>${esc(DATA.title)}</h1>
        <p class="sub">${esc(DATA.tagline)} — ${total} lessons across ${DATA.roadmaps.length} tracks. ${doneAll} completed. · <a href="#/dashboard">Open dashboard →</a></p></div>
      ${g ? `<div class="dag-legend"><span>Follow the arrows — this is the suggested order to work through the tracks.</span><span class="lg"><span class="sw"></span> prerequisite flow</span></div>
        <div class="dag-wrap"><div class="dag" id="ov-dag"></div></div>`
      : `<div class="overview-grid">${DATA.roadmaps.map(overviewCard).join("")}</div>`}</div>`;
    if (g) renderOverviewDag(g);
  }

  function overviewCard(rm) {
    const p = rmProgress(rm);
    return `<a class="rm-card" href="#/r/${rm.id}">
      <div class="rm-top"><div><h2>${esc(rm.title)}</h2><div class="est">⏱ ${esc(rm.estimate)} · ${rm.modules.length} modules</div></div>
        <div class="ring" style="--p:${p.pct}"><span>${p.pct}%</span></div></div>
      <div class="modlist">${esc(rm.modules.map(m => m.title).join(" · "))}</div>
      <div class="rm-foot"><div class="bar"><i style="width:${p.pct}%"></i></div><div class="count">${p.done}/${p.total} lessons</div></div></a>`;
  }

  function renderOverviewDag(g) {
    const dag = document.getElementById("ov-dag");
    const NW = 246, NH = 118, CW = 340, RW = 150, PAD = 16;
    const pos = {}; let maxC = 0, maxR = 0;
    Object.entries(g.nodes).forEach(([id, cr]) => { pos[id] = { x: PAD + cr[0] * CW, y: PAD + cr[1] * RW }; maxC = Math.max(maxC, cr[0]); maxR = Math.max(maxR, cr[1]); });
    const W = PAD * 2 + maxC * CW + NW, H = PAD * 2 + maxR * RW + NH;
    const edgeHtml = g.edges.map(([a, b]) => {
      const sa = pos[a], sb = pos[b]; if (!sa || !sb) return "";
      const x1 = sa.x + NW, y1 = sa.y + NH / 2, x2 = sb.x, y2 = sb.y + NH / 2, dx = Math.max(40, (x2 - x1) / 2);
      return `<path d="M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}"/>`;
    }).join("");
    const nodeHtml = DATA.roadmaps.filter(rm => pos[rm.id]).map(rm => {
      const p = rmProgress(rm), complete = p.total && p.done === p.total, P = pos[rm.id];
      return `<a class="dag-track ${complete ? "complete" : ""}" href="#/r/${rm.id}" style="left:${P.x}px;top:${P.y}px;width:${NW}px">
        <div class="dt-head"><div><h3>${esc(rm.title)}</h3><div class="dt-est">⏱ ${esc(rm.estimate)} · ${rm.modules.length} modules</div></div>
          <div class="ring" style="--p:${p.pct}"><span>${p.pct}%</span></div></div>
        <div class="dt-foot"><div class="bar"><i style="width:${p.pct}%"></i></div><div class="count">${p.done}/${p.total}</div></div></a>`;
    }).join("");
    dag.style.width = W + "px"; dag.style.height = H + "px";
    dag.innerHTML = `<svg class="dag-edges" width="${W}" height="${H}">${edgeHtml}</svg>${nodeHtml}`;
  }

  /* ===================== Roadmap (DAG) ===================== */
  function renderRoadmap(rid, selMod) {
    const rm = DATA.roadmaps.find(r => r.id === rid);
    if (!rm) return renderOverview();
    setActiveNav("learn");
    let sel = rm.modules.find(m => m.slug === selMod) || rm.modules[0];
    const p = rmProgress(rm);
    app.innerHTML = `<div class="page">
      <div class="breadcrumb"><a href="#/">Learning Overview</a><span class="sep">›</span><span>${esc(rm.title)}</span></div>
      <div class="page-head"><div class="eyebrow">${rm.modules.length} modules · ${rm.topicCount} lessons</div><h1>${esc(rm.title)}</h1>
        <div class="rm-foot" style="max-width:440px;margin-top:14px"><div class="bar"><i style="width:${p.pct}%"></i></div><div class="count">${p.pct}% complete</div></div></div>
      <div class="dag-legend"><span>Follow the arrows — left to right is the suggested learning order.</span>
        <span class="lg"><span class="sw"></span> prerequisite flow</span></div>
      <div class="roadmap-layout"><div class="dag-wrap"><div class="dag" id="dag"></div></div><div class="topics-panel" id="topics-panel"></div></div></div>`;

    const dag = document.getElementById("dag");
    const panel = document.getElementById("topics-panel");

    function renderGraph() {
      const NW = 210, NH = 64, CW = 280, RW = 98, PAD = 16;
      const g = rm.graph;
      // fall back to a single-column layout if no graph data
      const layout = (g && g.nodes) ? g.nodes : Object.fromEntries(rm.modules.map((m, i) => [m.slug, [0, i]]));
      const edges = (g && g.edges) ? g.edges : [];
      const pos = {}; let maxC = 0, maxR = 0;
      Object.entries(layout).forEach(([s, cr]) => { pos[s] = { x: PAD + cr[0] * CW, y: PAD + cr[1] * RW }; maxC = Math.max(maxC, cr[0]); maxR = Math.max(maxR, cr[1]); });
      const W = PAD * 2 + maxC * CW + NW, H = PAD * 2 + maxR * RW + NH;
      const edgeHtml = edges.map(([a, b]) => {
        const sa = pos[a], sb = pos[b]; if (!sa || !sb) return "";
        const x1 = sa.x + NW, y1 = sa.y + NH / 2, x2 = sb.x, y2 = sb.y + NH / 2, dx = Math.max(34, (x2 - x1) / 2);
        const lit = (a === sel.slug || b === sel.slug) ? "lit" : "";
        return `<path class="${lit}" d="M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}"/>`;
      }).join("");
      const nodeHtml = rm.modules.filter(m => pos[m.slug]).map(m => {
        const mp = modProgress(rid, m), complete = mp.total && mp.done === mp.total, P = pos[m.slug];
        return `<button class="dag-node ${m.slug === sel.slug ? "active" : ""} ${complete ? "complete" : ""}" data-mod="${m.slug}" style="left:${P.x}px;top:${P.y}px;width:${NW}px">
          <span class="dn-title"><span class="dn-dot"></span><span>${esc(m.title)}</span>${m.inferred ? '<span class="inferred-tag">inf</span>' : ""}</span>
          <span class="dn-foot"><span class="mini-bar"><i style="width:${mp.pct}%"></i></span><span class="dn-pct">${mp.done}/${mp.total}</span></span></button>`;
      }).join("");
      dag.style.width = W + "px"; dag.style.height = H + "px";
      dag.innerHTML = `<svg class="dag-edges" width="${W}" height="${H}">${edgeHtml}</svg>${nodeHtml}`;
      dag.querySelectorAll(".dag-node").forEach(btn => btn.addEventListener("click", () => {
        sel = rm.modules.find(m => m.slug === btn.dataset.mod); renderGraph(); paintPanel(sel);
      }));
    }

    function paintPanel(m) {
      const mp = modProgress(rid, m);
      const rows = m.topics.map(t => {
        const k = key(rid, m.slug, t.slug), done = isDone(k);
        return `<div class="topic-row ${done ? "done" : "todo"}">
          <button class="check" data-k="${k}" title="Mark ${done ? "incomplete" : "complete"}">✓</button>
          <a class="t-title" href="#/r/${rid}/${m.slug}/${t.slug}" style="color:inherit">${esc(t.title)}</a>
          <span class="badge ${t.difficulty}">${t.difficulty}</span></div>`;
      }).join("");
      panel.innerHTML = `<div class="tp-head"><h3>${esc(m.title)}</h3>
        <span class="tp-sub">${mp.done}/${mp.total} done · <a href="#/quiz/${rid}/${m.slug}">Take quiz →</a></span></div>${rows}`;
      panel.querySelectorAll("button.check").forEach(b => b.addEventListener("click", e => {
        e.preventDefault(); e.stopPropagation();
        setDone(b.dataset.k, !isDone(b.dataset.k));
        renderGraph(); paintPanel(m); // refresh node bars + panel counts in place
      }));
    }

    renderGraph();
    paintPanel(sel);
  }

  /* ===================== Lesson ===================== */
  async function renderLesson(rid, mslug, tslug) {
    const rm = DATA.roadmaps.find(r => r.id === rid);
    const m = rm && rm.modules.find(x => x.slug === mslug);
    const t = m && m.topics.find(x => x.slug === tslug);
    if (!t) return renderOverview();
    setActiveNav("learn");
    const k = key(rid, mslug, tslug);
    const flatRm = FLAT.filter(f => f.rid === rid);
    const idx = flatRm.findIndex(f => f.tslug === tslug && f.mslug === mslug);
    const prev = flatRm[idx - 1], next = flatRm[idx + 1];
    const sideLinks = m.topics.map(x => {
      const dk = key(rid, mslug, x.slug);
      return `<a class="${x.slug === tslug ? "current" : ""}" href="#/r/${rid}/${mslug}/${x.slug}">${isDone(dk) ? '<span class="dn">✓</span>' : ""}${esc(x.title)}</a>`;
    }).join("");

    app.innerHTML = `<div class="page"><div class="lesson-layout">
      <aside class="lesson-side"><p class="ls-mod">${esc(m.title)}</p>${sideLinks}</aside>
      <div class="lesson-main">
        <div class="breadcrumb"><a href="#/">Overview</a><span class="sep">›</span><a href="#/r/${rid}">${esc(rm.title)}</a><span class="sep">›</span><span>${esc(m.title)}</span></div>
        <h1 class="lesson-title">${esc(t.title)}</h1>
        <div class="lesson-meta"><span class="badge ${t.difficulty}">${t.difficulty}</span>
          <button class="complete-btn ${isDone(k) ? "done" : ""}" id="complete-btn">${isDone(k) ? "✓ Completed" : "Mark as complete"}</button>
          <a class="btn btn-ghost btn-sm" href="#/quiz/${rid}/${mslug}">Quiz this module →</a></div>
        <div class="article" id="article"><div class="loading">Loading lesson…</div></div>
        <div class="lesson-nav">
          ${prev ? `<a class="prev" href="${prev.route}"><div class="nv-label">← Previous</div><div class="nv-title">${esc(prev.title)}</div></a>` : "<span></span>"}
          ${next ? `<a class="next" href="${next.route}"><div class="nv-label">Next →</div><div class="nv-title">${esc(next.title)}</div></a>` : "<span></span>"}</div>
      </div><aside class="lesson-toc" id="toc"></aside></div></div>`;

    document.getElementById("complete-btn").addEventListener("click", function () {
      const on = !isDone(k); setDone(k, on);
      this.classList.toggle("done", on);
      this.textContent = on ? "✓ Completed" : "Mark as complete";
      const cur = app.querySelector(".lesson-side a.current");
      if (cur) cur.innerHTML = (on ? '<span class="dn">✓</span>' : "") + esc(t.title);
    });

    const articleEl = document.getElementById("article");
    let src;
    try { const res = await fetch(t.contentPath, { cache: "no-cache" }); src = res.ok ? await res.text() : null; }
    catch (e) { src = null; }
    if (src == null || src.trim().startsWith(MARKER)) {
      articleEl.innerHTML = `<div class="coming-soon"><div class="cs-icon">✍️</div><h3>Lesson coming soon</h3><p>This article hasn't been written yet.</p></div>`;
      document.getElementById("toc").innerHTML = ""; window.scrollTo(0, 0); return;
    }
    articleEl.innerHTML = md(src.replace(/^﻿?\s*#[^\n]*\n+/, ""));
    hl(articleEl);
    articleEl.querySelectorAll("a[href]").forEach(a => {
      const href = a.getAttribute("href");
      if (!href || !href.includes(".md") || /^(https?:|#|mailto:)/.test(href)) return;
      try {
        const clean = new URL(href, "http://x/" + t.contentPath).pathname.replace(/^\/+/, "").split("#")[0];
        const f = FLAT.find(x => x.contentPath === clean);
        if (f) a.setAttribute("href", f.route);
      } catch (e) {}
    });
    const toc = [];
    articleEl.querySelectorAll("h2, h3").forEach((h, i) => {
      const id = "s" + i + "-" + (h.textContent || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      h.id = id; toc.push(`<a class="${h.tagName === "H3" ? "h3" : ""}" href="#${id}" data-toc>${esc(h.textContent)}</a>`);
    });
    const tocEl = document.getElementById("toc");
    tocEl.innerHTML = toc.length ? `<div class="toc-h">On this page</div>${toc.join("")}` : "";
    tocEl.querySelectorAll("[data-toc]").forEach(a => a.addEventListener("click", e => {
      e.preventDefault(); const el = document.getElementById(a.getAttribute("href").slice(1)); if (el) el.scrollIntoView({ behavior: "smooth" });
    }));
    window.scrollTo(0, 0);
  }

  /* ===================== Dashboard ===================== */
  function latestResultsByModule() {
    const map = {}; // rid/mslug -> result (latest)
    Store.state.assessments.forEach(a => {
      const id = a.rid + "/" + a.mslug;
      if (!map[id] || a.date > map[id].date) map[id] = a;
    });
    return map;
  }
  function streakInfo() {
    const days = new Set();
    Object.values(Store.state.progress).forEach(ts => days.add(dayStr(ts)));
    Store.state.assessments.forEach(a => days.add(dayStr(a.date)));
    let streak = 0; const d = new Date();
    if (!days.has(dayStr(d.getTime()))) d.setDate(d.getDate() - 1); // allow yesterday
    while (days.has(dayStr(d.getTime()))) { streak++; d.setDate(d.getDate() - 1); }
    return { streak, activeDays: days.size };
  }

  function renderDashboard() {
    setActiveNav("dashboard");
    const total = FLAT.length, done = FLAT.filter(f => isDone(f.key)).length, op = pct(done, total);
    const week = Object.values(Store.state.progress).filter(ts => Date.now() - ts < 7 * 864e5).length;
    const { streak, activeDays } = streakInfo();
    const results = latestResultsByModule(), resVals = Object.values(results);
    const quizzesTaken = Store.state.assessments.length;
    const avgQuiz = resVals.length ? Math.round(resVals.reduce((s, r) => s + r.pct, 0) / resVals.length) : null;

    // difficulty
    const diff = { Easy: { d: 0, t: 0 }, Medium: { d: 0, t: 0 }, Hard: { d: 0, t: 0 } };
    FLAT.forEach(f => { diff[f.difficulty].t++; if (isDone(f.key)) diff[f.difficulty].d++; });

    // per-track
    const trackCards = DATA.roadmaps.map(rm => {
      const p = rmProgress(rm);
      const tr = resVals.filter(r => r.rid === rm.id);
      const q = tr.length ? Math.round(tr.reduce((s, r) => s + r.pct, 0) / tr.length) : null;
      return `<div class="track-card"><h3>${esc(rm.title)}</h3><div class="tc-sub">${rm.modules.length} modules</div>
        <div class="tc-row"><span class="lbl">Lessons</span><div class="bar"><i style="width:${p.pct}%"></i></div><span>${p.pct}%</span></div>
        <div class="tc-row"><span class="lbl">Quizzes</span>${q == null ? '<span class="empty-note">not taken</span>' : `<div class="bar"><i style="width:${q}%;background:linear-gradient(90deg,var(--accent),#6d5bff)"></i></div><span>${q}%</span>`}</div>
        <div style="margin-top:12px"><a class="btn btn-ghost btn-sm" href="#/r/${rm.id}">Open →</a></div></div>`;
    }).join("");

    // module signals → heatmap + strengths/focus
    const mods = [];
    DATA.roadmaps.forEach(rm => rm.modules.forEach(m => {
      const mp = modProgress(rm.id, m), r = results[rm.id + "/" + m.slug];
      mods.push({ rid: rm.id, rmTitle: rm.title, slug: m.slug, title: m.title, comp: mp.pct, done: mp.done, total: mp.total, quiz: r ? r.pct : null });
    }));
    const heat = mods.map(m => {
      const a = (m.comp / 100) * 0.85 + (m.comp > 0 ? 0.15 : 0);
      const bg = m.comp > 0 ? `background:color-mix(in srgb, var(--done) ${Math.round(m.comp)}%, var(--bg-elev));` : "";
      return `<a class="heat-cell" href="#/r/${m.rid}" title="${esc(m.rmTitle)} · ${m.comp}%" style="${bg}">
        <span class="hc-name">${esc(m.title)}</span><span class="hc-meta">${m.done}/${m.total} · ${m.comp}%${m.quiz != null ? " · quiz " + m.quiz + "%" : ""}</span></a>`;
    }).join("");

    const strengths = mods.filter(m => m.comp >= 80 || (m.quiz != null && m.quiz >= 80))
      .sort((a, b) => (b.comp + (b.quiz || 0)) - (a.comp + (a.quiz || 0))).slice(0, 8);
    const focus = mods.filter(m => (m.comp > 0 && m.comp < 60) || (m.quiz != null && m.quiz < 60))
      .sort((a, b) => (a.comp + (a.quiz || 0)) - (b.comp + (b.quiz || 0))).slice(0, 8);

    // recent
    const recentLessons = Object.entries(Store.state.progress).map(([k, ts]) => ({ k, ts }))
      .sort((a, b) => b.ts - a.ts).slice(0, 7)
      .map(e => { const f = FLAT.find(x => x.key === e.k); return f ? `<div class="recent-item"><span class="ri-ic">✓</span><a href="${f.route}">${esc(f.title)}</a><span class="ri-when">${relTime(e.ts)}</span></div>` : ""; }).join("");
    const recentQuizzes = Store.state.assessments.slice().sort((a, b) => b.date - a.date).slice(0, 5)
      .map(a => `<div class="recent-item"><span class="ri-ic">📝</span><a href="#/quiz/${a.rid}/${a.mslug}">${esc(a.label)}</a><span class="qr-score ${a.pct >= 80 ? "good" : a.pct >= 60 ? "mid" : "low"}" style="margin-left:8px">${a.pct}%</span><span class="ri-when">${relTime(a.date)}</span></div>`).join("");

    // continue
    const nextLesson = FLAT.find(f => !isDone(f.key));

    // quizzes list grouped by track
    const quizList = DATA.roadmaps.map(rm => {
      const rows = rm.modules.map(m => {
        const r = results[rm.id + "/" + m.slug];
        const sc = r ? `<span class="qr-score ${r.pct >= 80 ? "good" : r.pct >= 60 ? "mid" : "low"}">${r.pct}%</span>` : '<span class="empty-note">—</span>';
        return `<div class="quiz-row"><div class="qr-body"><div class="qr-title">${esc(m.title)}</div><div class="qr-sub">${r ? "last: " + relTime(r.date) : "not attempted"}</div></div>
          ${sc}<a class="btn btn-sm ${r ? "btn-ghost" : "btn-primary"}" href="#/quiz/${rm.id}/${m.slug}">${r ? "Retake" : "Take quiz"}</a></div>`;
      }).join("");
      return `<div class="track-block-h">${esc(rm.title)}</div><div class="quiz-list">${rows}</div>`;
    }).join("");

    app.innerHTML = `<div class="page">
      <div class="dash-head"><div class="page-head" style="margin:0"><div class="eyebrow">Your progress</div><h1>Dashboard</h1></div>
        <div class="dash-actions">
          ${nextLesson ? `<a class="btn btn-primary" href="${nextLesson.route}">▶ Continue: ${esc(nextLesson.title.slice(0, 28))}${nextLesson.title.length > 28 ? "…" : ""}</a>` : '<span class="chip good">🎉 All lessons complete!</span>'}
          <button class="btn btn-ghost btn-sm" id="export-btn">⬇ Export</button>
          <button class="btn btn-ghost btn-sm" id="import-btn">⬆ Import</button>
          <button class="btn btn-ghost btn-sm btn-danger" id="reset-btn">Reset</button>
          <input type="file" id="import-file" accept="application/json" hidden></div></div>

      <div class="stat-row">
        <div class="stat-tile hero"><div class="bigring" style="--p:${op}"><b>${op}%</b></div>
          <div><div class="sv">${done}<span style="font-size:16px;color:var(--text-faint)">/${total}</span></div><div class="sl">lessons completed</div></div></div>
        <div class="stat-tile"><div class="sv">🔥 ${streak}</div><div class="sl">day streak</div></div>
        <div class="stat-tile"><div class="sv">${activeDays}</div><div class="sl">active days</div></div>
        <div class="stat-tile"><div class="sv">${week}</div><div class="sl">lessons this week</div></div>
        <div class="stat-tile"><div class="sv">${quizzesTaken}</div><div class="sl">quizzes taken</div></div>
        <div class="stat-tile"><div class="sv">${avgQuiz == null ? "—" : avgQuiz + "%"}</div><div class="sl">avg quiz score</div></div>
      </div>

      <div class="dash-section"><h2>Tracks</h2><div class="track-grid">${trackCards}</div></div>

      <div class="dash-section"><h2>Difficulty mastery <span class="sec-sub">where your completed lessons sit</span></h2>
        <div class="panel"><div class="diff-bars">${["Easy", "Medium", "Hard"].map(d => {
          const x = diff[d]; const p = pct(x.d, x.t);
          return `<div class="diff-row"><span class="dlabel ${d}">${d}</span><div class="bar"><i class="${d}" style="width:${p}%"></i></div><span class="dcount">${x.d}/${x.t} · ${p}%</span></div>`;
        }).join("")}</div></div></div>

      <div class="dash-section"><div class="two-col">
        <div class="panel"><h3>💪 Strengths</h3>${strengths.length ? `<div class="chips">${strengths.map(m => `<a class="chip good" href="#/r/${m.rid}">${esc(m.title)} · ${m.comp}%</a>`).join("")}</div>` : '<p class="empty-note">Complete lessons or score 80%+ on a quiz to surface strengths.</p>'}</div>
        <div class="panel"><h3>🎯 Focus areas</h3>${focus.length ? `<div class="chips">${focus.map(m => `<a class="chip focus" href="#/r/${m.rid}">${esc(m.title)} · ${m.comp}%${m.quiz != null ? " / quiz " + m.quiz + "%" : ""}</a>`).join("")}</div>` : '<p class="empty-note">Started-but-incomplete modules and low quiz scores will show up here.</p>'}</div>
      </div></div>

      <div class="dash-section"><h2>Module map <span class="sec-sub">${mods.length} modules</span></h2><div class="heatmap">${heat}</div></div>

      <div class="dash-section"><div class="two-col">
        <div class="panel"><h3>Recently completed</h3><div class="recent-list">${recentLessons || '<p class="empty-note">No lessons completed yet.</p>'}</div></div>
        <div class="panel"><h3>Recent quizzes</h3><div class="recent-list">${recentQuizzes || '<p class="empty-note">No quizzes taken yet.</p>'}</div></div>
      </div></div>

      <div class="dash-section"><h2>Self-assessment <span class="sec-sub">MCQs + coding challenges per module</span></h2>${quizList}</div>
    </div>`;

    document.getElementById("export-btn").addEventListener("click", exportState);
    document.getElementById("reset-btn").addEventListener("click", resetState);
    const fileInput = document.getElementById("import-file");
    document.getElementById("import-btn").addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", importState);
  }

  function exportState() {
    const blob = new Blob([JSON.stringify(Store.state, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "bequant-progress.json"; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function importState(e) {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try { Store.state = normalize(JSON.parse(reader.result)); Store.saveNow(); renderDashboard(); }
      catch (err) { alert("Could not import: " + err.message); }
    };
    reader.readAsText(file);
  }
  function resetState() {
    if (!confirm("Reset ALL progress and assessment results? This cannot be undone.")) return;
    Store.state = { v: 2, progress: {}, assessments: [], settings: {} };
    Store.saveNow(); renderDashboard();
  }

  /* ===================== Quiz / Assessment ===================== */
  async function loadBank(rid) {
    if (rid in bankCache) return bankCache[rid];
    try { const r = await fetch(`assessments/${rid}.json`, { cache: "no-cache" }); bankCache[rid] = r.ok ? await r.json() : null; }
    catch (e) { bankCache[rid] = null; }
    return bankCache[rid];
  }

  async function renderQuiz(rid, mslug) {
    setActiveNav("dashboard");
    const rm = DATA.roadmaps.find(r => r.id === rid);
    const mod = rm && rm.modules.find(m => m.slug === mslug);
    if (!mod) return renderOverview();
    app.innerHTML = `<div class="page"><div class="loading">Loading quiz…</div></div>`;
    const bank = await loadBank(rid);
    const qb = bank && bank.modules && bank.modules[mslug] ? bank.modules[mslug] : null;
    const mcqs = (qb && qb.mcqs) || [];
    const coding = (qb && qb.coding) || [];

    if (!mcqs.length && !coding.length) {
      app.innerHTML = `<div class="page"><div class="breadcrumb"><a href="#/r/${rid}">${esc(rm.title)}</a><span class="sep">›</span><span>${esc(mod.title)}</span></div>
        <div class="coming-soon"><div class="cs-icon">📝</div><h3>Quiz coming soon</h3>
        <p>Questions for <b>${esc(mod.title)}</b> haven't been generated yet.</p>
        <p><a class="btn btn-ghost" href="#/dashboard">Back to dashboard</a></p></div></div>`;
      return;
    }

    const sel = {};   // mcq index -> chosen option
    const rate = {};  // coding index -> got|partial|missed
    let submitted = false;

    function paint() {
      const mcqHtml = mcqs.map((q, i) => {
        const opts = q.options.map((o, oi) => {
          let cls = "opt";
          if (submitted) { cls += " locked"; if (oi === q.answer) cls += " correct"; else if (sel[i] === oi) cls += " wrong"; }
          else if (sel[i] === oi) cls += " selected";
          return `<div class="${cls}" data-q="${i}" data-o="${oi}"><span class="opt-key">${String.fromCharCode(65 + oi)}</span><span>${mdInline(o)}</span></div>`;
        }).join("");
        const exp = submitted ? `<div class="q-explain ${sel[i] === q.answer ? "ok" : "no"}">${sel[i] === q.answer ? "✓ Correct. " : "✗ "}${mdInline(q.explanation || "")}</div>` : "";
        return `<div class="q-card"><div><span class="q-kind">MCQ ${i + 1}</span><span class="q-topic">${esc(q.topic || mod.title)}</span></div>
          <div class="q-text">${md(q.q)}</div><div class="q-options">${opts}</div>${exp}</div>`;
      }).join("");

      const codeHtml = coding.map((c, i) => {
        const r = rate[i];
        const revealed = submitted || c._revealed;
        const lang = c.lang || (rid === "python" ? "python" : "cpp");
        const runnable = !!c.harness;
        const editorVal = c._attempt != null ? c._attempt : (c.starter || "");
        const canRun = runnable && RUNTIME && (lang !== "cpp" || RUNTIME.cpp);
        let runBar = "";
        if (runnable) {
          runBar = `<div class="run-bar">
            ${canRun ? `<button class="btn btn-primary btn-sm" data-run="${i}" ${c._running ? "disabled" : ""}>▶ Run tests</button>`
              : `<span class="run-note">⚠ ${lang === "cpp" ? "No C++ compiler detected" : "Runner unavailable"} — start the app with <code>./serve.sh</code> to run code here.</span>`}
            <button class="btn btn-ghost btn-sm" data-loadref="${i}">Load reference into editor</button>
            <span class="run-note">${lang.toUpperCase()} · compiled &amp; tested locally${RUNTIME && RUNTIME.cppCompiler && lang === "cpp" ? " (" + esc(RUNTIME.cppCompiler) + ")" : ""}</span></div>${runResultHtml(c)}`;
        }
        return `<div class="q-card"><div><span class="q-kind">Coding ${i + 1}${runnable ? " · runnable" : ""}</span><span class="q-topic">${esc(c.topic || mod.title)}</span></div>
          <div class="q-text">${md(c.prompt)}</div>
          ${c.hints && c.hints.length ? `<details style="margin:8px 0"><summary style="cursor:pointer;color:var(--text-dim)">Hints</summary><ul>${c.hints.map(h => `<li>${mdInline(h)}</li>`).join("")}</ul></details>` : ""}
          <textarea class="code-attempt" data-c="${i}" spellcheck="false" placeholder="// write your solution here…">${esc(editorVal)}</textarea>
          ${runBar}
          ${revealed ? `<div class="run-output-h">Reference solution (commented)</div><div class="reveal-sol">${md(c.solution || "")}${c.discussion ? `<div class="q-explain">${mdInline(c.discussion)}</div>` : ""}</div>`
            : `<button class="btn btn-ghost btn-sm reveal-sol" data-reveal="${i}" style="margin-top:12px">Reveal reference solution</button>`}
          <div class="self-rate"><span class="sr-label">Self-rate:</span>
            <button class="rate-btn got ${r === "got" ? "active" : ""}" data-rate="${i}" data-v="got">Got it</button>
            <button class="rate-btn partial ${r === "partial" ? "active" : ""}" data-rate="${i}" data-v="partial">Partial</button>
            <button class="rate-btn missed ${r === "missed" ? "active" : ""}" data-rate="${i}" data-v="missed">Missed</button>
            ${runnable ? `<span class="run-note">auto-set from test results when you Run</span>` : ""}</div></div>`;
      }).join("");

      let resultHtml = "";
      if (submitted) {
        const mc = mcqs.reduce((s, q, i) => s + (sel[i] === q.answer ? 1 : 0), 0);
        const got = coding.filter((_, i) => rate[i] === "got").length;
        const partial = coding.filter((_, i) => rate[i] === "partial").length;
        const missed = coding.length - got - partial;
        const earned = mc + got + partial * 0.5, tot = mcqs.length + coding.length;
        const p = pct(Math.round(earned * 10), tot * 10);
        resultHtml = `<div class="quiz-result"><div class="score-ring" style="--p:${p}"><b>${p}%</b></div>
          <h2>${p >= 80 ? "Strong work 💪" : p >= 60 ? "Solid — review the misses" : "Worth another pass"}</h2>
          <div class="result-breakdown"><span>MCQ: <b>${mc}/${mcqs.length}</b></span>${coding.length ? `<span>Coding: <b>${got}</b> got · <b>${partial}</b> partial · <b>${missed}</b> missed</span>` : ""}</div>
          <div style="margin-top:18px;display:flex;gap:10px;justify-content:center"><a class="btn btn-ghost" href="#/dashboard">Dashboard</a><button class="btn btn-primary" id="retake-btn">Retake</button></div></div>`;
      }

      app.innerHTML = `<div class="page"><div class="quiz-wrap">
        <div class="breadcrumb"><a href="#/dashboard">Dashboard</a><span class="sep">›</span><a href="#/r/${rid}">${esc(rm.title)}</a><span class="sep">›</span><span>${esc(mod.title)}</span></div>
        <div class="page-head"><div class="eyebrow">Self-assessment</div><h1>${esc(mod.title)} quiz</h1>
          <p class="sub">${mcqs.length} multiple-choice · ${coding.length} coding challenge${coding.length === 1 ? "" : "s"}</p></div>
        ${resultHtml}${mcqHtml}${codeHtml}
        ${submitted ? "" : `<div style="margin:24px 0;text-align:center"><button class="btn btn-primary" id="finish-btn">Finish &amp; score</button></div>`}
      </div></div>`;

      app.querySelectorAll(".q-card pre code").forEach(el => { try { window.hljs.highlightElement(el); } catch (e) {} });

      // coding handlers — available before AND after submit
      app.querySelectorAll(".code-attempt").forEach(ta => ta.addEventListener("input", () => { coding[+ta.dataset.c]._attempt = ta.value; }));
      app.querySelectorAll("[data-reveal]").forEach(b => b.addEventListener("click", () => { coding[+b.dataset.reveal]._revealed = true; paint(); }));
      app.querySelectorAll("[data-loadref]").forEach(b => b.addEventListener("click", () => { const i = +b.dataset.loadref; coding[i]._attempt = extractCode(coding[i].solution); paint(); }));
      app.querySelectorAll("[data-run]").forEach(b => b.addEventListener("click", () => runCoding(+b.dataset.run)));
      app.querySelectorAll("[data-rate]").forEach(b => b.addEventListener("click", () => { rate[+b.dataset.rate] = b.dataset.v; if (submitted) saveResult(true); paint(); }));
      if (!submitted) {
        app.querySelectorAll(".opt").forEach(o => o.addEventListener("click", () => { sel[+o.dataset.q] = +o.dataset.o; paint(); }));
        const fin = document.getElementById("finish-btn");
        if (fin) fin.addEventListener("click", () => {
          const unanswered = mcqs.filter((_, i) => sel[i] == null).length + coding.filter((_, i) => !rate[i]).length;
          if (unanswered && !confirm(`${unanswered} item(s) unanswered (counted as missed). Score anyway?`)) return;
          submitted = true; saveResult(); window.scrollTo(0, 0); paint();
        });
      } else {
        const rt = document.getElementById("retake-btn");
        if (rt) rt.addEventListener("click", () => { renderQuiz(rid, mslug); });
      }
    }

    function saveResult(replaceLast) {
      const mc = mcqs.reduce((s, q, i) => s + (sel[i] === q.answer ? 1 : 0), 0);
      const got = coding.filter((_, i) => rate[i] === "got").length;
      const partial = coding.filter((_, i) => rate[i] === "partial").length;
      const earned = mc + got + partial * 0.5, tot = mcqs.length + coding.length;
      const p = tot ? Math.round((earned / tot) * 100) : 0;
      const result = { rid, mslug, label: mod.title, date: Date.now(),
        mcq: { correct: mc, total: mcqs.length }, coding: { got, partial, missed: coding.length - got - partial, total: coding.length }, pct: p };
      if (replaceLast && Store.state.assessments.length) {
        // update the result we just created for this attempt (re-rating after submit)
        const last = Store.state.assessments[Store.state.assessments.length - 1];
        if (last.rid === rid && last.mslug === mslug && Date.now() - last.date < 36e5) { Object.assign(last, result, { date: last.date }); Store.save(); return; }
      }
      Store.state.assessments.push(result); Store.save();
    }

    async function runCoding(i) {
      const c = coding[i];
      const lang = c.lang || (rid === "python" ? "python" : "cpp");
      c._running = true; c._result = null; paint();
      const source = (c._attempt != null ? c._attempt : (c.starter || "")) + "\n" + (c.harness || "");
      let res;
      try {
        res = await (await fetch("/api/run", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lang, source, timeoutMs: 6000 }) })).json();
      } catch (e) { res = { ok: false, stage: "error", error: "Runner unavailable — start the app with ./serve.sh" }; }
      c._running = false; c._result = res;
      if (res.ok && res.stage === "run") {
        const cs = parseCases(res.stdout);
        if (cs.length) { const p = cs.filter(x => x.pass).length; rate[i] = p === cs.length ? "got" : p > 0 ? "partial" : "missed"; }
      } else if (res.stage === "compile" || res.stage === "timeout") { rate[i] = "missed"; }
      if (submitted) saveResult(true);
      paint();
    }

    paint();
    window.scrollTo(0, 0);
  }

  /* ===================== router ===================== */
  function route() {
    closeSearch();
    const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
    if (parts[0] === "dashboard") return renderDashboard();
    if (parts[0] === "quiz" && parts.length >= 3) return renderQuiz(parts[1], parts[2]);
    if (parts[0] === "r" && parts.length === 2) return renderRoadmap(parts[1]);
    if (parts[0] === "r" && parts.length >= 4) return renderLesson(parts[1], parts[2], parts[3]);
    return renderOverview();
  }

  /* ===================== search ===================== */
  const overlay = document.getElementById("search-overlay");
  const sInput = document.getElementById("search-input");
  const sResults = document.getElementById("search-results");
  let sSel = 0, sList = [];
  function openSearch() { overlay.hidden = false; sInput.value = ""; runSearch(""); sInput.focus(); }
  function closeSearch() { overlay.hidden = true; }
  function runSearch(q) {
    q = q.trim().toLowerCase();
    sList = (q ? FLAT.filter(f => f.title.toLowerCase().includes(q) || f.mTitle.toLowerCase().includes(q) || f.rmTitle.toLowerCase().includes(q)) : FLAT).slice(0, 40);
    sSel = 0;
    sResults.innerHTML = sList.map((f, i) => `<li class="${i === 0 ? "sel" : ""}" data-i="${i}"><span class="badge ${f.difficulty}">${f.difficulty[0]}</span><span class="sr-title">${esc(f.title)}</span><span class="sr-path">${esc(f.rmTitle)} › ${esc(f.mTitle)}</span></li>`).join("") || `<li style="color:var(--text-faint)">No matches</li>`;
    sResults.querySelectorAll("li[data-i]").forEach(li => li.addEventListener("click", () => go(sList[+li.dataset.i])));
  }
  function go(f) { if (f) { closeSearch(); location.hash = f.route; } }
  function moveSel(d) {
    const items = sResults.querySelectorAll("li[data-i]"); if (!items.length) return;
    items[sSel] && items[sSel].classList.remove("sel");
    sSel = (sSel + d + items.length) % items.length; items[sSel].classList.add("sel"); items[sSel].scrollIntoView({ block: "nearest" });
  }
  document.getElementById("search-btn").addEventListener("click", openSearch);
  sInput.addEventListener("input", () => runSearch(sInput.value));
  document.addEventListener("keydown", e => {
    if (e.key === "/" && overlay.hidden && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); openSearch(); }
    else if (!overlay.hidden) {
      if (e.key === "Escape") closeSearch();
      else if (e.key === "ArrowDown") { e.preventDefault(); moveSel(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); moveSel(-1); }
      else if (e.key === "Enter") { e.preventDefault(); go(sList[sSel]); }
    }
  });
  overlay.addEventListener("click", e => { if (e.target === overlay) closeSearch(); });

  /* ===================== init ===================== */
  (async function init() {
    try {
      const data = await (await fetch("curriculum.json", { cache: "no-cache" })).json();
      DATA = data; MARKER = data.placeholderMarker || MARKER;
      DATA.roadmaps.forEach(rm => rm.modules.forEach(m => m.topics.forEach(t => {
        FLAT.push({ rid: rm.id, rmTitle: rm.title, mslug: m.slug, mTitle: m.title, tslug: t.slug, title: t.title,
          difficulty: t.difficulty, contentPath: t.contentPath, key: key(rm.id, m.slug, t.slug), route: `#/r/${rm.id}/${m.slug}/${t.slug}` });
      })));
      if (window.marked) window.marked.setOptions({ gfm: true, breaks: false });
      await Store.load();
      try { RUNTIME = await (await fetch("/api/runtime", { cache: "no-store" })).json(); } catch (e) { RUNTIME = null; }
      window.addEventListener("hashchange", route);
      route();
    } catch (err) {
      app.innerHTML = `<div class="page"><div class="coming-soon"><h3>Could not start the app</h3>
        <p>Run it through the local server: <code>cd site &amp;&amp; ./serve.sh</code> then open <code>http://localhost:8000</code></p>
        <p style="color:var(--hard)">${esc(err.message || err)}</p></div></div>`;
    }
  })();
})();
