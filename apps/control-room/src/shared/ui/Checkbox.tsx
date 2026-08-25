import type { ComponentPropsWithRef } from "react";

import { cn } from "@/shared/utils/className";

export function Checkbox({
  className,
  ...props
}: Omit<ComponentPropsWithRef<"input">, "type">) {
  return (
    <input
      className={cn(
        "fm-checkbox size-4 shrink-0 rounded-fm-control border border-fm-border bg-fm-canvas accent-fm-accent outline-none",
        "focus-visible:ring-2 focus-visible:ring-fm-accent disabled:cursor-not-allowed disabled:opacity-100",
        className,
      )}
      data-slot="checkbox"
      type="checkbox"
      {...props}
    />
  );
}
