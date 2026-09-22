import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * `false` during SSR and the hydration render, `true` afterwards (and on
 * client-only renders). Gate browser-dependent output — local time zones,
 * locales — on it so hydration always matches the server HTML.
 */
function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}

export { useHydrated };
