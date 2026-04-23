import { describe, expect, it } from "vitest";

import { resolveNodeHandle } from "../nodeHandleResolver";

describe("nodeHandleResolver", () => {
  it("resolves runtime root node", () => {
    const handle = resolveNodeHandle("runtime");
    expect(handle.nodeKind).toBe("session.runtime");
    expect(handle.sourceOfTruth).toBe("scene_document");
  });

  it("resolves new dynamic physics nodes", () => {
    expect(resolveNodeHandle("physics-solver").nodeKind).toBe("physics.solver");
    expect(resolveNodeHandle("physics-module-demag-method").nodeKind).toBe("physics.demag.method");
    expect(resolveNodeHandle("physics-module-demag-boundary").nodeKind).toBe("physics.boundary_conditions");

    const genericModule = resolveNodeHandle("physics-module-spin_transfer_torque");
    expect(genericModule.nodeKind).toBe("physics.interaction");
    expect(genericModule.entityId).toBe("spin_transfer_torque");
  });

  it("keeps legacy aliases compatible", () => {
    expect(resolveNodeHandle("phys-bc").nodeKind).toBe("physics.boundary_conditions");
    expect(resolveNodeHandle("phys-demag-open-bc").nodeKind).toBe("physics.boundary_conditions");
    expect(resolveNodeHandle("phys-spin-torque").nodeKind).toBe("physics.spin_torque");
    expect(resolveNodeHandle("study-defaults-runtime").nodeKind).toBe("study.pipeline.root");
  });

  it("resolves pipeline study stage nodes used by current tree ids", () => {
    const base = resolveNodeHandle("study-stage-node:relax-1");
    expect(base.nodeKind).toBe("study.stage.run");
    expect(base.domain).toBe("study");
    expect(base.entityId).toBe("relax-1");

    const detail = resolveNodeHandle("study-stage-node:relax-1/solver");
    expect(detail.nodeKind).toBe("study.stage.detail.solver");
    expect(detail.parentId).toBe("study-stage-node:relax-1");
    expect(detail.entityId).toBe("solver");
  });

  it("resolves flat study stage nodes used by compatibility ids", () => {
    const base = resolveNodeHandle("study-stage-flat:3");
    expect(base.nodeKind).toBe("study.stage.run");
    expect(base.domain).toBe("study");
    expect(base.entityId).toBe("3");

    const detail = resolveNodeHandle("study-stage-flat:3/overview");
    expect(detail.nodeKind).toBe("study.stage.detail.overview");
    expect(detail.parentId).toBe("study-stage-flat:3");
    expect(detail.entityId).toBe("overview");
  });
});
