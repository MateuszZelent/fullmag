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
    code: "region_material_realization_pending",
    diagnosticId: "material",
    message: "Material realization is pending.",
    realizationStatus: "blocked",
    severity: "error",
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

  it("renders backend errors as error feedback", () => {
    expect(
      resolveRegionInlineDiagnostics(diagnostics, [
        "regions.material_override",
      ]),
    ).toEqual([
      {
        capabilityLabel: "Regional material realization",
        diagnosticId: "material",
        kind: "error",
        message:
          "Regional material realization: Material realization is pending.",
      },
    ]);
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
