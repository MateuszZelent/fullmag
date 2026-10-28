import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentPropsWithRef } from "react";

import { cn } from "@/shared/utils/className";

import { DisabledReason } from "./DisabledReason";

const buttonVariants = cva(
  "fm-button",
  {
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
  },
);

export interface ButtonProps
  extends ComponentPropsWithRef<"button">,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /**
   * User-facing reason shown on hover and keyboard focus while `disabled`.
   * Ignored when the button is enabled.
   */
  disabledReason?: string | null;
}

export function Button({
  asChild = false,
  className,
  disabledReason,
  size,
  variant,
  ...props
}: ButtonProps) {
  const Component = asChild ? Slot : "button";
  const button = (
    <Component
      className={cn(buttonVariants({ size, variant }), className)}
      data-slot="button"
      {...props}
    />
  );

  const reason = props.disabled ? disabledReason?.trim() : undefined;
  return reason ? <DisabledReason reason={reason}>{button}</DisabledReason> : button;
}
