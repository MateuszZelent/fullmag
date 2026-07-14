import { describe, expect, it } from "vitest";

import {
  PBC_INSPECTOR_CONTEXT_IDS,
  resolvePbcInspectorContext,
} from "../inspectorRegistry";

describe("pbcInspectorModel", () => {
  it.each([
    ["physics.pbc", "authoring"],
    ["resources.mesh.periodic_pairs", "mesh-certificate"],
    ["study.stage.relax", "static"],
    ["study.stage.run", "time-domain"],
    ["study.stage.eigenmodes.periodic_pairs", "eigenmodes"],
    ["study.stage.frequency_response.periodic_pairs", "frequency-response"],
  ] as const)("resolves %s to the dedicated %s context", (kind, context) => {
    const model = resolvePbcInspectorContext(kind);
    expect(model?.context).toBe(context);
    expect(model?.contextId).toBe(PBC_INSPECTOR_CONTEXT_IDS[context]);
  });

  it("keeps the periodic mesh resource as the single status owner", () => {
    const models = [
      resolvePbcInspectorContext("physics.pbc"),
      resolvePbcInspectorContext("resources.mesh.periodic_pairs"),
      resolvePbcInspectorContext("study.stage.relax"),
      resolvePbcInspectorContext("study.stage.run"),
      resolvePbcInspectorContext("results.eigen.root"),
      resolvePbcInspectorContext("results.frequency_response.root"),
    ];
    expect(new Set(models.map((model) => model?.resourceOwner))).toEqual(
      new Set(["meshing.mesh.periodic_pairs"]),
    );
  });

  it("does not classify unrelated selections as PBC", () => {
    expect(resolvePbcInspectorContext("object.geometry")).toBeNull();
    expect(resolvePbcInspectorContext(null)).toBeNull();
  });
});
