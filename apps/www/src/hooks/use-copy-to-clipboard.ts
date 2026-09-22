import { useEffect, useRef, useState } from "react";

const COPIED_RESET_MS = 1500;

/**
 * Copy text and remember what was copied for a moment, so the caller can
 * show a confirmation. The reset timer is replaced on every copy and cleared
 * on unmount. `copiedKey` identifies which of several copy targets fired.
 */
function useCopyToClipboard<Key extends string = string>(resetMs = COPIED_RESET_MS) {
  const [copiedKey, setCopiedKey] = useState<Key | null>(null);
  const timeout = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timeout.current), []);

  const copy = async (text: string, key: Key): Promise<boolean> => {
    if (navigator.clipboard === undefined) {
      return false;
    }

    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return false;
    }

    window.clearTimeout(timeout.current);
    setCopiedKey(key);
    timeout.current = window.setTimeout(() => setCopiedKey(null), resetMs);
    return true;
  };

  return { copiedKey, copy };
}

export { useCopyToClipboard };
