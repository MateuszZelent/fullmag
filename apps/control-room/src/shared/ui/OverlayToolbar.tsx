import React, { type ReactNode } from "react";
import { cn } from "@/shared/utils/className";
import { useToolbarRovingFocus } from "@/shared/ui/useToolbarRovingFocus";

interface OverlayToolbarProps {
  children: ReactNode;
  className?: string;
  position?: "top-left" | "top-right" | "bottom-left" | "bottom-right" | "top-center" | "bottom-center";
  /** Accessible name; distinguishes several overlay toolbars on one surface. */
  label?: string;
  orientation?: "horizontal" | "vertical";
}

export function OverlayToolbar({
  children,
  className,
  position = "top-right",
  label = "Viewport controls",
  orientation = "horizontal",
}: OverlayToolbarProps) {
  const toolbar = useToolbarRovingFocus<HTMLDivElement>({ orientation, deps: [children] });
  return (
    <div
      ref={toolbar.ref}
      className={cn(
        "fm-overlay-toolbar",
        `fm-overlay-toolbar--${position}`,
        className
      )}
      role="toolbar"
      aria-label={label}
      aria-orientation={orientation}
      onKeyDown={toolbar.onKeyDown}
    >
      {children}
    </div>
  );
}
export default OverlayToolbar;
