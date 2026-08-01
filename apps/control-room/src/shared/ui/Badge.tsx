import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentPropsWithoutRef } from "react";

import { cn } from "@/shared/utils/className";

const badgeVariants = cva("fm-badge", {
  variants: {
    variant: {
      default: "fm-badge--default",
      secondary: "fm-badge--secondary",
      success: "fm-badge--success",
      warning: "fm-badge--warning",
      danger: "fm-badge--danger",
      accent: "fm-badge--accent",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

export interface BadgeProps
  extends ComponentPropsWithoutRef<"span">,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}
