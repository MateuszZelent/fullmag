import { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A structured grid layout overlay for 3D viewports.
 * Replaces hardcoded absolute positioning with designated semantic slots.
 * Automatically handles pointer events so users can interact with the 3D canvas
 * through empty spaces, while UI elements remain clickable.
 */
export function ViewportOverlayLayout({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "absolute inset-0 z-10 pointer-events-none p-3",
        "grid gap-3",
        "grid-cols-[auto_minmax(0,1fr)_auto]",
        "grid-rows-[auto_minmax(0,1fr)_auto]",
        className
      )}
      style={{
        gridTemplateAreas: `
          "top-left top-center top-right"
          "left center right"
          "bottom-left bottom-center bottom-right"
        `,
      }}
    >
      {children}
    </div>
  );
}

// ─── Semantic Layout Slots ─────────────────────────────────────────────

type SlotProps = {
  children: ReactNode;
  className?: string;
};

ViewportOverlayLayout.TopLeft = function TopLeft({ children, className }: SlotProps) {
  return (
    <div
      className={cn("pointer-events-none flex flex-col gap-2 items-start justify-start min-h-0 min-w-0", className)}
      style={{ gridArea: "top-left" }}
    >
      {children}
    </div>
  );
};

ViewportOverlayLayout.TopCenter = function TopCenter({ children, className }: SlotProps) {
  return (
    <div
      className={cn("pointer-events-none flex flex-col gap-2 items-center justify-start min-h-0 min-w-0", className)}
      style={{ gridArea: "top-center" }}
    >
      {children}
    </div>
  );
};

ViewportOverlayLayout.TopRight = function TopRight({ children, className }: SlotProps) {
  return (
    <div
      className={cn("pointer-events-none flex flex-col gap-2 items-end justify-start min-h-0 min-w-0", className)}
      style={{ gridArea: "top-right" }}
    >
      {children}
    </div>
  );
};

ViewportOverlayLayout.BottomLeft = function BottomLeft({ children, className }: SlotProps) {
  return (
    <div
      className={cn("pointer-events-none flex flex-col gap-2 items-start justify-end min-h-0 min-w-0", className)}
      style={{ gridArea: "bottom-left" }}
    >
      {children}
    </div>
  );
};

ViewportOverlayLayout.BottomCenter = function BottomCenter({ children, className }: SlotProps) {
  return (
    <div
      className={cn("pointer-events-none flex flex-col gap-2 items-center justify-end min-h-0 min-w-0", className)}
      style={{ gridArea: "bottom-center" }}
    >
      {children}
    </div>
  );
};

ViewportOverlayLayout.BottomRight = function BottomRight({ children, className }: SlotProps) {
  return (
    <div
      className={cn("pointer-events-none flex flex-col gap-2 items-end justify-end min-h-0 min-w-0", className)}
      style={{ gridArea: "bottom-right" }}
    >
      {children}
    </div>
  );
};

ViewportOverlayLayout.Right = function Right({ children, className }: SlotProps) {
  return (
    <div
      className={cn("pointer-events-none flex flex-col gap-2 items-end justify-start h-full min-h-0 min-w-0", className)}
      style={{ gridArea: "right" }}
    >
      {children}
    </div>
  );
};

ViewportOverlayLayout.Left = function Left({ children, className }: SlotProps) {
  return (
    <div
      className={cn("pointer-events-none flex flex-col gap-2 items-start justify-start h-full min-h-0 min-w-0", className)}
      style={{ gridArea: "left" }}
    >
      {children}
    </div>
  );
};
