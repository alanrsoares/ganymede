import { useSyncExternalStore } from "react";
import { getVersion, subscribe } from "~/drydock/store";

/**
 * Subscribe the component to drydock store changes. Returns the store
 * version; components read `view`/`hulls`/`sel` directly after calling it.
 */
export const useDrydock = (): number =>
  useSyncExternalStore(subscribe, getVersion);
