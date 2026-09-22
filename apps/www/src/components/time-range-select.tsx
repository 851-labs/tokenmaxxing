import { Select } from "@base-ui/react/select";
import { CaretDown, Check } from "@phosphor-icons/react/ssr";

import { TIME_RANGES, type TimeRange } from "../lib/chart-range";

function TimeRangeSelect({
  value,
  onChange,
}: {
  value: TimeRange;
  onChange: (value: TimeRange) => void;
}) {
  return (
    <Select.Root
      items={TIME_RANGES}
      modal={false}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
      value={value}
    >
      <Select.Trigger
        aria-label="Time range"
        className="group inline-flex h-9 min-w-40 items-center justify-between gap-4 rounded-md border border-border bg-background px-3 text-sm font-medium shadow-xs outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-accent"
      >
        <Select.Value />
        <Select.Icon>
          <CaretDown
            aria-hidden
            className="size-3.5 text-muted-foreground transition-transform group-data-popup-open:rotate-180"
          />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner
          align="end"
          alignItemWithTrigger={false}
          className="z-50 outline-none"
          sideOffset={6}
        >
          <Select.Popup className="min-w-44 origin-(--transform-origin) rounded-lg border border-border bg-card p-1 text-sm text-foreground shadow-lg outline-none transition-[opacity,scale] duration-150 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0">
            <Select.List>
              {TIME_RANGES.map((option) => (
                <Select.Item
                  className="relative flex cursor-default select-none items-center rounded-sm py-2 pr-5 pl-8 outline-none data-highlighted:bg-muted"
                  key={option.value}
                  value={option.value}
                >
                  <Select.ItemIndicator className="absolute left-2">
                    <Check aria-hidden className="size-4" />
                  </Select.ItemIndicator>
                  <Select.ItemText>{option.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

export { TimeRangeSelect };
