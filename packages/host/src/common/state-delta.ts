import type { CollabStateView, StateDelta } from "./collab-protocol";

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isRecord(value: unknown): value is Record<string, unknown> & { id: string } {
  return isPlainObject(value) && typeof value.id === "string";
}

function isValidCollection(value: unknown): value is Array<Record<string, unknown> & { id: string }> {
  if (!Array.isArray(value)) {
    return false;
  }
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || seen.has(item.id)) {
      return false;
    }
    seen.add(item.id);
  }
  return true;
}

function isMapObject(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value) || typeof value.id === "string") {
    return false;
  }
  const values = Object.values(value);
  if (values.length > 0 && values.every(isRecord)) {
    return false;
  }
  return true;
}

function setProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    return;
  }
  target[key] = value;
}

/** Deep equality for JSON values, independent of object key order. */
export function stableEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b)) {
    return true;
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }

  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray !== bIsArray) {
    return false;
  }

  if (aIsArray && bIsArray) {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (!stableEqual(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  for (const key of aKeys) {
    if (!hasOwn(bObj, key) || !stableEqual(aObj[key], bObj[key])) {
      return false;
    }
  }
  return true;
}

/** Returns true when `delta` carries no collection, map, replace or remove changes. */
export function isEmptyDelta(delta: StateDelta): boolean {
  const hasCollections =
    delta.collections !== undefined && Object.keys(delta.collections).length > 0;
  const hasMaps = delta.maps !== undefined && Object.keys(delta.maps).length > 0;
  const hasReplace = delta.replace !== undefined && Object.keys(delta.replace).length > 0;
  const hasRemove = delta.remove !== undefined && delta.remove.length > 0;
  return !hasCollections && !hasMaps && !hasReplace && !hasRemove;
}

/**
 * Computes a minimal structural `StateDelta` from `prev` to `next`.
 * Pure and safe for both Node and browser environments.
 */
export function diffProjectedState(prev: CollabStateView, next: CollabStateView): StateDelta {
  const collections: NonNullable<StateDelta["collections"]> = {};
  const maps: NonNullable<StateDelta["maps"]> = {};
  const replace: Record<string, unknown> = {};
  const remove: string[] = [];

  for (const key of Object.keys(prev)) {
    if (!hasOwn(next, key)) {
      remove.push(key);
    }
  }

  for (const key of Object.keys(next)) {
    const nextVal = next[key];
    if (!hasOwn(prev, key)) {
      setProperty(replace, key, nextVal);
      continue;
    }

    const prevVal = prev[key];
    if (isValidCollection(prevVal) && isValidCollection(nextVal)) {
      const prevById = new Map<string, Record<string, unknown> & { id: string }>();
      for (const rec of prevVal) {
        prevById.set(rec.id, rec);
      }

      const ids: string[] = [];
      const upsert: Array<Record<string, unknown> & { id: string }> = [];
      let orderOrLengthChanged = prevVal.length !== nextVal.length;

      for (let i = 0; i < nextVal.length; i++) {
        const rec = nextVal[i]!;
        ids.push(rec.id);
        if (!orderOrLengthChanged && prevVal[i]!.id !== rec.id) {
          orderOrLengthChanged = true;
        }
        const prevRec = prevById.get(rec.id);
        if (prevRec === undefined || !stableEqual(prevRec, rec)) {
          upsert.push(rec);
        }
      }

      if (upsert.length > 0 || orderOrLengthChanged) {
        setProperty(collections as Record<string, unknown>, key, { ids, upsert });
      }
      continue;
    }

    if (isMapObject(prevVal) && isMapObject(nextVal)) {
      const set: Record<string, unknown> = {};
      const mapRemove: string[] = [];

      for (const mapKey of Object.keys(prevVal)) {
        if (!hasOwn(nextVal, mapKey)) {
          mapRemove.push(mapKey);
        }
      }
      for (const mapKey of Object.keys(nextVal)) {
        if (!hasOwn(prevVal, mapKey) || !stableEqual(prevVal[mapKey], nextVal[mapKey])) {
          setProperty(set, mapKey, nextVal[mapKey]);
        }
      }

      if (Object.keys(set).length > 0 || mapRemove.length > 0) {
        setProperty(maps as Record<string, unknown>, key, { set, remove: mapRemove });
      }
      continue;
    }

    if (!stableEqual(prevVal, nextVal)) {
      setProperty(replace, key, nextVal);
    }
  }

  const delta: StateDelta = {};
  if (Object.keys(collections).length > 0) {
    delta.collections = collections;
  }
  if (Object.keys(maps).length > 0) {
    delta.maps = maps;
  }
  if (Object.keys(replace).length > 0) {
    delta.replace = replace;
  }
  if (remove.length > 0) {
    delta.remove = remove;
  }
  return delta;
}

/**
 * Applies `delta` onto `prev` returning a new view without mutating `prev` or `delta`.
 * Untouched records and untouched top-level values keep their object references.
 */
export function applyStateDelta<T extends CollabStateView>(prev: T, delta: StateDelta): T {
  const out: Record<string, unknown> = { ...prev };

  if (delta.remove !== undefined) {
    for (const key of delta.remove) {
      delete out[key];
    }
  }

  if (delta.replace !== undefined) {
    for (const [key, value] of Object.entries(delta.replace)) {
      setProperty(out, key, value);
    }
  }

  if (delta.maps !== undefined) {
    for (const [key, entry] of Object.entries(delta.maps)) {
      const existing = prev[key];
      const nextMap: Record<string, unknown> = isPlainObject(existing) ? { ...existing } : {};
      for (const removeKey of entry.remove) {
        delete nextMap[removeKey];
      }
      for (const [setKey, setValue] of Object.entries(entry.set)) {
        setProperty(nextMap, setKey, setValue);
      }
      setProperty(out, key, nextMap);
    }
  }

  if (delta.collections !== undefined) {
    for (const [key, entry] of Object.entries(delta.collections)) {
      const existing = prev[key];
      const prevById = new Map<string, Record<string, unknown> & { id: string }>();
      if (Array.isArray(existing)) {
        for (const item of existing) {
          if (isRecord(item)) {
            prevById.set(item.id, item);
          }
        }
      }

      const upsertById = new Map<string, Record<string, unknown> & { id: string }>();
      for (const item of entry.upsert) {
        upsertById.set(item.id, item);
      }

      const nextList: Array<Record<string, unknown> & { id: string }> = [];
      for (const id of entry.ids) {
        const upserted = upsertById.get(id);
        if (upserted !== undefined) {
          nextList.push(upserted);
          continue;
        }
        const kept = prevById.get(id);
        if (kept !== undefined) {
          nextList.push(kept);
        }
      }
      setProperty(out, key, nextList);
    }
  }

  return out as T;
}
