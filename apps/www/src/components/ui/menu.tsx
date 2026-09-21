import type { ComponentProps, ReactNode } from "react";
import { Menu as BaseMenu } from "@base-ui-components/react/menu";

import { cn } from "../../lib/cn";

/**
 * A dropdown menu built on Base UI. Compose by hand:
 *
 * ```tsx
 * <Menu>
 *   <Menu.Trigger className={buttonClassName(...)}>Actions</Menu.Trigger>
 *   <Menu.Content>
 *     <Menu.Item render={<Link to="/settings" />}>Settings</Menu.Item>
 *     <Menu.Separator />
 *     <Menu.Item onClick={...}>Sign out</Menu.Item>
 *   </Menu.Content>
 * </Menu>
 * ```
 */

/** Defaults to non-modal so opening never scroll-locks / shifts the sticky nav. */
function MenuRoot({ modal = false, ...rest }: ComponentProps<typeof BaseMenu.Root>) {
  return <BaseMenu.Root modal={modal} {...rest} />;
}

/** Narrows Base UI's `className` (which can be a `(state) => string` function)
 * to a plain string so our `cn()` wrappers accept it. */
type WithClassName<T> = Omit<T, "className"> & { className?: string };

interface MenuContentProps extends WithClassName<ComponentProps<typeof BaseMenu.Popup>> {
  side?: ComponentProps<typeof BaseMenu.Positioner>["side"];
  align?: ComponentProps<typeof BaseMenu.Positioner>["align"];
  sideOffset?: ComponentProps<typeof BaseMenu.Positioner>["sideOffset"];
}

/** Bundles Portal → Positioner → Popup with placement + open/close animation. */
function MenuContent({
  align = "end",
  className,
  side = "bottom",
  sideOffset = 6,
  ...rest
}: MenuContentProps) {
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner
        align={align}
        className="z-50 outline-none"
        side={side}
        sideOffset={sideOffset}
      >
        <BaseMenu.Popup
          className={cn(
            "min-w-36 origin-(--transform-origin) border border-border bg-card p-1 text-sm text-foreground shadow-lg outline-none",
            // Tailwind v4 emits `scale-*` as the standalone `scale` property, so it
            // must be named in the transition (alongside opacity) or it snaps.
            "transition-[opacity,scale] duration-150 ease-out",
            "data-starting-style:scale-95 data-starting-style:opacity-0",
            "data-ending-style:scale-95 data-ending-style:opacity-0",
            className,
          )}
          {...rest}
        />
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
}

interface MenuItemProps extends WithClassName<ComponentProps<typeof BaseMenu.Item>> {
  /** Leading icon, sized + aligned consistently. Inherits the item's text
   * color (so destructive items get a red icon too). */
  icon?: ReactNode;
}

/** A single action or link. Pass `render={<Link … />}` to navigate. */
function MenuItem({ children, className, icon, ...rest }: MenuItemProps) {
  return (
    <BaseMenu.Item
      className={cn(
        "flex cursor-default select-none items-center gap-2 px-2.5 py-1.5 outline-none",
        "data-highlighted:bg-muted data-disabled:pointer-events-none data-disabled:opacity-50",
        className,
      )}
      {...rest}
    >
      {icon === undefined ? null : (
        <span aria-hidden className="flex shrink-0 [&_svg]:size-4">
          {icon}
        </span>
      )}
      {children}
    </BaseMenu.Item>
  );
}

function MenuSeparator({ className }: WithClassName<ComponentProps<typeof BaseMenu.Separator>>) {
  return <BaseMenu.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} />;
}

const Menu = Object.assign(MenuRoot, {
  Content: MenuContent,
  Item: MenuItem,
  Separator: MenuSeparator,
  Trigger: BaseMenu.Trigger,
});

export { Menu };
