import type { ReactNode } from "react";

interface StatCardProps {
  label: string;
  value: ReactNode;
}

/** A borderless stat cell — meant to sit inside a hairline (`gap-px`) grid where
 * the grid gap, not a per-cell border, draws the dividing lines. */
function StatCard({ label, value }: StatCardProps) {
  return (
    <div className="bg-background p-4">
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-1.5 text-2xl font-semibold tracking-tight">{value}</p>
    </div>
  );
}

export { StatCard };
