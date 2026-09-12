"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

const TooltipProvider = ({ children }: { children: React.ReactNode; delayDuration?: number }) => (
  <>{children}</>
);

interface TooltipContextValue {
  open: boolean;
  setOpen: (next: boolean) => void;
}

const TooltipContext = React.createContext<TooltipContextValue | null>(null);

function useTooltipContext(component: string): TooltipContextValue {
  const context = React.useContext(TooltipContext);
  if (!context) {
    throw new Error(`${component} must be used within Tooltip.`);
  }
  return context;
}

const Tooltip = ({ children }: { children: React.ReactNode }) => {
  const [open, setOpen] = React.useState(false);
  const context = React.useMemo(() => ({ open, setOpen }), [open]);
  return (
    <TooltipContext.Provider value={context}>
      <span className="relative inline-flex">{children}</span>
    </TooltipContext.Provider>
  );
};

const TooltipTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ onMouseEnter, onMouseLeave, onFocus, onBlur, ...props }, ref) => {
  const { setOpen } = useTooltipContext("TooltipTrigger");
  return (
    <button
      ref={ref}
      type={props.type ?? "button"}
      onMouseEnter={(event) => {
        onMouseEnter?.(event);
        setOpen(true);
      }}
      onMouseLeave={(event) => {
        onMouseLeave?.(event);
        setOpen(false);
      }}
      onFocus={(event) => {
        onFocus?.(event);
        setOpen(true);
      }}
      onBlur={(event) => {
        onBlur?.(event);
        setOpen(false);
      }}
      {...props}
    />
  );
});
TooltipTrigger.displayName = "TooltipTrigger";

interface TooltipContentProps extends React.HTMLAttributes<HTMLDivElement> {
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  sideOffset?: number;
}

const TooltipContent = React.forwardRef<HTMLDivElement, TooltipContentProps>(
  ({ className, side = "top", align = "center", sideOffset = 4, style, ...props }, ref) => {
    const { open } = useTooltipContext("TooltipContent");
    if (!open) {
      return null;
    }
    const sideStyle: React.CSSProperties =
      side === "bottom"
        ? { top: `calc(100% + ${sideOffset}px)` }
        : side === "left"
          ? { right: `calc(100% + ${sideOffset}px)` }
          : side === "right"
            ? { left: `calc(100% + ${sideOffset}px)` }
            : { bottom: `calc(100% + ${sideOffset}px)` };
    const alignClass =
      side === "top" || side === "bottom"
        ? (align === "start" ? "left-0" : align === "end" ? "right-0" : "left-1/2 -translate-x-1/2")
        : (align === "start" ? "top-0" : align === "end" ? "bottom-0" : "top-1/2 -translate-y-1/2");
    return (
      <div
        ref={ref}
        className={cn(
          "absolute z-50 overflow-hidden rounded-md px-3 py-1.5",
          "text-xs font-medium",
          "bg-popover text-popover-foreground",
          "border border-border",
          "shadow-md",
          "animate-in",
          alignClass,
          className,
        )}
        style={{ ...sideStyle, ...style }}
        {...props}
      />
    );
  },
);
TooltipContent.displayName = "TooltipContent";

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
