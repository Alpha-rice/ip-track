import { openDB, addMeasurement, getAllMeasurements, clearMeasurements, saveSetting, loadSetting } from './db.js';

// ====== 設定: Tokenを埋め込み（公開配布に注意） ======
const IPINFO_TOKEN = "7de1450d6bd417"; // TODO: ここに発行したトークンを記載[2][10][16]

// ====== IPinfo API: 自分のIP or 指定IP ======
async function fetchIpinfo(targetIp) {
  const base = "https://ipinfo.io";
  const path = targetIp ? `/${encodeURIComponent(targetIp)}/json` : "/json"; // /{ip}/json or /json[2][3]
  const url = `${base}${path}?token=${encodeURIComponent(IPINFO_TOKEN)}`;
  const res = await fetch(url, { cache: "no-store", headers: { "Accept": "application/json" } });
  if (!res.ok) throw new Error(`ipinfo ${res.status}`);
  const data = await res.json();
  // data: ip, hostname, city, region, country, org など[10][13][6]
  return data;
}

// ====== 表示ユーティリティ ======
function fmtShortTime(ts) {
  const d = new Date(ts);
  const z = (n) => String(n).padStart(2, "0");
  return `${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
}
function fmtDelta(ms){
  if (ms == null) return "";
  const s = Math.floor(ms/1000);
  const m = Math.floor(s/60);
  const r = s % 60;
  if (m === 0) return `+${r}s`;
  return `+${m}m${r}s`;
}
function computeChangeIntervalsMs(listAsc){
  const intervals=[]; let prev=null;
  for (const cur of listAsc) {
    if (!prev){ prev=cur; continue; }
    if (cur.ip!=null && prev.ip!=null && cur.ip!==prev.ip) intervals.push(cur.ts - prev.ts);
    prev=cur;
  }
  return intervals;
}
function averageMs(arr){ if(!arr.length) return null; return arr.reduce((a,b)=>a+b,0)/arr.length; }

const el = {
  targetIp: document.getElementById("targetIp"),
  intervalSlider: document.getElementById("intervalSlider"),
  intervalSec: document.getElementById("intervalSec"),
  intervalLabel: document.getElementById("intervalLabel"),
  apply: document.getElementById("apply"),

  statusDot: document.getElementById("status"),
  currentIP: document.getElementById("currentIP"),
  metaLine: document.getElementById("metaLine"),

  avgInterval: document.getElementById("avgInterval"),
  changeCount: document.getElementById("changeCount"),
  historyBody: document.getElementById("historyBody"),

  btnStart: document.getElementById("btnStart"),
  btnStop: document.getElementById("btnStop"),
  btnGet: document.getElementById("btnGet"),
  btnClear: document.getElementById("btnClear"),
};

let timerId = null;

function setStatus(state){
  el.statusDot.classList.remove("status-ok","status-warn","status-err");
  if (state==="ok") el.statusDot.classList.add("status-ok");
  else if (state==="warn") el.statusDot.classList.add("status-warn");
  else if (state==="err") el.statusDot.classList.add("status-err");
}

async function refreshView(){
  const list = await getAllMeasurements();
  // 新しい順に表示するため、降順で描画。ただし計算は昇順が都合良いので別配列を作成。
  list.sort((a,b)=>b.ts - a.ts); // 降順（最新が先頭）
  const listAsc = [...list].reverse(); // 計算用に昇順

  const last = list.length ? list[0] : null; // 降順の先頭が最新
  el.currentIP.textContent = last && last.ip!=null ? last.ip : "-";

  // メタ情報（org / hostname / location）
  if (last && last.meta) {
    const { org, hostname, country, region, city } = last.meta;
    const locStr = [country, region, city].filter(Boolean).join(" / ");
    const parts = [];
    if (org) parts.push(`Org: ${org}`);
    if (hostname) parts.push(`Host: ${hostname}`);
    if (locStr) parts.push(`Loc: ${locStr}`);
    el.metaLine.textContent = parts.length ? parts.join(" | ") : "-";
  } else {
    el.metaLine.textContent = "-";
  }

  // 統計（Avg/Chg）
  const intervals = computeChangeIntervalsMs(listAsc);
  el.changeCount.textContent = String(intervals.length);
  const avg = averageMs(intervals);
  el.avgInterval.textContent = avg ? (avg>=3600000 ? (avg/3600000).toFixed(1)+"h" : (avg/60000).toFixed(1)+"m") : "-";

  // テーブル3カラム（新しい順）
  el.historyBody.innerHTML = "";
  for (let i=0;i<list.length;i++){
    const cur = list[i];
    const next = i>0 ? list[i-1] : null; // 降順なので一つ前が「直前の記録」
    const changed = !!(next && next.ip!=null && cur.ip!=null && next.ip!==cur.ip);
    // 不一致（WebRTC併用時の概念）は現状なし。将来用に保持するならここで条件を定義。
    const mismatch = false;

    const icon = changed ? "↻" : (mismatch ? "≠" : "=");
    const iconClass = changed ? "icon-changed" : (mismatch ? "icon-mismatch" : "icon-same");

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="icon-cell ${iconClass}">${icon}</td>
      <td>
        <span class="time-top">${fmtShortTime(cur.ts)}</span>
        <span class="time-sub">${next ? fmtDelta(next.ts - cur.ts) : ""}</span>
      </td>
      <td>${cur.ip ?? "-"}</td>
    `;
    el.historyBody.appendChild(tr);
  }
}

async function sampleOnce(){
  setStatus("warn");
  const ts = Date.now();

  try {
    const target = (el.targetIp.value || "").trim() || null;
    const data = await fetchIpinfo(target); // ip, hostname, city, region, country, org 等[2][10][13]

    const record = {
      ts,
      ip: data.ip ?? null,
      source: "ipinfo",
      meta: {
        org: data.org ?? null,
        hostname: data.hostname ?? null,
        country: data.country ?? null,
        region: data.region ?? null,
        city: data.city ?? null,
      }
    };

    await addMeasurement(record);
    setStatus(record.ip ? "ok" : "err");
  } catch (e) {
    setStatus("err");
    await addMeasurement({ ts, ip: null, source: "error" });
  } finally {
    await refreshView();
  }
}

function startPolling(){
  if (timerId) return;
  const sec = clampInterval(Number(el.intervalSec.value));
  el.intervalSec.value = String(sec);
  el.intervalSlider.value = String(sec);
  el.intervalLabel.textContent = `${sec}s`;
  timerId = setInterval(sampleOnce, sec*1000);
  el.btnStart.disabled = true;
  el.btnStop.disabled = false;
  sampleOnce();
}
function stopPolling(){
  if (!timerId) return;
  clearInterval(timerId);
  timerId=null;
  el.btnStart.disabled = false;
  el.btnStop.disabled = true;
}

function clampInterval(v){
  if (Number.isNaN(v)) return 60;
  return Math.min(300, Math.max(15, Math.round(v/5)*5));
}

(async function init(){
  await openDB();

  const savedSec = await loadSetting("intervalSec", 60);
  const sec = clampInterval(savedSec);
  el.intervalSec.value = String(sec);
  el.intervalSlider.value = String(sec);
  el.intervalLabel.textContent = `${sec}s`;

  const savedTarget = await loadSetting("targetIp", "");
  el.targetIp.value = savedTarget;

  el.intervalSlider.addEventListener("input", ()=>{
    el.intervalSec.value = el.intervalSlider.value;
    el.intervalLabel.textContent = `${el.intervalSlider.value}s`;
    if (timerId){ stopPolling(); startPolling(); }
  });
  el.intervalSec.addEventListener("change", ()=>{
    const s = clampInterval(Number(el.intervalSec.value));
    el.intervalSec.value = String(s);
    el.intervalSlider.value = String(s);
    el.intervalLabel.textContent = `${s}s`;
    if (timerId){ stopPolling(); startPolling(); }
  });
  el.apply.addEventListener("click", async ()=>{
    const s = clampInterval(Number(el.intervalSec.value));
    await saveSetting("intervalSec", s);
    await saveSetting("targetIp", el.targetIp.value.trim());
    if (timerId){ stopPolling(); startPolling(); }
  });

  el.btnStart.addEventListener("click", startPolling);
  el.btnStop.addEventListener("click", stopPolling);
  el.btnGet.addEventListener("click", sampleOnce);
  el.btnClear.addEventListener("click", async ()=>{
    await clearMeasurements();
    await refreshView();
  });

  await refreshView();
})();
