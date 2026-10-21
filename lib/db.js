const DB_NAME = 'tabvault';
const DB_VERSION = 1;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('snapshots')) {
        const s = db.createObjectStore('snapshots', { keyPath: 'id' });
        s.createIndex('ts', 'ts');
      }
      if (!db.objectStoreNames.contains('index')) {
        const s = db.createObjectStore('index', { keyPath: 'id' });
        s.createIndex('ts', 'ts');
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run(storeNames, mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeNames, mode);
        let out;
        try {
          out = fn(tx);
        } catch (e) {
          reject(e);
          return;
        }
        tx.oncomplete = () => resolve(out);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

function reqValue(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function indexEntryOf(snap) {
  return {
    id: snap.id,
    ts: snap.ts,
    reason: snap.reason,
    closedEvent: !!snap.closedEvent,
    tabCount: snap.tabCount,
    windowCount: snap.windowCount,
    domains: snap.domains || [],
  };
}

export async function putSnapshot(snap) {
  const entry = indexEntryOf(snap);
  await run(['snapshots', 'index'], 'readwrite', (tx) => {
    tx.objectStore('snapshots').put(snap);
    tx.objectStore('index').put(entry);
  });
  return entry;
}

export async function putSnapshots(snaps) {
  await run(['snapshots', 'index'], 'readwrite', (tx) => {
    const a = tx.objectStore('snapshots');
    const b = tx.objectStore('index');
    for (const s of snaps) {
      a.put(s);
      b.put(indexEntryOf(s));
    }
  });
}

export async function listIndex() {
  const db = await openDB();
  const tx = db.transaction('index', 'readonly');
  const all = await reqValue(tx.objectStore('index').getAll());
  return all.sort((a, b) => b.ts - a.ts);
}

export async function getIndexEntry(id) {
  const db = await openDB();
  const tx = db.transaction('index', 'readonly');
  return (await reqValue(tx.objectStore('index').get(id))) || null;
}

export async function getSnapshot(id) {
  const db = await openDB();
  const tx = db.transaction('snapshots', 'readonly');
  return (await reqValue(tx.objectStore('snapshots').get(id))) || null;
}

export async function getAllSnapshots() {
  const db = await openDB();
  const tx = db.transaction('snapshots', 'readonly');
  const all = await reqValue(tx.objectStore('snapshots').getAll());
  return all.sort((a, b) => b.ts - a.ts);
}

export async function deleteSnapshot(id) {
  await run(['snapshots', 'index'], 'readwrite', (tx) => {
    tx.objectStore('snapshots').delete(id);
    tx.objectStore('index').delete(id);
  });
}

export async function deleteSnapshots(ids) {
  if (!ids.length) return;
  await run(['snapshots', 'index'], 'readwrite', (tx) => {
    const a = tx.objectStore('snapshots');
    const b = tx.objectStore('index');
    for (const id of ids) {
      a.delete(id);
      b.delete(id);
    }
  });
}

export async function clearAllSnapshots() {
  await run(['snapshots', 'index'], 'readwrite', (tx) => {
    tx.objectStore('snapshots').clear();
    tx.objectStore('index').clear();
  });
}

export async function countSnapshots() {
  const idx = await listIndex();
  return idx.length;
}

export async function getMeta(key) {
  const db = await openDB();
  const tx = db.transaction('meta', 'readonly');
  return (await reqValue(tx.objectStore('meta').get(key))) || null;
}

export async function setMeta(key, value) {
  await run('meta', 'readwrite', (tx) => {
    tx.objectStore('meta').put({ key, value });
  });
}

export async function estimateSize() {
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const { usage } = await navigator.storage.estimate();
      return usage || 0;
    } catch (e) {
      return 0;
    }
  }
  return 0;
}

/**
 * 分级保留：新记录全留，旧的按小时/按天抽稀，超期删除。
 */
export async function pruneSnapshots({ max = 300, days = 90 } = {}) {
  const idx = await listIndex();
  if (!idx.length) return { removed: 0, kept: 0 };

  const now = Date.now();
  const DAY = 86400000;
  const HOUR = 3600000;
  const keep = new Set();
  const seen = new Set();

  for (let i = 0; i < idx.length; i++) {
    const e = idx[i];
    const age = now - e.ts;

    if (i < 40) {
      keep.add(e.id);
      continue;
    }
    if (age > days * DAY) continue;

    if (age <= DAY) {
      if (i < max) keep.add(e.id);
      continue;
    }
    if (age <= 7 * DAY) {
      const bucket = 'h' + Math.floor(e.ts / HOUR);
      if (!seen.has(bucket)) {
        seen.add(bucket);
        keep.add(e.id);
      }
      continue;
    }
    const bucket = 'd' + Math.floor(e.ts / DAY);
    if (!seen.has(bucket)) {
      seen.add(bucket);
      keep.add(e.id);
    }
  }

  const drop = idx.filter((e) => !keep.has(e.id)).map((e) => e.id);
  if (drop.length) await deleteSnapshots(drop);
  return { removed: drop.length, kept: keep.size };
}
