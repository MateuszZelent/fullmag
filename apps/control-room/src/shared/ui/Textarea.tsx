import type { ComponentPropsWithRef } from "react";

import { cn } from "@/shared/utils/className";

export function Textarea({
  className,
  ...props
}: ComponentPropsWithRef<"textarea">) {
  return (
    <textarea
      className={cn("fm-inspector-input fm-textarea", className)}
      data-slot="textarea"
      {...props}
    />
  );
}
