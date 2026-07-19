// Minimal reactive cell replacing van.state during the React migration.
// Semantics MATCH vanjs exactly: setter bails on Object.is (van bails on !==),
// so behavior is provably identical to the working van code — objects that were
// fresh refs per frame (score/counts) still notify; unchanged primitives don't.
import { useSyncExternalStore } from "react";

export interface Signal<T> {
  get val(): T;
  set val(v: T);
  subscribe(cb: () => void): () => void;
}

export const signal = <T>(init: T): Signal<T> => {
  let value = init;
  const subs = new Set<() => void>();
  return {
    get val() {
      return value;
    },
    set val(v: T) {
      if (Object.is(v, value)) return;
      value = v;
      for (const cb of subs) cb();
    },
    subscribe(cb) {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
  };
};

/** Subscribe a React component to a signal at leaf granularity. */
export const useSignal = <T>(s: Signal<T>): T =>
  useSyncExternalStore(
    s.subscribe,
    () => s.val,
    () => s.val,
  );
