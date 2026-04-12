import { describe, it, expect } from "vitest";
import { parseOptionalFiniteNumberText, normalizeVisualizationPresetRef } from "../components/runs/control-room/controlRoomUtils";
import { commandKindLabel, sameDisplaySelection } from "../components/runs/control-room/helpers";
import {
  deriveMeshWorkspacePreset,
  deriveMeshBuildRuntimeState,
  isMeshNodeId,
  estimateDenseSolverRamGb,
  deriveMeshBuildProgressValue,
} from "../components/runs/control-room/meshWorkspace";
import {
  materializationProgressFromMessage,
  parseStageExecutionMessage,
  resolveStudyStageExecutionState,
  asVec3,
  combineBounds,
} from "../components/runs/control-room/shared";

/* ═══════════════════════════════════════════════════════════════
 * controlRoomUtils
 * ═══════════════════════════════════════════════════════════════ */

describe("parseOptionalFiniteNumberText", () => {
  it("parses a valid integer", () => {
    expect(parseOptionalFiniteNumberText("42")).toBe(42);
  });
  it("parses a valid float", () => {
    expect(parseOptionalFiniteNumberText("3.14")).toBe(3.14);
  });
  it("trims whitespace", () => {
    expect(parseOptionalFiniteNumberText("  7  ")).toBe(7);
  });
  it("returns null for empty string", () => {
    expect(parseOptionalFiniteNumberText("")).toBeNull();
  });
  it("returns null for whitespace-only", () => {
    expect(parseOptionalFiniteNumberText("   ")).toBeNull();
  });
  it("returns null for non-numeric text", () => {
    expect(parseOptionalFiniteNumberText("abc")).toBeNull();
  });
  it("returns null for Infinity", () => {
    expect(parseOptionalFiniteNumberText("Infinity")).toBeNull();
  });
  it("returns null for NaN", () => {
    expect(parseOptionalFiniteNumberText("NaN")).toBeNull();
  });
  it("handles negative numbers", () => {
    expect(parseOptionalFiniteNumberText("-99.5")).toBe(-99.5);
  });
  it("handles scientific notation", () => {
    expect(parseOptionalFiniteNumberText("1e-9")).toBe(1e-9);
  });
});

describe("normalizeVisualizationPresetRef", () => {
  it("returns null for null input", () => {
    expect(normalizeVisualizationPresetRef(null)).toBeNull();
  });
  it("returns null for undefined input", () => {
    expect(normalizeVisualizationPresetRef(undefined)).toBeNull();
  });
  it("returns null if preset_id is empty", () => {
    expect(normalizeVisualizationPresetRef({ source: "local", preset_id: "" })).toBeNull();
  });
  it("returns null for invalid source", () => {
    expect(
      normalizeVisualizationPresetRef({ source: "invalid" as any, preset_id: "abc" }),
    ).toBeNull();
  });
  it("normalizes a valid local ref", () => {
    expect(
      normalizeVisualizationPresetRef({ source: "local", preset_id: "preset-1" }),
    ).toEqual({ source: "local", preset_id: "preset-1" });
  });
  it("normalizes a valid project ref", () => {
    expect(
      normalizeVisualizationPresetRef({ source: "project", preset_id: "p2" }),
    ).toEqual({ source: "project", preset_id: "p2" });
  });
  it("strips extra properties", () => {
    const input = { source: "local" as const, preset_id: "x", extra: true } as any;
    const result = normalizeVisualizationPresetRef(input);
    expect(result).toEqual({ source: "local", preset_id: "x" });
    expect(result).not.toHaveProperty("extra");
  });
});

/* ═══════════════════════════════════════════════════════════════
 * helpers
 * ═══════════════════════════════════════════════════════════════ */

describe("commandKindLabel", () => {
  it("maps known kinds", () => {
    expect(commandKindLabel("run")).toBe("Run");
    expect(commandKindLabel("relax")).toBe("Relax");
    expect(commandKindLabel("pause")).toBe("Pause");
    expect(commandKindLabel("resume")).toBe("Resume");
    expect(commandKindLabel("stop")).toBe("Stop");
    expect(commandKindLabel("break")).toBe("Stop");
    expect(commandKindLabel("solve")).toBe("Compute");
    expect(commandKindLabel("remesh")).toBe("Remesh");
    expect(commandKindLabel("save_vtk")).toBe("Export VTK");
    expect(commandKindLabel("display_selection_update")).toBe("Display selection");
    expect(commandKindLabel("preview_update")).toBe("Display update");
    expect(commandKindLabel("preview_refresh")).toBe("Preview refresh");
  });
  it("returns 'Command' for null/undefined/empty", () => {
    expect(commandKindLabel(null)).toBe("Command");
    expect(commandKindLabel(undefined)).toBe("Command");
    expect(commandKindLabel("")).toBe("Command");
    expect(commandKindLabel("   ")).toBe("Command");
  });
  it("returns the kind string for unknown kinds", () => {
    expect(commandKindLabel("custom_thing")).toBe("custom_thing");
  });
});

describe("sameDisplaySelection", () => {
  const base = {
    quantity: "m",
    kind: "field" as const,
    component: "x",
    layer: 0,
    all_layers: false,
    x_chosen_size: 64,
    y_chosen_size: 64,
    every_n: 1,
    max_points: 10000,
    auto_scale_enabled: true,
  };

  it("returns true for identical selections", () => {
    expect(sameDisplaySelection(base, { ...base })).toBe(true);
  });
  it("returns false when a field differs", () => {
    expect(sameDisplaySelection(base, { ...base, quantity: "h" })).toBe(false);
    expect(sameDisplaySelection(base, { ...base, every_n: 2 })).toBe(false);
  });
  it("returns false for null left", () => {
    expect(sameDisplaySelection(null, base)).toBe(false);
  });
  it("returns false for null right", () => {
    expect(sameDisplaySelection(base, null)).toBe(false);
  });
  it("returns false for both null", () => {
    expect(sameDisplaySelection(null, null)).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════
 * meshWorkspace
 * ═══════════════════════════════════════════════════════════════ */

describe("deriveMeshWorkspacePreset", () => {
  it("returns 'slice' for 2D viewMode", () => {
    expect(
      deriveMeshWorkspacePreset({ viewMode: "2D", femDockTab: "mesh", meshRenderMode: "surface" }),
    ).toBe("slice");
  });
  it("returns 'quality' when femDockTab=quality", () => {
    expect(
      deriveMeshWorkspacePreset({ viewMode: "Mesh", femDockTab: "quality", meshRenderMode: "surface" }),
    ).toBe("quality");
  });
  it("returns 'optimize' when femDockTab=mesher", () => {
    expect(
      deriveMeshWorkspacePreset({ viewMode: "Mesh", femDockTab: "mesher", meshRenderMode: "surface" }),
    ).toBe("optimize");
  });
  it("returns 'optimize' when femDockTab=pipeline", () => {
    expect(
      deriveMeshWorkspacePreset({ viewMode: "Mesh", femDockTab: "pipeline", meshRenderMode: "surface" }),
    ).toBe("optimize");
  });
  it("returns 'inspect-surface' for surface render mode", () => {
    expect(
      deriveMeshWorkspacePreset({ viewMode: "Mesh", femDockTab: "mesh", meshRenderMode: "surface" }),
    ).toBe("inspect-surface");
  });
  it("returns 'inspect-volume' for wireframe render mode", () => {
    expect(
      deriveMeshWorkspacePreset({ viewMode: "Mesh", femDockTab: "mesh", meshRenderMode: "wireframe" }),
    ).toBe("inspect-volume");
  });
});

describe("isMeshNodeId", () => {
  it("returns false for null/undefined/empty", () => {
    expect(isMeshNodeId(null)).toBe(false);
    expect(isMeshNodeId(undefined)).toBe(false);
    expect(isMeshNodeId("")).toBe(false);
  });
  it("recognizes universe-mesh IDs", () => {
    expect(isMeshNodeId("universe-mesh")).toBe(true);
    expect(isMeshNodeId("universe-mesh-quality")).toBe(true);
    expect(isMeshNodeId("universe-mesh-size")).toBe(true);
  });
  it("recognizes universe-airbox IDs", () => {
    expect(isMeshNodeId("universe-airbox")).toBe(true);
    expect(isMeshNodeId("universe-airbox-robin")).toBe(true);
  });
  it("recognizes mesh- prefixed IDs", () => {
    expect(isMeshNodeId("mesh")).toBe(true);
    expect(isMeshNodeId("mesh-part-1")).toBe(true);
  });
  it("recognizes geo-*-mesh IDs", () => {
    expect(isMeshNodeId("geo-disk-mesh")).toBe(true);
    expect(isMeshNodeId("geo-layer-mesh")).toBe(true);
  });
  it("rejects non-mesh IDs", () => {
    expect(isMeshNodeId("geo-disk")).toBe(false);
    expect(isMeshNodeId("solver-settings")).toBe(false);
    expect(isMeshNodeId("res-analysis-1")).toBe(false);
  });
});

describe("estimateDenseSolverRamGb", () => {
  it("computes N²×24/1e9", () => {
    expect(estimateDenseSolverRamGb(1000)).toBeCloseTo(0.024);
    expect(estimateDenseSolverRamGb(10000)).toBeCloseTo(2.4);
    expect(estimateDenseSolverRamGb(0)).toBe(0);
  });
});

describe("deriveMeshBuildRuntimeState", () => {
  it("treats active_build as the canonical running signal", () => {
    expect(
      deriveMeshBuildRuntimeState({
        meshWorkspace: {
          mesh_summary: null,
          mesh_quality_summary: null,
          mesh_pipeline_status: [],
          mesh_capabilities: null,
          mesh_adaptivity_state: null,
          mesh_history: [],
          active_build: { mode: "selected", target: { kind: "study_domain" } },
          effective_airbox_target: null,
          effective_per_object_targets: null,
          last_build_summary: null,
          last_build_error: null,
        },
        commandStatus: null,
        meshGenerating: false,
        scriptSyncBusy: false,
      }).status,
    ).toBe("running");
  });

  it("treats remesh completion plus build summary as success", () => {
    expect(
      deriveMeshBuildRuntimeState({
        meshWorkspace: {
          mesh_summary: null,
          mesh_quality_summary: null,
          mesh_pipeline_status: [],
          mesh_capabilities: null,
          mesh_adaptivity_state: null,
          mesh_history: [],
          active_build: null,
          effective_airbox_target: null,
          effective_per_object_targets: null,
          last_build_summary: { kind: "mesh_build_summary" },
          last_build_error: null,
        },
        commandStatus: {
          command_kind: "remesh",
          state: "completed",
          completion_state: "ok",
          reason: null,
        },
        meshGenerating: false,
        scriptSyncBusy: false,
      }).status,
    ).toBe("success");
  });

  it("surfaces rejection and backend error as failure", () => {
    const runtime = deriveMeshBuildRuntimeState({
      meshWorkspace: {
        mesh_summary: null,
        mesh_quality_summary: null,
        mesh_pipeline_status: [],
        mesh_capabilities: null,
        mesh_adaptivity_state: null,
        mesh_history: [],
        active_build: null,
        effective_airbox_target: null,
        effective_per_object_targets: null,
        last_build_summary: null,
        last_build_error: "mesh failed",
      },
      commandStatus: {
        command_kind: "remesh",
        state: "rejected",
        completion_state: null,
        reason: "backend rejected",
      },
      meshGenerating: true,
      scriptSyncBusy: false,
    });
    expect(runtime.status).toBe("failure");
    expect(runtime.errorMessage).toBe("backend rejected");
  });
});

describe("deriveMeshBuildProgressValue", () => {
  it("uses fallbackValue when provided", () => {
    expect(deriveMeshBuildProgressValue([], 50)).toBe(50);
  });
  it("clamps fallbackValue to 0-100", () => {
    expect(deriveMeshBuildProgressValue([], -10)).toBe(0);
    expect(deriveMeshBuildProgressValue([], 200)).toBe(100);
  });
  it("computes from stages when no fallback", () => {
    const stages = [
      { id: "queued" as const, label: "", status: "done" as const, detail: null },
      { id: "materializing" as const, label: "", status: "done" as const, detail: null },
      { id: "preparing_domain" as const, label: "", status: "active" as const, detail: null },
    ];
    expect(deriveMeshBuildProgressValue(stages, undefined)).toBe(45);
  });
  it("returns 0 for all-idle stages", () => {
    const stages = [
      { id: "queued" as const, label: "", status: "idle" as const, detail: null },
    ];
    expect(deriveMeshBuildProgressValue(stages, undefined)).toBe(0);
  });
  it("returns 100 for ready stage", () => {
    const stages = [
      { id: "ready" as const, label: "", status: "done" as const, detail: null },
    ];
    expect(deriveMeshBuildProgressValue(stages, undefined)).toBe(100);
  });
});

describe("resolveStudyStageExecutionState", () => {
  it("prefers typed stage execution contract over activity parsing", () => {
    expect(
      resolveStudyStageExecutionState({
        stageExecution: {
          total_stages: 3,
          completed_stage_indexes: [0],
          active_stage_index: 1,
          active_stage_kind: "relax",
          runtime_state: "running",
        },
        totalStages: 3,
        workspaceStatus: "running",
        activityLabel: "executing stage 3/3 (wrong)",
      }),
    ).toMatchObject({
      declaredTotal: 3,
      activeStageIndex: 1,
      completedStageIndexes: [0],
      activeStageKind: "relax",
      source: "contract",
    });
  });

  it("falls back to activity parsing when typed metadata is missing", () => {
    expect(
      resolveStudyStageExecutionState({
        stageExecution: null,
        totalStages: 2,
        workspaceStatus: "running",
        activityLabel: "executing stage 1/2 (relax)",
      }),
    ).toMatchObject({
      declaredTotal: 2,
      activeStageIndex: 0,
      completedStageIndexes: [],
      activeStageKind: "relax",
      source: "fallback",
    });
  });

  it("marks all stages completed when backend contract reports no active stage", () => {
    expect(
      resolveStudyStageExecutionState({
        stageExecution: {
          total_stages: 2,
          completed_stage_indexes: [0, 1],
          active_stage_index: null,
          active_stage_kind: null,
          runtime_state: "awaiting_command",
        },
        totalStages: 2,
        workspaceStatus: "awaiting_command",
        activityLabel: null,
      }).completedStageIndexes,
    ).toEqual([0, 1]);
  });
});

/* ═══════════════════════════════════════════════════════════════
 * shared
 * ═══════════════════════════════════════════════════════════════ */

describe("materializationProgressFromMessage", () => {
  it("returns 6 for null", () => {
    expect(materializationProgressFromMessage(null)).toBe(6);
  });
  it("returns 12 for unknown message", () => {
    expect(materializationProgressFromMessage("something random")).toBe(12);
  });
  it("detects gmsh percentage for curves", () => {
    const value = materializationProgressFromMessage("Meshing curve [50%]");
    expect(value).toBeCloseTo(49);
  });
  it("detects gmsh percentage for surfaces", () => {
    const value = materializationProgressFromMessage("Meshing surface [80%]");
    expect(value).toBeCloseTo(64.6);
  });
  it("detects gmsh percentage for volumes", () => {
    const value = materializationProgressFromMessage("Meshing volume [100%]");
    expect(value).toBeCloseTo(90);
  });
  it("detects keyword milestones", () => {
    expect(materializationProgressFromMessage("Loading python script")).toBe(14);
    expect(materializationProgressFromMessage("Building ProblemIR")).toBe(22);
    expect(materializationProgressFromMessage("Preparing FEM mesh asset")).toBe(32);
    expect(materializationProgressFromMessage("Script materialized")).toBe(100);
  });
});

describe("parseStageExecutionMessage", () => {
  it("returns null for null", () => {
    expect(parseStageExecutionMessage(null)).toBeNull();
  });
  it("returns null for non-matching message", () => {
    expect(parseStageExecutionMessage("running step 3")).toBeNull();
  });
  it("parses valid stage message", () => {
    expect(parseStageExecutionMessage("Executing stage 2/5 (relax)")).toEqual({
      current: 2,
      total: 5,
      kind: "relax",
    });
  });
  it("handles single-digit stages", () => {
    expect(parseStageExecutionMessage("executing stage 1/1 (compute)")).toEqual({
      current: 1,
      total: 1,
      kind: "compute",
    });
  });
});

describe("asVec3", () => {
  it("returns [x,y,z] for valid 3-element arrays", () => {
    expect(asVec3([1, 2, 3])).toEqual([1, 2, 3]);
  });
  it("returns null for wrong length", () => {
    expect(asVec3([1, 2])).toBeNull();
    expect(asVec3([1, 2, 3, 4])).toBeNull();
  });
  it("returns null for non-numeric elements", () => {
    expect(asVec3([1, "2", 3])).toBeNull();
  });
  it("returns null for non-arrays", () => {
    expect(asVec3("1,2,3")).toBeNull();
    expect(asVec3(null)).toBeNull();
    expect(asVec3(undefined)).toBeNull();
    expect(asVec3(42)).toBeNull();
  });
  it("accepts zero values", () => {
    expect(asVec3([0, 0, 0])).toEqual([0, 0, 0]);
  });
});

describe("combineBounds", () => {
  it("returns null for empty array", () => {
    expect(combineBounds([])).toBeNull();
  });
  it("returns single entry bounds", () => {
    const result = combineBounds([
      { boundsMin: [0, 0, 0], boundsMax: [1, 1, 1] },
    ]);
    expect(result).toEqual({ boundsMin: [0, 0, 0], boundsMax: [1, 1, 1] });
  });
  it("returns union of two boxes", () => {
    const result = combineBounds([
      { boundsMin: [0, 0, 0], boundsMax: [1, 1, 1] },
      { boundsMin: [2, 2, 2], boundsMax: [3, 3, 3] },
    ]);
    expect(result).toEqual({ boundsMin: [0, 0, 0], boundsMax: [3, 3, 3] });
  });
  it("handles overlapping boxes", () => {
    const result = combineBounds([
      { boundsMin: [0, 0, 0], boundsMax: [2, 2, 2] },
      { boundsMin: [1, 1, 1], boundsMax: [3, 3, 3] },
    ]);
    expect(result).toEqual({ boundsMin: [0, 0, 0], boundsMax: [3, 3, 3] });
  });
  it("handles negative coordinates", () => {
    const result = combineBounds([
      { boundsMin: [-5, -5, -5], boundsMax: [-1, -1, -1] },
      { boundsMin: [1, 1, 1], boundsMax: [5, 5, 5] },
    ]);
    expect(result).toEqual({ boundsMin: [-5, -5, -5], boundsMax: [5, 5, 5] });
  });
});
