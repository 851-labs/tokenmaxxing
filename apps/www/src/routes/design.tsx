import { useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Copy, PencilSimple, Trash } from "@phosphor-icons/react/ssr";

import { StatCard } from "../components/stat-card";
import { Avatar } from "../components/ui/avatar";
import { Badge, type BadgeVariant } from "../components/ui/badge";
import { Button, buttonClassName } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Code } from "../components/ui/code";
import { Input, Textarea } from "../components/ui/input";
import { Menu } from "../components/ui/menu";
import { Tabs } from "../components/ui/tabs";
import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH } from "../lib/og";

const Route = createFileRoute("/design")({
  component: DesignPage,
});

/** Token swatches. The `bg-*` class is a complete literal so Tailwind's
 * scanner emits it. */
const COLOR_TOKENS = [
  { name: "background", swatch: "bg-background" },
  { name: "foreground", swatch: "bg-foreground" },
  { name: "muted", swatch: "bg-muted" },
  { name: "muted-foreground", swatch: "bg-muted-foreground" },
  { name: "card", swatch: "bg-card" },
  { name: "card-foreground", swatch: "bg-card-foreground" },
  { name: "border", swatch: "bg-border" },
  { name: "accent", swatch: "bg-accent" },
  { name: "accent-foreground", swatch: "bg-accent-foreground" },
];

const TYPE_SIZES = [
  { label: "text-2xl", className: "text-2xl" },
  { label: "text-xl", className: "text-xl" },
  { label: "text-lg", className: "text-lg" },
  { label: "text-base", className: "text-base" },
  { label: "text-sm", className: "text-sm" },
  { label: "text-xs", className: "text-xs" },
];

const DEMO_TABS = [
  { label: "Spend", value: "spend" as const },
  { label: "Tokens", value: "tokens" as const },
  { label: "Active days", value: "days" as const },
];

const BADGE_VARIANTS: { label: string; variant: BadgeVariant }[] = [
  { label: "muted", variant: "muted" },
  { label: "accent", variant: "accent" },
  { label: "healthy", variant: "healthy" },
  { label: "stale", variant: "stale" },
  { label: "unknown", variant: "unknown" },
  { label: "repair-needed", variant: "repair-needed" },
  { label: "outdated", variant: "outdated" },
  { label: "update blocked", variant: "update-blocked" },
];

const OG_PREVIEWS = [
  {
    cardSrc: "/og-card/pondorasti",
    label: "Stats",
    pngSrc: "/og/pondorasti.png",
  },
];

function DesignPage() {
  const [tab, setTab] = useState<(typeof DEMO_TABS)[number]["value"]>("spend");

  return (
    <div className="flex flex-col gap-12 px-4 py-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Design system</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The tokens and primitives the site is built from. Colors follow the system appearance.
        </p>
      </header>

      <Section title="Profile OG">
        <div className="grid gap-8">
          {OG_PREVIEWS.map((preview) => (
            <div className="flex min-w-0 flex-col gap-3" key={preview.pngSrc}>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium">{preview.label}</span>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <a className="hover:text-foreground" href={preview.cardSrc}>
                    HTML card
                  </a>
                  <a className="hover:text-foreground" href={preview.pngSrc}>
                    PNG
                  </a>
                </div>
              </div>
              <div className="grid gap-3 xl:grid-cols-2">
                <div className="min-w-0">
                  <span className="mb-1 block text-xs text-muted-foreground">HTML card</span>
                  <OgHtmlPreview
                    src={preview.cardSrc}
                    title={`${preview.label} HTML Open Graph card`}
                  />
                </div>
                <div className="min-w-0">
                  <span className="mb-1 block text-xs text-muted-foreground">PNG output</span>
                  <OgPngPreview
                    alt={`${preview.label} profile Open Graph PNG preview`}
                    src={preview.pngSrc}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Color tokens">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {COLOR_TOKENS.map((token) => (
            <div className="flex flex-col gap-1.5" key={token.name}>
              <div className={`h-16 rounded-lg border border-border ${token.swatch}`} />
              <Code>{token.name}</Code>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Typography">
        <div className="flex flex-col gap-3">
          {TYPE_SIZES.map((size) => (
            <div className="flex items-baseline gap-4" key={size.label}>
              <span className="w-20 shrink-0 text-xs text-muted-foreground">{size.label}</span>
              <span className={size.className}>Maxxing the most tokens</span>
            </div>
          ))}
          <div className="flex items-baseline gap-4">
            <span className="w-20 shrink-0 text-xs text-muted-foreground">font-mono</span>
            <span className="font-mono text-sm">tokenmaxxing sync</span>
          </div>
          <div className="flex items-baseline gap-4">
            <span className="w-20 shrink-0 text-xs text-muted-foreground">weights</span>
            <span className="text-sm">
              <span className="font-normal">normal</span> ·{" "}
              <span className="font-medium">medium</span> ·{" "}
              <span className="font-semibold">semibold</span>
            </span>
          </div>
        </div>
      </Section>

      <Section title="Buttons">
        <div className="flex flex-wrap items-center gap-3">
          <Button size="xs" variant="primary">
            Primary xs
          </Button>
          <Button size="sm" variant="primary">
            Primary sm
          </Button>
          <Button size="md" variant="primary">
            Primary md
          </Button>
          <Button size="md" variant="outline">
            Outline
          </Button>
          <Button disabled size="md" variant="primary">
            Disabled
          </Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button>
        </div>
        <div className="mt-4 max-w-sm">
          <Button fullWidth size="md" variant="primary">
            Full width
          </Button>
        </div>
      </Section>

      <Section title="Tabs">
        <Tabs onChange={setTab} options={DEMO_TABS} value={tab} />
        <p className="mt-2 text-sm text-muted-foreground">
          Selected: <Code>{tab}</Code>
        </p>
      </Section>

      <Section title="Menu">
        <Menu>
          <Menu.Trigger className={buttonClassName({ size: "sm", variant: "primary" })}>
            Actions
          </Menu.Trigger>
          <Menu.Content align="start">
            <Menu.Item icon={<PencilSimple />}>Edit profile</Menu.Item>
            <Menu.Item icon={<Copy />}>Copy link</Menu.Item>
            <Menu.Separator />
            <Menu.Item
              className="text-red-500 data-[highlighted]:bg-red-500/10 data-[highlighted]:text-red-500"
              icon={<Trash />}
            >
              Delete
            </Menu.Item>
          </Menu.Content>
        </Menu>
        <p className="mt-2 text-sm text-muted-foreground">
          A Base UI dropdown — arrow keys move the highlight, Esc or an outside click closes it.
        </p>
      </Section>

      <Section title="Avatar">
        <div className="flex items-end gap-4">
          <Avatar size={24} src="https://github.com/pondorasti.png" />
          <Avatar size={28} src="https://github.com/pondorasti.png" />
          <Avatar size={56} src="https://github.com/pondorasti.png" />
          <Avatar size={56} src={null} />
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          Sizes 24 / 28 / 56, plus the null-src fallback.
        </p>
      </Section>

      <Section title="Badge">
        <div className="flex flex-wrap items-center gap-3">
          {BADGE_VARIANTS.map((badge) => (
            <Badge key={badge.variant} variant={badge.variant}>
              {badge.label}
            </Badge>
          ))}
        </div>
      </Section>

      <Section title="Input">
        <div className="flex max-w-sm flex-col gap-3">
          <Input placeholder="you@example.com" />
          <Textarea placeholder="Tell us what you maxxed…" rows={3} />
        </div>
      </Section>

      <Section title="Code">
        <p className="text-sm text-muted-foreground">
          Run <Code>npm install -g @851-labs/tokenmaxxing@latest</Code> to install.
        </p>
      </Section>

      <Section title="Card & StatCard">
        <Card className="max-w-sm p-5">
          <h3 className="font-medium">Card</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            A bordered surface on the card background. Pass <Code>className</Code> to override
            padding.
          </p>
        </Card>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Total spend" value="$1,284" />
          <StatCard label="Total tokens" value="48.2M" />
          <StatCard label="Active days" value="63" />
          <StatCard label="Top spend model" value="claude-opus-4-8" />
        </div>
      </Section>
    </div>
  );
}

function OgHtmlPreview({ src, title }: { src: string; title: string }) {
  const { ref, scale } = useOgPreviewScale();

  return (
    <div
      className="relative aspect-[1200/630] max-w-full overflow-hidden border border-border bg-muted"
      ref={ref}
    >
      <iframe
        className="absolute left-0 top-0 block border-0"
        src={src}
        style={{
          height: OG_IMAGE_HEIGHT,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          width: OG_IMAGE_WIDTH,
        }}
        title={title}
      />
    </div>
  );
}

function OgPngPreview({ alt, src }: { alt: string; src: string }) {
  const isLocalhost = useIsLocalhost();

  if (isLocalhost) {
    return (
      <div className="flex aspect-[1200/630] w-full flex-col justify-center gap-2 border border-border bg-muted p-4 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">PNG preview unavailable in local dev</p>
        <p>
          Cloudflare Browser runs remotely and cannot capture <Code>tokenmaxxing.localhost</Code>.
          Use the HTML card preview locally, or test PNG output from a deployed/preview URL.
        </p>
      </div>
    );
  }

  return (
    <img
      alt={alt}
      className="aspect-[1200/630] w-full border border-border bg-muted object-cover"
      loading="lazy"
      src={src}
    />
  );
}

function useOgPreviewScale() {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }

    const update = () => {
      setScale(Math.min(1, element.clientWidth / OG_IMAGE_WIDTH));
    };
    update();

    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(element);

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  return { ref, scale };
}

function useIsLocalhost() {
  const [isLocalhost, setIsLocalhost] = useState(false);

  useEffect(() => {
    const hostname = window.location.hostname;
    setIsLocalhost(
      hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "::1" ||
        hostname.endsWith(".localhost"),
    );
  }, []);

  return isLocalhost;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

export { Route };
