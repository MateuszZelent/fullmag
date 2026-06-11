import { describe, expect, it } from "vitest";

import {
  resolveRegionInlineDiagnostics,
  type RegionDiagnosticPresentationInput,
} from "./regionDiagnosticPresentation";

const diagnostics: RegionDiagnosticPresentationInput[] = [
  {
    capabilityGate: "regions.mesh_policy",
    code: "region_mesh_policy_requires_rebuild",
    diagnosticId: "mesh",
    message: "Mesh policy requires a compatible rebuild.",
    realizationStatus: "authored_pending_realization",
    severity: "warning",
  },
  {
    capabilityGate: "regions.material_override",
    code: "region_material_realization_required",
    diagnosticId: "material",
    message: "Material realization is required during execution planning.",
    realizationStatus: "blocked",
    severity: "info",
  },
  {
    capabilityGate: "regions.realized_materialization",
    code: "region_world_frame_materialization_unsupported",
    diagnosticId: "world-frame",
    message: "World-frame authored regions require explicit materialization.",
    realizationStatus: "authored_pending_realization",
    severity: "warning",
  },
];

describe("regionDiagnosticPresentation", () => {
  it("filters inline diagnostics to the requested capability gate", () => {
    expect(
      resolveRegionInlineDiagnostics(diagnostics, ["regions.mesh_policy"]),
    ).toEqual([
      {
        capabilityLabel: "Mesh policy support",
        diagnosticId: "mesh",
        kind: "warning",
        message:
          "Mesh policy support: Mesh policy requires a compatible rebuild.",
      },
    ]);
  });

  it("does not render informational capability notes as inline warnings", () => {
    expect(
      resolveRegionInlineDiagnostics(diagnostics, [
        "regions.material_override",
      ]),
    ).toEqual([]);
  });

  it("labels realized materialization blockers for region identity", () => {
    expect(
      resolveRegionInlineDiagnostics(diagnostics, [
        "regions.realized_materialization",
      ]),
    ).toEqual([
      {
        capabilityLabel: "Region materialization support",
        diagnosticId: "world-frame",
        kind: "warning",
        message:
          "Region materialization support: World-frame authored regions require explicit materialization.",
      },
    ]);
  });
});
