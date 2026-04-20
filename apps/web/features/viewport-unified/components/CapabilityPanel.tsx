/**
 * Capability-gated panel wrapper.
 *
 * Renders children only when the required capability is present,
 * optionally showing a fallback otherwise.
 */

import type { ReactNode } from "react";
import type { CapabilityMap } from "../../../src/api/types";

interface CapabilityPanelProps {
  capabilities: CapabilityMap | null;
  requires: keyof CapabilityMap;
  children: ReactNode;
  fallback?: ReactNode;
}

export function CapabilityPanel({
  capabilities,
  requires,
  children,
  fallback = null,
}: CapabilityPanelProps) {
  if (!capabilities || !capabilities[requires]) {
    return <>{fallback}</>;
  }
  return <>{children}</>;
}
