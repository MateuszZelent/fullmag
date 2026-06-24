import type { ObjectRegionDiagnosticItem } from "../ObjectRegionsPanelModel";
import { regionCapabilityLabel } from "@/shared/domain/region/regionCapabilityCatalog";

export type RegionDiagnosticPresentationInput = ObjectRegionDiagnosticItem;

export interface RegionInlineDiagnostic {
  capabilityLabel: string;
  diagnosticId: string;
  kind: "error" | "warning";
  message: string;
}

export function resolveRegionInlineDiagnostics(
  diagnostics: readonly RegionDiagnosticPresentationInput[],
  capabilityGates: readonly string[],
): RegionInlineDiagnostic[] {
  const allowed = new Set(capabilityGates);
  const inlineDiagnostics: RegionInlineDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const severity = diagnostic.severity.toLowerCase();
    if (
      diagnostic.capabilityGate !== null &&
      allowed.has(diagnostic.capabilityGate) &&
      (severity === "warning" || severity === "error")
    ) {
      const capabilityLabel = regionCapabilityLabel(diagnostic.capabilityGate);
      inlineDiagnostics.push({
        capabilityLabel,
        diagnosticId: diagnostic.diagnosticId,
        kind: diagnostic.severity.toLowerCase() === "error" ? "error" : "warning",
        message: `${capabilityLabel}: ${diagnostic.message}`,
      });
    }
  }
  return inlineDiagnostics;
}
