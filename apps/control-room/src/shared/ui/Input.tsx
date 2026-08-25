import type { ComponentPropsWithRef } from "react";

import { cn } from "@/shared/utils/className";

export function Input({
  className,
  ...props
}: ComponentPropsWithRef<"input">) {
  return (
    <input
      className={cn("fm-inspector-input", className)}
      data-slot="input"
      {...props}
    />
  );
}
