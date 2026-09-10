import { useRef, useSyncExternalStore } from "react";

export type Updater<T> = Partial<T> | ((s: T) => T);

export interface BoundStore<T> {
  get: () => T;
  set: (u: Updater<T>) => void;
  subscribe: (cb: () => void) => () => void;
  reset: () => void;
  init: T;
}

export function createStore<T>(init: T): BoundStore<T> {
  let state: T = init;
  const subs = new Set<() => void>();
  const emit = () => {
    for (const cb of Array.from(subs)) cb();
  };
  return {
    init,
    get: () => state,
    set: (u) => {
      state =
        typeof u === "function"
          ? (u as (s: T) => T)(state)
          : Array.isArray(state) || !isPlainObject(state)
            ? (u as T)
            : { ...state, ...u };
      emit();
    },
    subscribe: (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    reset: () => {
      state = init;
      emit();
    },
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function useStoreState<T>(store: BoundStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, () => store.init);
}

// Selector hook: keeps the subscription live but only re-renders when the
// selected slice changes by reference (slices are replaced by reference on set).
// The snapshot is cached per store-state reference so inline selectors that
// allocate fresh objects (e.g. ({ a, b }) => …) don't feed useSyncExternalStore
// an ever-changing snapshot (which would loop forever).
export function useStoreSlice<T, S>(store: BoundStore<T>, select: (s: T) => S): S {
  const cache = useRef<{ state: T; value: S } | null>(null);
  const getSnapshot = (): S => {
    const state = store.get();
    if (cache.current && cache.current.state === state) return cache.current.value;
    const value = select(state);
    cache.current = { state, value };
    return value;
  };
  return useSyncExternalStore(store.subscribe, getSnapshot, () => select(store.init));
}