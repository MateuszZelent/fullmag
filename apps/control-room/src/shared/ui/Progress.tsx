"use client";

import * as ProgressPrimitive from "@radix-ui/react-progress";
import type { ComponentPropsWithRef } from "react";

import { cn } from "@/shared/utils/className";

function Progress({
  className,
  ref,
  value,
  ...props
}: ComponentPropsWithRef<typeof ProgressPrimitive.Root>) {
  return (
    <ProgressPrimitive.Root
      ref={ref}
      className={cn("fm-progress", className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className="fm-progress__indicator"
        style={{ transform: `translateX(-${100 - (value ?? 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}
Progress.displayName = ProgressPrimitive.Root.displayName;

export { Progress };
