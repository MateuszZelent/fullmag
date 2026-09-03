"use client";

import { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  title: string;
  description?: string;
  tone?: string;
  compact?: boolean;
  children?: ReactNode;
}

export default function EmptyState({
  title,
  description,
  compact = false,
  children,
}: EmptyStateProps) {
  return (
    <div className={cn("grid place-items-center text-center rounded-md border border-border/40 bg-white/5", compact ? "p-6 gap-2" : "gap-3 p-10")}>
      <h3 className={cn("m-0 font-bold text-foreground", compact ? "text-[0.92rem]" : "text-base")}>{title}</h3>
      {description && <p className="m-0 text-[0.85rem] text-muted-foreground max-w-md">{description}</p>}
      {children}
    </div>
  );
}
