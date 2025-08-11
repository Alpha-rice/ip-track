import { getPublicIPviaWebRTC } from './webrtc_ip.js';
import { openDB, addMeasurement, getAllMeasurements, clearMeasurements, saveSetting, loadSetting } from './db.js';

async function getPublicIPviaHTTP(signal) {
  try {
    const res = await fetch('https://api.ipify.org?format=json', { signal, cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    return normalizeIP(data.ip);
  } catch {
    return null;
  }
}

function normalizeIP(ip) {
  if (!ip) return ip;
  return ip.includes(':') ? ip.toLowerCase() : ip;
}

function computeChangeIntervalsMs(measurements) {
  const intervals = [];
  let prev = null;
  for (let i = 0; i < measurements.length; i++) {
    const cur = measurements[i];
    if (!prev) { prev = cur; continue; }
    if (cur.ip != null && prev.ip != null && cur.ip !== prev.ip) {
      intervals.push(cur.ts - prev.ts);
    }
    prev = cur;
  }
  return intervals;
}

function averageMs(arr) {
  if (!arr.length) return null;
  return arr.reduce((a,b)=>a+b,0) / arr.length;
}

function fmtDuration(ms) {
  if (ms == null) return "-";
  const sec = ms / 1000;
  if (sec < 90) return `${sec.toFixed(1)}秒`;
  const min = sec / 60;
  if (min < 90) return `${min.toFixed(1)}分`;
  const hr = min / 60;
  if (hr < 48) return `${hr.toFixed(1)}時間`;
  const d = hr / 24;
  return `${d.toFixed(1)}日`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  const z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
}

const el = {
  intervalSec: document.getElementById("intervalSec"),
  sourcePref: document.getElementById("sourcePref"),
  apply: document.getElementById("apply"),
  start: document.getElementById("start"),
  stop: document.getElementById("stop"),
  status: document.getElementById("status"),
  currentIP: document.getElementById("currentIP"),
  mismatchNotice: document.getElementById("mismatchNotice"),
  avgInterval: document.getElementById("avgInterval"),
  changeCount: document.getElementById("changeCount"),
  historyBody: document.getElementById("historyBody"),
  clear: document.getElementById("clear"),
};

let timerId = null;

async function refreshView() {
  const list = await getAllMeasurements();
  list.sort((a,b)=>a.ts - b.ts);

  const last = list.length ? list[list.length - 1] : null;
  el.currentIP.textContent = last && last.ip != null ? last.ip : "-";

  if (last && last.webrtcIP && last.httpIP && last.webrtcIP !== last.httpIP) {
    el.mismatchNotice.innerHTML = `注意: WebRTC(${last.webrtcIP}) と HTTP API(${last.httpIP}) の結果が不一致です。VPN/ブラウザ設定の影響の可能性があります。`;
  } else {
    el.mismatchNotice.textContent = "";
  }

  el.historyBody.innerHTML = "";
  for (let i = 0; i < list.length; i++) {
    const prev = i ? list[i - 1] : null;
    const deltaMin = prev ? ((list[i].ts - prev.ts) / 60000).toFixed(1) : "-";
    const changed = prev && prev.ip != null && list[i].ip != null && list[i].ip !== prev.ip;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${fmtTime(list[i].ts)}</td>
      <td>${list[i].ip ?? "-"}</td>
      <td>${list[i].source ?? "-"}</td>
      <td>${deltaMin}</td>
      <td>${changed ? '<span class="badge badge-ok">変更</span>' : ''}</td>
      <td>${list[i].mismatch ? '<span class="badge badge-warn">不一致</span>' : ''}</td>
    `;
    el.historyBody.appendChild(tr);
  }

  const intervals = computeChangeIntervalsMs(list);
  el.changeCount.textContent = intervals.length;
  el.avgInterval.textContent = intervals.length ? fmtDuration(averageMs(intervals)) : "-";
}

async function sampleOnce() {
  el.status.textContent = "取得中...";
  const ts = Date.now();
  const sourcePref = el.sourcePref.value;

  let webrtcRes = null;
  let httpIP = null;

  try {
    if (sourcePref === "webrtc") {
      webrtcRes = await getPublicIPviaWebRTC();
    } else if (sourcePref === "http") {
      httpIP = await getPublicIPviaHTTP();
    } else {
      const [wr, hi] = await Promise.allSettled([
        getPublicIPviaWebRTC(),
        getPublicIPviaHTTP()
      ]);
      webrtcRes = wr.status === "fulfilled" ? wr.value : null;
      httpIP = hi.status === "fulfilled" ? hi.value : null;
    }

    const webrtcIP = webrtcRes && webrtcRes.ip ? webrtcRes.ip : null;
    const mismatch = !!(webrtcIP && httpIP && webrtcIP !== httpIP);

    let chosen = { ip: null, source: "none" };
    if (sourcePref === "webrtc") {
      if (webrtcIP) chosen = { ip: webrtcIP, source: "webrtc" };
    } else if (sourcePref === "http") {
      if (httpIP) chosen = { ip: httpIP, source: "http" };
    } else {
      if (webrtcIP && httpIP && webrtcIP === httpIP) chosen = { ip: webrtcIP, source: "both" };
      else if (httpIP) chosen = { ip: httpIP, source: "http" };
      else if (webrtcIP) chosen = { ip: webrtcIP, source: "webrtc" };
    }

    await addMeasurement({
      ts,
      ip: chosen.ip,
      source: chosen.source,
      webrtcIP: webrtcIP ?? undefined,
      httpIP: httpIP ?? undefined,
      mismatch
    });

    if (chosen.ip) {
      el.status.textContent = `OK (${chosen.source})`;
    } else {
      const parts = [];
      if (!webrtcIP) parts.push("WebRTC失敗");
      if (!httpIP) parts.push("HTTP失敗");
      el.status.textContent = parts.length ? parts.join(" / ") : "取得失敗";
    }
  } catch (e) {
    el.status.textContent = "取得処理で例外";
    await addMeasurement({ ts, ip: null, source: "error" });
  } finally {
    await refreshView();
  }
}

function startPolling() {
  if (timerId) return;
  const sec = Math.max(5, Number(el.intervalSec.value) || 60);
  el.intervalSec.value = sec;
  timerId = setInterval(sampleOnce, sec * 1000);
  el.start.disabled = true;
  el.stop.disabled = false;
  el.status.textContent = `監視中（${sec}秒間隔）`;
  sampleOnce();
}

function stopPolling() {
  if (!timerId) return;
  clearInterval(timerId);
  timerId = null;
  el.start.disabled = false;
  el.stop.disabled = true;
  el.status.textContent = "停止中";
}

(async function init() {
  await openDB();
  const savedInterval = await loadSetting("intervalSec", 60);
  el.intervalSec.value = savedInterval;
  const savedPref = await loadSetting("sourcePref", "auto");
  el.sourcePref.value = savedPref;

  el.apply.addEventListener("click", async () => {
    const sec = Math.max(5, Number(el.intervalSec.value) || 60);
    el.intervalSec.value = sec;
    await saveSetting("intervalSec", sec);
    await saveSetting("sourcePref", el.sourcePref.value);
    if (timerId) {
      stopPolling();
      startPolling();
    }
  });

  el.start.addEventListener("click", startPolling);
  el.stop.addEventListener("click", stopPolling);
  el.clear.addEventListener("click", async () => {
    await clearMeasurements();
    await refreshView();
  });
  
  await refreshView();
})();
