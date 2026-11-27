// 段考分析：解析分析檔、計算彙總統計、產生班級總覽與個人分析表
// 老師後台與家長頁共用。家長頁只拿到彙總統計（不含其他學生資料）＋本人作答紀錄。
import { esc } from "./fb.js";

/* ================= 解析 ================= */
// 支援兩種檔案：段考分析 HTML（內含 const D = {...}），或同結構的 JSON
export function parseAnalysisFile(text) {
  let D, ncq = null, title = "", subtitle = "";
  const t = text.trim();
  if (t.startsWith("{")) {
    D = JSON.parse(t); ncq = D.ncq || null; title = D.title || ""; subtitle = D.subtitle || "";
  } else {
    const i = t.indexOf("const D =");
    if (i < 0) throw new Error("找不到段考資料（const D）");
    D = JSON.parse(extractObject(t, t.indexOf("{", i)));
    const m = t.match(/const NCQ\s*=\s*(\[[\s\S]*?\]\s*\]);/);
    if (m) { try { ncq = JSON.parse(m[1].replace(/'/g, '"')).map(([name, max]) => ({ name, max })); } catch (e) { ncq = null; } }
    const tm = t.match(/<div class="t">([^<$]+?)\s*個人分析表<\/div>/) || t.match(/<title>([^<]+)<\/title>/);
    if (tm) title = tm[1].trim();
    const sm = t.match(/<div class="s">([^<$]+)<\/div>/);
    if (sm) subtitle = sm[1].trim();
    // 沿用原分析檔裡每一題非選擇題的建議文字（0 分／部分得分）
    if (ncq) for (const a of t.matchAll(/if \(s\.nc\[(\d+)\] < \d+\) adv\.push\(`[^`]*?\$\{([\s\S]*?)\}。`\);/g)) {
      const k = Number(a[1]), strs = [...a[2].matchAll(/'([^']*)'/g)].map(x => x[1]), lm = a[2].match(/<=\s*(\d+)/);
      if (ncq[k] && strs.length >= 2) ncq[k].adv = strs.length >= 3 ? { zero: strs[0], low: strs[1], high: strs[2], lowMax: lm ? Number(lm[1]) : 0 } : { zero: strs[0], low: strs[1], high: strs[1], lowMax: 999 };
    }
  }
  return normalize(D, ncq, title, subtitle);
}
function extractObject(s, start) {
  let depth = 0, inStr = false, q = "", esc2 = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc2) esc2 = false; else if (c === "\\") esc2 = true; else if (c === q) inStr = false; continue; }
    if (c === '"' || c === "'") { inStr = true; q = c; }
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  throw new Error("段考資料格式不完整");
}
function normalize(D, ncq, title, subtitle) {
  if (!D || typeof D.key !== "string" || !Array.isArray(D.pts) || !Array.isArray(D.students)) throw new Error("段考資料缺少答案、配分或學生資料");
  const Q = D.key.length;
  if (D.pts.length !== Q) throw new Error("配分題數和答案題數不一致");
  const units = Array.isArray(D.units) ? D.units.map(u => ({ name: u.name, qs: u.qs })) : Object.entries(D.units || {}).map(([name, qs]) => ({ name, qs }));
  const qdesc = Array.isArray(D.qdesc) ? D.qdesc.slice(0, Q) : [...Array(Q)].map((_, i) => (D.qdesc || {})[i + 1] || "");
  const ncN = Math.max(0, ...D.students.map(s => (s.nc || []).length));
  if (ncq && ncq.length === ncN) ncq = ncq.map(q => Object.assign({ name: String(q.name), max: Number(q.max) }, q.adv ? { adv: q.adv } : {}));
  else ncq = [...Array(ncN)].map((_, k) => ({ name: `非選擇題第 ${k + 1} 題`, max: Math.max(...D.students.map(s => (s.nc || [])[k] || 0)) }));
  const students = D.students.map(s => ({
    clsName: String(s.cls), seat: String(s.seat), name: String(s.name || ""),
    ans: [...Array(Q)].map((_, i) => String((s.ans || [])[i] || "").toUpperCase()),
    nc: [...Array(ncN)].map((_, k) => Number((s.nc || [])[k]) || 0),
    choice: Number(s.choice), score: Number(s.score != null ? s.score : s.total)
  }));
  students.forEach(s => { if (isNaN(s.choice)) s.choice = s.ans.reduce((t, a, i) => t + (a === D.key[i] ? D.pts[i] : 0), 0); if (isNaN(s.score)) s.score = s.choice + s.nc.reduce((a, b) => a + b, 0); });
  return { title: title || "段考", subtitle, key: D.key, pts: D.pts.map(Number), units, qdesc, ncq, students };
}

/* ================= 統計 ================= */
const pct = (a, b) => b ? Math.round(100 * a / b) : 0;
export function five(scores) {
  const d = [...scores].sort((a, b) => b - a), n = d.length;
  if (!n) return { top: 0, front: 0, mid: 0, back: 0, bottom: 0, avg: 0, sd: 0, n: 0 };
  const at = p => d[Math.max(1, Math.ceil(n * (1 - p))) - 1];
  const avg = scores.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(scores.reduce((t, v) => t + (v - avg) ** 2, 0) / (n - 1)) : 0;
  return { top: at(.88), front: at(.75), mid: at(.5), back: at(.25), bottom: at(.12), avg, sd: Math.round(sd * 100) / 100, n };
}
function median(a) { const b = [...a].sort((x, y) => x - y), m = b.length >> 1; return b.length ? (b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2) : 0; }

// raw：parseAnalysisFile 的結果；classMap：{ 班級名稱: classId }
// 回傳可以給家長讀的彙總（不含任何個人作答）
export function buildAgg(raw, classMap) {
  const Q = raw.key.length, S = raw.students;
  const ok = (s, i) => s.ans[i] === raw.key[i];
  const rate = (g, i) => pct(g.filter(s => ok(s, i)).length, g.length);
  const uRate = (g, qs) => pct(g.reduce((t, s) => t + qs.filter(q => ok(s, q - 1)).length, 0), g.length * qs.length);
  const sorted = [...S].sort((a, b) => b.score - a.score), n27 = Math.round(S.length * 0.27);
  const hi = sorted.slice(0, n27), lo = sorted.slice(-n27);
  const cls = {}, classIds = [];
  Object.entries(classMap).forEach(([name, id]) => {
    const g = S.filter(s => s.clsName === name); if (!g.length) return;
    const sc = g.map(s => s.score);
    classIds.push(id);
    cls[id] = {
      name, n: g.length, five: five(sc), median: median(sc), max: Math.max(...sc), min: Math.min(...sc),
      unitRate: raw.units.map(u => uRate(g, u.qs)), itemRate: [...Array(Q)].map((_, i) => rate(g, i)),
      ncAvg: raw.ncq.map((_, k) => g.reduce((t, s) => t + s.nc[k], 0) / g.length)
    };
  });
  return {
    title: raw.title, subtitle: raw.subtitle, key: raw.key, pts: raw.pts, units: raw.units, qdesc: raw.qdesc,
    ncq: raw.ncq.map((q, k) => Object.assign({ name: q.name, max: q.max, gift: S.length > 0 && S.every(s => s.nc[k] === q.max) }, q.adv ? { adv: q.adv } : {})),
    choiceMax: raw.pts.reduce((a, b) => a + b, 0), ncMax: raw.ncq.reduce((a, q) => a + q.max, 0),
    allRate: [...Array(Q)].map((_, i) => rate(S, i)), allUnitRate: raw.units.map(u => uRate(S, u.qs)),
    disc: [...Array(Q)].map((_, i) => Math.round((rate(hi, i) - rate(lo, i))) / 100), n27,
    all: five(S.map(s => s.score)), classIds, cls
  };
}

/* ================= 共用小工具 ================= */
const level = r => r < 60 ? ["難題", "p-hard"] : r < 85 ? ["中等", "p-mid"] : ["基礎", "p-easy"];
export const bandOf = (b, v) => v >= b.top ? "達頂標" : v >= b.front ? "達前標" : v >= b.mid ? "達均標" : v >= b.back ? "達後標" : v >= b.bottom ? "達底標" : "未達底標";
const unitCode = u => (u.match(/^(\d+-\d+)/) || [])[1];
const shortU = u => unitCode(u) || (/[・·]/.test(u) ? u.split(/[・·]/).pop() : u).slice(0, 6);
const unitIdx = (agg, q) => agg.units.findIndex(u => u.qs.includes(q));
const COLORS = ["#257de0", "#f47230", "#1f9d6b", "#8a5cd6"];
export const classColor = (agg, id) => COLORS[Math.max(0, agg.classIds.indexOf(id)) % COLORS.length];
function ptsNote(agg) {
  const groups = []; agg.pts.forEach((p, i) => { const g = groups[groups.length - 1]; if (g && g.p === p) g.to = i + 1; else groups.push({ p, from: i + 1, to: i + 1 }); });
  const ch = groups.map(g => `第 ${g.from}${g.to > g.from ? "–" + g.to : ""} 題每題 ${g.p} 分`).join("、");
  const nc = agg.ncq.length ? "；非選擇題" + agg.ncq.map((q, k) => `第 ${k + 1} 題 ${q.max} 分`).join("、") : "";
  return `※ 選擇題${ch}${nc}。`;
}
function giftNote(agg) { const g = agg.ncq.map((q, k) => q.gift ? k + 1 : 0).filter(Boolean); return g.length ? `第 ${g.join("、")} 題全體滿分` : ""; }
const classNames = agg => agg.classIds.map(id => agg.cls[id].name);
const allLabel = agg => `${classNames(agg).join("＋")} 共 ${agg.all.n} 人`;

/* ================= 個人分析表 ================= */
// rec：{ans, nc, choice, score}；meta：{seat, name}
export function sheetHtml(agg, clsId, meta, rec) {
  const K = agg.key, P = agg.pts, Q = K.length, c = agg.cls[clsId], st = c.five, sch = agg.all;
  const ok = i => rec.ans[i] === K[i];
  const ncT = rec.nc.reduce((a, b) => a + b, 0);
  const wrongIdx = [...Array(Q).keys()].filter(i => !ok(i)), blanks = wrongIdx.filter(i => !rec.ans[i]);
  const uData = agg.units.map((u, k) => { const n = u.qs.filter(q => ok(q - 1)).length; return { u: u.name, qs: u.qs, c: n, r: pct(n, u.qs.length), avg: c.unitRate[k] }; });
  const easyLost = wrongIdx.filter(i => agg.allRate[i] >= 85), midLost = wrongIdx.filter(i => agg.allRate[i] >= 60 && agg.allRate[i] < 85);
  const lostPts = a => a.reduce((t, i) => t + P[i], 0);
  const base = uData.filter(d => unitCode(d.u)), strong = uData.filter(d => d.r === 100);
  const weakB = base.length ? [...base].sort((a, b) => (a.r - a.avg) - (b.r - b.avg))[0] : null;
  const range = base.length ? `${unitCode(base[0].u)}～${unitCode(base[base.length - 1].u)}` : "";
  const adv = [];
  adv.push(`總分 <b>${rec.score}</b> 分（選擇 ${rec.choice}＋非選 ${ncT}），班級五標${bandOf(st, rec.score)}、全體五標${bandOf(sch, rec.score)}；比班平均${rec.score >= st.avg ? "高" : "低"} ${Math.abs(rec.score - st.avg).toFixed(1)} 分，比全體平均${rec.score >= sch.avg ? "高" : "低"} ${Math.abs(rec.score - sch.avg).toFixed(1)} 分。`);
  if (easyLost.length) adv.push(`有 <b>${easyLost.length}</b> 題基礎題失分（第 ${easyLost.map(i => i + 1).join("、")} 題，全體答對率都在 85% 以上），共 ${lostPts(easyLost)} 分，請優先訂正，這是最快能拿回的分數。`);
  if (midLost.length) adv.push(`中等題失分 ${midLost.length} 題（第 ${midLost.map(i => i + 1).join("、")} 題），共 ${lostPts(midLost)} 分，建議找同類型的題目再練習。`);
  if (base.length && base.every(d => d.r === 100)) adv.push(`課本單元（${range}）全部答對，基礎觀念完整，下一步可以多練素養題和題組。`);
  else if (weakB && weakB.r < 100) adv.push(`課本單元中最需要加強的是<b>「${esc(weakB.u)}」</b>（答對 ${weakB.c}/${weakB.qs.length} 題，班平均 ${weakB.avg}%）。`);
  if (strong.length && !(base.length && base.every(d => d.r === 100))) adv.push(`表現穩定的單元：${strong.map(d => esc(d.u)).join("、")}（全對）。`);
  agg.ncq.forEach((q, k) => {
    if (q.gift || rec.nc[k] >= q.max) return;
    const v = rec.nc[k];
    const tip = q.adv ? (v === 0 ? q.adv.zero : v <= q.adv.lowMax ? q.adv.low : q.adv.high)
      : (v === 0 ? "這類題目要從頭再練一次，先讀懂題意、再寫出完整過程" : v <= q.max / 2 ? "過程中有步驟出錯，要再細心檢查每一步" : "只差一點，答案的單位和最後一步要寫完整");
    adv.push(`非選第 ${k + 1} 題（${esc(q.name)}）得 ${v}/${q.max} 分，${esc(tip)}。`);
  });
  if (blanks.length) adv.push(`有 <b>${blanks.length}</b> 題沒有作答（第 ${blanks.map(i => i + 1).join("、")} 題），要注意時間分配；選擇題空白一定拿不到分數，至少要作答。`);
  const scale = (b, v) => {
    const LO = Math.min(20, b.bottom - 5, v - 2), X = x => ((Math.max(x, LO) - LO) / (100 - LO) * 100).toFixed(2) + "%";
    const tk = [["底標", b.bottom], ["後標", b.back], ["均標", b.mid], ["前標", b.front], ["頂標", b.top]].map(([l, x], k) => `<div class="tk${k % 2 ? " alt" : ""}" style="left:${X(x)}">${l}<br>${x}</div>`).join("");
    return `<div class="scale"><div class="ln"></div>${tk}<div class="me" style="left:${X(v)}">${v}</div></div>`;
  };
  const wrongRows = idx => idx.map(i => { const [lv, cl] = level(agg.allRate[i]); return `<tr><td class="num"><b>${i + 1}</b></td><td>${esc(shortU(agg.units[unitIdx(agg, i + 1)]?.name || ""))}</td><td>${esc(agg.qdesc[i])}</td><td class="wa">${esc(rec.ans[i] || "未答")}</td><td><b>${K[i]}</b></td><td class="num">${P[i]}</td><td class="num">${agg.allRate[i]}%</td><td><span class="pill ${cl}">${lv}</span></td></tr>`; }).join("");
  const wrongShort = idx => `<div class="scroll"><table><thead><tr><th class="num">題號</th><th>考點</th><th>你的答案</th><th>正確</th><th class="num">全體答對率</th></tr></thead><tbody>${idx.map(i => `<tr><td class="num"><b>${i + 1}</b></td><td>${esc(agg.qdesc[i])}</td><td class="wa">${esc(rec.ans[i] || "未答")}</td><td><b>${K[i]}</b></td><td class="num">${agg.allRate[i]}%</td></tr>`).join("")}</tbody></table></div>`;
  const half = Math.ceil(wrongIdx.length / 2), gn = giftNote(agg);
  return `<article class="sheet sh">
  <div class="sh-head"><div><div class="t">${esc(agg.title)} 個人分析表</div><div class="s">${esc(agg.subtitle)}</div></div>
   <div class="who">${esc(c.name)} 班${meta.seat ? " " + esc(meta.seat) + " 號" : ""}<b>${esc(meta.name)}</b></div></div>
  <div class="sh-k"><div class="main"><div class="l">總分 <small>選擇 ${rec.choice}／${agg.choiceMax}${agg.ncq.length ? `＋非選 ${ncT}／${agg.ncMax}` : ""}</small></div><div class="v"><span>${rec.score}</span> <small>／ ${agg.choiceMax + agg.ncMax}</small></div></div>
   <div><div class="l">班級五標落點</div><div class="v">${bandOf(st, rec.score)}</div></div>
   <div><div class="l">班級平均</div><div class="v">${st.avg.toFixed(1)}</div></div>
   <div><div class="l">全體平均</div><div class="v">${sch.avg.toFixed(1)}</div></div></div>
  <div class="scales"><div><h3>在班級五標的位置 <small>${esc(c.name)} 班 ${c.n} 人</small></h3>${scale(st, rec.score)}</div>
   <div><h3>在全體五標的位置 <small>${esc(allLabel(agg))}</small></h3>${scale(sch, rec.score)}</div></div>
  ${agg.ncq.length ? `<h3>非選擇題 <small>${esc(gn)}</small></h3>
  <div class="ncg" style="grid-template-columns:repeat(${Math.min(agg.ncq.length, 4)},minmax(0,1fr))">${agg.ncq.map((q, k) => `<div><div class="l">第 ${k + 1} 題・${esc(q.name)}</div><div class="v${rec.nc[k] < q.max ? " lo" : ""}">${rec.nc[k]}<small> ／ ${q.max}</small></div><div class="l">班平均 ${c.ncAvg[k].toFixed(1)}</div></div>`).join("")}</div>` : ""}
  <h3>各單元答對情形（選擇題） <small>長條是本人答對率，黑線是班級平均</small></h3>
  ${uData.map(d => `<div class="su"><div>${esc(d.u)}</div><div class="track"><div class="fill" style="width:${d.r}%;background:${d.r < d.avg - 10 ? "var(--bad)" : "var(--c1)"}"></div><div class="mk" style="left:calc(${d.avg}% - 1px)"></div></div><div class="r">${d.c}/${d.qs.length} 題・${d.r}%</div></div>`).join("")}
  <h3>逐題作答 <small>✓ 答對・紅色字母＝選的錯誤選項・虛線框＝未作答</small></h3>
  <div class="ag" style="grid-template-columns:repeat(${Math.min(Q, 25)},minmax(0,1fr))">${rec.ans.map((a, i) => `<div class="${ok(i) ? "" : a ? "x" : "e"}">${i + 1}<b>${ok(i) ? "✓" : esc(a || "—")}</b></div>`).join("")}</div>
  <h3>選擇題錯題分析 <small>共錯 ${wrongIdx.length} 題，失 ${lostPts(wrongIdx)} 分</small></h3>
  ${wrongIdx.length ? (wrongIdx.length > 9 ? `<div class="wt2">${wrongShort(wrongIdx.slice(0, half))}${wrongShort(wrongIdx.slice(half))}</div>`
    : `<div class="scroll"><table><thead><tr><th class="num">題號</th><th>單元</th><th>考點</th><th>你的答案</th><th>正確</th><th class="num">配分</th><th class="num">全體答對率</th><th>難度</th></tr></thead><tbody>${wrongRows(wrongIdx)}</tbody></table></div>`)
    : `<div class="allgood">選擇題全部答對！</div>`}
  <div class="advice"><b>學習建議</b><ul>${adv.map(a => `<li>${a}</li>`).join("")}</ul></div>
  <div class="sh-foot"><span>${esc(ptsNote(agg))}</span><span>全體＝${esc(allLabel(agg))}</span></div>
  </article>`;
}

/* ================= 老師用：班級總覽 ================= */
// students：[{clsId, seat, name, rec}]（老師從各班學生紀錄組出來）
export function overviewHtml(agg, students, sortMode) {
  const K = agg.key, Q = K.length, ids = agg.classIds;
  const ok = (s, i) => s.rec.ans[i] === K[i];
  const byCls = id => students.filter(s => s.clsId === id);
  const hardest = agg.allRate.map((r, i) => [r, i + 1]).sort((a, b) => a[0] - b[0]).slice(0, 2).sort((a, b) => a[1] - b[1]);
  const weakUnits = agg.units.map((u, k) => [u.name, agg.allUnitRate[k]]).sort((a, b) => a[1] - b[1]);
  const color = id => classColor(agg, id);
  const legend = `<div class="legend">${ids.map(id => `<span><i style="background:${color(id)}"></i>${esc(agg.cls[id].name)}</span>`).join("")}</div>`;
  let h = `<h1>${hardest.length >= 2 ? `失分最集中在第 ${hardest[0][1]}、${hardest[1][1]} 題：全體答對率只有 ${hardest[0][0]}%、${hardest[1][0]}%` : esc(agg.title)}</h1>
   <p class="sub">${esc(agg.subtitle)}・${ids.map(id => `${esc(agg.cls[id].name)} 班 ${agg.cls[id].n} 人`).join("、")}。總分 ${agg.choiceMax + agg.ncMax} 分＝選擇題 ${agg.choiceMax} 分${agg.ncq.length ? `＋非選擇題 ${agg.ncMax} 分` : ""}${giftNote(agg) ? `（非選${giftNote(agg)}）` : ""}。逐題分析和單元答對率只看選擇題。</p>`;
  h += `<div class="kpis">${ids.map((id, k) => { const c = agg.cls[id]; return `<div class="kpi${k === 0 ? " hl" : ""}"><div class="l">${esc(c.name)} 班平均</div><div class="v">${c.five.avg.toFixed(2)}</div><div class="n">中位數 ${c.median}・標準差 ${c.five.sd}・最高 ${c.max}／最低 ${c.min}</div></div>`; }).join("")}
   <div class="kpi"><div class="l">全體平均（${agg.all.n} 人）</div><div class="v">${agg.all.avg.toFixed(2)}</div><div class="n">頂 ${agg.all.top}・前 ${agg.all.front}・均 ${agg.all.mid}・後 ${agg.all.back}・底 ${agg.all.bottom}・標準差 ${agg.all.sd}</div></div>
   ${weakUnits.length ? `<div class="kpi"><div class="l">最弱單元（全體）</div><div class="v">${weakUnits[0][1]}%</div><div class="n">${esc(weakUnits[0][0])}${weakUnits[1] ? `；次弱：${esc(weakUnits[1][0])} ${weakUnits[1][1]}%` : ""}</div></div>` : ""}</div>`;
  const bins = [[0, 49, "49 以下"], [50, 59, "50–59"], [60, 69, "60–69"], [70, 79, "70–79"], [80, 89, "80–89"], [90, 1000, "90 以上"]];
  const cnt = id => bins.map(([a, b]) => byCls(id).filter(s => s.rec.score >= a && s.rec.score <= b).length);
  const counts = ids.map(cnt), mx = Math.max(1, ...counts.flat());
  h += `<div class="grid2"><div class="acard"><h2>分數分布</h2><p class="sub">各分數區間的人數</p>${legend}
    <div class="hist">${bins.map((b, i) => `<div class="hcol">${ids.map((id, k) => `<div class="hbar" style="height:${counts[k][i] / mx * 88}%;background:${color(id)}" title="${esc(agg.cls[id].name)} 班 ${b[2]} 分：${counts[k][i]} 人"><span>${counts[k][i]}</span></div>`).join("")}</div>`).join("")}</div>
    <div class="hlab">${bins.map(b => `<div>${b[2]}</div>`).join("")}</div></div>
   <div class="acard"><h2>各單元答對率</h2><p class="sub">單元裡每一題的答對人次加總，除以作答總人次</p>${legend}
    ${agg.units.map((u, k) => `<div class="urow"><div class="ulab">${esc(u.name)}<div class="dtxt">第 ${u.qs.join("、")} 題</div></div><div class="bars">${ids.map(id => { const r = agg.cls[id].unitRate[k]; return `<div class="bar"><div class="track"><div class="fill" style="width:${r}%;background:${color(id)}"></div></div><em>${r}%</em></div>`; }).join("")}</div></div>`).join("")}</div></div>`;
  if (agg.ncq.length) h += `<div class="acard"><h2>非選擇題</h2><p class="sub">各題平均得分與得分分布（人數）${giftNote(agg) ? "。" + giftNote(agg) : ""}</p><div class="scroll"><table><thead><tr><th class="num">題號</th><th>考點</th><th class="num">滿分</th>${ids.map(id => `<th class="num">${esc(agg.cls[id].name)} 平均</th>`).join("")}<th class="num">全體得分率</th><th>得分分布（全體）</th></tr></thead><tbody>
    ${agg.ncq.map((q, k) => { const dist = [...Array(q.max + 1)].map((_, v) => students.filter(s => s.rec.nc[k] === v).length);
      return `<tr><td class="num"><b>${k + 1}</b></td><td>${esc(q.name)}</td><td class="num">${q.max}</td>${ids.map(id => `<td class="num">${agg.cls[id].ncAvg[k].toFixed(2)}</td>`).join("")}<td class="num"><b>${pct(students.reduce((t, s) => t + s.rec.nc[k], 0), students.length * q.max)}%</b></td><td class="dtxt" style="white-space:normal">${dist.map((n, v) => n ? `${v} 分 ${n} 人` : "").filter(Boolean).join("・")}</td></tr>`; }).join("")}</tbody></table></div></div>`;
  const order = [...Array(Q).keys()]; if (sortMode === "r") order.sort((a, b) => agg.allRate[a] - agg.allRate[b]);
  h += `<div class="acard"><h2>選擇題逐題分析</h2>
   <p class="sub">難度依全體答對率：低於 60% 為難題，60–84% 為中等題，85% 以上為基礎題。鑑別度＝高分組答對率 − 低分組答對率（全體各取前、後 ${agg.n27} 人），0.3 以上算鑑別力良好。選項分布中，藍色是正確答案，紅色是最多人選的錯誤選項，灰色是其他錯誤選項，淺灰是未作答。</p>
   <div class="seg"><button class="abtn" data-act="anasort" data-id="q" aria-pressed="${sortMode !== "r"}">依題號</button><button class="abtn" data-act="anasort" data-id="r" aria-pressed="${sortMode === "r"}">依答對率（低到高）</button></div>
   <div class="scroll"><table><thead><tr><th class="num">題號</th><th>單元</th><th>考點</th><th>答案</th>${ids.map(id => `<th class="num">${esc(agg.cls[id].name)}</th>`).join("")}<th class="num">全體</th><th>難度</th><th>選項分布（全體）</th><th class="num">鑑別度</th></tr></thead><tbody>
   ${order.map(i => {
     const d = { A: 0, B: 0, C: 0, D: 0, "": 0 }; students.forEach(s => { const a = s.rec.ans[i]; d[a in d ? a : ""]++; });
     const wrong = ["A", "B", "C", "D"].filter(o => o !== K[i]).sort((a, b) => d[b] - d[a]), top = d[wrong[0]] ? wrong[0] : null;
     const segs = ["A", "B", "C", "D", ""].filter(o => d[o]).map(o => `<div style="flex:${d[o]};background:${o === K[i] ? "var(--c1)" : o === top ? "var(--bad)" : o === "" ? "var(--line)" : "#9aa3ad"}" title="${o || "未答"}：${d[o]} 人"></div>`).join("");
     const txt = ["A", "B", "C", "D"].map(o => o === K[i] ? `<b>${o} ${d[o]}</b>` : `${o} ${d[o]}`).join("・") + (d[""] ? `・未答 ${d[""]}` : "");
     const [lv, cl] = level(agg.allRate[i]);
     return `<tr><td class="num"><b>${i + 1}</b></td><td>${esc(shortU(agg.units[unitIdx(agg, i + 1)]?.name || ""))}</td><td>${esc(agg.qdesc[i])}</td><td><b>${K[i]}</b></td>${ids.map(id => `<td class="num">${agg.cls[id].itemRate[i]}%</td>`).join("")}<td class="num"><b>${agg.allRate[i]}%</b></td><td><span class="pill ${cl}">${lv}</span></td><td><div class="dist">${segs}</div><div class="dtxt">${txt}</div></td><td class="num">${agg.disc[i].toFixed(2)}</td></tr>`;
   }).join("")}</tbody></table></div></div>`;
  h += `<div class="grid2">${ids.map(id => `<div class="acard"><h2>${esc(agg.cls[id].name)} 班成績一覽</h2><p class="sub">點姓名可以打開個人分析表</p><div class="scroll"><table><thead><tr><th class="num">座號</th><th>姓名</th><th class="num">總分</th><th class="num">選擇</th>${agg.ncq.length ? `<th class="num">非選</th>` : ""}<th>班級五標</th>${agg.units.map(u => `<th class="num">${esc(shortU(u.name))}</th>`).join("")}</tr></thead><tbody>
    ${byCls(id).map(s => `<tr><td class="num">${esc(s.seat)}</td><td><button class="namebtn" data-act="anastu" data-c="${esc(id)}" data-s="${esc(s.sid)}">${esc(s.name)}</button></td><td class="num"><b>${s.rec.score}</b></td><td class="num">${s.rec.choice}</td>${agg.ncq.length ? `<td class="num">${s.rec.nc.reduce((a, b) => a + b, 0)}</td>` : ""}<td style="white-space:nowrap">${bandOf(agg.cls[id].five, s.rec.score)}</td>
    ${agg.units.map(u => { const r = pct(u.qs.filter(q => ok(s, q - 1)).length, u.qs.length); return `<td class="num" style="${r < 50 ? "color:var(--bad);font-weight:700" : ""}">${r}%</td>`; }).join("")}</tr>`).join("")}</tbody></table></div></div>`).join("")}</div>`;
  const weakest = s => agg.units.map((u, k) => [u.name, pct(u.qs.filter(q => ok(s, q - 1)).length, u.qs.length) - agg.allUnitRate[k]]).sort((a, b) => a[1] - b[1])[0]?.[0] || "";
  h += `<div class="acard"><h2>需要關注的學生</h2><p class="sub">低於全體後標（${agg.all.back} 分）的學生，以及他們最弱的單元</p><div class="grid2">${ids.map(id => `<div><b>${esc(agg.cls[id].name)} 班</b><ul class="watch">${byCls(id).filter(s => s.rec.score < agg.all.back).map(s => { const b = s.rec.ans.filter(a => !a).length;
    return `<li><button class="namebtn" data-act="anastu" data-c="${esc(id)}" data-s="${esc(s.sid)}">${esc(s.name)}</button>　${s.rec.score} 分・最弱：${esc(weakest(s))}${b >= 3 ? `・<span style="color:var(--bad)">未答 ${b} 題</span>` : ""}</li>`; }).join("") || "<li>沒有</li>"}</ul></div>`).join("")}</div></div>`;
  return h;
}
