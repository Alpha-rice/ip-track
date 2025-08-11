const DB_NAME = "ip-monitor-db";
const DB_VERSION = 2;

let dbPromise;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("measurements")) {
        const os = db.createObjectStore("measurements", { keyPath: "id", autoIncrement: true });
        os.createIndex("by_ts", "ts", { unique: false });
      } else {
        const store = req.transaction.objectStore("measurements");
        if (!store.indexNames.contains("by_ts")) {
          store.createIndex("by_ts", "ts", { unique: false });
        }
      }
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }
    };

    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        try { db.close(); } catch {}
        alert("データベースが更新されました。ページを再読み込みしてください。");
      };
      resolve(db);
    };

    req.onblocked = () => {
      alert("データベースを更新できません。別タブを閉じてから再読み込みしてください。");
    };

    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function addMeasurement(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("measurements", "readwrite");
    tx.objectStore("measurements").add(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllMeasurements() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("measurements", "readonly");
    const idx = tx.objectStore("measurements").index("by_ts");
    const req = idx.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function clearMeasurements() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("measurements", "readwrite");
    tx.objectStore("measurements").clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveSetting(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("settings", "readwrite");
    tx.objectStore("settings").put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadSetting(key, defVal) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("settings", "readonly");
    const req = tx.objectStore("settings").get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : defVal);
    req.onerror = () => reject(req.error);
  });
}
