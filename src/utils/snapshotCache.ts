const DB_NAME = 'domru_lab_snapshots_v1';
const STORE_NAME = 'snapshots';

const memoryUrlMap = new Map<string, string>();
const memoryFetchedAtMap = new Map<string, number>();
const memoryTickMap = new Map<string, number>();
const inFlightMap = new Map<string, Promise<string | null>>();
const listenersMap = new Map<string, Set<(url: string) => void>>();

// Limit concurrent snapshot HTTP requests to 3 so 20+ cameras never saturate browser/proxy connections
const MAX_CONCURRENT_SNAPSHOTS = 3;
let activeSnapshotFetches = 0;
const snapshotQueue: Array<() => void> = [];

function pumpSnapshotQueue(): void {
  while (snapshotQueue.length > 0 && activeSnapshotFetches < MAX_CONCURRENT_SNAPSHOTS) {
    const next = snapshotQueue.shift();
    if (next) next();
  }
}

function acquireSnapshotSlot(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new Error('Aborted'));
  }
  if (activeSnapshotFetches < MAX_CONCURRENT_SNAPSHOTS) {
    activeSnapshotFetches++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const task = () => {
      if (signal?.aborted) {
        reject(new Error('Aborted'));
        pumpSnapshotQueue();
        return;
      }
      activeSnapshotFetches++;
      resolve();
    };
    snapshotQueue.push(task);
  });
}

function releaseSnapshotSlot(): void {
  activeSnapshotFetches = Math.max(0, activeSnapshotFetches - 1);
  pumpSnapshotQueue();
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openSnapshotDb(): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined' || !('indexedDB' in window)) {
    return Promise.resolve(null);
  }
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = window.indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

export function getMemoryCachedSnapshotUrl(cameraId: string): string | null {
  return memoryUrlMap.get(cameraId) || null;
}

export function isSnapshotFreshForTick(
  cameraId: string,
  refreshTick: number,
  maxAgeMs: number = 30000
): boolean {
  const url = memoryUrlMap.get(cameraId);
  if (!url) return false;
  const lastTick = memoryTickMap.get(cameraId);
  const fetchedAt = memoryFetchedAtMap.get(cameraId) || 0;
  return lastTick === refreshTick && Date.now() - fetchedAt < maxAgeMs;
}

export function subscribeSnapshotCache(
  cameraId: string,
  cb: (url: string) => void
): () => void {
  let set = listenersMap.get(cameraId);
  if (!set) {
    set = new Set();
    listenersMap.set(cameraId, set);
  }
  set.add(cb);
  return () => {
    set?.delete(cb);
  };
}

function notifySnapshotListeners(cameraId: string, url: string) {
  const set = listenersMap.get(cameraId);
  if (!set) return;
  for (const cb of set) {
    try {
      cb(url);
    } catch {
      // ignore
    }
  }
}

export async function loadCachedSnapshotUrl(cameraId: string): Promise<string | null> {
  const inMem = memoryUrlMap.get(cameraId);
  if (inMem) return inMem;

  const db = await openSnapshotDb();
  if (!db) return null;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(cameraId);
      req.onsuccess = () => {
        const blob = req.result as Blob | undefined;
        if (blob instanceof Blob && blob.size > 100) {
          const existing = memoryUrlMap.get(cameraId);
          if (existing) {
            resolve(existing);
            return;
          }
          const url = URL.createObjectURL(blob);
          memoryUrlMap.set(cameraId, url);
          resolve(url);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function saveSnapshotBlobToDb(cameraId: string, blob: Blob): Promise<void> {
  const db = await openSnapshotDb();
  if (!db) return;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(blob, cameraId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function fetchAndCacheSnapshot(
  cameraId: string,
  snapshotUrl: string,
  signal?: AbortSignal,
  refreshTick?: number,
  force: boolean = false
): Promise<string | null> {
  if (!force) {
    const existingInFlight = inFlightMap.get(cameraId);
    if (existingInFlight) {
      return existingInFlight;
    }
  }

  let job: Promise<string | null> | null = null;
  job = (async () => {
    let acquired = false;
    try {
      await acquireSnapshotSlot(force ? undefined : signal);
      acquired = true;

      const fetchTimeoutController = new AbortController();
      const timeoutTimer = setTimeout(() => fetchTimeoutController.abort(), 20000);
      let res: globalThis.Response;
      try {
        res = await fetch(snapshotUrl, {
          method: 'GET',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          signal: fetchTimeoutController.signal,
        });
      } finally {
        clearTimeout(timeoutTimer);
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const blob = await res.blob();
      if (!blob || blob.size < 200) {
        throw new Error('Пустой ответ сервера');
      }

      await saveSnapshotBlobToDb(cameraId, blob);

      const prevUrl = memoryUrlMap.get(cameraId);
      const nextUrl = URL.createObjectURL(blob);
      memoryUrlMap.set(cameraId, nextUrl);
      memoryFetchedAtMap.set(cameraId, Date.now());
      if (refreshTick !== undefined) {
        memoryTickMap.set(cameraId, refreshTick);
      }
      notifySnapshotListeners(cameraId, nextUrl);

      if (prevUrl && prevUrl !== nextUrl) {
        setTimeout(() => {
          try {
            URL.revokeObjectURL(prevUrl);
          } catch {
            // ignore
          }
        }, 4000);
      }

      return nextUrl;
    } finally {
      if (acquired) {
        releaseSnapshotSlot();
      }
      if (job && inFlightMap.get(cameraId) === job) {
        inFlightMap.delete(cameraId);
      }
    }
  })();

  inFlightMap.set(cameraId, job);
  return job;
}
