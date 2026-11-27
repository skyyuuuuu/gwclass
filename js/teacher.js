import {
  configured, db, waitUser, isAdmin, createStudentAuth, changeOwnPassword, logout, errText, esc, toast, setupNotice,
  doc, collection, getDoc, getDocs, setDoc, updateDoc, writeBatch, deleteField
} from "./fb.js";
import { SCHOOL_NAME, DEFAULT_CLASSES } from "./config.js";

const STATUS = [["", "未登記"], ["done", "已交"], ["late", "遲交"], ["makeup", "補交"], ["missing", "未交"], ["exempt", "免交"]];
const STATUS_LABEL = Object.fromEntries(STATUS);
const SUBMITTED = { done: 1, late: 1, makeup: 1 };
const PASS = 0.6;
const UI_KEY = "gw-teacher-ui";
const app = document.getElementById("app");

let classes = [];
let ui = loadUI();
let pending = 0, lastErr = "", openMenu = false;

/* ---------- helpers ---------- */
function loadUI() { try { return Object.assign({ classId: null, tab: "lesson" }, JSON.parse(localStorage.getItem(UI_KEY) || "{}")); } catch (e) { return { classId: null, tab: "lesson" }; } }
function saveUI() { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch (e) {} }
function uid(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function today() { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); }
function fmt(n, d = 1) { if (n == null || isNaN(n)) return "—"; const p = 10 ** d; return String(Math.round(n * p) / p); }
const byDate = (a, b) => (a.date || "").localeCompare(b.date || "");
function byNo(a, b) {
  const x = parseFloat(a.no), y = parseFloat(b.no);
  if (!isNaN(x) && !isNaN(y) && x !== y) return x - y;
  if (isNaN(x) !== isNaN(y)) return isNaN(x) ? 1 : -1;
  return (a.name || "").localeCompare(b.name || "", "zh-Hant");
}
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
function cur() { return classes.find(c => c.id === ui.classId) || classes[0] || null; }
function weekday(d) { if (!d) return ""; const w = new Date(d + "T00:00:00").getDay(); return isNaN(w) ? "" : "週" + "日一二三四五六"[w]; }
function normClass(id, data) {
  return Object.assign({ id, name: "", subject: "", teacher: "", order: 0, homeworks: [], exams: [], lessons: [], students: [] }, data, { id, students: [] });
}
function genPw() {
  const cs = "abcdefghjkmnpqrstuvwxyz23456789", a = new Uint32Array(8);
  crypto.getRandomValues(a); return Array.from(a, n => cs[n % cs.length]).join("");
}

/* ---------- Firestore writes ---------- */
function track(p, strict) {
  pending++; renderStatus();
  return p.then(r => { pending--; renderStatus(); return r; }, e => {
    pending--; lastErr = errText(e); renderStatus(); toast("儲存失敗：" + lastErr);
    if (strict) throw e; return null;
  });
}
const classRef = c => doc(db, "classes", c.id);
const stuRef = (c, s) => doc(db, "classes", c.id, "students", s.id);
function classData(c) {
  return { name: c.name, subject: c.subject, teacher: c.teacher, order: c.order || 0, homeworks: c.homeworks, exams: c.exams, lessons: c.lessons };
}
function saveClass(c) { scheduleStats(c); return track(setDoc(classRef(c), classData(c), { merge: true })); }
function stuData(s) { return { no: s.no, sid: s.sid || "", name: s.name, login: s.login || "", uid: s.uid || "", hw: s.hw || {}, ex: s.ex || {} }; }
function saveStudentInfo(c, s) { return track(updateDoc(stuRef(c, s), { no: s.no, sid: s.sid || "", name: s.name })); }
function saveNote(c, s) { return track(setDoc(doc(db, "classes", c.id, "private", s.id), { note: s.note || "" })); }
function saveHw(c, s, hid) { scheduleStats(c); return track(updateDoc(stuRef(c, s), { ["hw." + hid]: s.hw[hid] || deleteField() })); }
function saveEx(c, s, eid) { scheduleStats(c); return track(updateDoc(stuRef(c, s), { ["ex." + eid]: s.ex[eid] == null ? deleteField() : s.ex[eid] })); }

// 統計只放全班數字（不含個人分數），家長頁讀這份
const statsTimers = {};
function scheduleStats(c) {
  clearTimeout(statsTimers[c.id]);
  statsTimers[c.id] = setTimeout(() => track(setDoc(doc(db, "classes", c.id, "stats", "summary"), computeStats(c))), 1200);
}
function computeStats(c) {
  const out = { hw: {}, ex: {}, updatedAt: Date.now() };
  c.homeworks.forEach(h => {
    let n = 0, sub = 0; const sc = [];
    c.students.forEach(s => { const r = (s.hw || {})[h.id]; if (r && r.s && r.s !== "exempt") { n++; if (SUBMITTED[r.s]) sub++; } if (r && typeof r.score === "number") sc.push(r.score); });
    out.hw[h.id] = { counted: n, submitted: sub, avg: avg(sc) };
  });
  c.exams.forEach(e => {
    const sc = []; c.students.forEach(s => { const v = (s.ex || {})[e.id]; if (typeof v === "number") sc.push(v); });
    out.ex[e.id] = { taken: sc.length, avg: avg(sc) };
  });
  const st = c.students.map(s => studentStats(c, s, true));
  const rates = st.map(x => x.rate).filter(x => x != null), ex = st.map(x => x.exAvg).filter(x => x != null), hw = st.map(x => x.hwAvg).filter(x => x != null);
  out.overall = { hwRate: avg(rates), exAvg: avg(ex), hwAvg: avg(hw) };
  return out;
}

/* ---------- stats ---------- */
function studentStats(c, s, publishedOnly) {
  let counted = 0, sub = 0, late = 0, absent = 0; const missing = [], hwS = [], exS = [];
  c.homeworks.forEach(h => {
    if (publishedOnly && h.hidden) return;
    const r = (s.hw || {})[h.id] || {};
    if (r.s && r.s !== "exempt") { counted++; if (SUBMITTED[r.s]) sub++; if (r.s === "late") late++; if (r.s === "missing") missing.push(h.title); }
    if (h.full && typeof r.score === "number") hwS.push(r.score / h.full * 100);
  });
  c.exams.forEach(e => {
    if (publishedOnly && e.hidden) return;
    const v = (s.ex || {})[e.id];
    if (v === "absent") absent++; else if (typeof v === "number" && e.full) exS.push(v / e.full * 100);
  });
  return { counted, sub, rate: counted ? sub / counted * 100 : null, missing, late, absent, hwAvg: avg(hwS), exAvg: avg(exS) };
}

/* ---------- load ---------- */
async function loadAll() {
  const snap = await getDocs(collection(db, "classes"));
  if (snap.empty) {
    for (const [i, name] of DEFAULT_CLASSES.entries()) {
      const c = normClass("c_" + name, { name, order: i });
      await setDoc(classRef(c), classData(c));
      classes.push(c);
    }
    return;
  }
  classes = await Promise.all(snap.docs.map(async d => {
    const c = normClass(d.id, d.data());
    const [ss, ps] = await Promise.all([getDocs(collection(db, "classes", d.id, "students")), getDocs(collection(db, "classes", d.id, "private"))]);
    const notes = {}; ps.docs.forEach(p => notes[p.id] = p.data().note || "");
    c.students = ss.docs.map(s => Object.assign({ no: "", sid: "", name: "", login: "", uid: "", hw: {}, ex: {} }, s.data(), { id: s.id, note: notes[s.id] || "" }));
    return c;
  }));
  // 帳號狀態：是否已完成第一次登入改密碼
  const acc = await getDocs(collection(db, "accounts"));
  const must = {}; acc.docs.forEach(a => must[a.id] = !!a.data().mustChange);
  classes.forEach(c => c.students.forEach(s => { if (s.uid) s.mustChange = !!must[s.uid]; }));
  classes.sort((a, b) => (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name));
}

/* ---------- render ---------- */
function render() {
  const c = cur();
  let h = `<div class="top"><h1>${esc(SCHOOL_NAME)}｜老師後台</h1><span class="spacer"></span><span id="status" class="status"></span>
    <div class="menu"><button class="btn" data-act="menu">選單 ▾</button>${openMenu ? menuHtml() : ""}</div></div>`;
  h += `<div class="layout"><aside class="side">${sideHtml(c)}</aside><main class="main">`;
  h += `<div class="mobile-cls"><select class="inp" data-act="pickcls">${classes.map(x => `<option value="${esc(x.id)}"${c && x.id === c.id ? " selected" : ""}>${esc(x.name)} 班</option>`).join("")}</select><button class="btn" data-act="addcls">＋ 班級</button></div>`;
  h += c ? mainHtml(c) : `<div class="empty"><p>還沒有班級。</p><button class="btn primary" data-act="addcls">＋ 新增班級</button></div>`;
  h += `</main></div>`;
  const keep = captureFocus();
  app.innerHTML = h;
  restoreFocus(keep);
  renderStatus();
}
function menuHtml() {
  return `<div class="menu-pop">
    <button data-act="exportcsvall">匯出全部班級 CSV</button>
    <button data-act="exportjson">下載完整備份（JSON）</button>
    <button data-act="importold">匯入舊版網頁的備份</button>
    <button data-act="chpw">修改我的密碼</button>
    <button data-act="logout">登出</button></div>`;
}
function renderStatus() {
  const el = document.getElementById("status"); if (!el) return;
  if (pending > 0) { el.textContent = "儲存中…"; el.className = "status busy"; }
  else if (lastErr) { el.textContent = "儲存失敗：" + lastErr; el.className = "status err"; }
  else { el.textContent = "已同步"; el.className = "status"; }
}
function sideHtml(c) {
  let h = `<h3>班級</h3>`;
  classes.forEach(x => {
    const meta = [x.subject, x.teacher].filter(Boolean).join("・");
    h += `<button class="cls${c && x.id === c.id ? " on" : ""}" data-act="cls" data-id="${esc(x.id)}">${esc(x.name)} 班<small>${esc(meta)}${meta ? "・" : ""}${x.students.length} 人</small></button>`;
  });
  return h + `<button class="btn add" data-act="addcls">＋ 新增班級</button>`;
}
function mainHtml(c) {
  const tabs = [["lesson", "上課進度"], ["hw", "作業"], ["exam", "考試"], ["sum", "學生總覽"], ["stu", "學生與帳號"], ["set", "班級設定"]];
  let h = `<div class="head"><h2>${esc(c.name)} 班</h2><span class="tag">${esc(SCHOOL_NAME)}</span>${c.subject ? `<span class="tag">${esc(c.subject)}</span>` : ""}${c.teacher ? `<span class="tag">${esc(c.teacher)}</span>` : ""}</div>`;
  h += `<div class="tabs">${tabs.map(t => `<button class="tab${ui.tab === t[0] ? " on" : ""}" data-act="tab" data-id="${t[0]}">${t[1]}</button>`).join("")}</div>`;
  const f = { lesson: lessonHtml, hw: hwHtml, exam: examHtml, sum: sumHtml, stu: stuHtml, set: setHtml }[ui.tab] || lessonHtml;
  return h + f(c);
}
const needStudents = c => c.students.length ? "" : `<div class="card empty">這個班還沒有學生，請先到「學生與帳號」新增。</div>`;

function lessonHtml(c) {
  let h = `<div class="card"><h4>新增上課紀錄</h4>
    <div class="row"><div class="field"><label>日期</label><input class="inp" type="date" id="lsDate" value="${today()}"></div>
    <div class="field"><label>節次／單元（選填）</label><input class="inp" id="lsUnit" placeholder="例：第 3 節、1-2 一元一次方程式" style="width:260px"></div></div>
    <div class="field" style="margin-top:8px"><label>上課進度</label><textarea class="inp" id="lsContent" placeholder="例：課本 P.32–36，講解移項法則，完成例題 1–4"></textarea></div>
    <div class="row" style="margin-top:8px"><div class="field" style="flex:1;min-width:220px"><label>回家作業（選填）</label><input class="inp" id="lsHw" placeholder="例：習作 P.12–13"></div>
    <div class="field" style="flex:1;min-width:220px"><label>備註（選填，家長看得到）</label><input class="inp" id="lsNote" placeholder="例：下週二小考 1-1、1-2"></div></div>
    <div class="row" style="margin-top:10px"><label class="check"><input type="checkbox" id="lsAddHw" checked> 有回家作業時，同時加到「作業」登記表</label>
    <span class="spacer" style="flex:1"></span><button class="btn primary" data-act="addlesson">新增</button></div></div>`;
  if (!c.lessons.length) return h + `<div class="card empty">還沒有上課紀錄。</div>`;
  h += `<div class="card">`;
  c.lessons.slice().sort((a, b) => byDate(b, a)).forEach(l => {
    h += `<div class="lesson"><div class="date">${esc((l.date || "").slice(5).replace("-", "/"))}<small>${esc(l.date ? l.date.slice(0, 4) : "")} ${weekday(l.date)}</small></div>
      <div class="body">${l.unit ? `<p><b>${esc(l.unit)}</b></p>` : ""}<p>${esc(l.content)}</p>
      ${l.homework ? `<div class="sub"><b>回家作業：</b>${esc(l.homework)}</div>` : ""}${l.note ? `<div class="sub"><b>備註：</b>${esc(l.note)}</div>` : ""}</div>
      <div><button class="btn sm" data-act="editlesson" data-id="${esc(l.id)}">編輯</button></div></div>`;
  });
  return h + `</div>`;
}
function hiddenNote(x) { return x.hidden ? "・家長看不到" : ""; }
function hwHtml(c) {
  let h = `<div class="card"><h4>新增作業</h4><div class="row"><div class="field" style="flex:1;min-width:160px"><label>作業名稱</label><input class="inp" id="hwTitle" placeholder="例：習作 P.10–15"></div><div class="field"><label>日期</label><input class="inp" type="date" id="hwDate" value="${today()}"></div><div class="field"><label>滿分（不計分就留白）</label><input class="inp" type="number" id="hwFull" placeholder="例：100" style="width:150px"></div><button class="btn primary" data-act="addhw">新增</button></div></div>`;
  const ne = needStudents(c); if (ne) return h + ne;
  if (!c.homeworks.length) return h + `<div class="card empty">還沒有作業。</div>`;
  const hws = c.homeworks.slice().sort(byDate), stus = c.students.slice().sort(byNo);
  h += `<div class="tablewrap"><table class="grid"><thead><tr><th class="stick">學生</th>`;
  hws.forEach(w => {
    h += `<th class="colhead${w.hidden ? " hidden" : ""}"><span class="t" title="${esc(w.title)}">${esc(w.title)}</span><span class="d">${esc(w.date || "")}${w.full ? "・滿分 " + esc(w.full) : "・不計分"}${hiddenNote(w)}</span>
      <span class="acts"><button class="btn sm" data-act="hwall" data-id="${esc(w.id)}" title="把未登記的人都設為已交">全已交</button><button class="btn sm" data-act="edithw" data-id="${esc(w.id)}">編輯</button></span></th>`;
  });
  h += `<th>繳交率</th></tr></thead><tbody>`;
  stus.forEach(s => {
    const st = studentStats(c, s);
    h += `<tr><td class="stick"><span class="no">${esc(s.no)}</span>${esc(s.name)}</td>`;
    hws.forEach(w => {
      const r = s.hw[w.id] || { s: "", score: null };
      h += `<td><div class="cell"><select class="st ${esc(r.s)}" data-act="hwst" data-h="${esc(w.id)}" data-s="${esc(s.id)}">${STATUS.map(o => `<option value="${o[0]}"${o[0] === (r.s || "") ? " selected" : ""}>${o[1]}</option>`).join("")}</select>`;
      if (w.full) { const low = typeof r.score === "number" && r.score < w.full * PASS; h += `<input class="sc${low ? " low" : ""}" inputmode="decimal" data-act="hwsc" data-h="${esc(w.id)}" data-s="${esc(s.id)}" value="${r.score == null ? "" : esc(r.score)}">`; }
      h += `</div></td>`;
    });
    h += `<td class="pct${st.rate != null && st.rate < 80 ? " lowtxt" : ""}">${st.rate == null ? "—" : fmt(st.rate, 0) + "%"}</td></tr>`;
  });
  h += `</tbody><tfoot><tr><td class="stick">統計</td>`;
  hws.forEach(w => {
    let n = 0, sub = 0; const sc = [];
    stus.forEach(s => { const r = s.hw[w.id]; if (r && r.s && r.s !== "exempt") { n++; if (SUBMITTED[r.s]) sub++; } if (r && typeof r.score === "number") sc.push(r.score); });
    h += `<td>已交 ${sub}/${n}${w.full && sc.length ? "<br>平均 " + fmt(avg(sc)) : ""}</td>`;
  });
  h += `<td></td></tr></tfoot></table></div>`;
  h += `<div class="legend"><span><i class="dot" style="background:var(--ok)"></i>已交</span><span><i class="dot" style="background:var(--warn)"></i>遲交</span><span><i class="dot" style="background:var(--info)"></i>補交</span><span><i class="dot" style="background:var(--bad)"></i>未交</span><span>繳交率＝(已交＋遲交＋補交)÷已登記</span><span>分數按 Enter 跳到下一位</span></div>`;
  return h;
}
function examHtml(c) {
  let h = `<div class="card"><h4>新增考試</h4><div class="row"><div class="field" style="flex:1;min-width:160px"><label>考試名稱</label><input class="inp" id="exTitle" placeholder="例：第一次段考"></div><div class="field"><label>日期</label><input class="inp" type="date" id="exDate" value="${today()}"></div><div class="field"><label>滿分</label><input class="inp" type="number" id="exFull" value="100" style="width:100px"></div><button class="btn primary" data-act="addex">新增</button></div>
    <p class="hint">分數還沒登記完、不想讓家長先看到，可以按「編輯」把這次考試設為「家長看不到」。</p></div>`;
  const ne = needStudents(c); if (ne) return h + ne;
  if (!c.exams.length) return h + `<div class="card empty">還沒有考試。</div>`;
  const exs = c.exams.slice().sort(byDate), stus = c.students.slice().sort(byNo);
  h += `<div class="tablewrap"><table class="grid"><thead><tr><th class="stick">學生</th>`;
  exs.forEach(e => {
    h += `<th class="colhead${e.hidden ? " hidden" : ""}"><span class="t" title="${esc(e.title)}">${esc(e.title)}</span><span class="d">${esc(e.date || "")}・滿分 ${esc(e.full)}${hiddenNote(e)}</span><span class="acts"><button class="btn sm" data-act="editex" data-id="${esc(e.id)}">編輯</button></span></th>`;
  });
  h += `<th>平均（百分制）</th></tr></thead><tbody>`;
  stus.forEach(s => {
    const st = studentStats(c, s);
    h += `<tr><td class="stick"><span class="no">${esc(s.no)}</span>${esc(s.name)}</td>`;
    exs.forEach(e => {
      const v = s.ex[e.id]; let cls = "";
      if (v === "absent") cls = " abs"; else if (typeof v === "number" && v < e.full * PASS) cls = " low";
      h += `<td><input class="sc${cls}" inputmode="decimal" data-act="exsc" data-e="${esc(e.id)}" data-s="${esc(s.id)}" value="${v === "absent" ? "缺" : v == null ? "" : esc(v)}"></td>`;
    });
    h += `<td class="pct${st.exAvg != null && st.exAvg < PASS * 100 ? " lowtxt" : ""}">${fmt(st.exAvg)}</td></tr>`;
  });
  h += `</tbody><tfoot><tr><td class="stick">統計</td>`;
  exs.forEach(e => {
    const sc = []; let ab = 0;
    stus.forEach(s => { const v = s.ex[e.id]; if (v === "absent") ab++; else if (typeof v === "number") sc.push(v); });
    h += `<td>${sc.length ? `平均 ${fmt(avg(sc))}<br>最高 ${fmt(Math.max(...sc))}・最低 ${fmt(Math.min(...sc))}` : "—"}${ab ? "<br>缺考 " + ab : ""}</td>`;
  });
  h += `<td></td></tr></tfoot></table></div><div class="legend"><span>缺考請輸入「缺」</span><span>紅字＝低於滿分 60%</span><span>按 Enter 跳到下一位</span></div>`;
  return h;
}
function sumHtml(c) {
  const ne = needStudents(c); if (ne) return ne;
  let h = `<div class="tablewrap"><table class="grid"><thead><tr><th class="stick">學生</th><th>作業繳交率</th><th>遲交</th><th>未交</th><th>作業平均</th><th>考試平均</th><th>缺考</th><th>未交的作業</th></tr></thead><tbody>`;
  c.students.slice().sort(byNo).forEach(s => {
    const st = studentStats(c, s); let flags = "";
    if (st.missing.length >= 2) flags += `<span class="flag">多次未交</span>`;
    if (st.exAvg != null && st.exAvg < PASS * 100) flags += `<span class="flag">考試偏低</span>`;
    h += `<tr><td class="stick"><span class="no">${esc(s.no)}</span>${esc(s.name)}${flags}</td>
      <td class="pct${st.rate != null && st.rate < 80 ? " lowtxt" : ""}">${st.rate == null ? "—" : `${fmt(st.rate, 0)}%（${st.sub}/${st.counted}）`}</td>
      <td>${st.late}</td><td class="${st.missing.length ? "lowtxt" : ""}">${st.missing.length}</td>
      <td class="pct">${fmt(st.hwAvg)}</td><td class="pct${st.exAvg != null && st.exAvg < PASS * 100 ? " lowtxt" : ""}">${fmt(st.exAvg)}</td><td>${st.absent}</td>
      <td class="misslist">${st.missing.length ? esc(st.missing.join("、")) : `<span class="oktxt">—</span>`}</td></tr>`;
  });
  return h + `</tbody></table></div><div class="legend"><span>作業、考試平均都換算成百分制</span><span>「多次未交」＝未交 2 次以上；「考試偏低」＝考試平均低於 60</span></div>`;
}
function stuHtml(c) {
  const noAcct = c.students.filter(s => !s.uid).length;
  let h = `<div class="card"><h4>批次新增學生</h4><textarea class="inp" id="bulk" placeholder="一行一位，「座號 學號 姓名」：&#10;1 1130101 王小明&#10;2 1130102 林小華"></textarea><p class="hint">可直接從 Excel 複製三欄（座號、學號、姓名）貼上；學號之後也可以在下方名單補填。</p><div class="row" style="margin-top:8px"><button class="btn primary" data-act="bulkadd">加入名單</button></div></div>`;
  if (!c.students.length) return h + `<div class="card empty">目前沒有學生。</div>`;
  h += `<div class="card"><div class="row" style="justify-content:space-between;align-items:center;margin-bottom:6px"><h4 style="margin:0">名單與登入帳號（${c.students.length} 人）</h4>
    <button class="btn primary" data-act="mkall"${noAcct ? "" : " disabled"}>${noAcct ? `為 ${noAcct} 位學生建立帳號` : "全部都已建立帳號"}</button></div>
    <p class="hint" style="margin:0 0 6px">家長和學生用「學號」加上你設定的初始密碼登入，第一次登入時必須改成自己的密碼。家長和學生共用同一組帳號。</p>`;
  c.students.slice().sort(byNo).forEach(s => {
    const status = !s.uid ? "尚未建立帳號" : s.mustChange ? `<b>${esc(s.login)}</b>・<span class="lowtxt" style="font-weight:400">待首次登入</span>` : `<b>${esc(s.login)}</b>・<span class="oktxt">已啟用</span>`;
    h += `<div class="stu-row"><input class="inp" style="width:58px" data-act="stuf" data-f="no" data-s="${esc(s.id)}" value="${esc(s.no)}" placeholder="座號">
      <input class="inp" style="width:104px" data-act="stuf" data-f="sid" data-s="${esc(s.id)}" value="${esc(s.sid)}" placeholder="學號">
      <input class="inp" style="width:110px" data-act="stuf" data-f="name" data-s="${esc(s.id)}" value="${esc(s.name)}">
      <input class="inp" style="flex:1;min-width:140px" data-act="stuf" data-f="note" data-s="${esc(s.id)}" value="${esc(s.note)}" placeholder="私人備註（只有老師看得到）">
      <span class="acct">${status}</span>
      <button class="btn sm" data-act="${s.uid ? "resetpw" : "mkone"}" data-s="${esc(s.id)}">${s.uid ? "重設密碼" : "建立帳號"}</button>
      <button class="btn sm danger" data-act="delstu" data-s="${esc(s.id)}">刪除</button></div>`;
  });
  return h + `</div>`;
}
function setHtml(c) {
  return `<div class="card"><h4>班級資料</h4><div class="row">
    <div class="field"><label>班級（例：701）</label><input class="inp" data-act="clsf" data-f="name" value="${esc(c.name)}"></div>
    <div class="field"><label>科目</label><input class="inp" data-act="clsf" data-f="subject" value="${esc(c.subject)}"></div>
    <div class="field"><label>老師</label><input class="inp" data-act="clsf" data-f="teacher" value="${esc(c.teacher)}"></div></div>
    <p class="hint">班級名稱改了，學生的登入帳號（學號）不受影響。</p></div>
    <div class="card"><h4>匯出</h4><div class="row"><button class="btn" data-act="exportcsv">匯出本班 CSV</button></div></div>
    <div class="card"><h4>刪除班級</h4><p class="hint" style="margin-top:0">會刪除這個班的學生、作業、成績、上課紀錄，學生帳號也會失效。無法復原，建議先下載備份。</p><div class="row" style="margin-top:8px"><button class="btn danger" data-act="delcls">刪除「${esc(c.name)} 班」</button></div></div>`;
}

/* ---------- focus keep ---------- */
function captureFocus() { const a = document.activeElement; if (!a || !a.dataset || !a.dataset.act) return null; return { act: a.dataset.act, h: a.dataset.h, e: a.dataset.e, s: a.dataset.s, f: a.dataset.f }; }
function findEl(k) {
  let sel = `[data-act="${k.act}"]`;
  ["h", "e", "s", "f"].forEach(x => { if (k[x]) sel += `[data-${x}="${CSS.escape(k[x])}"]`; });
  return app.querySelector(sel);
}
function restoreFocus(k) { if (!k) return; const el = findEl(k); if (el) { el.focus(); if (el.tagName === "INPUT" && el.select) try { el.select(); } catch (e) {} } }
function rerenderKeepScroll() {
  let w = app.querySelector(".tablewrap"); const sl = w ? w.scrollLeft : 0, st = w ? w.scrollTop : 0, y = window.scrollY;
  render(); w = app.querySelector(".tablewrap"); if (w) { w.scrollLeft = sl; w.scrollTop = st; } window.scrollTo(0, y);
}

/* ---------- dialogs ---------- */
function modal(title, fields, onOk, extra) {
  const bg = document.createElement("div"); bg.className = "modal-bg";
  let h = `<div class="modal"><h3>${esc(title)}</h3>`;
  fields.forEach(f => {
    h += `<div class="field">`;
    if (f.type === "checkbox") h += `<label class="check" style="font-size:14px;color:var(--ink)"><input type="checkbox" name="${f.name}"${f.value ? " checked" : ""}> ${esc(f.label)}</label>`;
    else if (f.type === "textarea") h += `<label>${esc(f.label)}</label><textarea class="inp" name="${f.name}">${esc(f.value || "")}</textarea>`;
    else h += `<label>${esc(f.label)}</label><input class="inp" name="${f.name}" type="${f.type || "text"}" value="${esc(f.value == null ? "" : f.value)}" placeholder="${esc(f.placeholder || "")}">`;
    h += `</div>`;
  });
  h += `<div class="acts">${extra ? `<button class="btn danger" data-m="extra" style="margin-right:auto">${esc(extra.label)}</button>` : ""}<button class="btn" data-m="cancel">取消</button><button class="btn primary" data-m="ok">確定</button></div></div>`;
  bg.innerHTML = h; document.body.appendChild(bg);
  const first = bg.querySelector("input,textarea"); if (first) first.focus();
  const close = () => bg.remove();
  const ok = async () => {
    const v = {}; bg.querySelectorAll("[name]").forEach(i => v[i.name] = i.type === "checkbox" ? i.checked : i.value.trim());
    if (await onOk(v) !== false) close();
  };
  bg.addEventListener("click", e => { const m = e.target.dataset && e.target.dataset.m; if (e.target === bg || m === "cancel") close(); else if (m === "ok") ok(); else if (m === "extra") { close(); extra.run(); } });
  bg.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") ok(); else if (e.key === "Escape") close(); });
}
function confirmBox(msg, onYes, yesLabel) {
  const bg = document.createElement("div"); bg.className = "modal-bg";
  bg.innerHTML = `<div class="modal"><h3>請確認</h3><p style="margin:0;white-space:pre-wrap">${esc(msg)}</p><div class="acts"><button class="btn" data-m="no">取消</button><button class="btn danger" data-m="yes">${esc(yesLabel || "確定刪除")}</button></div></div>`;
  document.body.appendChild(bg);
  bg.addEventListener("click", e => { const m = e.target.dataset && e.target.dataset.m; if (e.target === bg || m === "no") bg.remove(); else if (m === "yes") { bg.remove(); onYes(); } });
}
function showCredentials(list) {
  const bg = document.createElement("div"); bg.className = "modal-bg";
  bg.innerHTML = `<div class="modal wide"><h3>${esc(SCHOOL_NAME)}｜學生登入帳號</h3>
    <div class="warnbox no-print">初始密碼只會顯示這一次，關掉前請先「列印」或「下載 CSV」。</div>
    <p style="margin:0 0 4px">登入網址：<b>${esc(location.href.replace(/teacher\.html.*$/, ""))}</b></p>
    <p style="margin:0 0 8px">帳號是學號；第一次登入後會要求改成自己的密碼。</p>
    <table class="cred"><thead><tr><th>班級</th><th>座號</th><th>姓名</th><th>學號（帳號）</th><th>初始密碼</th></tr></thead><tbody>
    ${list.map(r => `<tr><td>${esc(r.cls)}</td><td>${esc(r.no)}</td><td>${esc(r.name)}</td><td class="pw">${esc(r.login)}</td><td class="pw">${esc(r.pw)}</td></tr>`).join("")}</tbody></table>
    <div class="acts no-print"><button class="btn" data-m="csv">下載 CSV</button><button class="btn" data-m="print">列印這份清單</button><button class="btn primary" data-m="slips">列印個別通知單</button><button class="btn" data-m="close">我已保存，關閉</button></div></div>`;
  document.body.appendChild(bg);
  bg.addEventListener("click", e => {
    const m = e.target.dataset && e.target.dataset.m;
    if (m === "close") bg.remove();
    else if (m === "print") printWith("printing");
    else if (m === "slips") { buildSlips(list); printWith("printing-slips"); }
    else if (m === "csv") download(`${SCHOOL_NAME}_學生帳號_${stamp()}.csv`, toCsv([["班級", "座號", "姓名", "學號（帳號）", "初始密碼"]].concat(list.map(r => [r.cls, r.no, r.name, r.login, r.pw]))), "text/csv");
  });
}

/* ---------- printing ---------- */
// 列印時只顯示指定內容；等列印視窗關閉（afterprint）才還原，手機 Safari 也能正常列印
function printWith(cls) {
  document.body.classList.remove("printing", "printing-slips");
  document.body.classList.add(cls);
  const done = () => document.body.classList.remove(cls);
  window.addEventListener("afterprint", done, { once: true });
  window.print();
}
// 個別通知單：一人一張，A4 一頁 8 張，剪開夾進聯絡簿
function buildSlips(list) {
  const old = document.querySelector(".slips-print"); if (old) old.remove();
  const url = location.href.replace(/teacher\.html.*$/, "");
  const box = document.createElement("div"); box.className = "slips-print";
  box.innerHTML = list.map(r => `<div class="slip">
    <div class="slip-h"><b>${esc(SCHOOL_NAME)} ${esc(r.cls)} 班｜學習紀錄登入通知</b><span>${r.no ? esc(r.no) + " 號 " : ""}${esc(r.name)}</span></div>
    <table><tr><th>登入網址</th><td class="url">${esc(url)}</td></tr>
    <tr><th>帳號（學號）</th><td class="mono">${esc(r.login)}</td></tr>
    <tr><th>初始密碼</th><td class="mono">${esc(r.pw)}</td></tr></table>
    <ol><li>第一次登入後，系統會要求設定新密碼，改好才能查看資料。</li>
    <li>家長與學生共用這組帳號，請勿將密碼告訴他人。</li>
    <li>忘記密碼或無法登入，請聯絡老師重設。</li></ol></div>`).join("");
  document.body.appendChild(box);
}

/* ---------- accounts ---------- */
const normSid = v => String(v || "").trim().toLowerCase();
function sidTaken(sid, except) {
  sid = normSid(sid); if (!sid) return false;
  return classes.some(x => x.students.some(y => y !== except && (normSid(y.sid) === sid || y.login === sid)));
}
async function createAccount(c, s, pw) {
  const login = normSid(s.sid);
  const { uid: newUid, email } = await createStudentAuth(login, pw);
  const b = writeBatch(db);
  b.set(doc(db, "accounts", newUid), { classId: c.id, studentId: s.id, mustChange: true });
  b.set(doc(db, "logins", login), { email });
  if (s.login && s.login !== login) b.delete(doc(db, "logins", s.login));
  if (s.uid && s.uid !== newUid) b.delete(doc(db, "accounts", s.uid)); // 舊帳號立即失效
  b.update(stuRef(c, s), { login, uid: newUid });
  await track(b.commit(), true);
  s.login = login; s.uid = newUid; s.mustChange = true;
  return { cls: c.name, no: s.no, name: s.name, login, pw };
}
// 選擇初始密碼：統一密碼或每人隨機
function askInitialPw(title, count, onGo) {
  const bg = document.createElement("div"); bg.className = "modal-bg";
  bg.innerHTML = `<div class="modal"><h3>${esc(title)}</h3>
    <p style="margin:0 0 10px">共 ${count} 位。家長或學生用<b>學號</b>和初始密碼登入，第一次登入會被要求改成自己的密碼。</p>
    <div class="field"><label class="check" style="font-size:14px;color:var(--ink)"><input type="radio" name="mode" value="rand" checked> 每人隨機產生不同的初始密碼（建議）</label></div>
    <div class="field"><label class="check" style="font-size:14px;color:var(--ink)"><input type="radio" name="mode" value="same"> 由我設定初始密碼（全部相同）</label>
      <input class="inp" name="pw" placeholder="至少 6 個字元" style="margin:4px 0 0 24px;width:calc(100% - 24px)"></div>
    <p class="hint">建立後可以列印「個別通知單」，剪開夾進聯絡簿發給家長。全部相同的話，知道別人學號的同學就能搶先登入，比較不建議。</p>
    <div class="acts"><button class="btn" data-m="cancel">取消</button><button class="btn primary" data-m="ok">建立</button></div></div>`;
  document.body.appendChild(bg);
  const pwI = bg.querySelector("[name=pw]"); bg.querySelector("[data-m=ok]").focus();
  pwI.addEventListener("input", () => { bg.querySelector("[value=same]").checked = true; });
  const ok = () => {
    const mode = bg.querySelector("[name=mode]:checked").value, pw = pwI.value.trim();
    if (mode === "same" && pw.length < 6) { toast("初始密碼至少 6 個字元"); pwI.focus(); return; }
    bg.remove(); onGo(mode === "same" ? () => pw : genPw);
  };
  bg.addEventListener("click", e => { const m = e.target.dataset && e.target.dataset.m; if (e.target === bg || m === "cancel") bg.remove(); else if (m === "ok") ok(); });
  bg.addEventListener("keydown", e => { if (e.key === "Enter") ok(); else if (e.key === "Escape") bg.remove(); });
}
async function createMany(c, list, pwFn) {
  const noSid = list.filter(s => !normSid(s.sid)), dup = list.filter(s => normSid(s.sid) && sidTaken(s.sid, s));
  list = list.filter(s => normSid(s.sid) && !sidTaken(s.sid, s));
  const done = []; let fail = "";
  for (const [i, s] of list.entries()) {
    toast(`建立帳號中… ${i + 1}/${list.length}`);
    try { done.push(await createAccount(c, s, pwFn())); } catch (e) { fail = errText(e); break; }
  }
  render();
  const tt = document.querySelector(".toast"); if (tt) tt.remove();
  if (done.length) showCredentials(done);
  const msgs = [];
  if (noSid.length) msgs.push(`${noSid.map(x => x.name).join("、")} 還沒填學號`);
  if (dup.length) msgs.push(`${dup.map(x => x.name).join("、")} 的學號和其他學生重複`);
  if (fail) msgs.push(`有 ${list.length - done.length} 位沒建立成功：${fail}，可稍後再按一次`);
  if (msgs.length) toast(msgs.join("；"));
}

/* ---------- export / import ---------- */
function csvCell(v) { v = v == null ? "" : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
function toCsv(rows) { return "﻿" + rows.map(r => r.map(csvCell).join(",")).join("\r\n"); }
function stamp() { return today().replace(/-/g, ""); }
function download(name, data, mime) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([data], { type: mime })); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
function classCsvRows(c) {
  const hws = c.homeworks.slice().sort(byDate), exs = c.exams.slice().sort(byDate);
  const head = ["班級", "座號", "學號", "姓名"];
  hws.forEach(w => { head.push(`作業｜${w.title}｜繳交`); if (w.full) head.push(`作業｜${w.title}｜分數(/${w.full})`); });
  exs.forEach(e => head.push(`考試｜${e.title}(/${e.full})`));
  head.push("作業繳交率", "未交次數", "作業平均(百分制)", "考試平均(百分制)");
  const rows = [head];
  c.students.slice().sort(byNo).forEach(s => {
    const st = studentStats(c, s), r = [c.name, s.no, s.sid || "", s.name];
    hws.forEach(w => { const x = s.hw[w.id] || {}; r.push(x.s ? STATUS_LABEL[x.s] : ""); if (w.full) r.push(x.score == null ? "" : x.score); });
    exs.forEach(e => { const v = s.ex[e.id]; r.push(v === "absent" ? "缺考" : v == null ? "" : v); });
    r.push(st.rate == null ? "" : fmt(st.rate, 0) + "%", st.missing.length, st.hwAvg == null ? "" : fmt(st.hwAvg), st.exAvg == null ? "" : fmt(st.exAvg));
    rows.push(r);
  });
  return rows;
}
// 舊版（單頁網頁）備份格式：{classes:[{name,students,homeworks,exams,hwRecords,examRecords}]}
function importOld(data) {
  const msgs = []; const b = writeBatch(db); let ops = 0;
  (data.classes || []).forEach(oc => {
    let c = classes.find(x => x.name === oc.name);
    if (c && c.students.length) { msgs.push(`${oc.name} 班已有學生，略過`); return; }
    if (!c) { c = normClass(uid("c_"), { name: oc.name, order: classes.length }); classes.push(c); }
    c.subject = c.subject || oc.subject || ""; c.teacher = c.teacher || oc.teacher || "";
    c.homeworks = (oc.homeworks || []).map(h => ({ id: h.id, title: h.title, date: h.date || "", full: h.full == null ? null : Number(h.full) }));
    c.exams = (oc.exams || []).map(e => ({ id: e.id, title: e.title, date: e.date || "", full: Number(e.full) || 100 }));
    c.students = (oc.students || []).map(s => {
      const ns = { id: s.id, no: s.no || "", sid: "", name: s.name || "", login: "", uid: "", hw: {}, ex: {}, note: s.note || "" };
      c.homeworks.forEach(h => { const r = ((oc.hwRecords || {})[h.id] || {})[s.id]; if (r && (r.s || r.score != null)) ns.hw[h.id] = { s: r.s || "", score: r.score == null ? null : r.score }; });
      c.exams.forEach(e => { const v = ((oc.examRecords || {})[e.id] || {})[s.id]; if (v != null) ns.ex[e.id] = v; });
      return ns;
    });
    b.set(classRef(c), classData(c)); ops++;
    c.students.forEach(s => { b.set(stuRef(c, s), stuData(s)); ops++; if (s.note) { b.set(doc(db, "classes", c.id, "private", s.id), { note: s.note }); ops++; } });
    msgs.push(`${c.name} 班：匯入 ${c.students.length} 位學生、${c.homeworks.length} 份作業、${c.exams.length} 次考試`);
  });
  if (ops > 450) { toast("資料太多，請分班匯入"); return; }
  track(b.commit()).then(() => { classes.forEach(scheduleStats); render(); toast(msgs.join("；") || "沒有可匯入的班級"); });
}

/* ---------- events ---------- */
function parseScore(raw, allowAbsent) {
  raw = String(raw).trim(); if (raw === "") return { ok: true, v: null };
  if (allowAbsent && /^(缺|缺考|a|absent)$/i.test(raw)) return { ok: true, v: "absent" };
  const n = Number(raw); if (isNaN(n) || n < 0) return { ok: false }; return { ok: true, v: n };
}
function moveDown(el) {
  const td = el.closest("td"), tr = td.parentElement, idx = Array.prototype.indexOf.call(tr.children, td), next = tr.nextElementSibling;
  const inp = next && next.children[idx] && next.children[idx].querySelector("input.sc");
  if (inp) { inp.focus(); inp.select(); } else el.blur();
}
function addHomework(c, title, date, full) { c.homeworks.push({ id: uid("h_"), title, date, full }); }
function itemDialog(c, isHw, item) {
  const list = isHw ? c.homeworks : c.exams;
  modal(isHw ? "編輯作業" : "編輯考試", [
    { name: "title", label: "名稱", value: item.title }, { name: "date", label: "日期", type: "date", value: item.date },
    { name: "full", label: isHw ? "滿分（不計分就留白）" : "滿分", type: "number", value: item.full },
    { name: "hidden", label: "家長看不到這一項（例如分數還沒登記完）", type: "checkbox", value: !!item.hidden }
  ], v => {
    if (!v.title) { toast("請輸入名稱"); return false; }
    const f = v.full === "" ? null : Number(v.full);
    if (f !== null && (isNaN(f) || f <= 0)) { toast("滿分要是大於 0 的數字"); return false; }
    if (!isHw && f === null) { toast("考試請填滿分"); return false; }
    Object.assign(item, { title: v.title, date: v.date, full: f }); if (v.hidden) item.hidden = true; else delete item.hidden;
    saveClass(c); render();
  }, { label: "刪除", run: () => confirmBox(`確定刪除「${item.title}」及所有學生在這一項的紀錄？`, () => {
    list.splice(list.indexOf(item), 1);
    const b = writeBatch(db); b.set(classRef(c), classData(c), { merge: true });
    c.students.forEach(s => { const m = isHw ? s.hw : s.ex; if (item.id in m) { delete m[item.id]; b.update(stuRef(c, s), { [(isHw ? "hw." : "ex.") + item.id]: deleteField() }); } });
    track(b.commit()); scheduleStats(c); render();
  }) });
}

app.addEventListener("click", async e => {
  const t = e.target.closest("[data-act]");
  if (openMenu && !(t && t.dataset.act === "menu")) { openMenu = false; const p = app.querySelector(".menu-pop"); if (p) p.remove(); }
  if (!t || t.tagName === "SELECT" || t.tagName === "INPUT") return;
  const act = t.dataset.act, c = cur(), id = t.dataset.id;
  const findS = () => c.students.find(x => x.id === t.dataset.s);
  switch (act) {
    case "menu": openMenu = !openMenu; render(); break;
    case "cls": ui.classId = id; saveUI(); render(); break;
    case "tab": ui.tab = id; saveUI(); render(); break;
    case "logout": await logout(); location.replace("index.html"); break;
    case "chpw":
      modal("修改我的密碼", [{ name: "old", label: "目前密碼", type: "password" }, { name: "pw", label: "新密碼（至少 6 個字元）", type: "password" }, { name: "pw2", label: "再輸入一次新密碼", type: "password" }], async v => {
        if (v.pw.length < 6) { toast("新密碼至少 6 個字元"); return false; }
        if (v.pw !== v.pw2) { toast("兩次輸入的新密碼不一樣"); return false; }
        try { await changeOwnPassword(v.old, v.pw); toast("密碼已更新"); } catch (ex) { toast(errText(ex)); return false; }
      }); break;
    case "addcls":
      modal("新增班級", [{ name: "name", label: "班級", placeholder: "例：702" }, { name: "subject", label: "科目" }, { name: "teacher", label: "老師" }], v => {
        if (!v.name) { toast("請輸入班級"); return false; }
        const n = normClass(uid("c_"), { name: v.name.replace(/\s*班$/, ""), subject: v.subject, teacher: v.teacher, order: classes.length });
        classes.push(n); ui.classId = n.id; ui.tab = "stu"; saveUI(); saveClass(n); render();
      }); break;
    case "addlesson": {
      const content = document.getElementById("lsContent").value.trim(), hw = document.getElementById("lsHw").value.trim();
      const date = document.getElementById("lsDate").value;
      if (!content) { toast("請輸入上課進度"); break; }
      c.lessons.push({ id: uid("l_"), date, unit: document.getElementById("lsUnit").value.trim(), content, homework: hw, note: document.getElementById("lsNote").value.trim() });
      const alsoHw = !!hw && document.getElementById("lsAddHw").checked;
      if (alsoHw) addHomework(c, hw, date, null);
      saveClass(c); render(); toast(alsoHw ? "已新增上課紀錄，回家作業也加到作業登記表了" : "已新增上課紀錄"); break;
    }
    case "editlesson": {
      const l = c.lessons.find(x => x.id === id); if (!l) break;
      modal("編輯上課紀錄", [{ name: "date", label: "日期", type: "date", value: l.date }, { name: "unit", label: "節次／單元", value: l.unit }, { name: "content", label: "上課進度", type: "textarea", value: l.content }, { name: "homework", label: "回家作業", value: l.homework }, { name: "note", label: "備註（家長看得到）", value: l.note }], v => {
        if (!v.content) { toast("請輸入上課進度"); return false; }
        Object.assign(l, v); saveClass(c); render();
      }, { label: "刪除", run: () => confirmBox(`確定刪除 ${l.date} 的上課紀錄？（不會刪除作業登記）`, () => { c.lessons.splice(c.lessons.indexOf(l), 1); saveClass(c); render(); }) });
      break;
    }
    case "addhw": case "addex": {
      const isHw = act === "addhw", p = isHw ? "hw" : "ex";
      const title = document.getElementById(p + "Title").value.trim(), date = document.getElementById(p + "Date").value, fr = document.getElementById(p + "Full").value.trim();
      if (!title) { toast("請輸入名稱"); break; }
      const full = fr === "" ? null : Number(fr);
      if (full !== null && (isNaN(full) || full <= 0)) { toast("滿分要是大於 0 的數字"); break; }
      if (!isHw && full === null) { toast("考試請填滿分"); break; }
      if (isHw) addHomework(c, title, date, full); else c.exams.push({ id: uid("e_"), title, date, full });
      saveClass(c); render(); break;
    }
    case "hwall": {
      const b = writeBatch(db); let n = 0;
      c.students.forEach(s => { const r = s.hw[id]; if (!r || !r.s) { s.hw[id] = { s: "done", score: r ? r.score : null }; b.update(stuRef(c, s), { ["hw." + id]: s.hw[id] }); n++; } });
      if (n) { track(b.commit()); scheduleStats(c); }
      rerenderKeepScroll(); toast(n ? `已把 ${n} 位未登記的學生設為已交` : "所有人都已登記"); break;
    }
    case "edithw": case "editex": {
      const isHw = act === "edithw", item = (isHw ? c.homeworks : c.exams).find(x => x.id === id);
      if (item) itemDialog(c, isHw, item); break;
    }
    case "bulkadd": {
      const lines = document.getElementById("bulk").value.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const b = writeBatch(db); let n = 0; const dupSid = [];
      lines.forEach(l => {
        const tk = l.split(/[\s,，\t、]+/).filter(Boolean); let no = "", sid = "";
        if (tk.length > 1 && /^\d{1,3}$/.test(tk[0])) no = tk.shift();
        if (tk.length > 1 && /^(?=.*\d)[0-9a-z]{4,}$/i.test(tk[0])) sid = tk.shift();
        const name = tk.join(" ").trim(); if (!name) return;
        if (sid && sidTaken(sid)) dupSid.push(sid);
        const s = { id: uid("s_"), no, sid, name, login: "", uid: "", hw: {}, ex: {}, note: "" };
        c.students.push(s); b.set(stuRef(c, s), stuData(s)); n++;
      });
      if (!n) { toast("請先輸入學生名單"); break; }
      if (n > 400) { toast("一次最多 400 位"); break; }
      track(b.commit()); render(); toast(`已加入 ${n} 位學生` + (dupSid.length ? `；注意學號重複：${dupSid.join("、")}` : "")); break;
    }
    case "mkone": {
      const s = findS(); if (!s) break;
      if (!normSid(s.sid)) { toast("請先填入學號"); break; }
      if (sidTaken(s.sid, s)) { toast("這個學號和其他學生重複"); break; }
      askInitialPw(`建立「${s.name}」的帳號`, 1, fn => createMany(c, [s], fn)); break;
    }
    case "mkall": {
      const list = c.students.filter(s => !s.uid).sort(byNo);
      const ready = list.filter(s => normSid(s.sid));
      if (!ready.length) { toast("請先在名單填入學號"); break; }
      if (ready.length < list.length) toast(`有 ${list.length - ready.length} 位還沒填學號，這次會先略過`);
      askInitialPw(`為 ${c.name} 班建立帳號`, ready.length, fn => createMany(c, ready, fn));
      break;
    }
    case "resetpw": {
      const s = findS(); if (!s) break;
      if (!normSid(s.sid)) { toast("請先填入學號"); break; }
      askInitialPw(`重設「${s.name}」的密碼（舊密碼會立即失效）`, 1, fn => createMany(c, [s], fn));
      break;
    }
    case "delstu": {
      const s = findS(); if (!s) break;
      confirmBox(`確定刪除學生「${s.name}」及他所有的作業與成績紀錄？${s.uid ? "\n他的登入帳號也會失效。" : ""}`, () => {
        c.students = c.students.filter(x => x !== s);
        const b = writeBatch(db);
        b.delete(stuRef(c, s)); b.delete(doc(db, "classes", c.id, "private", s.id));
        if (s.uid) b.delete(doc(db, "accounts", s.uid));
        if (s.login) b.delete(doc(db, "logins", s.login));
        track(b.commit()); scheduleStats(c); render();
      }); break;
    }
    case "delcls":
      confirmBox(`確定刪除「${c.name} 班」？\n此班所有學生、作業、成績、上課紀錄都會刪除，學生帳號也會失效。`, () => {
        const b = writeBatch(db);
        c.students.forEach(s => { b.delete(stuRef(c, s)); b.delete(doc(db, "classes", c.id, "private", s.id)); if (s.uid) b.delete(doc(db, "accounts", s.uid)); if (s.login) b.delete(doc(db, "logins", s.login)); });
        b.delete(doc(db, "classes", c.id, "stats", "summary")); b.delete(classRef(c));
        track(b.commit());
        classes = classes.filter(x => x !== c); ui.classId = classes[0] ? classes[0].id : null; ui.tab = "lesson"; saveUI(); render();
      }); break;
    case "exportcsv": download(`${SCHOOL_NAME}${c.name}班_成績_${stamp()}.csv`, toCsv(classCsvRows(c)), "text/csv"); break;
    case "exportcsvall": { let all = []; classes.forEach((x, i) => { if (i) all.push([]); all = all.concat(classCsvRows(x)); }); download(`${SCHOOL_NAME}_成績_${stamp()}.csv`, toCsv(all), "text/csv"); break; }
    case "exportjson": download(`${SCHOOL_NAME}_完整備份_${stamp()}.json`, JSON.stringify({ exportedAt: new Date().toISOString(), classes: classes.map(x => Object.assign(classData(x), { id: x.id, students: x.students })) }, null, 1), "application/json"); break;
    case "importold": {
      const fi = document.createElement("input"); fi.type = "file"; fi.accept = ".json,application/json";
      fi.onchange = () => {
        const f = fi.files[0]; if (!f) return; const rd = new FileReader();
        rd.onload = () => {
          let d; try { d = JSON.parse(rd.result); if (!d || !Array.isArray(d.classes) || !d.classes.length || !("hwRecords" in d.classes[0])) throw 0; } catch (err) { toast("這不是舊版網頁的備份檔"); return; }
          confirmBox(`備份裡有 ${d.classes.length} 個班級（${d.classes.map(x => x.name).join("、")}）。\n同名且還沒有學生的班級會匯入資料，已有學生的班級會略過。`, () => importOld(d), "匯入");
        };
        rd.readAsText(f);
      };
      fi.click(); break;
    }
  }
});

app.addEventListener("change", e => {
  const t = e.target, act = t.dataset.act, c = cur(); if (!act || !c) return;
  if (act === "pickcls") { ui.classId = t.value; saveUI(); render(); return; }
  const s = t.dataset.s ? c.students.find(x => x.id === t.dataset.s) : null;
  if (act === "hwst" && s) {
    const r = s.hw[t.dataset.h] || { s: "", score: null }; r.s = t.value;
    if (!r.s && r.score == null) delete s.hw[t.dataset.h]; else s.hw[t.dataset.h] = r;
    saveHw(c, s, t.dataset.h); rerenderKeepScroll();
  } else if ((act === "hwsc" || act === "exsc") && s) {
    const isHw = act === "hwsc"; let p = parseScore(t.value, !isHw);
    if (!p.ok) { toast("請輸入數字" + (isHw ? "" : "，缺考打「缺」")); t.value = ""; p = { v: null }; }
    if (isHw) {
      const w = c.homeworks.find(x => x.id === t.dataset.h), r = s.hw[t.dataset.h] || { s: "", score: null };
      r.score = p.v; if (p.v != null && !r.s) r.s = "done";
      if (!r.s && r.score == null) delete s.hw[t.dataset.h]; else s.hw[t.dataset.h] = r;
      if (w && p.v != null && p.v > w.full) toast("注意：分數超過滿分 " + w.full);
      saveHw(c, s, t.dataset.h);
    } else {
      const ex = c.exams.find(x => x.id === t.dataset.e);
      if (p.v == null) delete s.ex[t.dataset.e]; else s.ex[t.dataset.e] = p.v;
      if (ex && typeof p.v === "number" && p.v > ex.full) toast("注意：分數超過滿分 " + ex.full);
      saveEx(c, s, t.dataset.e);
    }
    setTimeout(rerenderKeepScroll, 0);
  } else if (act === "stuf" && s) {
    const f = t.dataset.f, v = t.value.trim();
    if (f === "name" && !v) { t.value = s.name; toast("姓名不能空白"); return; }
    if (f === "sid") {
      if (v && sidTaken(v, s)) { t.value = s.sid || ""; toast("這個學號和其他學生重複"); return; }
      if (s.uid && !v) { t.value = s.sid; toast("已建立帳號的學生不能清空學號"); return; }
      const oldLogin = s.login, newLogin = normSid(v);
      s.sid = v; saveStudentInfo(c, s);
      if (s.uid && oldLogin && newLogin !== oldLogin) {
        // 學號改了：登入帳號跟著改，密碼不變
        getDoc(doc(db, "logins", oldLogin)).then(snap => {
          if (!snap.exists()) return;
          const b = writeBatch(db);
          b.set(doc(db, "logins", newLogin), snap.data()); b.delete(doc(db, "logins", oldLogin)); b.update(stuRef(c, s), { login: newLogin });
          return track(b.commit()).then(() => { s.login = newLogin; render(); toast(`登入帳號已改為 ${newLogin}，密碼不變`); });
        });
      }
      return;
    }
    s[f] = v;
    if (f === "note") saveNote(c, s); else saveStudentInfo(c, s);
    const side = app.querySelector(".side"); if (side) side.innerHTML = sideHtml(c);
  } else if (act === "clsf") {
    const v = t.value.trim(); if (t.dataset.f === "name" && !v) { t.value = c.name; toast("班級名稱不能空白"); return; }
    c[t.dataset.f] = t.dataset.f === "name" ? v.replace(/\s*班$/, "") : v; saveClass(c); render();
  }
});
app.addEventListener("keydown", e => {
  const t = e.target;
  if (e.key === "Enter" && t.classList && t.classList.contains("sc")) { e.preventDefault(); moveDown(t); return; }
  if (e.key === "Enter" && (t.id === "hwTitle" || t.id === "hwFull")) app.querySelector('[data-act="addhw"]').click();
  if (e.key === "Enter" && (t.id === "exTitle" || t.id === "exFull")) app.querySelector('[data-act="addex"]').click();
});
window.addEventListener("beforeunload", e => { if (pending > 0) { e.preventDefault(); e.returnValue = ""; } });

/* ---------- start ---------- */
if (!configured) setupNotice(app);
else {
  const user = await waitUser();
  if (!user) location.replace("index.html");
  else if (!isAdmin(user)) location.replace("student.html");
  else {
    try { await loadAll(); render(); }
    catch (e) { app.innerHTML = `<div class="login-wrap"><div class="login-card"><h1>載入失敗</h1><p>${esc(errText(e))}</p><button class="btn" onclick="location.reload()">重新整理</button></div></div>`; }
  }
}
