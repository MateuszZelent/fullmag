/**
 * Capability-gated panel wrapper.
 *
 * Transitional wrapper kept for compatibility while migrating to the
 * unified toolbar/shell contracts. The default behavior keeps controls
 * visible and marks them unavailable instead of hiding content.
 */

import type { ReactNode } from "react";
import type { CapabilityMap } from "@/src/api/types";

interface CapabilityPanelProps {
  capabilities: CapabilityMap | null;
  requires: keyof CapabilityMap;
  children: ReactNode;
  fallback?: ReactNode;
  mode?: "disable" | "hide";
  reason?: string;
}

export function CapabilityPanel({
  capabilities,
  requires,
  children,
  fallback = null,
  mode = "disable",
  reason = "Capability unavailable",
}: CapabilityPanelProps) {
  const available = Boolean(capabilities && capabilities[requires]);
  if (available) {
    return <>{children}</>;
  }
  if (mode === "hide") {
    return <>{fallback}</>;
  }
  return (
    <div
      aria-disabled
      title={reason}
      className="opacity-60 pointer-events-none select-none"
      data-capability-requires={requires}
    >
      {children}
    </div>
  );
}
