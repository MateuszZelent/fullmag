"use client";

import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import type { ComponentPropsWithRef } from "react";

import { cn } from "@/shared/utils/className";

function ScrollArea({
  className,
  children,
  ref,
  ...props
}: ComponentPropsWithRef<typeof ScrollAreaPrimitive.Root>) {
  return (
    <ScrollAreaPrimitive.Root
      ref={ref}
      className={cn("fm-scroll-area", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport className="fm-scroll-area__viewport">
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName;

function ScrollBar({
  className,
  orientation = "vertical",
  ref,
  ...props
}: ComponentPropsWithRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      ref={ref}
      orientation={orientation}
      className={cn(
        "fm-scroll-area__scrollbar",
        orientation === "vertical"
          ? "fm-scroll-area__scrollbar--vertical"
          : "fm-scroll-area__scrollbar--horizontal",
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb className="fm-scroll-area__thumb" />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  );
}
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName;

export { ScrollArea, ScrollBar };
