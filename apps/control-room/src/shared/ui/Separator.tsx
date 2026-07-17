"use client";

import * as SeparatorPrimitive from "@radix-ui/react-separator";
import type { ComponentPropsWithRef } from "react";

import { cn } from "@/shared/utils/className";

function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ref,
  ...props
}: ComponentPropsWithRef<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      ref={ref}
      decorative={decorative}
      orientation={orientation}
      className={cn(
        "fm-separator",
        orientation === "vertical" ? "fm-separator--vertical" : "fm-separator--horizontal",
        className,
      )}
      {...props}
    />
  );
}
Separator.displayName = SeparatorPrimitive.Root.displayName;

export { Separator };
