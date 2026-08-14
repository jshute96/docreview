"use client";

import * as React from "react";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Box and glyph are scaled together at each step — see the note below. */
const SIZES = {
  /** Toolbar rows, where the menu stands alongside full-size buttons. */
  default: "px-2",
  /** Inline with the small (`h-5`) buttons of a bulk-action row. */
  compact: "h-5 px-1 [&_svg]:size-3",
  /** Inline with body text, e.g. the author/date line of a comment. */
  mini: "h-4 px-1 [&_svg]:size-2.5",
} as const;

interface HamburgerButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Match the size to whatever the button sits beside. Defaults to `default`. */
  size?: keyof typeof SIZES;
}

/**
 * The "more options" hamburger used as a `DropdownMenuTrigger` throughout the
 * app. Everything is drawn here so the menus stay identical across pages —
 * previously each call site rolled its own and they drifted apart.
 *
 * Note the `[&_svg]` override in compact mode: `Button` pins icons to `size-4`,
 * so shrinking only the box leaves a full-size glyph squeezed inside it.
 *
 * Forwards its ref because `DropdownMenuTrigger asChild` needs one.
 */
export const HamburgerButton = React.forwardRef<HTMLButtonElement, HamburgerButtonProps>(
  function HamburgerButton({ size = "default", className, title, ...props }, ref) {
    return (
      <Button
        ref={ref}
        variant="outline"
        size="sm"
        title={title ?? "More options"}
        className={cn("text-zinc-900", SIZES[size], className)}
        {...props}
      >
        <Menu />
      </Button>
    );
  }
);
