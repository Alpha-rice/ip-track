import { openDB, addMeasurement, getAllMeasurements, clearMeasurements, saveSetting, loadSetting } from './db.js';
import { getPublicIPviaWebRTC } from './webrtc_ip.js';   // 追加

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
  list.sort((a,b)=>b.ts - a.ts);           // 新しい順

  /* --- 最新行のメタ表示は省略 --- */

  /* --- 変更間隔計算用に昇順コピー --- */
  const asc = [...list].reverse();
  /* …Avg/Chg 計算・表示は従来通り… */

  /* --- テーブル描画 --- */
  el.historyBody.innerHTML = "";
  for (let i=0;i<list.length;i++){
    const cur  = list[i];
    const prev = i>0 ? list[i-1] : null;   // 降順の直後 = 前回

    const changed  = !!(prev && prev.ip && cur.ip && prev.ip !== cur.ip);
    const mismatch = !!cur.mismatch;

    /* ★ フィルタ条件 ★ */
    if (!changed && !mismatch) continue;   // 表示しない

    const icon      = changed ? "↻" : (mismatch ? "≠" : "=");
    const iconClass = changed ? "icon-changed" :
                      (mismatch ? "icon-mismatch" : "icon-same");

    /* --- 4 列目の簡易 ipinfo --- */
    const m = cur.meta || {};
    const loc = [m.country,m.region,m.city].filter(Boolean).join("/");
    const info = [m.org,m.hostname,loc].filter(Boolean).join(" • ") || "-";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="icon-cell ${iconClass}">${icon}</td>
      <td>
        <span class="time-top">${fmtShortTime(cur.ts)}</span>
        <span class="time-sub">${prev ? fmtDelta(prev.ts - cur.ts) : ""}</span>
      </td>
      <td>${cur.ip ?? "-"}</td>
      <td>${info}</td>              <!-- 4 列目 -->
    `;
    el.historyBody.appendChild(tr);
  }
}

async function sampleOnce(){
  setStatus("warn");
  const ts = Date.now();

  try {
    /* ---------- ① 2 系統取得 ---------- */
    const target = (el.targetIp.value || "").trim() || null;

    // HTTP: ipinfo
    const httpData = await fetchIpinfo(target);      // ipinfo API
    const httpIP   = httpData.ip ?? null;

    // STUN: WebRTC
    const wrRes    = await getPublicIPviaWebRTC();   // srflx
    const stunIP   = wrRes && wrRes.ip ? wrRes.ip : null;

    /* ---------- ② 不一致判定 ---------- */
    const mismatch = !!(httpIP && stunIP && httpIP !== stunIP);

    /* ---------- ③ レコード生成 ---------- */
    const record = {
      ts,
      ip : httpIP ?? stunIP ?? null,      // 表示・比較用
      httpIP,
      stunIP,
      mismatch,
      meta:{
        org      : httpData.org      ?? null,
        hostname : httpData.hostname ?? null,
        country  : httpData.country  ?? null,
        region   : httpData.region   ?? null,
        city     : httpData.city     ?? null,
      }
    };
    await addMeasurement(record);
    setStatus(record.ip ? (mismatch? "warn":"ok") : "err");
  } catch(e){
    setStatus("err");
    await addMeasurement({ts, ip:null, source:"error"});
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
