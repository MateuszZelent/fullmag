import { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface ViewportToolGroupProps {
  children: ReactNode;
  label?: string;
  className?: string;
  compact?: boolean;
}

export function ViewportToolGroup({ children, label, className, compact = false }: ViewportToolGroupProps) {
  return (
    <div
      className={cn(
        "flex items-center p-0.5 rounded-md bg-background/60 backdrop-blur-md border border-border/40 shadow-sm gap-0.5 pointer-events-auto",
        className
      )}
    >
      {label && !compact && (
        <span className="text-[0.6rem] font-bold uppercase tracking-widest text-muted-foreground/80 px-1.5 select-none">
          {label}
        </span>
      )}
      {children}
    </div>
  );
}

export function ViewportToolSeparator() {
  return <div className="w-px h-4 bg-border/40 mx-0.5 shrink-0" />;
}
