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
});
