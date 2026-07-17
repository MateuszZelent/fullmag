import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentPropsWithoutRef } from "react";

import { cn } from "@/shared/utils/className";

const buttonVariants = cva(
  [
    "fm-button inline-flex min-w-0 items-center justify-center border",
    "rounded-fm-control font-fm-ui font-medium leading-none outline-none",
    "transition-[transform,background-color,border-color,color,box-shadow] duration-150",
    "active:scale-[0.98] motion-reduce:active:scale-100",
    "focus-visible:ring-2 focus-visible:ring-fm-accent",
    "disabled:cursor-not-allowed disabled:border-fm-disabled-border",
    "disabled:bg-fm-disabled disabled:text-fm-disabled-text disabled:opacity-100 disabled:active:scale-100",
  ],
  {
    variants: {
      variant: {
        primary:
          "fm-button--primary border-fm-accent bg-fm-accent text-fm-inverse shadow-[var(--fm-shadow-control)] hover:border-fm-strong hover:shadow-[var(--fm-shadow-control-hover)] active:shadow-[var(--fm-shadow-control-pressed)]",
        secondary:
          "fm-button--secondary border-fm-border bg-fm-raised text-fm-primary shadow-[var(--fm-shadow-control)] hover:border-fm-strong hover:bg-fm-disabled hover:shadow-[var(--fm-shadow-control-hover)] active:shadow-[var(--fm-shadow-control-pressed)]",
        ghost:
          "fm-button--ghost border-transparent bg-transparent text-fm-secondary hover:bg-fm-disabled hover:text-fm-primary",
        danger:
          "fm-button--danger border-fm-danger bg-transparent text-fm-danger hover:bg-fm-disabled",
      },
      size: {
        sm: "fm-button--sm h-fm-control-sm gap-2 px-2 text-[length:var(--fm-font-size-control)]",
        md: "fm-button--md h-fm-control-md gap-2 px-3 text-[length:var(--fm-font-size-control)]",
        icon: "fm-button--icon size-fm-control-sm p-0 text-[length:var(--fm-font-size-control)]",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "md",
    },
  },
);

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
      data-slot="button"
      {...props}
    />
  );
}
