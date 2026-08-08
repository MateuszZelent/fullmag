import { describe, expect, it } from "vitest";

import {
  buildPhysicsInspectorOverviewModel,
  physicsInspectorMetrics,
  physicsInspectorScopeLabel,
  physicsInspectorStatusLabel,
} from "./PhysicsInspectorOverviewModel";

describe("PhysicsInspectorOverviewModel", () => {
  it("normalizes stable scope, dependency and execution provenance", () => {
    const model = buildPhysicsInspectorOverviewModel({
      dependency: {
        requiredSourceIds: ["current:mtj"],
        reason: "Current source has not been resolved.",
        status: "blocked",
      },
      execution: {
        capability: "fem.cpu.steady_transport",
        graphRevision: 12,
        requestedLane: "fem",
        resolvedLane: "fem.cpu",
        sceneRevision: 9,
      },
      family: "spin_torque",
      scope: {
        kind: "region",
        objectId: "free-layer",
        regionId: "magnetic",
        stableRef: "region:free-layer:magnetic",
      },
      source: { id: "torque:stt", kind: "spin_torque", path: "scene.spin_torques[0]" },
      status: "blocked",
      statusReason: "No current transport module is present.",
      values: [{ label: "Current density", unit: "A/m²", value: 1.2e11 }],
    });

    expect(model.scope).toMatchObject({
      kind: "region",
      label: "Region",
      stableRef: "region:free-layer:magnetic",
    });
    expect(model.source.path).toBe("scene.spin_torques[0]");
    expect(model.execution.resolvedLane).toBe("fem.cpu");
    expect(physicsInspectorMetrics(model)).toEqual([
      { label: "Scope", value: "Region" },
      { label: "Source", value: "torque:stt" },
      { label: "Lane", tone: "success", value: "fem.cpu" },
      { label: "Status", tone: "warning", value: "Blocked" },
    ]);
  });

  it("uses explicit labels for all supported scope and diagnostic states", () => {
    expect(physicsInspectorScopeLabel("global")).toBe("Global");
    expect(physicsInspectorScopeLabel("cross_object")).toBe("Cross-object");
    expect(physicsInspectorStatusLabel("unresolved")).toBe("Unresolved");
    expect(physicsInspectorStatusLabel("inactive")).toBe("Inactive");
  });
});
