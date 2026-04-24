import { describe, expect, it } from "vitest";

import {
  isGeometryAuthoringWorkspace,
  resetSceneEditorToCameraFirst,
  shouldForceCameraFirstViewport,
} from "../workspaceViewportGuards";
import { buildSceneDocumentFromScriptBuilder } from "../../../../lib/session/sceneDocument";
import type { ScriptBuilderState } from "../../../../lib/session/types";

function makeSceneDocument() {
  const builder: ScriptBuilderState = {
    revision: 1,
    geometries: [],
    current_modules: [],
    excitation_analysis: [],
    universe: {
      size: [1e-6, 1e-6, 1e-6],
      origin: [0, 0, 0],
      mesh: {
        max_edge: 20e-9,
        min_edge: 4e-9,
        grading: 1.3,
        airgap: 0,
      },
    },
    mesh: {
      max_edge: 20e-9,
      min_edge: 4e-9,
      grading: 1.3,
      airgap: 0,
    },
    backend: "local",
    cpu_threads: 1,
    fem_demag_solver_policy: "auto",
    demag_realization: "thresholded_charge_sheet",
    external_field: [0, 0, 0],
    solver: {
      solver_mode: "relax",
      alpha: 0.5,
      gamma: 2.211e5,
      dt: 1e-12,
      max_steps: 1000,
      tolerance: 1e-6,
      relax_torque_threshold: 1e-6,
      relax_energy_threshold: 1e-9,
    },
    stages: [],
    study_pipeline: null,
    initial_state: null,
  };
  return buildSceneDocumentFromScriptBuilder(builder);
}

describe("workspaceViewportGuards", () => {
  it("treats only build + Geometry as geometry authoring", () => {
    expect(isGeometryAuthoringWorkspace("build", "Geometry")).toBe(true);
    expect(isGeometryAuthoringWorkspace("study", "Geometry")).toBe(false);
    expect(isGeometryAuthoringWorkspace("build", "Study")).toBe(false);
  });

  it("forces camera-first for the normal workspace 3D viewport", () => {
    expect(
      shouldForceCameraFirstViewport({
        workspaceMode: "study",
        activeCoreTab: "Study",
        effectiveViewMode: "3D",
      }),
    ).toBe(true);
  });

  it("does not force camera-first for explicit Geometry authoring", () => {
    expect(
      shouldForceCameraFirstViewport({
        workspaceMode: "build",
        activeCoreTab: "Geometry",
        effectiveViewMode: "3D",
      }),
    ).toBe(false);
  });

  it("does not force camera-first outside the 3D viewport", () => {
    expect(
      shouldForceCameraFirstViewport({
        workspaceMode: "study",
        activeCoreTab: "Study",
        effectiveViewMode: "Mesh",
      }),
    ).toBe(false);
  });

  it("clears persisted transform scope and gizmo mode", () => {
    const scene = makeSceneDocument();
    scene.editor.active_transform_scope = "object";
    scene.editor.gizmo_mode = "rotate";

    const next = resetSceneEditorToCameraFirst(scene);

    expect(next).not.toBe(scene);
    expect(next?.editor.active_transform_scope).toBeNull();
    expect(next?.editor.gizmo_mode).toBeNull();
  });

  it("keeps scene object identity when already camera-first", () => {
    const scene = makeSceneDocument();

    const next = resetSceneEditorToCameraFirst(scene);

    expect(next).toBe(scene);
  });
});
