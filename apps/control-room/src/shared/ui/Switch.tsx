"use client";

import * as SwitchPrimitive from "@radix-ui/react-switch";
import type { ComponentPropsWithRef } from "react";

import { cn } from "@/shared/utils/className";

function Switch({
  className,
  ref,
  ...props
}: ComponentPropsWithRef<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      ref={ref}
      className={cn("fm-switch", className)}
      {...props}
    >
      <SwitchPrimitive.Thumb className="fm-switch__thumb" />
    </SwitchPrimitive.Root>
  );
}
Switch.displayName = SwitchPrimitive.Root.displayName;

export { Switch };
