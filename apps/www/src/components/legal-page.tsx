import type { ReactNode } from "react";

/** Shared layout for the privacy policy and terms of service. */
function LegalPage({
  children,
  title,
  updated,
}: {
  children: ReactNode;
  title: string;
  updated: string;
}) {
  return (
    <div className="px-4 py-10 sm:py-14">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-3 text-sm text-muted-foreground">Last updated: {updated}</p>
      </header>

      <div className="mt-10 space-y-8">{children}</div>
    </div>
  );
}

function LegalSection({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section>
      <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{children}</p>
    </section>
  );
}

export { LegalPage, LegalSection };
