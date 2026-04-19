import { describe, expect, it } from "vitest";
import {
  parseNodeIdToTarget,
  objectIdFromTarget,
  assetIdFromTarget,
  isTargetSpatial,
  isTargetTransformable,
  ribbonContextForTarget,
  inspectorPanelForTarget,
  EMPTY_SELECTION,
} from "../model/selection";

describe("parseNodeIdToTarget", () => {
  it("returns workspace for null", () => {
    expect(parseNodeIdToTarget(null)).toEqual({ kind: "workspace" });
  });

  it("parses universe", () => {
    expect(parseNodeIdToTarget("universe")).toEqual({ kind: "universe" });
  });

  it("parses airbox", () => {
    expect(parseNodeIdToTarget("airbox")).toEqual({ kind: "airbox" });
  });

  it("parses object by id", () => {
    expect(parseNodeIdToTarget("obj-abc123")).toEqual({ kind: "object", objectId: "abc123" });
  });

  it("parses object geometry with geom- prefix", () => {
    expect(parseNodeIdToTarget("geom-abc123")).toEqual({ kind: "object_geometry", objectId: "abc123" });
  });

  it("parses object material", () => {
    expect(parseNodeIdToTarget("mat-abc123")).toEqual({ kind: "object_material", objectId: "abc123" });
  });

  it("parses magnetization asset", () => {
    const result = parseNodeIdToTarget("mag-abc123");
    expect(result.kind).toBe("magnetization_asset");
    if (result.kind === "magnetization_asset") {
      expect(result.objectId).toBe("abc123");
    }
  });

  it("parses magnetization transform", () => {
    const result = parseNodeIdToTarget("mag-transform-abc123");
    expect(result.kind).toBe("magnetization_transform");
  });

  it("parses physics stack with prefix", () => {
    const result = parseNodeIdToTarget("physics-obj1");
    expect(result.kind).toBe("physics_stack");
  });

  it("parses magnetic parameters", () => {
    const result = parseNodeIdToTarget("magparam-abc");
    expect(result.kind).toBe("magnetic_parameters");
    if (result.kind === "magnetic_parameters") {
      expect(result.objectId).toBe("abc");
    }
  });

  it("parses mesh domain", () => {
    const result = parseNodeIdToTarget("mesh-abc");
    expect(result.kind).toBe("mesh_domain");
  });

  it("parses study stage", () => {
    const result = parseNodeIdToTarget("stage-relax");
    expect(result.kind).toBe("study_stage");
  });

  it("parses result", () => {
    const result = parseNodeIdToTarget("res-sol1");
    expect(result.kind).toBe("result");
  });

  it("returns workspace for unrecognized id", () => {
    expect(parseNodeIdToTarget("foo-bar")).toEqual({ kind: "workspace" });
  });
});

describe("objectIdFromTarget", () => {
  it("returns objectId from object target", () => {
    expect(objectIdFromTarget({ kind: "object", objectId: "x" })).toBe("x");
  });

  it("returns objectId from geometry target", () => {
    expect(objectIdFromTarget({ kind: "object_geometry", objectId: "y" })).toBe("y");
  });

  it("returns objectId from material target", () => {
    expect(objectIdFromTarget({ kind: "object_material", objectId: "z" })).toBe("z");
  });

  it("returns null for non-object target", () => {
    expect(objectIdFromTarget({ kind: "workspace" })).toBeNull();
  });
});

describe("assetIdFromTarget", () => {
  it("returns assetId from magnetization_asset", () => {
    expect(assetIdFromTarget({ kind: "magnetization_asset", objectId: "x", assetId: "a" })).toBe("a");
  });

  it("returns null for non-asset target", () => {
    expect(assetIdFromTarget({ kind: "object", objectId: "x" })).toBeNull();
  });
});

describe("isTargetSpatial", () => {
  it("object is spatial", () => {
    expect(isTargetSpatial({ kind: "object", objectId: "x" })).toBe(true);
  });

  it("universe is spatial", () => {
    expect(isTargetSpatial({ kind: "universe" })).toBe(true);
  });

  it("airbox is spatial", () => {
    expect(isTargetSpatial({ kind: "airbox" })).toBe(true);
  });

  it("physics_stack is not spatial", () => {
    expect(isTargetSpatial({ kind: "physics_stack", objectId: "x" })).toBe(false);
  });

  it("study_stage is not spatial", () => {
    expect(isTargetSpatial({ kind: "study_stage", nodeId: "stage-s" })).toBe(false);
  });

  it("workspace is not spatial", () => {
    expect(isTargetSpatial({ kind: "workspace" })).toBe(false);
  });
});

describe("isTargetTransformable", () => {
  it("object is transformable", () => {
    expect(isTargetTransformable({ kind: "object", objectId: "x" })).toBe(true);
  });

  it("object_geometry is transformable", () => {
    expect(isTargetTransformable({ kind: "object_geometry", objectId: "x" })).toBe(true);
  });

  it("universe is not transformable", () => {
    expect(isTargetTransformable({ kind: "universe" })).toBe(false);
  });
});

describe("ribbonContextForTarget", () => {
  it("returns coreTab for workspace", () => {
    const ctx = ribbonContextForTarget({ kind: "workspace" });
    expect(ctx.coreTab).toBeDefined();
  });

  it("returns geometry coreTab for object", () => {
    const ctx = ribbonContextForTarget({ kind: "object", objectId: "x" });
    expect(ctx.coreTab).toBe("geometry");
    expect(ctx.contextualTab).toBe("object");
  });
});

describe("inspectorPanelForTarget", () => {
  it("returns workspace-overview for workspace", () => {
    expect(inspectorPanelForTarget({ kind: "workspace" })).toBe("workspace-overview");
  });

  it("returns object-overview for object", () => {
    expect(inspectorPanelForTarget({ kind: "object", objectId: "x" })).toBe("object-overview");
  });

  it("returns material-assignment for object_material", () => {
    expect(inspectorPanelForTarget({ kind: "object_material", objectId: "x" })).toBe("material-assignment");
  });

  it("returns magnetization-authoring for magnetization_asset", () => {
    expect(inspectorPanelForTarget({ kind: "magnetization_asset", objectId: "x", assetId: "a" })).toBe("magnetization-authoring");
  });
});

describe("EMPTY_SELECTION", () => {
  it("has workspace target", () => {
    expect(EMPTY_SELECTION.target).toEqual({ kind: "workspace" });
  });

  it("has zero revision", () => {
    expect(EMPTY_SELECTION.revision).toBe(0);
  });
});
