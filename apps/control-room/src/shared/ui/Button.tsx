import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentPropsWithoutRef } from "react";

import { cn } from "@/shared/utils/className";

const buttonVariants = cva("fm-button", {
  variants: {
    variant: {
      primary: "fm-button--primary",
      secondary: "fm-button--secondary",
      ghost: "fm-button--ghost",
      danger: "fm-button--danger",
    },
    size: {
      sm: "fm-button--sm",
      md: "fm-button--md",
      icon: "fm-button--icon",
    },
  },
  defaultVariants: {
    variant: "secondary",
    size: "md",
  },
});

export interface ButtonProps
  extends ComponentPropsWithoutRef<"button">,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export function Button({
  asChild = false,
  className,
  size,
  variant,
  ...props
}: ButtonProps) {
  const Component = asChild ? Slot : "button";

  return (
    <Component
      className={cn(buttonVariants({ size, variant }), className)}
      {...props}
    />
  );
}
