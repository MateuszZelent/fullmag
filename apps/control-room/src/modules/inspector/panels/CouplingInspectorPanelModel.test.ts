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
  it("resolves selected authored coupling details", () => {
    const resource: CouplingListResource = {
      couplings: [
        {
          coupling_id: "exchange:core-shell",
          coupling_kind: "exchange",
          enabled: true,
          params: { kind: "exchange", mode: "harmonic_mean", scale: 0.5 } as never,
          realization_status: "authored_pending_realization",
          source: { kind: "region", object: "film", region_id: "film:r1" } as never,
          target: { kind: "surface", object: "film", selector: "top" } as never,
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
      source: { label: "film/film:r1", regionId: "film:r1" },
      target: { label: "film/top", selector: "top" },
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
