import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/** `false` during SSR and the hydration render, `true` afterwards. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}

export { useHydrated };
