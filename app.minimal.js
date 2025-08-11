import { getPublicIPviaWebRTC } from './webrtc_ip.js';
import { openDB, addMeasurement, getAllMeasurements, clearMeasurements, saveSetting, loadSetting } from './db.js';

// HTTP API
async function getPublicIPviaHTTP(signal) {
  try {
    const res = await fetch('https://api.ipify.org?format=json', { signal, cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    return normalizeIP(data.ip);
  } catch { return null; }
}

function normalizeIP(ip){ return ip && ip.includes(':') ? ip.toLowerCase() : ip; }

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
function computeChangeIntervalsMs(measurements){
  const intervals=[]; let prev=null;
  for (const cur of measurements) {
    if (!prev){ prev=cur; continue; }
    if (cur.ip!=null && prev.ip!=null && cur.ip!==prev.ip) intervals.push(cur.ts - prev.ts);
    prev=cur;
  }
  return intervals;
}
function averageMs(arr){ if(!arr.length) return null; return arr.reduce((a,b)=>a+b,0)/arr.length; }

const el = {
  sourcePref: document.getElementById("sourcePref"),
  intervalSlider: document.getElementById("intervalSlider"),
  intervalSec: document.getElementById("intervalSec"),
  intervalLabel: document.getElementById("intervalLabel"),
  apply: document.getElementById("apply"),

  statusDot: document.getElementById("status"),
  currentIP: document.getElementById("currentIP"),
  mismatchNotice: document.getElementById("mismatchNotice"),

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
  // state: ok|warn|err|idle
  el.statusDot.classList.remove("status-ok","status-warn","status-err");
  if (state==="ok") el.statusDot.classList.add("status-ok");
  else if (state==="warn") el.statusDot.classList.add("status-warn");
  else if (state==="err") el.statusDot.classList.add("status-err");
}

async function refreshView(){
  const list = await getAllMeasurements();
  list.sort((a,b)=>a.ts-b.ts);

  const last = list.at(-1);
  el.currentIP.textContent = last && last.ip!=null ? last.ip : "-";

  // mismatch notice
  if (last && last.webrtcIP && last.httpIP && last.webrtcIP !== last.httpIP) {
    el.mismatchNotice.textContent = `注意: WebRTC(${last.webrtcIP}) と HTTP(${last.httpIP}) の結果が不一致です。`;
  } else {
    el.mismatchNotice.textContent = "";
  }

  // stats
  const intervals = computeChangeIntervalsMs(list);
  el.changeCount.textContent = String(intervals.length);
  const avg = averageMs(intervals);
  el.avgInterval.textContent = avg ? (avg>=3600000 ? (avg/3600000).toFixed(1)+"h" : (avg/60000).toFixed(1)+"m") : "-";

  // table (3 columns)
  el.historyBody.innerHTML = "";
  for (let i=0;i<list.length;i++){
    const cur = list[i];
    const prev = i? list[i-1] : null;
    const changed = !!(prev && prev.ip!=null && cur.ip!=null && prev.ip!==cur.ip);
    const mismatch = !!cur.mismatch;

    const icon = changed ? "↻" : (mismatch ? "≠" : "=");
    const iconClass = changed ? "icon-changed" : (mismatch ? "icon-mismatch" : "icon-same");

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="icon-cell ${iconClass}">${icon}</td>
      <td>
        <span class="time-top">${fmtShortTime(cur.ts)}</span>
        <span class="time-sub">${prev ? fmtDelta(cur.ts - prev.ts) : ""}</span>
      </td>
      <td>${cur.ip ?? "-"}</td>
    `;
    el.historyBody.appendChild(tr);
  }
}

async function sampleOnce(){
  setStatus("warn");
  const ts = Date.now();
  const pref = el.sourcePref.value;

  let webrtcRes = null, httpIP = null;

  try {
    if (pref === "webrtc") {
      webrtcRes = await getPublicIPviaWebRTC();
    } else if (pref === "http") {
      httpIP = await getPublicIPviaHTTP();
    } else {
      const [wr, hi] = await Promise.allSettled([ getPublicIPviaWebRTC(), getPublicIPviaHTTP() ]);
      webrtcRes = wr.status==="fulfilled" ? wr.value : null;
      httpIP = hi.status==="fulfilled" ? hi.value : null;
    }
    const webrtcIP = webrtcRes && webrtcRes.ip ? webrtcRes.ip : null;
    const mismatch = !!(webrtcIP && httpIP && webrtcIP !== httpIP);

    // choose
    let chosen = { ip:null, source:"none" };
    if (pref==="webrtc") {
      if (webrtcIP) chosen={ip:webrtcIP, source:"webrtc"};
    } else if (pref==="http") {
      if (httpIP) chosen={ip:httpIP, source:"http"};
    } else {
      if (webrtcIP && httpIP && webrtcIP===httpIP) chosen={ip:webrtcIP, source:"both"};
      else if (httpIP) chosen={ip:httpIP, source:"http"};
      else if (webrtcIP) chosen={ip:webrtcIP, source:"webrtc"};
    }

    await addMeasurement({
      ts,
      ip: chosen.ip,
      source: chosen.source,
      webrtcIP: webrtcIP ?? undefined,
      httpIP: httpIP ?? undefined,
      mismatch
    });

    setStatus(chosen.ip ? (mismatch ? "warn" : "ok") : "err");
  } catch {
    setStatus("err");
    await addMeasurement({ ts, ip:null, source:"error" });
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

  // load settings
  const savedPref = await loadSetting("sourcePref", "auto");
  el.sourcePref.value = savedPref;
  const savedSec = await loadSetting("intervalSec", 60);
  const sec = clampInterval(savedSec);
  el.intervalSec.value = String(sec);
  el.intervalSlider.value = String(sec);
  el.intervalLabel.textContent = `${sec}s`;

  // sync slider <-> number
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

  // apply/save
  el.apply.addEventListener("click", async ()=>{
    await saveSetting("sourcePref", el.sourcePref.value);
    const s = clampInterval(Number(el.intervalSec.value));
    await saveSetting("intervalSec", s);
    if (timerId){ stopPolling(); startPolling(); }
  });

  // bottom controls
  el.btnStart.addEventListener("click", startPolling);
  el.btnStop.addEventListener("click", stopPolling);
  el.btnGet.addEventListener("click", sampleOnce);
  el.btnClear.addEventListener("click", async ()=>{
    await clearMeasurements();
    await refreshView();
  });

  await refreshView();
})();
