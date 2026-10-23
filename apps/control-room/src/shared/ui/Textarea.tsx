import type { ComponentPropsWithRef } from "react";

import { cn } from "@/shared/utils/className";

export function Textarea({
  className,
  ...props
}: ComponentPropsWithRef<"textarea">) {
  return (
    <textarea
      className={cn("fm-inspector-textarea fm-textarea", className)}
      data-slot="textarea"
      {...props}
    />
  );
}
