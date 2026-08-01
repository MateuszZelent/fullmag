import type { ReactNode } from "react";

import { cn } from "@/shared/utils/className";

type StatusVariant = "ready" | "running" | "completed" | "stale" | "failed" | "error" | "degraded" | "queued" | "building" | "pending" | "warning" | "success" | "info";

interface StatusBadgeProps {
  /** Status variant, controls color */
  status: StatusVariant;
  /** Badge label text */
  children: ReactNode;
  /** Additional CSS class */
  className?: string;
}

/**
 * Shared status badge used across Explorer tree nodes, Inspector panels, and Footer.
 * Uses data-status attribute for CSS-driven color theming.
 */
export function StatusBadge({ status, children, className }: StatusBadgeProps) {
  return (
    <span className={cn("fm-status-badge", className)} data-status={status}>
      {children}
    </span>
  );
}
