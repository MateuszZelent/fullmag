import React, { type ReactNode } from "react";
import { cn } from "@/shared/utils/className";

interface OverlayToolbarProps {
  children: ReactNode;
  className?: string;
  position?: "top-left" | "top-right" | "bottom-left" | "bottom-right" | "top-center" | "bottom-center";
}

export function OverlayToolbar({
  children,
  className,
  position = "top-right",
}: OverlayToolbarProps) {
  return (
    <div
      className={cn(
        "fm-overlay-toolbar",
        `fm-overlay-toolbar--${position}`,
        className
      )}
      role="toolbar"
      aria-label="Viewport controls"
    >
      {children}
    </div>
  );
}
export default OverlayToolbar;
