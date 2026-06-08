import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { CouplingListResource } from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";

import { resolveCouplingInspectorModel } from "./CouplingInspectorPanelModel";

function couplingSelection(couplingId: string): Selection {
  return {
    kind: "physics.coupling",
    label: "Coupling",
    moduleSource: "explorer",
    nodeId: `model:physics:couplings:${couplingId}`,
    objectId: null,
    ref: {
      couplingId,
      kind: "physics.coupling",
      nodeId: `model:physics:couplings:${couplingId}`,
      type: "physics-coupling",
    },
  };
}

describe("CouplingInspectorPanelModel", () => {
  it("keeps coupling repair actions wired to existing model transactions", () => {
    const source = readFileSync(
      new URL("./CouplingInspectorPanel.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("api.model.patchCoupling(");
    expect(source).toContain("api.model.deleteCoupling(");
    expect(source).toContain('model.enabled ? "Disable Coupling" : "Enable Coupling"');
    expect(source).toContain("MODEL_COUPLINGS_RESOURCE_KEY");
    expect(source).toContain("publishCommittedSceneResource(");
  });

  it("resolves selected authored coupling details", () => {
    const resource: CouplingListResource = {
      couplings: [
        {
          coupling_id: "exchange:core-shell",
          coupling_kind: "exchange",
          enabled: true,
          params: { kind: "exchange", mode: "harmonic_mean", scale: 0.5 } as never,
          realization_status: "authored_pending_realization",
          blocker_reason: "Surface exchange runtime operator is unavailable.",
          source: { kind: "region", object: "film", region_id: "film:r1" } as never,
          source_resolution: {
            status: "authored_endpoint_valid",
            object_id: "film",
            region_id: "film:r1",
          },
          target: { kind: "surface", object: "film", selector: "top" } as never,
          target_resolution: {
            status: "resolved",
            object_id: "film",
            selector: "top",
            tolerance: 1e-12,
            resolved_face_count: 12,
            area: 4e-14,
          },
        },
      ],
      scene_revision: 7,
    };

    expect(
      resolveCouplingInspectorModel(
        couplingSelection("exchange:core-shell"),
        resource,
      ),
    ).toMatchObject({
      couplingId: "exchange:core-shell",
      kind: "exchange",
      mode: "found",
      parameters: { mode: "harmonic_mean", scale: 0.5 },
      blockerReason: "Surface exchange runtime operator is unavailable.",
      source: {
        label: "film/film:r1",
        regionId: "film:r1",
        resolutionStatus: "authored_endpoint_valid",
      },
      target: {
        label: "film/top",
        selector: "top",
        resolutionStatus: "resolved",
        resolvedFaceCount: 12,
        area: 4e-14,
      },
    });
  });

  it("reports missing and unselected states explicitly", () => {
    expect(
      resolveCouplingInspectorModel(couplingSelection("missing"), {
        couplings: [],
        scene_revision: 1,
      }),
    ).toMatchObject({ couplingId: "missing", mode: "missing" });

    expect(
      resolveCouplingInspectorModel(
        {
          kind: null,
          label: null,
          moduleSource: null,
          nodeId: null,
          objectId: null,
          ref: null,
        },
        null,
      ),
    ).toMatchObject({ couplingId: null, mode: "unselected" });
  });
});
