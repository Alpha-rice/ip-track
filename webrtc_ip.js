// WebRTCのICE候補から typ srflx のIPを抽出するユーティリティ。
// タイムアウトと複数STUNに対応し、最初に得られたsrflxを返す。
// 参考: ブラウザやVPNでの差異、srflxが得られない/遅延する事象[8][3]。
export async function getPublicIPviaWebRTC(options = {}) {
  const {
    stunServers = [
      "stun:stun.l.google.com:19302",
      "stun:global.stun.twilio.com:3478",
      "stun:stun1.l.google.com:19302"
    ],
    hardTimeoutMs = 8000
  } = options;

  let resolved = false;
  let timer = null;
  const pcs = [];

  const cleanupAll = () => {
    pcs.forEach(pc => { try { pc.close(); } catch {} });
    if (timer) clearTimeout(timer);
  };

  const promise = new Promise(async (resolve) => {
    timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanupAll();
        resolve({ ip: null, error: "timeout" });
      }
    }, hardTimeoutMs);

    for (const url of stunServers) {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: [url] }] });
      pcs.push(pc);
      pc.createDataChannel("d");

      const candidates = new Set();

      const finishTry = (out) => {
        if (!resolved) {
          resolved = true;
          cleanupAll();
          resolve(out);
        }
      };

      pc.onicecandidate = (e) => {
        if (!e.candidate) {
          const ip = pickSrflx(candidates);
          if (ip) finishTry({ ip, stun: url });
          return;
        }
        candidates.add(e.candidate.candidate);
        const quick = extractSrflxIP(e.candidate.candidate);
        if (quick) finishTry({ ip: quick, stun: url });
      };

      pc.onicecandidateerror = (e) => {
        // 続行（他STUNで成功する可能性）[8]
      };

      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === "complete") {
          const ip = pickSrflx(candidates);
          if (ip) finishTry({ ip, stun: url });
        }
      };

      try {
        await pc.setLocalDescription(await pc.createOffer({ iceRestart: true }));
      } catch {
        // 次のSTUNへ
      }
    }
  });

  const res = await promise;
  return res;

  function pickSrflx(set) {
    for (const c of set) {
      const ip = extractSrflxIP(c);
      if (ip) return ip;
    }
    return null;
  }

  function extractSrflxIP(candStr) {
    const parts = candStr.trim().split(/\s+/);
    const ip = parts[4];
    const typIndex = parts.indexOf("typ");
    const typ = typIndex > -1 ? parts[typIndex + 1] : "";
    if (typ === "srflx" && isIPAddress(ip)) return normalizeIP(ip);
    return null;
  }

  function isIPAddress(str) {
    return /^(\d{1,3}\.){3}\d{1,3}$/.test(str) || /^[0-9a-f:]+$/i.test(str);
  }

  function normalizeIP(ip) {
    // IPv6は小文字化。IPv4はそのまま。
    return ip.includes(":") ? ip.toLowerCase() : ip;
  }
}
