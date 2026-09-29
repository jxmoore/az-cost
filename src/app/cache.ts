// The last run, kept in this browser (IndexedDB) so reopening it is instant.
// It holds subscription ids and costs, only in this user's browser profile, and "Forget" clears it.
import type { CostData } from "../core/types";

const DB = "azcost", STORE = "runs", KEY = "last";

export interface SavedRun { data: CostData; who: string | null; saved: string }

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T | null> {
  try {
    const db = await open();
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    }).finally(() => db.close());
  } catch {
    return null; // private windows and locked-down browsers: no cache, the app still works
  }
}

export const loadRun = () => tx<SavedRun>("readonly", s => s.get(KEY));
export const saveRun = (run: SavedRun) => tx("readwrite", s => s.put(run, KEY));
export const forgetRun = () => tx("readwrite", s => s.delete(KEY));
