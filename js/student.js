// 家長／學生頁：只讀取自己的資料（accounts/自己、班級資料、自己的學生紀錄、全班統計）
import { configured, db, waitUser, isAdmin, changeOwnPassword, logout, errText, esc, toast, setupNotice, doc, getDoc, updateDoc } from "./fb.js";
import { SCHOOL_NAME } from "./config.js";

const STATUS_LABEL = { "": "未登記", done: "已交", late: "遲交", makeup: "補交", missing: "未交", exempt: "免交" };
const SUBMITTED = { done: 1, late: 1, makeup: 1 };
const app = document.getElementById("app");
let cls, stu, stats, tab = "lesson";

const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
function fmt(n, d = 1) { if (n == null || isNaN(n)) return "—"; const p = 10 ** d; return String(Math.round(n * p) / p); }
const byDate = (a, b) => (a.date || "").localeCompare(b.date || "");
function weekday(d) { if (!d) return ""; const w = new Date(d + "T00:00:00").getDay(); return isNaN(w) ? "" : "週" + "日一二三四五六"[w]; }
function md(d) { return d ? d.slice(5).replace("-", "/") : ""; }

function myStats() {
  let counted = 0, sub = 0; const missing = [], hwS = [], exS = [];
  cls.homeworks.forEach(h => {
    const r = (stu.hw || {})[h.id] || {};
    if (r.s && r.s !== "exempt") { counted++; if (SUBMITTED[r.s]) sub++; if (r.s === "missing") missing.push(h); }
    if (h.full && typeof r.score === "number") hwS.push(r.score / h.full * 100);
  });
  cls.exams.forEach(e => { const v = (stu.ex || {})[e.id]; if (typeof v === "number" && e.full) exS.push(v / e.full * 100); });
  return { counted, sub, rate: counted ? sub / counted * 100 : null, missing, hwAvg: avg(hwS), exAvg: avg(exS) };
}

function render() {
  const st = myStats(), ov = (stats && stats.overall) || {};
  let h = `<div class="top"><h1>${esc(SCHOOL_NAME)}｜學習紀錄</h1><span class="spacer"></span>
    <button class="btn" data-act="chpw">改密碼</button><button class="btn" data-act="logout">登出</button></div>`;
  h += `<div class="sp"><div class="sp-head"><h2>${esc(stu.name)}</h2><p>${esc(cls.name)} 班${stu.no ? "・" + esc(stu.no) + " 號" : ""}${cls.subject ? "・" + esc(cls.subject) : ""}${cls.teacher ? "・" + esc(cls.teacher) + " 老師" : ""}</p></div>`;
  h += `<div class="cards">
    <div class="stat"><div class="k">作業繳交率</div><div class="v${st.rate != null && st.rate < 80 ? " bad" : ""}">${st.rate == null ? "—" : fmt(st.rate, 0) + "%"}</div><div class="c">${st.counted ? `交了 ${st.sub}/${st.counted} 份` : "尚無紀錄"}${ov.hwRate != null ? `・全班 ${fmt(ov.hwRate, 0)}%` : ""}</div></div>
    <div class="stat"><div class="k">未交作業</div><div class="v${st.missing.length ? " bad" : ""}">${st.missing.length}</div><div class="c">${st.missing.length ? esc(st.missing.map(x => x.title).join("、")) : "目前沒有未交"}</div></div>
    <div class="stat"><div class="k">考試平均（百分制）</div><div class="v">${fmt(st.exAvg)}</div><div class="c">${ov.exAvg != null ? `全班平均 ${fmt(ov.exAvg)}` : "　"}</div></div></div>`;
  const tabs = [["lesson", "上課進度"], ["hw", "作業"], ["exam", "考試"]];
  h += `<div class="tabs">${tabs.map(t => `<button class="tab${tab === t[0] ? " on" : ""}" data-act="tab" data-id="${t[0]}">${t[1]}</button>`).join("")}</div>`;
  h += tab === "hw" ? hwHtml() : tab === "exam" ? examHtml() : lessonHtml();
  h += `<p class="hint" style="margin-top:16px">全班平均只包含平均數字，不會顯示其他同學的成績。</p></div>`;
  app.innerHTML = h;
}
function lessonHtml() {
  const ls = (cls.lessons || []).slice().sort((a, b) => byDate(b, a));
  if (!ls.length) return `<div class="card empty">老師還沒有登記上課進度。</div>`;
  return `<div class="card">${ls.map(l => `<div class="lesson"><div class="date">${esc(md(l.date))}<small>${esc(l.date ? l.date.slice(0, 4) : "")} ${weekday(l.date)}</small></div>
    <div class="body">${l.unit ? `<p><b>${esc(l.unit)}</b></p>` : ""}<p>${esc(l.content)}</p>${l.homework ? `<div class="sub"><b>回家作業：</b>${esc(l.homework)}</div>` : ""}${l.note ? `<div class="sub"><b>備註：</b>${esc(l.note)}</div>` : ""}</div><div></div></div>`).join("")}</div>`;
}
function hwHtml() {
  const hws = cls.homeworks.slice().sort((a, b) => byDate(b, a));
  if (!hws.length) return `<div class="card empty">目前沒有作業紀錄。</div>`;
  return `<div class="listwrap"><table class="list"><thead><tr><th>日期</th><th>作業</th><th>繳交</th><th class="num">分數</th><th class="num">全班平均</th></tr></thead><tbody>${hws.map(h => {
    const r = (stu.hw || {})[h.id] || {}, s = (stats && stats.hw && stats.hw[h.id]) || {};
    return `<tr><td class="num" style="text-align:left">${esc(md(h.date))}</td><td>${esc(h.title)}</td><td><span class="chip ${esc(r.s || "")}">${STATUS_LABEL[r.s || ""]}</span></td>
      <td class="num">${h.full ? (typeof r.score === "number" ? `${fmt(r.score)} / ${esc(h.full)}` : "—") : "<span class='hint'>不計分</span>"}</td>
      <td class="num">${h.full && s.avg != null ? fmt(s.avg) : "—"}</td></tr>`;
  }).join("")}</tbody></table></div>`;
}
function examHtml() {
  const exs = cls.exams.slice().sort((a, b) => byDate(b, a));
  if (!exs.length) return `<div class="card empty">目前沒有考試紀錄。</div>`;
  return `<div class="listwrap"><table class="list"><thead><tr><th>日期</th><th>考試</th><th class="num">分數</th><th class="num">全班平均</th></tr></thead><tbody>${exs.map(e => {
    const v = (stu.ex || {})[e.id], s = (stats && stats.ex && stats.ex[e.id]) || {};
    const low = typeof v === "number" && v < e.full * 0.6;
    return `<tr><td class="num" style="text-align:left">${esc(md(e.date))}</td><td>${esc(e.title)}</td>
      <td class="num${low ? " lowtxt" : ""}">${v === "absent" ? "缺考" : typeof v === "number" ? `${fmt(v)} / ${esc(e.full)}` : "—"}</td>
      <td class="num">${s.avg != null ? fmt(s.avg) : "—"}</td></tr>`;
  }).join("")}</tbody></table></div>`;
}
function errorCard(title, msg) {
  app.innerHTML = `<div class="login-wrap"><div class="login-card"><h1>${esc(title)}</h1><p>${esc(msg)}</p><button class="btn primary" data-act="logout">回到登入頁</button></div></div>`;
}

app.addEventListener("click", async e => {
  const t = e.target.closest("[data-act]"); if (!t) return;
  if (t.tagName === "A") e.preventDefault();
  if (t.dataset.act === "tab") { tab = t.dataset.id; render(); }
  else if (t.dataset.act === "logout") { await logout(); location.replace("index.html"); }
  else if (t.dataset.act === "chpw") chpwDialog();
});
function chpwDialog() {
  const bg = document.createElement("div"); bg.className = "modal-bg";
  bg.innerHTML = `<div class="modal"><h3>修改密碼</h3>
    <div class="field"><label>目前密碼</label><input class="inp" type="password" name="old" autocomplete="current-password"></div>
    <div class="field"><label>新密碼（至少 6 個字元）</label><input class="inp" type="password" name="pw" autocomplete="new-password"></div>
    <div class="field"><label>再輸入一次新密碼</label><input class="inp" type="password" name="pw2" autocomplete="new-password"></div>
    <p class="hint">家長和學生共用這組帳號，改了密碼記得告訴對方。</p>
    <div class="acts"><button class="btn" data-m="cancel">取消</button><button class="btn primary" data-m="ok">確定</button></div></div>`;
  document.body.appendChild(bg);
  const val = n => bg.querySelector(`[name=${n}]`).value;
  const ok = async () => {
    if (val("pw").length < 6) return toast("新密碼至少 6 個字元");
    if (val("pw") !== val("pw2")) return toast("兩次輸入的新密碼不一樣");
    if (val("pw") === val("old")) return toast("新密碼不能和目前密碼一樣");
    try { await changeOwnPassword(val("old"), val("pw")); bg.remove(); toast("密碼已更新"); } catch (ex) { toast(errText(ex)); }
  };
  bg.addEventListener("click", e => { const m = e.target.dataset.m; if (e.target === bg || m === "cancel") bg.remove(); else if (m === "ok") ok(); });
  bg.addEventListener("keydown", e => { if (e.key === "Enter") ok(); else if (e.key === "Escape") bg.remove(); });
  bg.querySelector("input").focus();
}

// 第一次登入：必須先改密碼才能看資料
function forceChange(user, onDone) {
  app.innerHTML = `<div class="login-wrap"><form class="login-card" id="fc">
    <h1>請先設定新密碼</h1>
    <p class="sub">這是第一次登入，請把老師給的初始密碼改成你們自己的密碼。家長和學生共用這組帳號，改好後記得告訴對方。</p>
    <div class="field"><label for="o">初始密碼（老師給的）</label><input class="inp" id="o" type="password" autocomplete="current-password" required></div>
    <div class="field"><label for="n1">新密碼（至少 6 個字元）</label><input class="inp" id="n1" type="password" autocomplete="new-password" required></div>
    <div class="field"><label for="n2">再輸入一次新密碼</label><input class="inp" id="n2" type="password" autocomplete="new-password" required></div>
    <div class="err" id="fe"></div>
    <button class="btn primary" id="fb" type="submit">確認修改</button>
    <p class="hint" style="text-align:center"><a href="#" data-act="logout">登出</a></p></form></div>`;
  const fe = document.getElementById("fe"), btn = document.getElementById("fb");
  document.getElementById("fc").addEventListener("submit", async e => {
    e.preventDefault(); fe.textContent = "";
    const o = document.getElementById("o").value, n1 = document.getElementById("n1").value, n2 = document.getElementById("n2").value;
    if (n1.length < 6) { fe.textContent = "新密碼至少 6 個字元"; return; }
    if (n1 !== n2) { fe.textContent = "兩次輸入的新密碼不一樣"; return; }
    if (n1 === o) { fe.textContent = "新密碼不能和初始密碼一樣"; return; }
    btn.disabled = true; btn.textContent = "修改中…";
    try {
      await changeOwnPassword(o, n1);
      await updateDoc(doc(db, "accounts", user.uid), { mustChange: false });
      toast("密碼已更新"); onDone();
    } catch (ex) {
      fe.textContent = /invalid-credential|wrong-password/.test(ex.code || "") ? "初始密碼不正確" : errText(ex);
      btn.disabled = false; btn.textContent = "確認修改";
    }
  });
  document.getElementById("o").focus();
}

async function loadAndRender(classId, studentId) {
  const [c, s, st] = await Promise.all([
    getDoc(doc(db, "classes", classId)), getDoc(doc(db, "classes", classId, "students", studentId)),
    getDoc(doc(db, "classes", classId, "stats", "summary"))
  ]);
  if (!c.exists() || !s.exists()) return errorCard("找不到資料", "請聯絡老師確認帳號設定。");
  const cd = c.data();
  // 老師設為「家長看不到」的作業／考試不顯示
  cls = { name: cd.name || "", subject: cd.subject || "", teacher: cd.teacher || "", lessons: cd.lessons || [],
    homeworks: (cd.homeworks || []).filter(x => !x.hidden), exams: (cd.exams || []).filter(x => !x.hidden) };
  stu = s.data(); stats = st.exists() ? st.data() : null;
  render();
}

if (!configured) setupNotice(app);
else {
  const user = await waitUser();
  if (!user) location.replace("index.html");
  else if (isAdmin(user)) location.replace("teacher.html");
  else {
    try {
      const acc = await getDoc(doc(db, "accounts", user.uid));
      if (!acc.exists()) errorCard("帳號已失效", "這組帳號已被老師重設或停用，請用老師給的新密碼重新登入。");
      else {
        const { classId, studentId, mustChange } = acc.data();
        const go = () => loadAndRender(classId, studentId).catch(e => errorCard("載入失敗", errText(e)));
        if (mustChange) forceChange(user, go); else await go();
      }
    } catch (e) { errorCard("載入失敗", errText(e)); }
  }
}
