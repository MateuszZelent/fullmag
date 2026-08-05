import { describe, expect, it, vi } from "vitest";

import {
  ANALYSIS_HYSTERESIS_BOOKMARKS_PATH,
  DATA_FIELDS_PATH,
  DATA_FIELD_VECTOR_PATH,
  DATA_SCALARS_PATH,
  DIAGNOSTICS_ENGINE_LOG_PATH,
  DIAGNOSTICS_SOLVER_PROFILE_PATH,
  MESHING_BUILDS_CURRENT_PATH,
  MESHING_SHARED_DOMAIN_MANIFEST_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
  MODEL_SCENE_PATH,
  MODEL_STUDY_PATH,
  MODEL_REGION_DIAGNOSTICS_PATH,
  PERSISTENCE_CHECKPOINTS_PATH,
  PERSISTENCE_EXPORTS_PATH,
  PERSISTENCE_FIELD_STATE_EXPORTS_PATH,
  PERSISTENCE_FIELD_STATE_IMPORT_INSPECTIONS_PATH,
  PERSISTENCE_FIELD_STATE_IMPORTS_PATH,
  PERSISTENCE_IMPORTS_PATH,
  SIMULATION_COMMANDS_PATH,
  SIMULATION_OBJECT_METRICS_PATH,
  SIMULATION_RUN_CURRENT_PATH,
  SIMULATION_SOLVER_ENERGIES_CURRENT_PATH,
  SIMULATION_SOLVER_STATUS_PATH,
  SIMULATION_STAGE_HYSTERESIS_EXECUTION_TREE_PATH,
  SIMULATION_STAGES_EXECUTION_PATH,
  VISUALIZATION_STATE_PATH,
} from "../api/apiPaths";
import type { ControlRoomApi } from "../api/ControlRoomApi";
import { CommandRegistry } from "../commands/CommandRegistry";
import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import { LayoutController } from "../layout/LayoutController";
import { ResourceInvalidationController } from "../resources/ResourceInvalidationController";
import { SelectionController } from "../selection/SelectionController";
import { SESSION_STATUS_RESOURCE_KEY } from "../resources/useSessionStatus";
import { activeLaneCapabilityFixture } from "../resources/activeLaneCapabilityFixture.testSupport";
import {
  resolveViewport3DActiveQuantityId,
  resolveViewport3DPrimaryFieldQuery,
  resolveViewport3DSelectedSnapshotId,
  resolveViewport3DSelectedSnapshotQuery,
} from "@/modules/viewport-3d/hooks/useViewport3DSceneModel";
import {
  resolveViewport3DFieldVectorResourceKey,
} from "@/modules/viewport-3d/viewport3dResources";

import { STUDY_RUNTIME_COMMANDS } from "./studyRuntimeCommandContributions";


function registryWithStudyRuntimeCommands(): CommandRegistry {
  const registry = new CommandRegistry();
  registry.attach(new EventBus<KernelEventMap>());
  for (const command of STUDY_RUNTIME_COMMANDS) {
    registry.register(command);
  }
  return registry;
}

function objectSelection(objectId = "body") {
  return {
    get: () => ({
      kind: "object.root",
      label: objectId,
      moduleSource: "explorer",
      nodeId: `object:${objectId}`,
      objectId,
      ref: {
        kind: "object.root",
        nodeId: `object:${objectId}`,
        objectId,
        type: "scene-object",
        visualizationTargetId: `object:${objectId}`,
      },
    }),
  };
}

function hysteresisCommandPoint() {
  return {
    branch_id: "descending",
    branch_ids: ["descending"],
    branch_index: 0,
    field_value_mT: 25,
    m_avg: [0.1, 0.2, 0.8],
    m_ip: 0.1,
    m_oop: 0.7,
    m_parallel: 0.8,
    minor_loop_id: null,
    parent_branch_id: null,
    point_id: 4,
    protocol_role: "descending",
    recoil_start_point_id: null,
    reversal_index: null,
    run_status: "completed",
    settle_status: "converged",
    snapshot_id: "hysteresis_point_005",
    snapshot_resource_ref: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?snapshot_id=hysteresis_point_005`,
    status: "completed",
  };
}

function airboxSelection() {
  return {
    get: () => ({
      kind: "airbox.root",
      label: "Airbox",
      moduleSource: "explorer",
      nodeId: "airbox",
      objectId: null,
      ref: {
        kind: "airbox.root",
        nodeId: "airbox",
        type: "airbox",
      },
    }),
  };
}

function studyStageSelection(stageIndex = 1, stageId = "run-2") {
  return {
    get: () => ({
      kind: "study.stage.run",
      label: "Run 2",
      moduleSource: "explorer",
      nodeId: `model:study:stages:stage:${stageId}`,
      objectId: null,
      ref: {
        kind: "study.stage.run",
        nodeId: `model:study:stages:stage:${stageId}`,
        stageId,
        stageIndex,
        type: "study-stage",
      },
    }),
  };
}

function selectionController() {
  return new SelectionController(new EventBus<KernelEventMap>());
}

function runtimeResourceData({
  activeStageIndex = null,
  activeLaneOperations = {
    "study.relaxation": {
      state: "supported",
      reason: "Relaxation is supported.",
      requires: [],
    },
    "study.time_integration": {
      state: "supported",
      reason: "Time integration is supported.",
      requires: [],
    },
    "study.eigenmodes": {
      state: "supported",
      reason: "Eigenmodes are supported.",
      requires: [],
    },
    "study.frequency_response": {
      state: "supported",
      reason: "Frequency response is supported.",
      requires: [],
    },
    "study.fft": {
      state: "supported",
      reason: "FFT is supported.",
      requires: [],
    },
  },
  binaryFields = true,
  commands = null,
  commandCount = 0,
  discretization = "fdm",
  eigenModes = false,
  explicitTopology = false,
  geometryValidation = { diagnostics: [] },
  regionDiagnostics = { diagnostics: [], scene_revision: 0 },
  meshBuildCurrent = null,
  meshBuildStatus = "idle",
  meshPipelineStatus = null,
  meshSourceSceneRevision = null,
  meshRevision = 0,
  runtimeState = "idle",
  runtimeControls = null,
  regionCoefficientsRevision,
  regionInitialStateRevision,
  regionMembershipRevision,
  regionTopologyRevision,
  sceneRevision = 3,
  solverProfile = null,
  stageRevision = 7,
}: {
  activeStageIndex?: number | null;
  activeLaneOperations?: Record<
    string,
    { reason: string; requires: string[]; state: string }
  >;
  binaryFields?: boolean;
  commands?: Array<{
    command_id?: string;
    kind: string;
    reason?: string;
    status: string;
  }> | null;
  commandCount?: number;
  discretization?: string;
  eigenModes?: boolean;
  explicitTopology?: boolean;
  geometryValidation?: unknown;
  regionDiagnostics?: unknown;
  meshBuildCurrent?: unknown;
  meshBuildStatus?: string;
  meshPipelineStatus?: Array<{
    id: string;
    label?: string;
    status: string;
  }> | null;
  meshRevision?: number;
  meshSourceSceneRevision?: number | null;
  runtimeState?: string;
  runtimeControls?: Array<{
    enabled: boolean;
    kind: string;
    reason?: string | null;
  }> | null;
  regionCoefficientsRevision?: number;
  regionInitialStateRevision?: number;
  regionMembershipRevision?: number;
  regionTopologyRevision?: number;
  sceneRevision?: number | null;
  solverProfile?: unknown;
  stageRevision?: number;
} = {}): Record<string, unknown> {
  return {
    [DIAGNOSTICS_SOLVER_PROFILE_PATH]: solverProfile,
    [MESHING_BUILDS_CURRENT_PATH]:
      meshBuildCurrent ??
      (meshPipelineStatus
        ? { mesh_pipeline_status: meshPipelineStatus }
        : { status: meshBuildStatus }),
    [MESHING_SHARED_DOMAIN_MANIFEST_PATH]:
      meshRevision > 0
        ? {
            revision: meshRevision,
            source_scene_revision: meshSourceSceneRevision ?? sceneRevision,
          }
        : null,
    [MODEL_GEOMETRY_VALIDATION_PATH]: geometryValidation,
    [MODEL_REGION_DIAGNOSTICS_PATH]: regionDiagnostics,
    [SESSION_STATUS_RESOURCE_KEY]: {
      capabilities: {
        active_lane: {
          ...activeLaneCapabilityFixture(),
          operations: activeLaneOperations,
          resolved: {
            backend: discretization,
            device: "cpu",
            discretization,
            mode: "strict",
            precision: "double",
          },
        },
        algorithms_available: [],
        binary_fields: binaryFields,
        cell_fields: true,
        eigen_modes: eigenModes,
        explicit_topology: explicitTopology,
        gpu_telemetry: true,
        node_fields: explicitTopology,
        preview_2d: true,
        preview_3d: true,
        scalar_history: true,
        structured_grid: !explicitTopology,
      },
      domain: {
        cell_count: 1,
        discretization,
        generation_id: 1,
      },
      resources: {
        mesh_revision: meshRevision,
        ...(regionCoefficientsRevision === undefined
          ? {}
          : { region_coefficients_revision: regionCoefficientsRevision }),
        ...(regionInitialStateRevision === undefined
          ? {}
          : { region_initial_state_revision: regionInitialStateRevision }),
        ...(regionMembershipRevision === undefined
          ? {}
          : { region_membership_revision: regionMembershipRevision }),
        ...(regionTopologyRevision === undefined
          ? {}
          : { region_topology_revision: regionTopologyRevision }),
        scene_revision: sceneRevision,
      },
    },
    [SIMULATION_COMMANDS_PATH]: {
      accepted_count: 0,
      can_accept_commands: true,
      commands:
        commands ??
        Array.from({ length: commandCount }, (_, index) => ({
          command_id: `cmd-${index}`,
          kind: "solve",
          status: "completed",
        })),
      completed_count: 0,
      dispatched_count: 0,
      failed_count: 0,
      pending_count: 0,
      rejected_count: 0,
      revision: 1,
      running_count: 0,
      runtime_controls: runtimeControls ?? [],
    },
    [SIMULATION_SOLVER_STATUS_PATH]: { runtime_state: runtimeState },
    [SIMULATION_STAGES_EXECUTION_PATH]: {
      active_stage_index: activeStageIndex,
      revision: stageRevision,
      runtime_state: runtimeState,
      stages:
        activeStageIndex == null
          ? []
          : [
              { stage_id: "stage-000" },
              { stage_id: "stage-001" },
              { stage_id: "stage-002" },
            ],
    },
  };
}

describe("study runtime command contributions", () => {
  it("selects Study root and stages nodes from local navigation commands", async () => {
    const registry = registryWithStudyRuntimeCommands();
    const selection = selectionController();

    await expect(
      registry.execute("study.open-overview", {
        selection,
        source: "test",
      }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(selection.get()).toMatchObject({
      kind: "study.root",
      label: "Study",
      nodeId: "model:study",
      ref: {
        kind: "study.root",
        nodeId: "model:study",
        type: "study",
      },
    });

    await expect(
      registry.execute("study.open-stages", {
        selection,
        source: "test",
      }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(selection.get()).toMatchObject({
      kind: "study.stages",
      label: "Stages",
      nodeId: "model:study:stages",
      ref: {
        kind: "study.stages",
        nodeId: "model:study:stages",
        type: "study",
      },
    });
  });

  it("adds relax stages with mumax-compatible torque tolerance stored in A/m", async () => {
    const registry = registryWithStudyRuntimeCommands();
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const scene = vi.fn(async () => ({ scene_revision: 3, study: { stages: [] } }));
    const commitTransaction = vi.fn(async () => ({ scene_revision: 4 }));

    const result = await registry.execute("study.add-relax-stage", {
      api: {
        model: { scene, commitTransaction },
      } as never,
      resourceData: runtimeResourceData(),
      resources,
      source: "test",
    });

    expect(result).toEqual({
      message: "Relax stage added.",
      status: "completed",
    });
    const [[request]] = commitTransaction.mock.calls as unknown as [[
      { merge_patch?: { study?: { stages?: Array<Record<string, unknown>> } } },
    ]];
    const stage = request.merge_patch?.study?.stages?.[0];
    expect(stage).toMatchObject({
      kind: "relax",
      torque_tolerance_apm: expect.any(Number),
    });
    expect(stage).not.toHaveProperty("torque_tolerance");
    expect(stage).not.toHaveProperty("energy_tolerance_j");
    expect(stage).not.toHaveProperty("fixed_timestep");
    expect(stage).not.toHaveProperty("integrator");
    expect(stage).not.toHaveProperty("max_relaxation_time_s");
    expect(stage?.torque_tolerance_apm).toBeCloseTo(1e-4, 12);
    expect(stage).toMatchObject({
      algorithm: "llg_overdamped",
      max_steps: "50000",
    });
  });

  it("adds each authored study stage kind through command registry merge patches", async () => {
    const registry = registryWithStudyRuntimeCommands();
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const scene = vi.fn(async () => ({
      scene_revision: 3,
      study: { stages: [{ kind: "relax", stage_id: "relax-1" }] },
    }));
    const commitTransaction = vi.fn(async () => ({ scene_revision: 5 }));

    const commands = [
      ["study.add-field-drive-stage", "add_field_drive"],
      ["study.add-table-autosave-stage", "table_autosave"],
      ["study.add-autosave-stage", "autosave"],
      ["study.add-fft-response-stage", "fft_response"],
      ["study.add-run-stage", "run"],
      ["study.add-hysteresis-stage", "hysteresis"],
      ["study.add-eigenmodes-stage", "eigenmodes"],
      ["study.add-frequency-response-stage", "frequency_response"],
      ["study.add-save-state-stage", "save_state"],
    ] as const;

    await Promise.all(
      commands.map(([commandId]) =>
        registry.execute(commandId, {
          api: {
            model: { scene, commitTransaction },
          } as never,
          resourceData: runtimeResourceData({
            discretization: "fem",
            eigenModes: true,
          }),
          resources,
          source: "test",
        }),
      ),
    );

    const calls = commitTransaction.mock.calls as unknown as Array<
      [{ merge_patch: { study: { stages: Array<Record<string, unknown>> } } }]
    >;
    for (const [index, [request]] of calls.entries()) {
      const expectedKind = commands[index]?.[1];
      const stage = request.merge_patch.study.stages[1];
      expect(stage).toMatchObject({
        kind: expectedKind,
        stage_id: `${expectedKind.replace(/_/g, "-")}-2`,
      });
      if (expectedKind === "run") {
        expect(stage).not.toHaveProperty("sampling");
        expect(stage).not.toHaveProperty("spin_wave_response");
        expect(stage).not.toHaveProperty("fixed_timestep");
      }
    }
    expect(resources.getRevision(MODEL_SCENE_PATH)).toBe(5);
    expect(resources.getRevision(MODEL_STUDY_PATH)).toBe(5);
    expect(resources.getRevision(SIMULATION_STAGES_EXECUTION_PATH)).toBe(5);
  });

  it("uses distinct active-lane operations for frequency-analysis stage authoring", () => {
    const registry = registryWithStudyRuntimeCommands();
    const context = {
      api: {} as never,
      resourceData: runtimeResourceData({
        discretization: "fem",
        eigenModes: true,
        activeLaneOperations: {
          "study.eigenmodes": {
            state: "semantic_only",
            reason: "Eigenmode authoring is semantic-only on this lane.",
            requires: ["planner:eigenmodes"],
          },
          "study.frequency_response": {
            state: "unsupported",
            reason: "Frequency response is unavailable on this lane.",
            requires: ["planner:frequency_response"],
          },
          "study.fft": {
            state: "supported",
            reason: "FFT is supported from available field quantities.",
            requires: ["field_quantity"],
          },
        },
      }),
      source: "test" as const,
    };

    expect(registry.isEnabled("study.add-eigenmodes-stage", context)).toBe(false);
    expect(
      registry.get("study.add-eigenmodes-stage")?.disabledReason?.(context),
    ).toBe("Eigenmode authoring is semantic-only on this lane.");
    expect(registry.isEnabled("study.add-frequency-response-stage", context)).toBe(false);
    expect(
      registry.get("study.add-frequency-response-stage")?.disabledReason?.(context),
    ).toBe("Frequency response is unavailable on this lane.");
    expect(registry.isEnabled("study.add-fft-response-stage", context)).toBe(true);
  });

  it("fails closed for frequency-analysis commands without active-lane status", () => {
    const registry = registryWithStudyRuntimeCommands();
    const context = {
      api: {} as never,
      resourceData: runtimeResourceData({
        discretization: "fem",
        activeLaneOperations: {},
      }),
      source: "test" as const,
    };

    expect(registry.isEnabled("study.add-eigenmodes-stage", context)).toBe(false);
    expect(
      registry.get("study.add-eigenmodes-stage")?.disabledReason?.(context),
    ).toBe("Active-lane capability snapshot is unavailable.");
  });

  it.each([
    ["study.add-relax-stage", "study.relaxation"],
    ["study.add-run-stage", "study.time_integration"],
  ])(
    "gates %s with the planner-owned %s operation",
    (commandId, operationId) => {
      const registry = registryWithStudyRuntimeCommands();
      const unsupported = {
        api: {} as never,
        resourceData: runtimeResourceData({
          activeLaneOperations: {
            [operationId]: {
              state: "unsupported",
              reason: `${operationId} is unavailable for this resolved lane.`,
              requires: ["planner:resolved_lane"],
            },
          },
        }),
        source: "test" as const,
      };
      const supported = {
        api: {} as never,
        resourceData: runtimeResourceData({
          activeLaneOperations: {
            [operationId]: {
              state: "supported",
              reason: `${operationId} is supported for this resolved lane.`,
              requires: ["planner:resolved_lane"],
            },
          },
        }),
        source: "test" as const,
      };

      expect(registry.isEnabled(commandId, unsupported), commandId).toBe(false);
      expect(registry.get(commandId)?.disabledReason?.(unsupported)).toBe(
        `${operationId} is unavailable for this resolved lane.`,
      );
      expect(registry.isEnabled(commandId, supported), commandId).toBe(true);
      expect(registry.get(commandId)?.disabledReason?.(supported)).toBeNull();
    },
  );

  it.each(["study.add-relax-stage", "study.add-run-stage"])(
    "fails closed for %s without its active-lane operation",
    (commandId) => {
      const registry = registryWithStudyRuntimeCommands();
      const context = {
        api: {} as never,
        resourceData: runtimeResourceData({ activeLaneOperations: {} }),
        source: "test" as const,
      };

      expect(registry.isEnabled(commandId, context), commandId).toBe(false);
      expect(registry.get(commandId)?.disabledReason?.(context)).toBe(
        "Active-lane capability snapshot is unavailable.",
      );
    },
  );

  it("adds hysteresis stage visibly by selecting the new stage and opening Study", async () => {
    const registry = registryWithStudyRuntimeCommands();
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const layout = new LayoutController(bus);
    const selection = new SelectionController(bus);
    layout.setActiveTab("home");
    const scene = vi.fn(async () => ({
      scene_revision: 3,
      study: { stages: [{ kind: "relax", stage_id: "relax-1" }] },
    }));
    const commitTransaction = vi.fn(async () => ({ scene_revision: 5 }));

    const result = await registry.execute("study.add-hysteresis-stage", {
      api: {
        model: { scene, commitTransaction },
      } as never,
      layout,
      resources,
      selection,
      source: "test",
    });

    expect(result).toEqual({
      message: "Hysteresis stage added.",
      status: "completed",
    });
    const [[request]] = commitTransaction.mock.calls as unknown as [[
      { merge_patch: { study: { stages: Array<Record<string, unknown>> } } },
    ]];
    const stage = request.merge_patch.study.stages[1];
    expect(stage).toMatchObject({
      branch_mode: "major_loop",
      field_max_mT: 100,
      field_min_mT: -100,
      field_step_mT: 10,
      kind: "hysteresis",
      orientation: { kind: "preset", preset_name: "oop_positive" },
      settle_pipeline: {
        kind: "sequence",
        steps: [
          {
            kind: "relax",
            method: "llg_overdamped",
          },
        ],
      },
      stage_id: "hysteresis-2",
    });
    expect(stage).not.toHaveProperty("start_field");
    expect(stage).not.toHaveProperty("field_steps");
    expect(layout.get().activeModuleTab).toBe("study");
    expect(layout.get().panelVisible.right).toBe(true);
    expect(selection.get()).toMatchObject({
      kind: "study.stage.hysteresis",
      label: "hysteresis stage",
      nodeId: "model:study:stages:stage:hysteresis-2",
      ref: {
        kind: "study.stage.hysteresis",
        stageId: "hysteresis-2",
        stageIndex: 1,
        type: "study-stage",
      },
    });
  });

  it("continues a completed hysteresis stage by adding an explicit next run stage", async () => {
    const registry = registryWithStudyRuntimeCommands();
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const layout = new LayoutController(bus);
    const selection = new SelectionController(bus);
    const scene = vi.fn(async () => ({
      scene_revision: 8,
      study: {
        stages: [
          {
            kind: "hysteresis",
            stage_id: "hysteresis-1",
          },
        ],
      },
    }));
    const commitTransaction = vi.fn(async () => ({ scene_revision: 9 }));

    const result = await registry.execute("hysteresis.continue-to-next-stage", {
      api: {
        model: { scene, commitTransaction },
      } as never,
      layout,
      resources,
      selection,
      source: "test",
    }, {
      stageId: "hysteresis-1",
    });

    expect(result).toEqual({
      message: "Continuation run stage added after hysteresis-1.",
      status: "completed",
    });
    const [[request]] = commitTransaction.mock.calls as unknown as [[
      { merge_patch: { study: { stages: Array<Record<string, unknown>> } } },
    ]];
    expect(request.merge_patch.study.stages).toHaveLength(2);
    expect(request.merge_patch.study.stages[1]).toMatchObject({
      kind: "run",
      stage_id: "run-2",
    });
    expect(resources.getRevision(MODEL_STUDY_PATH)).toBe(9);
    expect(resources.getRevision(SIMULATION_STAGES_EXECUTION_PATH)).toBe(9);
    expect(selection.get()).toMatchObject({
      kind: "study.stage.run",
      ref: {
        stageId: "run-2",
        stageIndex: 1,
      },
    });
    expect(layout.get().activeModuleTab).toBe("study");
  });

  it("loads a hysteresis point in 3D by publishing an analysis chart point selection", async () => {
    const registry = registryWithStudyRuntimeCommands();
    const bus = new EventBus<KernelEventMap>();
    const layout = new LayoutController(bus);
    const selection = new SelectionController(bus);
    layout.setActiveViewportMainModule("analysis-plots");

    const result = await registry.execute("hysteresis.load-point-in-3d", {
      layout,
      selection,
      source: "test",
    }, {
      fieldVal: 25,
      mVal: 0.8,
      pointId: 4,
      snapshotId: "hysteresis_point_005",
      snapshotResourceRef: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?snapshot_id=hysteresis_point_005&stage_id=hysteresis-1`,
      stageId: "hysteresis-1",
    });

    expect(result).toEqual({
      message: "Loaded point in 3D.",
      status: "completed",
    });
    expect(selection.get()).toMatchObject({
      kind: "analysis.chart-point",
      label: "Point 4 (25 mT)",
      moduleSource: "analysis-plots",
      nodeId: "analysis:hysteresis:hysteresis-1:point:4",
      objectId: null,
      ref: {
        chartId: "hysteresis:hysteresis-1",
        pointId: 4,
        quantity: "m",
        resourceRef: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?snapshot_id=hysteresis_point_005&stage_id=hysteresis-1`,
        snapshotId: "hysteresis_point_005",
        stageId: "hysteresis-1",
        tableId: "hysteresis:hysteresis-1",
        targetId: "hysteresis-step:hysteresis-1:4",
        targetKind: "hysteresis-step",
        type: "analysis-chart-point",
        x: 25,
        y: 0.8,
      },
    });
    expect(layout.get().activeViewportMainModuleId).toBe("viewport-3d");
    expect(layout.get().focusedSlot).toBe("viewport-main");

    const selectedSnapshotId = resolveViewport3DSelectedSnapshotId(selection.get());
    const quantityId = resolveViewport3DActiveQuantityId({
      selectedSnapshotId,
      selection: selection.get(),
      visualizationState: { active_quantity_id: "H_eff" } as never,
    });
    const fieldQuery = resolveViewport3DPrimaryFieldQuery({
      fdmInstanceModelNeedsFieldVector: false,
      fdmSurfaceColorMode: null,
      fdmTopographyEnabled: false,
      fdmVectorsVisible: false,
      fieldRenderOptions: {
        fullVectorBudget: 0,
        partVectorBudgets: new Map(),
        scalarColorModes: new Set(),
        scalarColorsVisible: false,
      },
      snapshotId: selectedSnapshotId,
      snapshotQuery: resolveViewport3DSelectedSnapshotQuery(selection.get()),
    });

    expect(quantityId).toBe("m");
    expect(resolveViewport3DFieldVectorResourceKey(quantityId, fieldQuery)).toBe(
      `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?component=full&scope_kind=full&snapshot_id=hysteresis_point_005&stage_id=hysteresis-1`,
    );
  });

  it("returns from a loaded hysteresis point snapshot to the live field", async () => {
    const registry = registryWithStudyRuntimeCommands();
    const bus = new EventBus<KernelEventMap>();
    const selection = new SelectionController(bus);

    await registry.execute("hysteresis.load-point-in-3d", {
      selection,
      source: "test",
    }, {
      fieldVal: 25,
      mVal: 0.8,
      pointId: 4,
      snapshotId: "hysteresis_point_005",
      stageId: "hysteresis-1",
    });
    expect(selection.get().ref).toMatchObject({
      snapshotId: "hysteresis_point_005",
      type: "analysis-chart-point",
    });

    const result = await registry.execute("hysteresis.return-to-live", {
      selection,
      source: "test",
    });

    expect(result).toEqual({
      message: "Returned 3D viewport to the live magnetization field.",
      status: "completed",
    });
    expect(selection.get()).toEqual({
      kind: null,
      label: null,
      moduleSource: "analysis-plots",
      nodeId: null,
      objectId: null,
      ref: null,
    });
  });

  it("replaces the 3D hysteresis replay query when loading another saved point", async () => {
    const registry = registryWithStudyRuntimeCommands();
    const bus = new EventBus<KernelEventMap>();
    const selection = new SelectionController(bus);

    await registry.execute("hysteresis.load-point-in-3d", {
      selection,
      source: "test",
    }, {
      fieldVal: 25,
      mVal: 0.8,
      pointId: 4,
      snapshotId: "hysteresis_point_005",
      snapshotResourceRef: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?snapshot_id=hysteresis_point_005&stage_id=hysteresis-1`,
      stageId: "hysteresis-1",
    });

    await registry.execute("hysteresis.load-point-in-3d", {
      selection,
      source: "test",
    }, {
      fieldVal: -15,
      mVal: -0.35,
      pointId: 8,
      snapshotId: "hysteresis_point_009",
      snapshotResourceRef: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?snapshot_id=hysteresis_point_009&stage_id=hysteresis-1`,
      stageId: "hysteresis-1",
    });

    const selectedSnapshotId = resolveViewport3DSelectedSnapshotId(selection.get());
    const quantityId = resolveViewport3DActiveQuantityId({
      selectedSnapshotId,
      selection: selection.get(),
      visualizationState: { active_quantity_id: "H_eff" } as never,
    });
    const fieldQuery = resolveViewport3DPrimaryFieldQuery({
      fdmInstanceModelNeedsFieldVector: false,
      fdmSurfaceColorMode: null,
      fdmTopographyEnabled: false,
      fdmVectorsVisible: false,
      fieldRenderOptions: {
        fullVectorBudget: 0,
        partVectorBudgets: new Map(),
        scalarColorModes: new Set(),
        scalarColorsVisible: false,
      },
      snapshotId: selectedSnapshotId,
      snapshotQuery: resolveViewport3DSelectedSnapshotQuery(selection.get()),
    });

    expect(selection.get()).toMatchObject({
      nodeId: "analysis:hysteresis:hysteresis-1:point:8",
      ref: {
        pointId: 8,
        resourceRef: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?snapshot_id=hysteresis_point_009&stage_id=hysteresis-1`,
        snapshotId: "hysteresis_point_009",
        stageId: "hysteresis-1",
        type: "analysis-chart-point",
      },
    });
    expect(quantityId).toBe("m");
    expect(fieldQuery).toEqual({
      component: "full",
      scope_kind: "full",
      snapshot_id: "hysteresis_point_009",
      stage_id: "hysteresis-1",
    });
    expect(resolveViewport3DFieldVectorResourceKey(quantityId, fieldQuery)).toBe(
      `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?component=full&scope_kind=full&snapshot_id=hysteresis_point_009&stage_id=hysteresis-1`,
    );
  });

  it("does not clear another hysteresis stage when returning one stage to live", async () => {
    const registry = registryWithStudyRuntimeCommands();
    const bus = new EventBus<KernelEventMap>();
    const selection = new SelectionController(bus);

    await registry.execute("hysteresis.load-point-in-3d", {
      selection,
      source: "test",
    }, {
      fieldVal: 25,
      mVal: 0.8,
      pointId: 4,
      snapshotId: "hysteresis_point_005",
      stageId: "hysteresis-2",
    });

    const result = await registry.execute("hysteresis.return-to-live", {
      selection,
      source: "test",
    }, {
      stageId: "hysteresis-1",
    });

    expect(result).toEqual({
      message: "Returned 3D viewport to the live magnetization field.",
      status: "completed",
    });
    expect(selection.get().ref).toMatchObject({
      snapshotId: "hysteresis_point_005",
      stageId: "hysteresis-2",
      type: "analysis-chart-point",
    });
  });

  it("selects a hysteresis point for comparison in the analysis chart", async () => {
    const registry = registryWithStudyRuntimeCommands();
    const bus = new EventBus<KernelEventMap>();
    const layout = new LayoutController(bus);
    const selection = new SelectionController(bus);
    layout.setActiveViewportMainModule("viewport-3d");

    const result = await registry.execute("hysteresis.compare-point", {
      layout,
      selection,
      source: "test",
    }, {
      point: hysteresisCommandPoint(),
      stageId: "hysteresis-1",
    });

    expect(result).toEqual({
      message: "Selected hysteresis point 4 for comparison.",
      status: "completed",
    });
    expect(selection.get()).toMatchObject({
      kind: "analysis.chart-point",
      label: "Point 4 (25 mT)",
      moduleSource: "analysis-plots",
      ref: {
        pointId: 4,
        quantity: "m",
        snapshotId: "hysteresis_point_005",
        stageId: "hysteresis-1",
        type: "analysis-chart-point",
        x: 25,
        y: 0.8,
      },
    });
    expect(layout.get().activeViewportMainModuleId).toBe("analysis-plots");
    expect(layout.get().focusedSlot).toBe("viewport-main");
  });

  it("exports a hysteresis point as a local CSV action", async () => {
    const registry = registryWithStudyRuntimeCommands();

    const result = await registry.execute("hysteresis.export-point-csv", {
      source: "test",
    }, {
      point: hysteresisCommandPoint(),
      stageId: "hysteresis-1",
    });

    expect(result).toEqual({
      message: "Exported hysteresis point 4 as CSV.",
      status: "completed",
    });
  });

  it("exports a full hysteresis loop as a local CSV action", async () => {
    const registry = registryWithStudyRuntimeCommands();

    const result = await registry.execute("hysteresis.export-loop-csv", {
      source: "test",
    }, {
      points: [
        hysteresisCommandPoint(),
        {
          ...hysteresisCommandPoint(),
          field_value_mT: -25,
          m_parallel: -0.75,
          point_id: 5,
          snapshot_id: "hysteresis_point_006",
        },
      ],
      stageId: "hysteresis-1",
    });

    expect(result).toEqual({
      message: "Exported hysteresis loop with 2 points as CSV.",
      status: "completed",
    });
  });

  it("rejects full hysteresis loop CSV export without point data", async () => {
    const registry = registryWithStudyRuntimeCommands();

    const result = await registry.execute("hysteresis.export-loop-csv", {
      source: "test",
    }, {
      points: [],
      stageId: "hysteresis-1",
    });

    expect(result).toEqual({
      message: "No hysteresis points are available to export.",
      status: "failed",
    });
  });

  it("bookmarks a hysteresis point through the control-room resource", async () => {
    const registry = registryWithStudyRuntimeCommands();
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bookmarkPoint = vi.fn(async () => ({
      bookmarks: [],
      revision: 42,
      stage_id: "hysteresis-1",
      stage_index: 0,
    }));
    const api = {
      analysis: {
        hysteresis: {
          bookmarkPoint,
        },
      },
    } as unknown as ControlRoomApi;

    const result = await registry.execute("hysteresis.bookmark-point", {
      api,
      resources,
      source: "test",
    }, {
      point: hysteresisCommandPoint(),
      stageId: "hysteresis-1",
    });

    expect(result).toEqual({
      message: "Bookmarked hysteresis point 4.",
      status: "completed",
    });
    expect(bookmarkPoint).toHaveBeenCalledWith("hysteresis-1", {
      point_id: 4,
    });
    expect(
      resources.getRevision(
        ANALYSIS_HYSTERESIS_BOOKMARKS_PATH.replace(
          "{stage_id}",
          "hysteresis-1",
        ),
      ),
    ).toBe(42);
    expect(
      resources.getRevision(
        `${SIMULATION_STAGE_HYSTERESIS_EXECUTION_TREE_PATH.replace(
          "{stage_id}",
          "hysteresis-1",
        )}?window=active`,
      ),
    ).toBe(42);

    vi.unstubAllGlobals();
  });

  it("fails hysteresis point bookmarking without the control-room API", async () => {
    const registry = registryWithStudyRuntimeCommands();

    const result = await registry.execute("hysteresis.bookmark-point", {
      source: "test",
    }, {
      point: hysteresisCommandPoint(),
      stageId: "hysteresis-1",
    });

    expect(result).toEqual({
      message: "Control-room API is unavailable.",
      status: "failed",
    });
  });

  it("clears a hysteresis snapshot explorer selection when returning that stage to live", async () => {
    const registry = registryWithStudyRuntimeCommands();
    const bus = new EventBus<KernelEventMap>();
    const selection = new SelectionController(bus);

    selection.set({
      kind: "study.stage.action",
      label: "Snapshot hysteresis_point_005",
      nodeId: "study:stage:0:field-point:4:snapshot:hysteresis_point_005",
      objectId: null,
      ref: {
        kind: "study.stage.action",
        nodeId: "study:stage:0:field-point:4:snapshot:hysteresis_point_005",
        pointId: 4,
        quantityId: "m",
        resourceRef: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?snapshot_id=hysteresis_point_005`,
        snapshotId: "hysteresis_point_005",
        stageId: "hysteresis-1",
        stageIndex: 0,
        targetId: "hysteresis-step:hysteresis-1:4",
        type: "hysteresis-snapshot",
      },
    }, "explorer");

    const result = await registry.execute("hysteresis.return-to-live", {
      selection,
      source: "test",
    }, {
      stageId: "hysteresis-1",
    });

    expect(result).toEqual({
      message: "Returned 3D viewport to the live magnetization field.",
      status: "completed",
    });
    expect(selection.get()).toEqual({
      kind: null,
      label: null,
      moduleSource: "analysis-plots",
      nodeId: null,
      objectId: null,
      ref: null,
    });
  });

  it("does not claim a hysteresis point is loaded in 3D without a saved snapshot", async () => {
    const registry = registryWithStudyRuntimeCommands();
    const bus = new EventBus<KernelEventMap>();
    const selection = new SelectionController(bus);

    const result = await registry.execute("hysteresis.load-point-in-3d", {
      selection,
      source: "test",
    }, {
      fieldVal: 25,
      mVal: 0.8,
      pointId: 4,
      snapshotId: null,
      stageId: "hysteresis-1",
    });

    expect(result).toEqual({
      message: "This hysteresis point has no saved magnetization snapshot.",
      status: "failed",
    });
    expect(selection.get()).toEqual({
      kind: null,
      label: null,
      moduleSource: null,
      nodeId: null,
      objectId: null,
      ref: null,
    });
  });

  it("does not load a hysteresis point in 3D when the saved snapshot payload is missing", async () => {
    const registry = registryWithStudyRuntimeCommands();
    const bus = new EventBus<KernelEventMap>();
    const selection = new SelectionController(bus);

    const result = await registry.execute("hysteresis.load-point-in-3d", {
      selection,
      source: "test",
    }, {
      fieldVal: 25,
      mVal: 0.8,
      pointId: 4,
      snapshotId: "hysteresis_point_005",
      snapshotStorageReason: "snapshot payload not found in hysteresis.zarr or JSON fallback",
      snapshotStorageStatus: "missing",
      stageId: "hysteresis-1",
    });

    expect(result).toEqual({
      message:
        "Snapshot payload is missing for this hysteresis point: snapshot payload not found in hysteresis.zarr or JSON fallback",
      status: "failed",
    });
    expect(selection.get()).toEqual({
      kind: null,
      label: null,
      moduleSource: null,
      nodeId: null,
      objectId: null,
      ref: null,
    });
  });

  it("uses a hysteresis point snapshot as an object initial state", async () => {
    const registry = registryWithStudyRuntimeCommands();
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const importFieldState = vi.fn(async () => ({
      applied_point_count: 2,
      artifact_ref: "hysteresis_snapshots/hysteresis_point_005/m.json",
      field_revision: 11,
      mode: "apply",
      quantity_id: "m",
      target: { id: "body", kind: "object" },
      warnings: [],
    }));

    const result = await registry.execute("hysteresis.use-point-as-initial-state", {
      api: {
        persistence: {
          fieldStates: { import: importFieldState },
        },
      } as never,
      resources,
      selection: objectSelection("body") as never,
      source: "test",
    }, {
      snapshotId: "hysteresis_point_005",
      stageId: "hysteresis-1",
    });

    expect(result).toEqual({
      message: "Hysteresis point hysteresis_point_005 applied as initial state.",
      status: "completed",
    });
    expect(importFieldState).toHaveBeenCalledWith({
      artifact_ref: "hysteresis_snapshots/hysteresis_point_005/m.json",
      mode: "apply",
      quantity_id: "m",
      target: { id: "body", kind: "object" },
    });
    expect(resources.getRevision(DATA_FIELDS_PATH)).toBe(11);
    expect(resources.getRevision(PERSISTENCE_FIELD_STATE_IMPORTS_PATH)).toBe(11);
  });

  it("uses the hysteresis point snapshot artifact ref when applying an initial state", async () => {
    const registry = registryWithStudyRuntimeCommands();
    const vectorResourceRef = `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?snapshot_id=hysteresis_point_005`;
    const importFieldState = vi.fn(async () => ({
      applied_point_count: 2,
      artifact_ref: "hysteresis_snapshots/hysteresis_point_005/m.json",
      field_revision: 12,
      mode: "apply",
      quantity_id: "m",
      target: { id: "body", kind: "object" },
      warnings: [],
    }));

    const result = await registry.execute(
      "hysteresis.use-point-as-initial-state",
      {
        api: {
          persistence: {
            fieldStates: { import: importFieldState },
          },
        } as never,
        selection: objectSelection("body") as never,
        source: "test",
      },
      {
        snapshotId: "hysteresis_point_005",
        snapshotArtifactRef: "hysteresis_snapshots/hysteresis_point_005/m.json",
        snapshotResourceRef: vectorResourceRef,
        stageId: "hysteresis-1",
      },
    );

    expect(result).toMatchObject({ status: "completed" });
    expect(importFieldState).toHaveBeenCalledWith({
      artifact_ref: "hysteresis_snapshots/hysteresis_point_005/m.json",
      mode: "apply",
      quantity_id: "m",
      target: { id: "body", kind: "object" },
    });
  });

  it("ignores legacy data-plane snapshot resource refs when applying an initial state", async () => {
    const registry = registryWithStudyRuntimeCommands();
    const vectorResourceRef = `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?snapshot_id=hysteresis_point_005`;
    const importFieldState = vi.fn(async () => ({
      applied_point_count: 2,
      artifact_ref: "hysteresis_snapshots/hysteresis_point_005/m.json",
      field_revision: 12,
      mode: "apply",
      quantity_id: "m",
      target: { id: "body", kind: "object" },
      warnings: [],
    }));

    const result = await registry.execute(
      "hysteresis.use-point-as-initial-state",
      {
        api: {
          persistence: {
            fieldStates: { import: importFieldState },
          },
        } as never,
        selection: objectSelection("body") as never,
        source: "test",
      },
      {
        snapshotId: "hysteresis_point_005",
        snapshotResourceRef: vectorResourceRef,
        stageId: "hysteresis-1",
      },
    );

    expect(result).toMatchObject({ status: "completed" });
    expect(importFieldState).toHaveBeenCalledWith({
      artifact_ref: "hysteresis_snapshots/hysteresis_point_005/m.json",
      mode: "apply",
      quantity_id: "m",
      target: { id: "body", kind: "object" },
    });
  });

  it("removes the selected study stage from the authored pipeline", async () => {
    const registry = registryWithStudyRuntimeCommands();
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const scene = vi.fn(async () => ({
      scene_revision: 3,
      study: {
        stages: [
          { kind: "relax", stage_id: "relax-1" },
          { kind: "run", stage_id: "run-2" },
          { kind: "hysteresis", stage_id: "hysteresis-3" },
        ],
      },
    }));
    const commitTransaction = vi.fn(async () => ({ scene_revision: 6 }));

    const result = await registry.execute("study.remove-selected-stage", {
      api: {
        model: { scene, commitTransaction },
      } as never,
      resources,
      selection: studyStageSelection(1) as never,
      source: "test",
    });

    expect(result).toEqual({
      message: "Study stage removed.",
      status: "completed",
    });
    expect(commitTransaction).toHaveBeenCalledWith({
      kind: "merge_patch",
      merge_patch: {
        study: {
          stages: [
            { kind: "relax", stage_id: "relax-1" },
            { kind: "hysteresis", stage_id: "hysteresis-3" },
          ],
        },
      },
    });
    expect(resources.getRevision(MODEL_SCENE_PATH)).toBe(6);
    expect(resources.getRevision(MODEL_STUDY_PATH)).toBe(6);
    expect(resources.getRevision(SIMULATION_STAGES_EXECUTION_PATH)).toBe(6);
  });

  it("enables solver profiling through the runtime command queue and diagnostics resources", async () => {
    const registry = registryWithStudyRuntimeCommands();
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const submit = vi.fn(async () => ({
      accepted: true,
      command_id: "cmd-profile-on",
      error: null,
    }));
    const profileListener = vi.fn();
    const engineLogListener = vi.fn();
    resources.subscribe(DIAGNOSTICS_SOLVER_PROFILE_PATH, profileListener);
    resources.subscribe(DIAGNOSTICS_ENGINE_LOG_PATH, engineLogListener);

    const result = await registry.execute("diagnostics.toggle-solver-profiler", {
      api: {
        commands: { submit },
      } as never,
      resourceData: runtimeResourceData({
        solverProfile: {
          config: {
            emit_engine_log: false,
            enabled: false,
            max_samples: 128,
            persist_artifact: false,
            sample_every: 1,
            sample_interval_wall_ms: 0,
          },
          state: "disabled",
        },
      }),
      resources,
      source: "test",
    });

    expect(result).toEqual({
      message: "Solver profiler enabled.",
      status: "completed",
    });
    expect(submit).toHaveBeenCalledWith({
      client_intent_id: expect.stringMatching(/^diagnostics:solver-profiler:/),
      kind: "set_solver_profile",
      profile: {
        emit_engine_log: false,
        enabled: true,
        max_samples: 128,
        persist_artifact: true,
        sample_every: 1,
        sample_interval_wall_ms: 5000,
      },
      reason: "enable_solver_profile",
      requested_at_unix_ms: expect.any(Number),
      target: { kind: "study" },
    });
    expect(resources.getRevision(DIAGNOSTICS_SOLVER_PROFILE_PATH)).toBe(
      "cmd-profile-on",
    );
    expect(resources.getRevision(DIAGNOSTICS_ENGINE_LOG_PATH)).toBe(
      "cmd-profile-on",
    );
    expect(resources.getRevision(SIMULATION_COMMANDS_PATH)).toBe(
      "cmd-profile-on",
    );
    expect(profileListener).toHaveBeenCalledWith("cmd-profile-on");
    expect(engineLogListener).toHaveBeenCalledWith("cmd-profile-on");
  });

  it("marks the solver profiler command active and can disable it explicitly", async () => {
    const registry = registryWithStudyRuntimeCommands();
    const submit = vi.fn(async () => ({
      accepted: true,
      command_id: "cmd-profile-off",
      error: null,
    }));
    const context = {
      api: {
        commands: { submit },
      } as never,
      resourceData: runtimeResourceData({
        solverProfile: {
          config: {
            emit_engine_log: true,
            enabled: true,
            max_samples: 4096,
            persist_artifact: true,
            sample_every: 1,
            sample_interval_wall_ms: 5000,
          },
          state: "active",
        },
      }),
      source: "test" as const,
    };

    expect(registry.isActive("diagnostics.toggle-solver-profiler", context)).toBe(
      true,
    );

    const result = await registry.execute(
      "diagnostics.toggle-solver-profiler",
      context,
      false,
    );

    expect(result).toEqual({
      message: "Solver profiler disabled.",
      status: "completed",
    });
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "set_solver_profile",
        profile: expect.objectContaining({
          emit_engine_log: false,
          enabled: false,
          max_samples: 4096,
          persist_artifact: false,
          sample_every: 1,
          sample_interval_wall_ms: 5000,
        }),
        reason: "disable_solver_profile",
        target: { kind: "study" },
      }),
    );
  });

  it("submits compute fields without broad result invalidations on acceptance", async () => {
    const registry = registryWithStudyRuntimeCommands();
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const submit = vi.fn(async () => ({
      accepted: true,
      command_id: "cmd-fields",
      error: null,
    }));
    const fieldVectorKey = `${DATA_FIELD_VECTOR_PATH.replace(
      "{quantity_id}",
      "m",
    )}?component=full`;
    const fieldVectorListener = vi.fn();
    const scalarWindowListener = vi.fn();
    resources.subscribe(fieldVectorKey, fieldVectorListener);
    resources.subscribe(`${DATA_SCALARS_PATH}?limit=100`, scalarWindowListener);

    const result = await registry.execute("study.compute-fields", {
      api: {
        commands: { submit },
      } as never,
      resourceData: runtimeResourceData(),
      resources,
      source: "test",
    });

    expect(result).toEqual({
      message: "Compute fields command accepted.",
      status: "completed",
    });
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "compute_fields",
        reason: "user_requested",
        target: { kind: "study" },
      }),
    );
    expect(resources.getRevision(SIMULATION_COMMANDS_PATH)).toBe("cmd-fields");
    expect(resources.getRevision(SIMULATION_STAGES_EXECUTION_PATH)).toBe(
      "cmd-fields",
    );
    expect(resources.getRevision(SIMULATION_SOLVER_STATUS_PATH)).toBe(
      "cmd-fields",
    );
    expect(resources.getRevision(SESSION_STATUS_RESOURCE_KEY)).toBeNull();
    expect(resources.getRevision(DATA_FIELDS_PATH)).toBeNull();
    expect(resources.getRevision(DATA_SCALARS_PATH)).toBeNull();
    expect(fieldVectorListener).not.toHaveBeenCalled();
    expect(scalarWindowListener).not.toHaveBeenCalled();
  });

  it("submits compute energies without broad result invalidations on acceptance", async () => {
    const registry = registryWithStudyRuntimeCommands();
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const submit = vi.fn(async () => ({
      accepted: true,
      command_id: "cmd-energies",
      error: null,
    }));
    const objectMetricsKey = SIMULATION_OBJECT_METRICS_PATH.replace(
      "{object_id}",
      "arch_Waveguide",
    );
    const objectMetricsListener = vi.fn();
    const scalarWindowListener = vi.fn();
    resources.subscribe(objectMetricsKey, objectMetricsListener);
    resources.subscribe(`${DATA_SCALARS_PATH}?limit=100`, scalarWindowListener);

    const result = await registry.execute("study.compute-energies", {
      api: {
        commands: { submit },
      } as never,
      resourceData: runtimeResourceData(),
      resources,
      source: "test",
    });

    expect(result).toEqual({
      message: "Compute energies command accepted.",
      status: "completed",
    });
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "compute_energies",
        reason: "user_requested",
        target: { kind: "study" },
      }),
    );
    expect(resources.getRevision(SIMULATION_COMMANDS_PATH)).toBe("cmd-energies");
    expect(resources.getRevision(SIMULATION_STAGES_EXECUTION_PATH)).toBe(
      "cmd-energies",
    );
    expect(resources.getRevision(SIMULATION_SOLVER_STATUS_PATH)).toBe(
      "cmd-energies",
    );
    expect(resources.getRevision(SESSION_STATUS_RESOURCE_KEY)).toBeNull();
    expect(resources.getRevision(SIMULATION_SOLVER_ENERGIES_CURRENT_PATH)).toBeNull();
    expect(resources.getRevision(DATA_SCALARS_PATH)).toBeNull();
    expect(scalarWindowListener).not.toHaveBeenCalled();
    expect(objectMetricsListener).not.toHaveBeenCalled();
  });

  it("submits the Compute Study command without broad result invalidations on acceptance", async () => {
    const registry = registryWithStudyRuntimeCommands();
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const submit = vi.fn(async () => ({
      accepted: true,
      command_id: "cmd-solve",
      error: null,
    }));
    const scalarWindowListener = vi.fn();
    const sessionStatusListener = vi.fn();
    const currentRunListener = vi.fn();
    resources.subscribe(`${DATA_SCALARS_PATH}?limit=100`, scalarWindowListener);
    resources.subscribe(SESSION_STATUS_RESOURCE_KEY, sessionStatusListener);
    resources.subscribe(SIMULATION_RUN_CURRENT_PATH, currentRunListener);

    const result = await registry.execute("study.run", {
      api: {
        commands: { submit },
      } as never,
      resourceData: runtimeResourceData(),
      resources,
      source: "test",
    });

    expect(result).toEqual({
      message: "Study compute command accepted.",
      status: "completed",
    });
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "solve",
        reason: "user_requested",
        target: { kind: "study" },
      }),
    );
    expect(resources.getRevision(SIMULATION_COMMANDS_PATH)).toBe("cmd-solve");
    expect(resources.getRevision(SIMULATION_STAGES_EXECUTION_PATH)).toBe(
      "cmd-solve",
    );
    expect(resources.getRevision(SIMULATION_SOLVER_STATUS_PATH)).toBe(
      "cmd-solve",
    );
    expect(resources.getRevision(SESSION_STATUS_RESOURCE_KEY)).toBeNull();
    expect(resources.getRevision(SIMULATION_RUN_CURRENT_PATH)).toBeNull();
    expect(resources.getRevision(DATA_SCALARS_PATH)).toBeNull();
    expect(sessionStatusListener).not.toHaveBeenCalled();
    expect(currentRunListener).not.toHaveBeenCalled();
    expect(scalarWindowListener).not.toHaveBeenCalled();
  });

  it("reports a clear disabled reason when the API facade is unavailable", () => {
    const registry = registryWithStudyRuntimeCommands();
    const context = { source: "test" as const };

    expect(registry.isEnabled("study.compute-fields", context)).toBe(false);
    expect(registry.get("study.compute-fields")?.disabledReason?.(context)).toBe(
      "Control-room API is unavailable.",
    );
  });

  it("saves runtime checkpoints through the persistence facade", async () => {
    const registry = registryWithStudyRuntimeCommands();
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const create = vi.fn(async () => ({
      checkpoint: {
        artifact_ref: "artifacts/checkpoints/cp-000042.fmstate",
        backend_family: "fdm_cpu",
        checkpoint_id: "cp-000042",
        checksum: "sha256:abc",
        coordinate_frame: "solver_domain",
        created_at: "2026-05-14T12:00:00Z",
        dt: 1e-13,
        field_revision: 7,
        format: "fmstate",
        mesh_revision: 5,
        resume_class: "logical_resume",
        run_id: "run-1",
        scene_revision: 3,
        source: "user_requested",
        step: 42,
        time_s: 2.5e-9,
        vector_count: 2,
      },
    }));
    const checkpointListener = vi.fn();
    resources.subscribe(PERSISTENCE_CHECKPOINTS_PATH, checkpointListener);

    const result = await registry.execute("study.save-checkpoint", {
      api: {
        persistence: {
          checkpoints: { create },
        },
      } as never,
      resourceData: {
        [SIMULATION_SOLVER_STATUS_PATH]: { runtime_state: "paused" },
      },
      resources,
      source: "test",
    });

    expect(result).toEqual({
      message: "Checkpoint saved.",
      status: "completed",
    });
    expect(create).toHaveBeenCalledWith({
      profile: "resume",
      reason: "user_requested",
    });
    expect(resources.getRevision(PERSISTENCE_CHECKPOINTS_PATH)).toBe("cp-000042");
    expect(resources.getRevision(SESSION_STATUS_RESOURCE_KEY)).toBe("cp-000042");
    expect(checkpointListener).toHaveBeenCalledWith("cp-000042");
  });

  it("restores checkpoints and invalidates field, scalar, energy, metric, and visualization resources", async () => {
    const registry = registryWithStudyRuntimeCommands();
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const restore = vi.fn(async () => ({
      checkpoint: {
        artifact_ref: "artifacts/checkpoints/cp-000042.fmstate",
        backend_family: "fdm_cpu",
        checkpoint_id: "cp-000042",
        checksum: "sha256:abc",
        coordinate_frame: "solver_domain",
        created_at: "2026-05-14T12:00:00Z",
        dt: 1e-13,
        field_revision: 8,
        format: "fmstate",
        mesh_revision: 5,
        resume_class: "logical_resume",
        run_id: "run-1",
        scene_revision: 3,
        source: "user_requested",
        step: 42,
        time_s: 2.5e-9,
        vector_count: 2,
      },
      field_revision: 8,
      restore_class: "logical_resume",
      restored_vector_count: 2,
      warnings: [],
    }));
    const fieldVectorKey = `${DATA_FIELD_VECTOR_PATH.replace(
      "{quantity_id}",
      "m",
    )}?component=full`;
    const objectMetricsKey = SIMULATION_OBJECT_METRICS_PATH.replace(
      "{object_id}",
      "arch_Waveguide",
    );
    const fieldVectorListener = vi.fn();
    const objectMetricsListener = vi.fn();
    resources.subscribe(fieldVectorKey, fieldVectorListener);
    resources.subscribe(objectMetricsKey, objectMetricsListener);

    const result = await registry.execute("study.restore-checkpoint", {
      api: {
        persistence: {
          checkpoints: { restore },
        },
      } as never,
      resourceData: {
        [PERSISTENCE_CHECKPOINTS_PATH]: {
          checkpoints: [
            {
              checkpoint_id: "cp-000042",
              resume_class: "logical_resume",
            },
          ],
        },
      },
      resources,
      source: "test",
    });

    expect(result).toEqual({
      message: "Checkpoint restored.",
      status: "completed",
    });
    expect(restore).toHaveBeenCalledWith("cp-000042", {
      reason: "user_requested",
    });
    expect(resources.getRevision(PERSISTENCE_CHECKPOINTS_PATH)).toBe(8);
    expect(resources.getRevision(SESSION_STATUS_RESOURCE_KEY)).toBe(8);
    expect(resources.getRevision(DATA_FIELDS_PATH)).toBe(8);
    expect(resources.getRevision(DATA_SCALARS_PATH)).toBe(8);
    expect(resources.getRevision(SIMULATION_SOLVER_ENERGIES_CURRENT_PATH)).toBe(8);
    expect(resources.getRevision(VISUALIZATION_STATE_PATH)).toBe(8);
    expect(fieldVectorListener).toHaveBeenCalledWith(8);
    expect(objectMetricsListener).toHaveBeenCalledWith(8);
  });

  it("exports state through the persistence facade", async () => {
    const registry = registryWithStudyRuntimeCommands();
    const bus = new EventBus<KernelEventMap>();
    const layout = new LayoutController(bus);
    const resources = new ResourceInvalidationController(bus);
    const create = vi.fn(async () => ({
      fms_base64: "Zm1z",
      profile: "resume",
      session_id: "session-1",
      size_bytes: 3,
    }));

    const result = await registry.execute("study.export-state", {
      api: {
        persistence: {
          exports: { create },
        },
      } as never,
      layout,
      resources,
      source: "test",
    });

    expect(result).toEqual({
      message: "State export created.",
      status: "completed",
    });
    expect(create).toHaveBeenCalledWith({
      profile: "resume",
      ui_state: {
        kernel_layout: {
          activeBottomPanelTab: "telemetry",
          activeModuleTab: "home",
          activeViewportMainModuleId: "viewport-3d",
          focusedSlot: null,
          panelVisible: {
            bottom: true,
            left: true,
            right: true,
          },
        },
        version: 1,
        workspace_layout: null,
      },
    });
    expect(resources.getRevision(PERSISTENCE_EXPORTS_PATH)).toBe("session-1");
  });

  it("submits VTK export through the runtime command facade", async () => {
    const registry = registryWithStudyRuntimeCommands();
    const submit = vi.fn(async () => ({
      accepted: true,
      command_id: "cmd-vtk",
    }));

    const result = await registry.execute("study.save-vtk", {
      api: {
        commands: { submit },
      } as never,
      resourceData: runtimeResourceData({
        activeStageIndex: 1,
        runtimeState: "idle",
      }),
      source: "test",
    });

    expect(result).toEqual({
      message: "VTK export command accepted.",
      status: "completed",
    });
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "save_vtk",
        target: {
          kind: "stage_id",
          stage_id: "stage-001",
        },
      }),
    );
  });

  it("exports selected object field state through the persistence facade", async () => {
    const registry = registryWithStudyRuntimeCommands();
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const exportFieldState = vi.fn(async () => ({
      artifact_ref: "field-states/body-m.h5",
      component_count: 3,
      field_revision: 7,
      format: "h5",
      point_count: 2,
      quantity_id: "m",
      target: { id: "body", kind: "object" },
    }));
    const artifactBytes = vi.fn(async () => ({
      data: new ArrayBuffer(4),
      error: null,
      etag: null,
      status: "ready",
    }));

    const result = await registry.execute("study.save-field-state", {
      api: {
        data: {
          artifacts: { bytes: artifactBytes },
        },
        persistence: {
          fieldStates: { export: exportFieldState },
        },
      } as never,
      input: { fileName: "body-m.h5" },
      resources,
      selection: objectSelection("body") as never,
      source: "test",
    });

    expect(result).toEqual({
      message: "Field state saved as field-states/body-m.h5.",
      status: "completed",
    });
    expect(exportFieldState).toHaveBeenCalledWith({
      file_name: "body-m.h5",
      format: "h5",
      quantity_id: "m",
      target: { id: "body", kind: "object" },
    });
    expect(artifactBytes).toHaveBeenCalledWith("field-states/body-m.h5");
    expect(resources.getRevision(PERSISTENCE_FIELD_STATE_EXPORTS_PATH)).toBe(
      "field-states/body-m.h5",
    );
  });

  it("loads selected object field state and invalidates live field resources", async () => {
    const registry = registryWithStudyRuntimeCommands();
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const inspectImport = vi.fn(async () => ({
      artifact_ref: "field-states/body-m.field-state.json",
      compatibility: "compatible",
      component_count: 3,
      default_mode: "apply",
      format: "field_state_json",
      point_count: 2,
      quantity_id: "m",
      target: { id: "body", kind: "object" },
      warnings: [],
    }));
    const importFieldState = vi.fn(async () => ({
      applied_point_count: 2,
      artifact_ref: "field-states/body-m.field-state.json",
      field_revision: 9,
      mode: "apply",
      quantity_id: "m",
      target: { id: "body", kind: "object" },
      warnings: [],
    }));

    const result = await registry.execute("study.load-field-state", {
      api: {
        persistence: {
          fieldStates: {
            import: importFieldState,
            inspectImport,
          },
        },
      } as never,
      input: { artifactRef: "field-states/body-m.field-state.json" },
      resources,
      selection: objectSelection("body") as never,
      source: "test",
    });

    expect(result).toEqual({
      message: "Field state loaded from field-states/body-m.field-state.json.",
      status: "completed",
    });
    expect(inspectImport).toHaveBeenCalledWith({
      artifact_ref: "field-states/body-m.field-state.json",
      format: "field_state_json",
      quantity_id: "m",
      target: { id: "body", kind: "object" },
    });
    expect(importFieldState).toHaveBeenCalledWith({
      artifact_ref: "field-states/body-m.field-state.json",
      mode: "apply",
      quantity_id: "m",
      target: { id: "body", kind: "object" },
    });
    expect(resources.getRevision(DATA_FIELDS_PATH)).toBe(9);
    expect(resources.getRevision(PERSISTENCE_FIELD_STATE_IMPORTS_PATH)).toBe(9);
    expect(
      resources.getRevision(PERSISTENCE_FIELD_STATE_IMPORT_INSPECTIONS_PATH),
    ).toBe(9);
  });

  it("uploads a selected field-state file before loading it", async () => {
    const registry = registryWithStudyRuntimeCommands();
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const importAsset = vi.fn(async () => ({
      asset_id: "body-m-h5",
      artifact_ref: "imports/body-m.h5",
      byte_length: 1024,
      summary: {
        kind: "field_state",
        label: "body-m.h5",
        notes: ["field-state import candidate"],
      },
    }));
    const inspectImport = vi.fn(async () => ({
      artifact_ref: "imports/body-m.h5",
      compatibility: "compatible",
      component_count: 3,
      default_mode: "apply",
      format: "field_state_json",
      point_count: 2,
      quantity_id: "m",
      target: { id: "body", kind: "object" },
      warnings: [],
    }));
    const importFieldState = vi.fn(async () => ({
      applied_point_count: 2,
      artifact_ref: "imports/body-m.h5",
      field_revision: 10,
      mode: "apply",
      quantity_id: "m",
      target: { id: "body", kind: "object" },
      warnings: [],
    }));

    const result = await registry.execute("study.load-field-state", {
      api: {
        persistence: {
          assets: { import: importAsset },
          fieldStates: {
            import: importFieldState,
            inspectImport,
          },
        },
      } as never,
      input: {
        contentBase64: "aDVm",
        fileName: "body-m.h5",
      },
      resources,
      selection: objectSelection("body") as never,
      source: "test",
    });

    expect(result).toEqual({
      message: "Field state loaded from imports/body-m.h5.",
      status: "completed",
    });
    expect(importAsset).toHaveBeenCalledWith({
      content_base64: "aDVm",
      file_name: "body-m.h5",
      target_realization: "field_state",
    });
    expect(inspectImport).toHaveBeenCalledWith({
      artifact_ref: "imports/body-m.h5",
      format: "field_state_json",
      quantity_id: "m",
      target: { id: "body", kind: "object" },
    });
    expect(importFieldState).toHaveBeenCalledWith({
      artifact_ref: "imports/body-m.h5",
      mode: "apply",
      quantity_id: "m",
      target: { id: "body", kind: "object" },
    });
    expect(resources.getRevision(DATA_FIELDS_PATH)).toBe(10);
    expect(resources.getRevision(PERSISTENCE_FIELD_STATE_IMPORTS_PATH)).toBe(10);
  });

  it("loads selected airbox field state as an attached artifact", async () => {
    const registry = registryWithStudyRuntimeCommands();
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const importAsset = vi.fn(async () => ({
      asset_id: "airbox-h-eff-h5",
      artifact_ref: "imports/airbox-h-eff.h5",
      byte_length: 1024,
      summary: {
        kind: "field_state",
        label: "airbox-h-eff.h5",
        notes: ["field-state import candidate"],
      },
    }));
    const inspectImport = vi.fn(async () => ({
      artifact_ref: "imports/airbox-h-eff.h5",
      compatibility: "compatible",
      component_count: 3,
      default_mode: "attach",
      format: "field_state_json",
      point_count: 4,
      quantity_id: "H_eff",
      target: { id: "airbox", kind: "airbox" },
      warnings: [],
    }));
    const importFieldState = vi.fn(async () => ({
      applied_point_count: 0,
      artifact_ref: "imports/airbox-h-eff.h5",
      field_revision: 7,
      mode: "attach",
      quantity_id: "H_eff",
      target: { id: "airbox", kind: "airbox" },
      warnings: [],
    }));

    const result = await registry.execute("study.load-field-state", {
      api: {
        persistence: {
          assets: { import: importAsset },
          fieldStates: {
            import: importFieldState,
            inspectImport,
          },
        },
      } as never,
      input: {
        contentBase64: "aDVm",
        fileName: "airbox-h-eff.h5",
      },
      resources,
      selection: airboxSelection() as never,
      source: "test",
    });

    expect(result).toEqual({
      message: "Field state loaded from imports/airbox-h-eff.h5.",
      status: "completed",
    });
    expect(inspectImport).toHaveBeenCalledWith({
      artifact_ref: "imports/airbox-h-eff.h5",
      format: "field_state_json",
      quantity_id: "H_eff",
      target: { id: "airbox", kind: "airbox" },
    });
    expect(importFieldState).toHaveBeenCalledWith({
      artifact_ref: "imports/airbox-h-eff.h5",
      mode: "attach",
      quantity_id: "H_eff",
      target: { id: "airbox", kind: "airbox" },
    });
    expect(resources.getRevision(PERSISTENCE_FIELD_STATE_IMPORTS_PATH)).toBe(7);
  });

  it("imports state through the persistence facade and invalidates restored session resources", async () => {
    const registry = registryWithStudyRuntimeCommands();
    const bus = new EventBus<KernelEventMap>();
    const layout = new LayoutController(bus);
    const resources = new ResourceInvalidationController(bus);
    const inspect = vi.fn(async () => ({
      inspection: {
        created_at: "2026-05-15T00:00:00Z",
        created_by_version: "test",
        format_version: "1",
        name: "Imported session",
        profile: "resume",
        restore_class: "logical_resume",
        run_count: 1,
        saved_at: "2026-05-15T00:00:00Z",
        session_id: "session-imported",
        total_size_bytes: 128,
        warnings: [],
      },
    }));
    const commit = vi.fn(async () => ({
      restore_class: "logical_resume",
      session_id: "session-imported",
      ui_state: {
        kernel_layout: {
          activeModuleTab: "study",
          activeViewportMainModuleId: "analysis-plots",
          focusedSlot: "panel-right",
          panelVisible: {
            bottom: false,
            left: false,
            right: true,
          },
        },
        version: 1,
        workspace_layout: null,
      },
      warnings: [],
    }));
    const fieldVectorKey = `${DATA_FIELD_VECTOR_PATH.replace(
      "{quantity_id}",
      "m",
    )}?component=full`;
    const fieldVectorListener = vi.fn();
    resources.subscribe(fieldVectorKey, fieldVectorListener);

    const result = await registry.execute("study.import-state", {
      api: {
        persistence: {
          imports: { commit, inspect },
        },
      } as never,
      input: {
        fmsBase64: "Zm1z",
        restoreMode: "resume",
      },
      layout,
      resources,
      source: "test",
    });

    expect(result).toEqual({
      message: "State imported from session-imported.",
      status: "completed",
    });
    expect(inspect).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledWith({
      fms_base64: "Zm1z",
      restore_mode: "resume",
    });
    expect(resources.getRevision(PERSISTENCE_IMPORTS_PATH)).toBe(
      "session-imported",
    );
    expect(resources.getRevision(SESSION_STATUS_RESOURCE_KEY)).toBe(
      "session-imported",
    );
    expect(resources.getRevision(DATA_FIELDS_PATH)).toBe("session-imported");
    expect(resources.getRevision(DATA_SCALARS_PATH)).toBe("session-imported");
    expect(resources.getRevision(VISUALIZATION_STATE_PATH)).toBe(
      "session-imported",
    );
    expect(fieldVectorListener).toHaveBeenCalledWith("session-imported");
    expect(layout.get()).toMatchObject({
      activeModuleTab: "study",
      activeViewportMainModuleId: "analysis-plots",
      focusedSlot: "panel-right",
      panelVisible: {
        bottom: false,
        left: false,
        right: true,
      },
    });
  });

  it("gates runtime controls from resource-backed runtime state", () => {
    const registry = registryWithStudyRuntimeCommands();
    const api = {} as never;
    const runningContext = {
      api,
      resourceData: runtimeResourceData({
        activeStageIndex: 1,
        runtimeState: "running",
      }),
      source: "test" as const,
    };
    const pausedContext = {
      api,
      resourceData: runtimeResourceData({
        activeStageIndex: 1,
        runtimeState: "paused",
      }),
      source: "test" as const,
    };
    const idleContext = {
      api,
      resourceData: runtimeResourceData(),
      source: "test" as const,
    };

    expect(registry.isEnabled("study.pause", runningContext)).toBe(true);
    expect(registry.isEnabled("study.resume", runningContext)).toBe(false);
    expect(registry.get("study.resume")?.disabledReason?.(runningContext)).toBe(
      "Runtime is not paused.",
    );
    expect(registry.isEnabled("study.resume", pausedContext)).toBe(true);
    expect(registry.isEnabled("study.stop", pausedContext)).toBe(true);
    expect(registry.isEnabled("study.discard-paused-state", pausedContext)).toBe(
      true,
    );
    expect(registry.isEnabled("study.discard-paused-state", runningContext)).toBe(
      false,
    );
    expect(
      registry
        .get("study.discard-paused-state")
        ?.disabledReason?.(runningContext),
    ).toBe("Runtime is not paused.");
    expect(registry.isEnabled("study.skip", runningContext)).toBe(true);
    expect(registry.isEnabled("study.pause", idleContext)).toBe(false);
    expect(registry.get("study.pause")?.disabledReason?.(idleContext)).toBe(
      "Runtime is not running.",
    );
  });

  it("uses backend runtime control readback when command readiness is published", () => {
    const registry = registryWithStudyRuntimeCommands();
    const context = {
      api: {} as never,
      resourceData: runtimeResourceData({
        activeStageIndex: 1,
        runtimeControls: [
          {
            enabled: false,
            kind: "pause",
            reason: "Runtime backend is draining.",
          },
        ],
        runtimeState: "running",
      }),
      source: "test" as const,
    };

    expect(registry.isEnabled("study.pause", context)).toBe(false);
    expect(registry.get("study.pause")?.disabledReason?.(context)).toBe(
      "Runtime backend is draining.",
    );
  });

  it("does not let stale state-derived backend readiness override fresher solver state", () => {
    const registry = registryWithStudyRuntimeCommands();
    const context = {
      api: {} as never,
      resourceData: runtimeResourceData({
        activeStageIndex: 1,
        runtimeControls: [
          {
            enabled: false,
            kind: "pause",
            reason: "Runtime is not running.",
          },
        ],
        runtimeState: "running",
      }),
      source: "test" as const,
    };

    expect(registry.isEnabled("study.pause", context)).toBe(true);
    expect(registry.get("study.pause")?.disabledReason?.(context)).toBeNull();
  });

  it("marks study runtime commands active from the command queue", () => {
    const registry = registryWithStudyRuntimeCommands();
    const activeStatuses = [
      "accepted",
      "dispatched",
      "pending",
      "queued",
      "running",
    ];
    const inactiveStatuses = ["completed", "failed", "rejected"];
    const commandKinds = [
      ["study.run", "solve"],
      ["study.pause", "pause"],
      ["study.resume", "resume"],
      ["study.stop", "stop"],
      ["study.skip", "skip"],
      ["study.compute-fields", "compute_fields"],
      ["study.compute-energies", "compute_energies"],
    ] as const;

    for (const [commandId, kind] of commandKinds) {
      for (const status of activeStatuses) {
        expect(
          registry.isActive(commandId, {
            api: {} as never,
            resourceData: runtimeResourceData({
              commands: [{ command_id: "cmd-active", kind, status }],
            }),
            source: "test",
          }),
          `${commandId} ${status}`,
        ).toBe(true);
      }

      for (const status of inactiveStatuses) {
        expect(
          registry.isActive(commandId, {
            api: {} as never,
            resourceData: runtimeResourceData({
              commands: [{ command_id: "cmd-inactive", kind, status }],
            }),
            source: "test",
          }),
          `${commandId} ${status}`,
        ).toBe(false);
      }
    }
  });

  it("marks discard active only for explicit discard stop commands", () => {
    const registry = registryWithStudyRuntimeCommands();
    const baseContext = {
      api: {} as never,
      resourceData: runtimeResourceData({
        commands: [
          {
            command_id: "cmd-stop",
            kind: "stop",
            status: "running",
          },
        ],
      }),
      source: "test" as const,
    };
    const discardContext = {
      ...baseContext,
      resourceData: runtimeResourceData({
        commands: [
          {
            command_id: "cmd-discard",
            kind: "stop",
            reason: "discard_paused_state",
            status: "running",
          },
        ],
      }),
    };

    expect(registry.isActive("study.stop", baseContext)).toBe(true);
    expect(registry.isActive("study.discard-paused-state", baseContext)).toBe(
      false,
    );
    expect(registry.isActive("study.discard-paused-state", discardContext)).toBe(
      true,
    );
  });

  it("requires session status before starting compute commands", () => {
    const registry = registryWithStudyRuntimeCommands();
    const api = {} as never;
    const resourceData = { ...runtimeResourceData() };
    delete resourceData[SESSION_STATUS_RESOURCE_KEY];
    const context = {
      api,
      resourceData,
      source: "test" as const,
    };

    expect(registry.isEnabled("study.run", context)).toBe(false);
    expect(registry.get("study.run")?.disabledReason?.(context)).toBe(
      "Session status is unavailable.",
    );
  });

  it("gates compute fields on the active data-plane capability", () => {
    const registry = registryWithStudyRuntimeCommands();
    const context = {
      api: {} as never,
      resourceData: runtimeResourceData({ binaryFields: false }),
      source: "test" as const,
    };

    expect(registry.isEnabled("study.compute-fields", context)).toBe(false);
    expect(
      registry.get("study.compute-fields")?.disabledReason?.(context),
    ).toBe("Field data plane is unavailable.");
  });

  it("blocks runtime start commands while geometry validation has runtime blockers", () => {
    const registry = registryWithStudyRuntimeCommands();
    const context = {
      api: {} as never,
      resourceData: runtimeResourceData({
        geometryValidation: {
          diagnostics: [
            {
              message: "Geometry self-intersection",
              severity: "error",
            },
          ],
        },
      }),
      source: "test" as const,
    };

    expect(registry.isEnabled("study.run", context)).toBe(false);
    expect(registry.get("study.run")?.disabledReason?.(context)).toBe(
      "Resolve geometry validation blockers before running runtime commands.",
    );
  });

  it("blocks runtime start commands while geometry validation is dirty", () => {
    const registry = registryWithStudyRuntimeCommands();
    const context = {
      api: {} as never,
      resourceData: runtimeResourceData({
        discretization: "fem",
        geometryValidation: { dirty: true, diagnostics: [] },
        meshPipelineStatus: [
          { id: "readiness", label: "Solver Readiness", status: "done" },
        ],
        meshRevision: 5,
      }),
      source: "test" as const,
    };

    expect(registry.isEnabled("study.compute-fields", context)).toBe(false);
    expect(
      registry.get("study.compute-fields")?.disabledReason?.(context),
    ).toBe(
      "Resolve geometry validation blockers before running runtime commands.",
    );
  });

  it("blocks runtime start commands while a mesh build is active", () => {
    const registry = registryWithStudyRuntimeCommands();
    const context = {
      api: {} as never,
      resourceData: runtimeResourceData({ meshBuildStatus: "running" }),
      source: "test" as const,
    };

    expect(registry.isEnabled("study.run", context)).toBe(false);
    expect(registry.get("study.run")?.disabledReason?.(context)).toBe(
      "A mesh build is still running.",
    );

    const pipelineContext = {
      api: {} as never,
      resourceData: {
        ...runtimeResourceData(),
        [MESHING_BUILDS_CURRENT_PATH]: {
          mesh_pipeline_status: [
            { id: "generate", label: "Generate", status: "running" },
          ],
        },
      },
      source: "test" as const,
    };

    expect(registry.isEnabled("study.run", pipelineContext)).toBe(false);
  });

  it("blocks runtime start commands for region-owned capability diagnostics", () => {
    const registry = registryWithStudyRuntimeCommands();
    const context = {
      api: {} as never,
      resourceData: runtimeResourceData({
        regionDiagnostics: {
          scene_revision: 3,
          diagnostics: [
            {
              capability_gate: "regions.realized_materialization",
              code: "region_world_frame_materialization_unsupported",
              diagnostic_id: "region:r1:world-frame-materialization",
              message:
                "World-frame authored regions require explicit materialization before execution.",
              owner_object_id: "obj1",
              realization_status: "authored",
              region_id: "r1",
              severity: "warning",
            },
          ],
        },
      }),
      source: "test" as const,
    };

    expect(registry.isEnabled("study.run", context)).toBe(false);
    expect(registry.get("study.run")?.disabledReason?.(context)).toBe(
      "Region materialization support blocker: World-frame authored regions require explicit materialization before execution.",
    );
  });

  it("does not block runtime start commands for informational region material realization notes", () => {
    const registry = registryWithStudyRuntimeCommands();
    const context = {
      api: {} as never,
      resourceData: runtimeResourceData({
        regionDiagnostics: {
          scene_revision: 3,
          diagnostics: [
            {
              capability_gate: "regions.material_override",
              code: "region_material_realization_required",
              diagnostic_id: "region:r1:material-required",
              message:
                "Region material override or material field is authored; execution planning must materialize it or block unsupported runtime paths.",
              owner_object_id: "obj1",
              realization_status: "authored",
              region_id: "r1",
              severity: "info",
            },
          ],
        },
      }),
      source: "test" as const,
    };

    expect(registry.isEnabled("study.run", context)).toBe(true);
    expect(registry.get("study.run")?.disabledReason?.(context)).toBeNull();
  });

  it("requires current shared-domain mesh provenance for FEM runtime start commands", () => {
    const registry = registryWithStudyRuntimeCommands();
    const api = {} as never;
    const noMeshContext = {
      api,
      resourceData: runtimeResourceData({ discretization: "fem" }),
      source: "test" as const,
    };
    const staleMeshContext = {
      api,
      resourceData: runtimeResourceData({
        discretization: "fem",
        meshRevision: 5,
        meshSourceSceneRevision: 2,
        sceneRevision: 3,
      }),
      source: "test" as const,
    };
    const currentMeshContext = {
      api,
      resourceData: runtimeResourceData({
        discretization: "fem",
        meshRevision: 5,
        meshSourceSceneRevision: 3,
        sceneRevision: 3,
      }),
      source: "test" as const,
    };

    expect(registry.isEnabled("study.run", noMeshContext)).toBe(false);
    expect(registry.get("study.run")?.disabledReason?.(noMeshContext)).toBe(
      "Build a current shared-domain mesh before running. Open Mesh Jobs or Build Shared-Domain Mesh.",
    );
    expect(registry.isEnabled("study.run", staleMeshContext)).toBe(false);
    expect(registry.get("study.run")?.disabledReason?.(staleMeshContext)).toBe(
      "Build a current shared-domain mesh before running. Open Mesh Jobs or Build Shared-Domain Mesh.",
    );
    expect(registry.isEnabled("study.run", currentMeshContext)).toBe(true);
  });

  it("does not bypass local FEM mesh readiness when backend reports compute enabled", () => {
    const registry = registryWithStudyRuntimeCommands();
    const resourceData = runtimeResourceData({
      discretization: "fem",
      meshRevision: 5,
      runtimeControls: [
        { kind: "compute_fields", enabled: true },
        { kind: "compute_energies", enabled: true },
        { kind: "solve", enabled: true },
      ],
    });
    const manifest = resourceData[MESHING_SHARED_DOMAIN_MANIFEST_PATH] as {
      source_scene_revision?: number | null;
    };
    manifest.source_scene_revision = null;
    const context = {
      api: {} as never,
      resourceData,
      source: "test" as const,
    };

    expect(registry.isEnabled("study.compute-fields", context)).toBe(false);
    expect(
      registry.get("study.compute-fields")?.disabledReason?.(context),
    ).toBe(
      "Build a current shared-domain mesh before running. Open Mesh Jobs or Build Shared-Domain Mesh.",
    );
    expect(registry.isEnabled("study.compute-energies", context)).toBe(false);
    expect(registry.isEnabled("study.run", context)).toBe(false);
  });

  it("accepts generated shared-domain meshes once the build pipeline is ready", () => {
    const registry = registryWithStudyRuntimeCommands();
    const resourceData = runtimeResourceData({
      discretization: "fem",
      meshPipelineStatus: [
        { id: "queued", label: "Queued", status: "done" },
        { id: "ready", label: "Ready", status: "active" },
      ],
      meshRevision: 5,
    });
    const manifest = resourceData[MESHING_SHARED_DOMAIN_MANIFEST_PATH] as {
      source_scene_revision?: number | null;
    };
    manifest.source_scene_revision = null;
    const context = {
      api: {} as never,
      resourceData,
      source: "test" as const,
    };

    expect(registry.isEnabled("study.compute-fields", context)).toBe(true);
    expect(
      registry.get("study.compute-fields")?.disabledReason?.(context),
    ).toBeNull();
    expect(registry.isEnabled("study.compute-energies", context)).toBe(true);
    expect(registry.isEnabled("study.run", context)).toBe(true);
  });

  it("accepts generated shared-domain meshes when solver readiness is done", () => {
    const registry = registryWithStudyRuntimeCommands();
    const resourceData = runtimeResourceData({
      discretization: "fem",
      meshPipelineStatus: [
        { id: "import", label: "Import", status: "done" },
        { id: "generate", label: "Generate", status: "done" },
        { id: "validation", label: "Validation", status: "done" },
        { id: "readiness", label: "Solver Readiness", status: "done" },
      ],
      meshRevision: 38,
    });
    const manifest = resourceData[MESHING_SHARED_DOMAIN_MANIFEST_PATH] as {
      source_scene_revision?: number | null;
    };
    manifest.source_scene_revision = null;
    const context = {
      api: {} as never,
      resourceData,
      source: "test" as const,
    };

    expect(registry.isEnabled("study.compute-fields", context)).toBe(true);
    expect(
      registry.get("study.compute-fields")?.disabledReason?.(context),
    ).toBeNull();
    expect(registry.isEnabled("study.compute-energies", context)).toBe(true);
    expect(registry.isEnabled("study.run", context)).toBe(true);
  });

  it("submits paused-state discard as a stop command with explicit intent", async () => {
    const registry = registryWithStudyRuntimeCommands();
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const submit = vi.fn(async () => ({
      accepted: true,
      command_id: "cmd-discard",
      error: null,
    }));

    const result = await registry.execute("study.discard-paused-state", {
      api: {
        commands: { submit },
      } as never,
      resourceData: runtimeResourceData({
        activeStageIndex: 1,
        commandCount: 2,
        runtimeState: "paused",
        stageRevision: 9,
      }),
      resources,
      source: "test",
    });

    expect(result).toEqual({
      message: "Paused state discard command accepted.",
      status: "completed",
    });
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "stop",
        precondition: {
          command_revision: 2,
          runtime_state: "paused",
          stage_execution_revision: 9,
        },
        reason: "discard_paused_state",
        target: { kind: "stage_id", stage_id: "stage-001" },
      }),
    );
    expect(resources.getRevision(SIMULATION_COMMANDS_PATH)).toBe("cmd-discard");
    expect(resources.getRevision(SIMULATION_STAGES_EXECUTION_PATH)).toBe(
      "cmd-discard",
    );
    expect(resources.getRevision(SIMULATION_SOLVER_STATUS_PATH)).toBe(
      "cmd-discard",
    );
    expect(resources.getRevision(SESSION_STATUS_RESOURCE_KEY)).toBeNull();
  });

  it("submits runtime controls with active-stage target and revision preconditions", async () => {
    const registry = registryWithStudyRuntimeCommands();
    const resources = new ResourceInvalidationController(new EventBus<KernelEventMap>());
    const submit = vi.fn(async () => ({
      accepted: true,
      command_id: "cmd-pause",
      error: null,
    }));

    const result = await registry.execute("study.pause", {
      api: {
        commands: { submit },
      } as never,
      resourceData: runtimeResourceData({
        activeStageIndex: 1,
        commandCount: 3,
        runtimeState: "running",
        stageRevision: 11,
      }),
      resources,
      source: "test",
    });

    expect(result).toEqual({
      message: "Pause command accepted.",
      status: "completed",
    });
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "pause",
        precondition: {
          command_revision: 3,
          runtime_state: "running",
          stage_execution_revision: 11,
        },
        target: { kind: "stage_id", stage_id: "stage-001" },
      }),
    );
  });

  it("refreshes pause, stop, and skip preconditions from the command ledger count", async () => {
    const registry = registryWithStudyRuntimeCommands();
    const cases = [
      ["study.pause", "pause"],
      ["study.stop", "stop"],
      ["study.skip", "skip"],
    ] as const;

    for (const [commandId, kind] of cases) {
      const submit = vi.fn(async () => ({
        accepted: true,
        command_id: `cmd-${kind}`,
        error: null,
      }));
      const list = vi.fn(async () => ({
        accepted_count: 0,
        can_accept_commands: true,
        commands: [
          {
            command_id: "cmd-existing",
            kind: "solve",
            status: "completed",
          },
        ],
        completed_count: 1,
        dispatched_count: 0,
        failed_count: 0,
        pending_count: 0,
        rejected_count: 0,
        revision: 99,
        running_count: 0,
        runtime_controls: [],
      }));
      const status = vi.fn(async () => ({
        revision: 31,
        runtime_state: "running",
      }));
      const execution = vi.fn(async () => ({
        active_stage_index: 1,
        revision: 22,
        runtime_state: "running",
        stages: [
          { stage_id: "stage-000" },
          { stage_id: "stage-001" },
          { stage_id: "stage-002" },
        ],
      }));

      const result = await registry.execute(commandId, {
        api: {
          commands: { list, submit },
          simulation: {
            solver: { status },
            stages: { execution },
          },
        } as never,
        resourceData: runtimeResourceData({
          activeStageIndex: 1,
          commandCount: 3,
          runtimeState: "running",
          stageRevision: 11,
        }),
        source: "test",
      });

      expect(result.status).toBe("completed");
      expect(submit).toHaveBeenCalledWith(
        expect.objectContaining({
          kind,
          precondition: {
            command_revision: 1,
            runtime_state: "running",
            stage_execution_revision: 22,
          },
          target: { kind: "stage_id", stage_id: "stage-001" },
        }),
      );
    }
  });

  it("refreshes runtime command preconditions from the command ledger count before submit", async () => {
    const registry = registryWithStudyRuntimeCommands();
    const submit = vi.fn(async () => ({
      accepted: true,
      command_id: "cmd-run",
      error: null,
    }));
    const list = vi.fn(async () => ({
      accepted_count: 0,
      can_accept_commands: true,
      commands: [],
      completed_count: 0,
      dispatched_count: 0,
      failed_count: 0,
      pending_count: 0,
      rejected_count: 0,
      revision: 12,
      running_count: 0,
      runtime_controls: [],
    }));
    const status = vi.fn(async () => ({
      revision: 31,
      runtime_state: "awaiting_command",
    }));
    const execution = vi.fn(async () => ({
      active_stage_index: 0,
      revision: 14,
      runtime_state: "awaiting_command",
      stages: [{ stage_id: "stage-000" }],
    }));

    const result = await registry.execute("study.run", {
      api: {
        commands: { list, submit },
        simulation: {
          solver: { status },
          stages: { execution },
        },
      } as never,
      resourceData: runtimeResourceData({
        commandCount: 3,
        regionCoefficientsRevision: 17,
        regionInitialStateRevision: 18,
        regionMembershipRevision: 16,
        regionTopologyRevision: 15,
        runtimeState: "cancelled",
        stageRevision: 9,
      }),
      source: "test",
    });

    expect(result).toEqual({
      message: "Study compute command accepted.",
      status: "completed",
    });
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "solve",
        precondition: {
          command_revision: 0,
          region_coefficients_revision: 17,
          region_initial_state_revision: 18,
          region_membership_revision: 16,
          region_topology_revision: 15,
          runtime_state: "awaiting_command",
        },
      }),
    );
  });

  it("does not attach stage revision preconditions to study-level compute commands", async () => {
    const registry = registryWithStudyRuntimeCommands();
    const submit = vi.fn(async () => ({
      accepted: true,
      command_id: "cmd-energies",
      error: null,
    }));
    const list = vi.fn(async () => ({
      accepted_count: 0,
      can_accept_commands: true,
      commands: [],
      completed_count: 0,
      dispatched_count: 0,
      failed_count: 0,
      pending_count: 0,
      rejected_count: 0,
      revision: 8,
      running_count: 0,
      runtime_controls: [],
    }));
    const status = vi.fn(async () => ({
      revision: 19,
      runtime_state: "awaiting_command",
    }));
    const execution = vi.fn(async () => ({
      active_stage_index: null,
      revision: 22,
      runtime_state: "awaiting_command",
      stages: [],
    }));

    const result = await registry.execute("study.compute-energies", {
      api: {
        commands: { list, submit },
        simulation: {
          solver: { status },
          stages: { execution },
        },
      } as never,
      resourceData: runtimeResourceData({
        commandCount: 7,
        runtimeState: "awaiting_command",
        stageRevision: 18,
      }),
      source: "test",
    });

    expect(result).toEqual({
      message: "Compute energies command accepted.",
      status: "completed",
    });
    expect(submit).toHaveBeenCalledTimes(1);
    const [request] = submit.mock.calls[0] as unknown as [
      { precondition?: Record<string, unknown> },
    ];
    expect(request.precondition).toEqual({
      command_revision: 0,
      runtime_state: "awaiting_command",
    });
  });

  it("gates checkpoint saving on resource-backed runtime state", () => {
    const registry = registryWithStudyRuntimeCommands();
    const api = {} as never;
    const pausedContext = {
      api,
      resourceData: runtimeResourceData({ runtimeState: "paused" }),
      source: "test" as const,
    };
    const idleContext = {
      api,
      resourceData: runtimeResourceData(),
      source: "test" as const,
    };

    expect(registry.isEnabled("study.save-checkpoint", pausedContext)).toBe(true);
    expect(registry.isEnabled("study.save-checkpoint", idleContext)).toBe(false);
    expect(
      registry.get("study.save-checkpoint")?.disabledReason?.(idleContext),
    ).toBe("No runtime magnetization state is available to checkpoint.");
  });

  it("requires a restorable checkpoint before enabling checkpoint restore", () => {
    const registry = registryWithStudyRuntimeCommands();
    const api = {} as never;
    const emptyContext = {
      api,
      resourceData: {
        [PERSISTENCE_CHECKPOINTS_PATH]: { checkpoints: [] },
      },
      source: "test" as const,
    };
    const configOnlyContext = {
      api,
      resourceData: {
        [PERSISTENCE_CHECKPOINTS_PATH]: {
          checkpoints: [
            {
              checkpoint_id: "cp-config",
              resume_class: "config_only",
            },
          ],
        },
      },
      source: "test" as const,
    };

    expect(registry.isEnabled("study.restore-checkpoint", emptyContext)).toBe(
      false,
    );
    expect(
      registry.get("study.restore-checkpoint")?.disabledReason?.(emptyContext),
    ).toBe("No checkpoint is selected.");
    expect(registry.isEnabled("study.restore-checkpoint", configOnlyContext)).toBe(
      false,
    );
    expect(
      registry
        .get("study.restore-checkpoint")
        ?.disabledReason?.(configOnlyContext),
    ).toBe("Selected checkpoint does not contain magnetization state.");
  });

  it("prevents starting a study while a runtime command is active", () => {
    const registry = registryWithStudyRuntimeCommands();
    const context = {
      api: {} as never,
      resourceData: {
        ...runtimeResourceData(),
        [SIMULATION_COMMANDS_PATH]: {
          commands: [{ status: "running" }],
        },
      },
      source: "test" as const,
    };

    expect(registry.isEnabled("study.run", context)).toBe(false);
    expect(registry.get("study.run")?.disabledReason?.(context)).toBe(
      "A runtime command is already active.",
    );
  });

  it("does not let stale active command queue block a newer inactive lifecycle state", () => {
    const registry = registryWithStudyRuntimeCommands();
    const context = {
      api: {} as never,
      resourceData: runtimeResourceData({
        commands: [
          {
            command_id: "cmd-stale-solve",
            kind: "solve",
            status: "running",
          },
        ],
        runtimeControls: [
          {
            enabled: false,
            kind: "solve",
            reason: "A runtime command is already active.",
          },
        ],
        runtimeState: "awaiting_command",
        stageRevision: 36,
      }),
      source: "test" as const,
    };

    expect(registry.isEnabled("study.run", context)).toBe(true);
    expect(registry.isActive("study.run", context)).toBe(false);
    expect(registry.get("study.run")?.disabledReason?.(context)).toBeNull();
  });

  it("does not let stale active command queue block a backend reset to idle", () => {
    const registry = registryWithStudyRuntimeCommands();
    const context = {
      api: {} as never,
      resourceData: runtimeResourceData({
        commands: [
          {
            command_id: "cmd-before-reset",
            kind: "solve",
            status: "running",
          },
        ],
        runtimeControls: [
          {
            enabled: false,
            kind: "solve",
            reason: "A runtime command is already active.",
          },
        ],
        runtimeState: "idle",
        stageRevision: 42,
      }),
      source: "test" as const,
    };

    expect(registry.isEnabled("study.run", context)).toBe(true);
    expect(registry.isActive("study.run", context)).toBe(false);
    expect(registry.get("study.run")?.disabledReason?.(context)).toBeNull();
  });

  describe("dynamics command contributions", () => {
    it("keeps presentation actions disabled until real command contracts exist", async () => {
      const registry = registryWithStudyRuntimeCommands();
      const context = {
        api: {} as never,
        source: "test" as const,
      };
      const ids = [
        "study.open-dynamics-workbench",
        "study.plot-selected-mode",
        "study.plot-selected-response-field",
        "study.animate-phase",
        "study.compare-selected-peak",
        "study.export-selected-metadata",
      ];

      for (const id of ids) {
        expect(registry.isEnabled(id, context), id).toBe(false);
        expect(registry.get(id)?.disabledReason?.(context), id).toContain(
          "is not implemented",
        );
        const res = await registry.get(id)?.run(context);
        expect(res?.status, id).toBe("failed");
        expect(res?.message, id).toContain("is not implemented");
      }
    });

    it("handles gated authoring/transaction actions", async () => {
      const registry = registryWithStudyRuntimeCommands();

      // Case 1: Session status unavailable
      const context1 = {
        api: {} as never,
        resourceData: {},
        source: "test" as const,
      };
      expect(registry.isEnabled("study.trigger-field-calculation", context1)).toBe(false);
      expect(registry.get("study.trigger-field-calculation")?.disabledReason?.(context1)).toBe("Session status is unavailable.");
      expect(registry.isEnabled("study.update-k-path", context1)).toBe(false);
      expect(registry.get("study.update-k-path")?.disabledReason?.(context1)).toBe("Session status is unavailable.");

      // Case 2: Capabilities missing
      const context2 = {
        api: {} as never,
        resourceData: {
          [SESSION_STATUS_RESOURCE_KEY]: {
            capabilities: {
              binary_fields: false,
              eigen_modes: false,
            },
          },
        },
        source: "test" as const,
      };
      expect(registry.isEnabled("study.trigger-field-calculation", context2)).toBe(false);
      expect(registry.get("study.trigger-field-calculation")?.disabledReason?.(context2)).toContain("does not support binary_fields");
      expect(registry.isEnabled("study.update-k-path", context2)).toBe(false);
      expect(registry.get("study.update-k-path")?.disabledReason?.(context2)).toContain("does not support eigen_modes");

      // Case 3: Capabilities present
      const submit = vi.fn(async () => ({
        accepted: true,
        command_id: "cmd-fields",
        error: null,
      }));
      const context3ResourceData = runtimeResourceData();
      const status = context3ResourceData[SESSION_STATUS_RESOURCE_KEY] as {
        capabilities: Record<string, unknown>;
      };
      status.capabilities.eigen_modes = true;
      const context3 = {
        api: {
          commands: { submit },
        } as never,
        resourceData: context3ResourceData,
        source: "test" as const,
      };
      expect(registry.isEnabled("study.trigger-field-calculation", context3)).toBe(true);
      expect(registry.get("study.trigger-field-calculation")?.disabledReason?.(context3)).toBeNull();
      expect(registry.isEnabled("study.update-k-path", context3)).toBe(false);
      expect(registry.get("study.update-k-path")?.disabledReason?.(context3)).toBe("Update k-Path is not implemented yet.");

      const res1 = await registry.get("study.trigger-field-calculation")?.run(context3);
      expect(res1?.status).toBe("completed");
      expect(res1?.message).toBe("Field calculation command accepted.");
      expect(submit).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "compute_fields",
          reason: "user_requested",
          target: { kind: "study" },
        }),
      );
      const res2 = await registry.get("study.update-k-path")?.run(context3);
      expect(res2?.status).toBe("failed");
      expect(res2?.message).toBe("Update k-Path is not implemented yet.");
    });
  });
});
