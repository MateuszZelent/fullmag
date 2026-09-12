import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[0.7rem] font-semibold tracking-wider uppercase transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground hover:bg-primary/80",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive:
          "border-transparent bg-destructive/20 text-destructive hover:bg-destructive/30",
        outline: "text-foreground",
        // Custom semantic variants for Fullmag Status
        info: "border-transparent bg-info/15 text-info hover:bg-info/25",
        success: "border-transparent bg-success/15 text-success hover:bg-success/25",
        warn: "border-transparent bg-warning/15 text-warning hover:bg-warning/25",
        accent: "border-transparent bg-primary/15 text-primary hover:bg-primary/25",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {
  pulse?: boolean;
  showDot?: boolean;
}

function Badge({ className, variant, pulse, showDot, ...props }: BadgeProps) {
  const hasDot = pulse || showDot;
  
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props}>
      {hasDot && (
        <span className="relative flex h-1.5 w-1.5">
          {pulse && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />}
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
        </span>
      )}
      {props.children}
    </div>
  );
}

export { Badge, badgeVariants };
