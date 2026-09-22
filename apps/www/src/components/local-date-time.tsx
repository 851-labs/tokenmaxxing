import { useHydrated } from "../hooks/use-hydrated";
import { formatDateTimeUtc } from "../lib/format";

/**
 * A timestamp in the viewer's locale and time zone. The server (and the
 * hydration render) print a deterministic UTC string instead, so the markup
 * never mismatches; the local rendering swaps in right after hydration.
 */
function LocalDateTime({ iso }: { iso: string }) {
  const hydrated = useHydrated();

  return (
    <time dateTime={iso}>{hydrated ? new Date(iso).toLocaleString() : formatDateTimeUtc(iso)}</time>
  );
}

export { LocalDateTime };
