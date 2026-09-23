import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import { cn } from "../../lib/cn";

interface SegmentedOption<Value extends string> {
  label: string;
  value: Value;
}

interface SegmentedControlProps<Value extends string> {
  /** Accessible name for the group, e.g. "Time window". */
  label: string;
  onChange: (value: Value) => void;
  options: readonly SegmentedOption<Value>[];
  value: Value;
}

interface IndicatorBox {
  height: number;
  left: number;
  top: number;
  width: number;
}

/** Arrow keys step through options (wrapping); Home/End jump to the ends. */
const KEY_STEPS: Partial<Record<string, "first" | "last" | 1 | -1>> = {
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -1,
  End: "last",
  Home: "first",
};

/** The option index a key moves selection to, or null for keys it ignores. */
function nextSegmentIndex(current: number, count: number, key: string): number | null {
  const step = KEY_STEPS[key];
  if (step === undefined || count === 0) {
    return null;
  }
  if (step === "first") {
    return 0;
  }
  if (step === "last") {
    return count - 1;
  }

  return (current + step + count) % count;
}

/**
 * A segmented control: pick exactly one option from a small inline set. It is
 * a WAI-ARIA radio group — one tab stop on the selected option, and arrow
 * keys move selection with focus (not tabs: nothing here owns a panel). The
 * active pill slides between options once measured; until then (SSR,
 * hydration) the checked option paints it itself.
 */
function SegmentedControl<Value extends string>({
  label,
  onChange,
  options,
  value,
}: SegmentedControlProps<Value>) {
  const groupRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<IndicatorBox | null>(null);
  const selectedIndex = options.findIndex((option) => option.value === value);

  useLayoutEffect(() => {
    const group = groupRef.current;
    if (group === null) {
      return;
    }

    const measure = () => {
      const checked = group.querySelector<HTMLElement>('[aria-checked="true"]');
      setIndicator(
        checked === null
          ? null
          : {
              height: checked.offsetHeight,
              left: checked.offsetLeft,
              top: checked.offsetTop,
              width: checked.offsetWidth,
            },
      );
    };
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(group);
    return () => observer.disconnect();
  }, [value]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = nextSegmentIndex(Math.max(selectedIndex, 0), options.length, event.key);
    const option = next === null ? undefined : options[next];
    if (next === null || option === undefined) {
      return;
    }

    event.preventDefault();
    groupRef.current?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
    if (option.value !== value) {
      onChange(option.value);
    }
  };

  return (
    <div
      aria-label={label}
      className="relative inline-flex shrink-0 border border-border p-0.5"
      onKeyDown={onKeyDown}
      ref={groupRef}
      role="radiogroup"
    >
      {indicator === null ? null : (
        <span
          aria-hidden="true"
          className="absolute z-0 bg-foreground transition-all duration-200 ease-out"
          style={indicator}
        />
      )}
      {options.map((option, index) => {
        const checked = option.value === value;
        // Roving tabindex: the selected option is the group's one tab stop
        // (the first, if the value matches none).
        const tabbable = selectedIndex === -1 ? index === 0 : checked;
        return (
          <button
            aria-checked={checked}
            className={cn(
              "relative z-10 whitespace-nowrap px-2.5 py-1 text-xs font-medium outline-none transition-colors",
              "text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent",
              "aria-checked:text-background aria-checked:hover:text-background",
              indicator === null && "aria-checked:bg-foreground",
            )}
            key={option.value}
            onClick={() => {
              if (!checked) {
                onChange(option.value);
              }
            }}
            role="radio"
            tabIndex={tabbable ? 0 : -1}
            type="button"
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export { nextSegmentIndex, SegmentedControl };

export type { SegmentedOption };
