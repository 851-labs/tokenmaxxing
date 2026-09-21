import { Tabs as BaseTabs } from "@base-ui/react/tabs";

import { cn } from "../../lib/cn";

interface TabsProps<Value extends string> {
  options: { label: string; value: Value }[];
  value: Value;
  onChange: (value: Value) => void;
}

/** A segmented control: pick one option from a small inline set. The active
 * pill is a Base UI `Tabs.Indicator`, so it slides between options when the
 * selection changes. */
function Tabs<Value extends string>({ options, value, onChange }: TabsProps<Value>) {
  return (
    <BaseTabs.Root onValueChange={(next) => onChange(next as Value)} value={value}>
      <BaseTabs.List className="relative inline-flex border border-border p-0.5">
        <BaseTabs.Indicator
          className="absolute left-(--active-tab-left) top-(--active-tab-top) z-0 h-(--active-tab-height) w-(--active-tab-width) bg-foreground transition-all duration-200 ease-out"
          renderBeforeHydration
        />
        {options.map((option) => (
          <BaseTabs.Tab
            className={cn(
              "relative z-10 px-2.5 py-1 text-xs font-medium transition-colors",
              "text-muted-foreground hover:text-foreground",
              "data-active:text-background data-active:hover:text-background",
            )}
            key={option.value}
            value={option.value}
          >
            {option.label}
          </BaseTabs.Tab>
        ))}
      </BaseTabs.List>
    </BaseTabs.Root>
  );
}

export { Tabs };
