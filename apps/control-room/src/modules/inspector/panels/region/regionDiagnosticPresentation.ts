import type { ObjectRegionDiagnosticItem } from "../ObjectRegionsPanelModel";
import type { MeshInspectorLane } from "../fdmMeshInspectorModel";
import { regionCapabilityLabel } from "@/shared/domain/region/regionCapabilityCatalog";

export type RegionDiagnosticPresentationInput = ObjectRegionDiagnosticItem;

const FEM_REGION_CAPABILITY_GATES = new Set([
  "regions.conformal_or_projected_boundary",
  "regions.material_override",
  "regions.mesh_policy",
  "regions.realized_materialization",
]);

/**
 * Region diagnostics are authored above the solver lane, but these capability
 * gates describe FEM materialization/mesh realization. Keep their messages
 * visible only once the active lane is explicitly FEM; preserve diagnostics
 * without a FEM gate (including future lane-neutral gates) on every lane.
 */
export function resolveRegionDiagnosticsForLane(
  diagnostics: readonly RegionDiagnosticPresentationInput[],
  meshLane: MeshInspectorLane = "unknown",
): RegionDiagnosticPresentationInput[] {
  if (meshLane === "fem") return [...diagnostics];
  return diagnostics.filter(
    (diagnostic) =>
      diagnostic.capabilityGate === null ||
      !FEM_REGION_CAPABILITY_GATES.has(diagnostic.capabilityGate),
  );
}

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
