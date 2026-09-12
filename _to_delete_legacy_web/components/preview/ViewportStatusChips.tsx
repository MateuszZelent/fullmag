import { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface ViewportStatusChipProps {
  children: ReactNode;
  active?: boolean;
  color?: "default" | "primary" | "success" | "warning" | "error" | "info";
  className?: string;
  title?: string;
}

export function ViewportStatusChip({ children, active, color = "default", className, title }: ViewportStatusChipProps) {
  return (
    <div
      title={title}
      className={cn(
        "flex items-center h-6 px-2 rounded-full border text-[0.6rem] font-semibold uppercase tracking-widest transition-colors backdrop-blur-md pointer-events-auto shadow-sm",
        color === "default" && "border-border/30 bg-background/50 text-muted-foreground",
        color === "primary" && "border-primary/30 bg-primary/10 text-primary",
        color === "success" && "border-success/30 bg-success/10 text-success",
        color === "warning" && "border-warning/30 bg-warning/10 text-warning",
        color === "error" && "border-error/30 bg-error/10 text-error",
        color === "info" && "border-info/30 bg-info/10 text-info",
        active && "border-primary/45 bg-primary/18 text-primary",
        className
      )}
    >
      {children}
    </div>
  );
}
