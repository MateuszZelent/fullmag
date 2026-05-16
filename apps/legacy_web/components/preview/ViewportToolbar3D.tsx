import { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface ViewportToolbar3DProps {
  children: ReactNode;
  className?: string;
  sideChildren?: ReactNode;
  bottomChildren?: ReactNode;
  compact?: boolean;
}

export function ViewportToolbar3D({
  children,
  className,
  sideChildren,
  bottomChildren,
  compact = false,
}: ViewportToolbar3DProps) {
  return (
    <div
      className={cn(
        "pointer-events-none z-10 inline-flex max-w-full self-start flex-col gap-2",
        className,
      )}
    >
      <div className={cn("flex max-w-full flex-wrap items-start gap-2", !sideChildren && "justify-start")}>
        <div className={cn("flex flex-wrap items-center", compact ? "gap-1" : "gap-1.5")}>
          {children}
        </div>
        {sideChildren && <div className="flex flex-col items-end gap-1.5">{sideChildren}</div>}
      </div>
      {bottomChildren && (
        <div className="pointer-events-none mt-1 w-full">
          {bottomChildren}
        </div>
      )}
    </div>
  );
}
