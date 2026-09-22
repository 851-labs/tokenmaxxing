import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { useLayoutEffect, useRef, useState } from "react";

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

/**
 * A segmented control: pick exactly one option from a small inline set. It is
 * a labelled group of pressed/unpressed toggle buttons (not tabs — nothing
 * here owns a panel). The active pill slides between options once measured;
 * until then (SSR, hydration) the pressed button paints it itself.
 */
function SegmentedControl<Value extends string>({
  label,
  onChange,
  options,
  value,
}: SegmentedControlProps<Value>) {
  const groupRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<IndicatorBox | null>(null);

  useLayoutEffect(() => {
    const group = groupRef.current;
    if (group === null) {
      return;
    }

    const measure = () => {
      const pressed = group.querySelector<HTMLElement>("[data-pressed]");
      setIndicator(
        pressed === null
          ? null
          : {
              height: pressed.offsetHeight,
              left: pressed.offsetLeft,
              top: pressed.offsetTop,
              width: pressed.offsetWidth,
            },
      );
    };
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(group);
    return () => observer.disconnect();
  }, [value]);

  return (
    <ToggleGroup
      aria-label={label}
      className="relative inline-flex border border-border p-0.5"
      onValueChange={(next) => {
        // Pressing the active option would clear the group; keep one selected.
        const selected = next[0];
        if (selected !== undefined) {
          onChange(selected);
        }
      }}
      ref={groupRef}
      value={[value]}
    >
      {indicator === null ? null : (
        <span
          aria-hidden="true"
          className="absolute z-0 bg-foreground transition-all duration-200 ease-out"
          style={indicator}
        />
      )}
      {options.map((option) => (
        <Toggle
          className={cn(
            "relative z-10 px-2.5 py-1 text-xs font-medium transition-colors",
            "text-muted-foreground hover:text-foreground",
            "data-pressed:text-background data-pressed:hover:text-background",
            indicator === null && "data-pressed:bg-foreground",
          )}
          key={option.value}
          value={option.value}
        >
          {option.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

export { SegmentedControl };

export type { SegmentedOption };
