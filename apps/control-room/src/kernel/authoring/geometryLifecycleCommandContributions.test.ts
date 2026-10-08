import { describe, expect, it, vi } from "vitest";
import { ControlRoomApiError } from "../api/ControlRoomApi";

import {
  MESHING_BUILDS_CURRENT_PATH,
  MESHING_BUILDS_PATH,
  MESHING_CAPABILITIES_PATH,
  MESHING_OBJECT_QUALITY_PATH,
  MESHING_OBJECT_REPORT_PATH,
  MESHING_OBJECT_TOPOLOGY_PATH,
  MESHING_SHARED_DOMAIN_MANIFEST_PATH,
  MESHING_SHARED_DOMAIN_QUALITY_DATA_PATH,
  MESHING_SHARED_DOMAIN_QUALITY_GATES_PATH,
  MESHING_SHARED_DOMAIN_QUALITY_PATH,
  MESHING_SHARED_DOMAIN_REALIZED_SIZE_FIELDS_PATH,
  MESHING_SHARED_DOMAIN_REPORT_PATH,
  MESHING_SEMANTICS_PATH,
  MESHING_SUMMARY_PATH,
  MODEL_GEOMETRY_CAPABILITIES_PATH,
  MODEL_GEOMETRY_DIAGNOSTICS_PATH,
  MODEL_GEOMETRY_REALIZATION_CURRENT_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
  MODEL_READINESS_PATH,
  MODEL_REALIZED_REGIONS_PATH,
  MODEL_REGION_DIAGNOSTICS_PATH,
  MODEL_SCENE_PATH,
  MODEL_UNIVERSE_PATH,
  SIMULATION_PREPARATION_PATH,
} from "../api/apiPaths";
import type { CommandContext } from "../commands/commandTypes";
import { CommandRegistry } from "../commands/CommandRegistry";
import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import { ResourceInvalidationController } from "../resources/ResourceInvalidationController";
import { SESSION_STATUS_RESOURCE_KEY } from "../resources/useSessionStatus";
import { activeLaneCapabilityFixture } from "../resources/activeLaneCapabilityFixture.testSupport";
import { SelectionController } from "../selection/SelectionController";

import {
  FEM_GRID_COMMAND_NOT_APPLICABLE_REASON,
  FDM_MESH_COMMAND_NOT_APPLICABLE_REASON,
  GEOMETRY_LIFECYCLE_COMMANDS,
  UNKNOWN_GRID_COMMAND_LANE_REASON,
  UNKNOWN_MESH_COMMAND_LANE_REASON,
  resolveMeshCommandLane,
  resumeMeshBuildObservation,
  restoreMeshBuildObservation,
  runFdmGridRefreshOperation,
} from "./geometryLifecycleCommandContributions";

function registryWithLifecycleCommands(confirm = true): CommandRegistry {
  const registry = new CommandRegistry();
  const fallbackBus = new EventBus<KernelEventMap>();
  const configuredBuses = new WeakSet<EventBus<KernelEventMap>>();
  registry.attach(fallbackBus);
  for (const command of GEOMETRY_LIFECYCLE_COMMANDS) {
    registry.register({ ...command, run: (context) => {
      const bus = context.bus ?? fallbackBus;
      if (!configuredBuses.has(bus)) {
        bus.on("mesh:build-confirm-requested", (request) => {
          if (request.requestId) bus.emit("mesh:build-confirm-resolved", {
            requestId: request.requestId, confirmed: confirm,
          });
        });
        configuredBuses.add(bus);
      }
      return command.run({ ...context, bus });
    } });
  }
  return registry;
}

function selectBox(selection: SelectionController): void {
  selection.set(
    {
      kind: "object.mesh",
      label: "Box",
      nodeId: "model:object:box:mesh",
      objectId: "box",
      ref: {
        kind: "object.mesh",
        nodeId: "model:object:box:mesh",
        objectId: "box",
        type: "scene-object",
        visualizationTargetId: "object:box",
      },
    },
    "test",
  );
}

function sessionStatus(discretization: string, domainDiscretization = discretization) {
  const activeLane = activeLaneCapabilityFixture();
  const resolved = discretization === "fem" || discretization === "fdm"
    ? { ...activeLane.resolved!, backend: discretization, discretization }
    : null;
  return {
    [SESSION_STATUS_RESOURCE_KEY]: {
      capabilities: {
        active_lane: {
          ...activeLane,
          authored: { ...activeLane.authored, backend: discretization, discretization },
          requested: { ...activeLane.requested, backend: discretization, discretization },
          resolved,
          source: { ...activeLane.source, engine_id: `${discretization}_cpu_reference` },
          operations: {
            ...activeLane.operations,
            grid_build: {
              ...activeLane.operations.grid_build,
              state: discretization === "fdm" ? "supported" as const : "unsupported" as const,
              reason_code: discretization === "fdm" ? "capability_supported" : "capability_unsupported",
              reason: "Grid building follows the resolved planner lane.",
            },
            shared_mesh_build: {
              state: discretization === "fem" ? "supported" as const : "unsupported" as const,
              reason_code: discretization === "fem" ? "capability_supported" : "capability_unsupported",
              reason: "Shared meshing follows the resolved planner lane.",
              requires: ["discretization:fem"],
            },
          },
        },
      },
      domain: { discretization: domainDiscretization },
    },
  };
}

describe("geometry lifecycle command contributions", () => {
  it("builds geometry only for the current scene revision and invalidates derived resources", async () => {
    const registry = registryWithLifecycleCommands();
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const realize = vi.fn(async () => ({
      backend_target: "fdm" as const,
      realization_revision: 21,
      source_scene_revision: 21,
      status: "realized",
    }));

    expect(
      registry.isEnabled("builder-build-geometry", {
        source: "test",
        api: { model: { geometry: { realize } } } as never,
        resourceData: { [MODEL_SCENE_PATH]: { revision: 21 } },
      }),
    ).toBe(true);

    const result = await registry.execute("builder-build-geometry", {
      api: { model: { geometry: { realize } } } as never,
      resourceData: { [MODEL_SCENE_PATH]: { revision: 21 } },
      resources,
      source: "test",
    });

    expect(result).toEqual({
      message: "Geometry realization completed.",
      status: "completed",
    });
    expect(realize).toHaveBeenCalledWith({});
    for (const resourceKey of [
      MODEL_GEOMETRY_REALIZATION_CURRENT_PATH,
      MODEL_REALIZED_REGIONS_PATH,
      MODEL_REGION_DIAGNOSTICS_PATH,
      MODEL_UNIVERSE_PATH,
      MODEL_READINESS_PATH,
    ]) {
      expect(resources.getRevision(resourceKey)).toBe(21);
    }
  });

  it("fails closed when geometry realization responds for a stale scene", async () => {
    const registry = registryWithLifecycleCommands();
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const realize = vi.fn(async () => ({
      backend_target: "fem" as const,
      realization_revision: 20,
      source_scene_revision: 20,
      status: "realized",
    }));

    const result = await registry.execute("builder-build-geometry", {
      api: { model: { geometry: { realize } } } as never,
      resourceData: { [MODEL_SCENE_PATH]: { revision: 21 } },
      resources,
      source: "test",
    });

    expect(result).toEqual({
      message:
        "Geometry realization is stale: source scene revision 20 does not match current scene revision 21. Refetch the scene before using it.",
      status: "failed",
    });
    expect(realize).toHaveBeenCalledWith({});
    expect(resources.getRevision(MODEL_GEOMETRY_REALIZATION_CURRENT_PATH)).toBeNull();
    expect(resources.getRevision(MODEL_REALIZED_REGIONS_PATH)).toBeNull();
    expect(resources.getRevision(MODEL_REGION_DIAGNOSTICS_PATH)).toBeNull();
    expect(resources.getRevision(MODEL_UNIVERSE_PATH)).toBeNull();
    expect(resources.getRevision(MODEL_READINESS_PATH)).toBeNull();
  });

  it("disables geometry realization until the canonical scene revision is available", () => {
    const registry = registryWithLifecycleCommands();
    const realize = vi.fn();
    const context = {
      api: { model: { geometry: { realize } } } as never,
      source: "test" as const,
    };

    expect(registry.isEnabled("builder-build-geometry", context)).toBe(false);
    expect(
      registry.get("builder-build-geometry")?.disabledReason?.(context),
    ).toBe(
      "The canonical scene revision is unavailable. Refetch the scene before building geometry.",
    );
  });

  it("validates only the current scene revision and refreshes validation resources", async () => {
    const registry = registryWithLifecycleCommands();
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const validation = vi.fn(async () => ({
      backend_target: "fdm" as const,
      diagnostics: [],
      dirty: false,
      scene_revision: 21,
      status: "valid",
    }));

    const result = await registry.execute("builder-validate", {
      api: { model: { geometry: { validation } } } as never,
      resourceData: { [MODEL_SCENE_PATH]: { revision: 21 } },
      resources,
      source: "test",
    });

    expect(result).toEqual({
      message: "Geometry validation completed.",
      status: "completed",
    });
    expect(validation).toHaveBeenCalledWith();
    expect(resources.getRevision(MODEL_GEOMETRY_VALIDATION_PATH)).toBe(21);
    expect(resources.getRevision(MODEL_GEOMETRY_DIAGNOSTICS_PATH)).toBe(21);
    expect(resources.getRevision(MODEL_READINESS_PATH)).toBe(21);
  });

  it("does not publish a stale geometry validation response", async () => {
    const registry = registryWithLifecycleCommands();
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const validation = vi.fn(async () => ({
      backend_target: "fem" as const,
      diagnostics: [],
      dirty: true,
      scene_revision: 20,
      status: "blocked",
    }));

    const result = await registry.execute("builder-validate", {
      api: { model: { geometry: { validation } } } as never,
      resourceData: { [MODEL_SCENE_PATH]: { revision: 21 } },
      resources,
      source: "test",
    });

    expect(result.status).toBe("failed");
    expect(result.message).toContain("Geometry validation is stale");
    expect(resources.getRevision(MODEL_GEOMETRY_VALIDATION_PATH)).toBeNull();
    expect(resources.getRevision(MODEL_GEOMETRY_DIAGNOSTICS_PATH)).toBeNull();
    expect(resources.getRevision(MODEL_READINESS_PATH)).toBeNull();
  });

  it("submits selected-object mesh builds through the command registry", async () => {
    const registry = registryWithLifecycleCommands();
    const bus = new EventBus<KernelEventMap>();
    const selection = new SelectionController(bus);
    const resources = new ResourceInvalidationController(bus);
    const meshEvents: unknown[] = [];
    bus.on("mesh:build-submitted", (event) => meshEvents.push(event));
    selectBox(selection);
    const layout = {
      setFocusedSlot: vi.fn(),
      setPanelVisible: vi.fn(),
    };
    const submit = vi.fn(async () => ({
      accepted: true,
      command_id: "cmd-1",
      error: null,
    }));
    const detail = vi.fn(async () => ({
      command_id: "cmd-1",
      status: "completed",
      completion_status: "completed",
      seq: 1,
      resource_invalidations: [
        { resource_key: "meshing/shared-domain/manifest", revision: 1 },
      ],
    }));

    expect(
      registry.isEnabled("mesh.build-selected", {
        selection,
        source: "test",
        resourceData: sessionStatus("fem"),
      }),
    ).toBe(true);

    const result = await registry.execute("mesh.build-selected", {
      api: {
        commands: { submit, detail },
      } as never,
      bus,
      layout: layout as never,
      resources,
      resourceData: sessionStatus("fem"),
      selection,
      source: "test",
    });

    expect(result).toEqual({ commandId: "cmd-1", status: "completed" });
    expect(submit).toHaveBeenCalledWith({
      client_intent_id: expect.stringMatching(/^mesh-confirm-/),
      kind: "mesh_build",
      mesh_reason: "selected-object",
      mesh_target: { kind: "object_mesh", object_id: "box" },
    });
    expect(resources.getRevision(MESHING_BUILDS_CURRENT_PATH)).toBe(1);
    expect(resources.getRevision(SIMULATION_PREPARATION_PATH)).toBe("mesh:1");
    expect(
      resources.getRevision(
        MESHING_OBJECT_TOPOLOGY_PATH.replace("{object_id}", "box"),
      ),
    ).toBe(1);
    expect(
      resources.getRevision(
        MESHING_OBJECT_REPORT_PATH.replace("{object_id}", "box"),
      ),
    ).toBe(1);
    expect(
      resources.getRevision(
        MESHING_OBJECT_QUALITY_PATH.replace("{object_id}", "box"),
      ),
    ).toBe(1);
    expect(meshEvents).toEqual([
      {
        requestId: expect.stringMatching(/^mesh-confirm-/),
        commandId: "cmd-1",
        objectId: "box",
        reason: "selected-object",
        targetKind: "object_mesh",
      },
    ]);
    expect(layout.setPanelVisible).toHaveBeenCalledWith("bottom", true);
    expect(layout.setFocusedSlot).toHaveBeenCalledWith("panel-bottom");
  });

  it("submits shared-domain mesh builds and focuses the mesh jobs footer", async () => {
    const registry = registryWithLifecycleCommands();
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const meshEvents: unknown[] = [];
    bus.on("mesh:build-submitted", (event) => meshEvents.push(event));
    const layout = {
      setFocusedSlot: vi.fn(),
      setPanelVisible: vi.fn(),
    };
    const submit = vi.fn(async () => ({
      accepted: true,
      command_id: "cmd-shared",
      error: null,
    }));
    const detail = vi.fn(async () => ({
      command_id: "cmd-shared",
      status: "completed",
      completion_status: "completed",
      seq: 2,
      resource_invalidations: [
        { resource_key: "meshing/shared-domain/manifest", revision: 2 },
      ],
    }));

    const result = await registry.execute("mesh.build-shared-domain", {
      api: {
        commands: { submit, detail },
      } as never,
      bus,
      layout: layout as never,
      resources,
      resourceData: sessionStatus("fem"),
      source: "test",
    });

    expect(result).toEqual({ commandId: "cmd-shared", status: "completed" });
    expect(submit).toHaveBeenCalledWith({
      client_intent_id: expect.stringMatching(/^mesh-confirm-/),
      kind: "mesh_build",
      mesh_reason: "shared-domain",
      mesh_target: { kind: "study_domain" },
    });
    expect(resources.getRevision(MESHING_BUILDS_CURRENT_PATH)).toBe(2);
    expect(meshEvents).toEqual([
      {
        requestId: expect.stringMatching(/^mesh-confirm-/),
        commandId: "cmd-shared",
        reason: "shared-domain",
        targetKind: "study_domain",
      },
    ]);
    expect(layout.setPanelVisible).toHaveBeenCalledWith("bottom", true);
    expect(layout.setFocusedSlot).toHaveBeenCalledWith("panel-bottom");
  });

  it("disables object-scoped commands without object selection", () => {
    const registry = registryWithLifecycleCommands();
    const selection = new SelectionController(new EventBus<KernelEventMap>());

    expect(
      registry.isEnabled("mesh.build-selected", {
        selection,
        source: "test",
      }),
    ).toBe(false);
    expect(
      registry.isEnabled("geometry.delete-object", {
        selection,
        source: "test",
      }),
    ).toBe(false);
  });

  it("uses the mesh capability resource reason for build commands", () => {
    const registry = registryWithLifecycleCommands();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    selectBox(selection);
    const context = {
      selection,
      source: "test" as const,
      resourceData: {
        ...sessionStatus("fem"),
        [MESHING_CAPABILITIES_PATH]: {
          mesh_capabilities: {
            fem: {
              status: "unsupported",
              reason: "FEM shared-domain meshing is disabled for this session.",
            },
          },
        },
      },
    };

    expect(registry.isEnabled("mesh.build-selected", context)).toBe(false);
    expect(registry.get("mesh.build-selected")?.disabledReason?.(context)).toBe(
      "FEM shared-domain meshing is disabled for this session.",
    );
    expect(registry.isEnabled("mesh.build-shared-domain", context)).toBe(false);
  });

  it("requires an explicit FEM session lane when a legacy mesh resource omits lane keys", () => {
    const registry = registryWithLifecycleCommands();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    selectBox(selection);

    const context = {
      selection,
      source: "test" as const,
      resourceData: {
        [MESHING_CAPABILITIES_PATH]: {
          mesh_capabilities: { has_volume_mesh: true },
        },
      },
    };

    expect(registry.isEnabled("mesh.build-selected", context)).toBe(false);
    expect(registry.get("mesh.build-selected")?.disabledReason?.(context)).toBe(
      UNKNOWN_MESH_COMMAND_LANE_REASON,
    );
  });

  it("focuses primitive display explicitly for the selected object", async () => {
    const registry = registryWithLifecycleCommands();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    const visualization = {
      patchTarget: vi.fn(),
    };
    selectBox(selection);

    const result = await registry.execute("geometry.focus-primitive", {
      selection,
      source: "test",
      visualization: visualization as never,
    });

    expect(result).toEqual({ status: "completed" });
    expect(visualization.patchTarget).toHaveBeenCalledWith(
      { id: "box", kind: "object", label: "Box" },
      {
        pointsVisible: false,
        primitiveVisible: true,
        renderMode: "surface+edges",
        shaderVisible: true,
        wireframeVisible: true,
      },
    );
  });

  it("submits quality-threshold refinement as a shared-domain mesh build", async () => {
    const registry = registryWithLifecycleCommands();
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const meshOptions = {
      compute_quality: true,
      per_element_quality: true,
      quality_refinement: {
        element_index: 7,
        kind: "worst_element_box",
        metric: "gamma",
        threshold: 0.08,
      },
      size_fields: [
        {
          kind: "Box",
          source: "quality_threshold_refinement",
          params: {
            VIn: 2e-9,
            VOut: 1e22,
            XMax: 1.8e-8,
            XMin: 2e-9,
            YMax: 2.8e-8,
            YMin: 1.2e-8,
            ZMax: 1.1e-8,
            ZMin: -5e-9,
          },
        },
      ],
    };
    const submit = vi.fn(async () => ({
      accepted: true,
      command_id: "cmd-refine",
      error: null,
    }));
    const detail = vi.fn(async () => ({
      command_id: "cmd-refine",
      status: "completed",
      completion_status: "completed",
      seq: 3,
      resource_invalidations: [
        { resource_key: "meshing/shared-domain/manifest", revision: 3 },
      ],
    }));

    const result = await registry.execute(
      "mesh.refine-worst-quality-element",
      {
        api: {
          commands: { submit, detail },
        } as never,
        resources,
        resourceData: sessionStatus("fem"),
        source: "test",
      },
      { elementIndex: 7, meshOptions },
    );

    expect(result).toEqual({ commandId: "cmd-refine", status: "completed" });
    expect(submit).toHaveBeenCalledWith({
      client_intent_id: expect.stringMatching(/^mesh-confirm-/),
      kind: "mesh_build",
      mesh_options: meshOptions,
      mesh_reason: "quality_threshold_refinement",
      mesh_target: { kind: "study_domain" },
    });
    expect(resources.getRevision(MESHING_BUILDS_PATH)).toBe(3);
    expect(resources.getRevision(MESHING_BUILDS_CURRENT_PATH)).toBe(3);
    expect(resources.getRevision(MESHING_SUMMARY_PATH)).toBe(3);
    expect(resources.getRevision(MESHING_SEMANTICS_PATH)).toBe(3);
    expect(resources.getRevision(MESHING_SHARED_DOMAIN_MANIFEST_PATH)).toBe(3);
    expect(resources.getRevision(SIMULATION_PREPARATION_PATH)).toBe("mesh:3");
    expect(resources.getRevision(MESHING_SHARED_DOMAIN_REPORT_PATH)).toBe(3);
    expect(resources.getRevision(MESHING_SHARED_DOMAIN_QUALITY_PATH)).toBe(3);
    expect(resources.getRevision(MESHING_SHARED_DOMAIN_QUALITY_DATA_PATH)).toBe(3);
    expect(resources.getRevision(MESHING_SHARED_DOMAIN_QUALITY_GATES_PATH)).toBe(3);
    expect(
      resources.getRevision(MESHING_SHARED_DOMAIN_REALIZED_SIZE_FIELDS_PATH),
    ).toBe(3);
  });

  it("uses the FEM capability resource to gate quality refinement", () => {
    const registry = registryWithLifecycleCommands();
    const context: CommandContext = {
      resourceData: {
        ...sessionStatus("fem"),
        [MESHING_CAPABILITIES_PATH]: {
          mesh_capabilities: {
            fem: {
              status: "unsupported",
              reason: "FEM quality refinement is unavailable for this session.",
            },
          },
        },
      },
      source: "test",
      input: { meshOptions: { compute_quality: true } },
    };

    expect(
      registry.isEnabled("mesh.refine-worst-quality-element", context),
    ).toBe(false);
    expect(
      registry.get("mesh.refine-worst-quality-element")?.disabledReason?.(context),
    ).toBe("FEM quality refinement is unavailable for this session.");
  });

  it("disables primitive commands when geometry capabilities reject them", () => {
    const registry = registryWithLifecycleCommands();
    const context: CommandContext = {
      resourceData: {
        [MODEL_GEOMETRY_CAPABILITIES_PATH]: {
          primitives: { box: true, cylinder: false, sphere: true },
        },
      },
      source: "test",
    };

    expect(registry.isEnabled("geometry.add-box", context)).toBe(true);
    expect(registry.isEnabled("geometry.add-cylinder", context)).toBe(false);
    expect(
      registry.get("geometry.add-cylinder")?.disabledReason?.(context),
    ).toBe("Backend does not expose cylinder geometry authoring.");
  });

  it("opens and commits thin-film drafts as box primitives without a mesh policy", async () => {
    const registry = registryWithLifecycleCommands();
    const bus = new EventBus<KernelEventMap>();
    const selection = new SelectionController(bus);
    const resources = new ResourceInvalidationController(bus);
    const now = vi.spyOn(Date, "now").mockReturnValue(12345);
    const commitTransaction = vi.fn<
      (transaction: unknown) => Promise<{
        committed_scene: { revision: number };
        scene_revision: number;
        transaction_kind: string;
      }>
    >(async () => ({
      committed_scene: { revision: 22 },
      scene_revision: 22,
      transaction_kind: "create_object",
    }));

    try {
      expect(
        await registry.execute("geometry.add-thin-film", {
          selection,
          source: "test",
        }),
      ).toEqual({ status: "completed" });
      expect(selection.get()).toEqual({
        kind: "builder.primitive",
        label: "New thin film",
        moduleSource: "geometry-authoring",
        nodeId: "geometry:draft:thin-film",
        objectId: null,
        ref: null,
      });

      expect(
        await registry.execute("geometry.commit-object-draft", {
          api: {
            model: { commitTransaction },
          } as never,
          resources,
          resourceData: { [MODEL_SCENE_PATH]: { revision: 21 } },
          selection,
          source: "test",
        }),
      ).toEqual({ status: "completed" });
      expect(commitTransaction).toHaveBeenCalledWith({
        base_revision: 21,
        geometry: {
          geometry_kind: "Box",
          geometry_params: { size: [1e-7, 1e-7, 1e-8] },
        },
        kind: "create_object",
        name: "New thin film",
        object_id: "box-9ix",
        transform: {
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
          translation: [0, 0, 0],
        },
      });
      expect(commitTransaction.mock.calls[0]?.[0]).not.toHaveProperty("mesh_policy");
      expect(commitTransaction.mock.calls[0]?.[0]).not.toHaveProperty("swept_prism");
      expect(commitTransaction.mock.calls[0]?.[0]).not.toHaveProperty("fallback");
    } finally {
      now.mockRestore();
    }
  });

  it("disables selected mesh build for validation blockers", () => {
    const registry = registryWithLifecycleCommands();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    selectBox(selection);
    const context: CommandContext = {
      resourceData: {
        ...sessionStatus("fem"),
        [MODEL_GEOMETRY_VALIDATION_PATH]: {
          blockers: [
            {
              message: "Box exceeds universe bounds",
              object_id: "box",
              severity: "error",
            },
          ],
        },
      },
      selection,
      source: "test",
    };

    expect(registry.isEnabled("mesh.build-selected", context)).toBe(false);
    expect(registry.get("mesh.build-selected")?.disabledReason?.(context)).toBe(
      "Resolve geometry validation blockers before building this mesh.",
    );
  });

  it("disables selected mesh build while an object mesh build is running", () => {
    const registry = registryWithLifecycleCommands();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    selectBox(selection);
    const context: CommandContext = {
      resourceData: {
        ...sessionStatus("fem"),
        [MESHING_BUILDS_CURRENT_PATH]: {
          active_build: {
            mesh_target: { kind: "object_mesh", object_id: "box" },
            status: "running",
          },
        },
      },
      selection,
      source: "test",
    };

    expect(registry.isEnabled("mesh.build-selected", context)).toBe(false);
    expect(registry.get("mesh.build-selected")?.disabledReason?.(context)).toBe(
      "A mesh build is already running for this object.",
    );
  });

  it("commits delete transactions and clears deleted object selection", async () => {
    const registry = registryWithLifecycleCommands();
    const bus = new EventBus<KernelEventMap>();
    const selection = new SelectionController(bus);
    const resources = new ResourceInvalidationController(bus);
    selection.set(
      {
        kind: "object.root",
        label: "Box",
        nodeId: "model:object:box",
        objectId: "box",
        ref: {
          kind: "object.root",
          nodeId: "model:object:box",
          objectId: "box",
          type: "scene-object",
          visualizationTargetId: "object:box",
        },
      },
      "test",
    );
    const commitTransaction = vi.fn(async (_request: unknown) => ({
      committed_scene: { revision: 15 },
      scene_revision: 15,
      transaction_kind: "delete_object",
    }));

    const result = await registry.execute("geometry.delete-object", {
      api: {
        model: { commitTransaction },
      } as never,
      resources,
      selection,
      source: "test",
    });

    expect(result).toEqual({ status: "completed" });
    expect(commitTransaction).toHaveBeenCalledWith({
      kind: "delete_object",
      object_id: "box",
    });
    expect(selection.get().objectId).toBeNull();
    expect(resources.getRevision(MODEL_SCENE_PATH)).toBe(15);
    expect(resources.getRevision(MODEL_GEOMETRY_DIAGNOSTICS_PATH)).toBe(15);
  });

  it("keeps a newer selection out of geometry delete history while the ACK is pending", async () => {
    const registry = registryWithLifecycleCommands();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    const resources = new ResourceInvalidationController(new EventBus<KernelEventMap>());
    selection.set({
      kind: "object.root",
      label: "Box",
      nodeId: "model:object:box",
      objectId: "box",
      ref: null,
    }, "test");
    const before = {
      objects: [{ object_id: "box" }, { object_id: "other" }],
      revision: 14,
    };
    const after = {
      objects: [{ object_id: "other" }],
      revision: 15,
    };
    const record = vi.fn();
    const commitTransaction = vi.fn(async () => {
      selection.set({
        kind: "object.root",
        label: "Other",
        nodeId: "model:object:other",
        objectId: "other",
        ref: null,
      }, "explorer");
      return {
        committed_scene: after,
        scene_revision: 15,
        transaction_kind: "delete_object",
      };
    });

    await registry.execute("geometry.delete-object", {
      api: { model: { commitTransaction, scene: vi.fn(async () => before) } } as never,
      authoringHistory: { record } as never,
      resources,
      selection,
      source: "test",
    });

    expect(selection.get().objectId).toBe("other");
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      afterWorkspaceState: expect.objectContaining({
        selection: expect.objectContaining({ objectId: "box" }),
      }),
      beforeWorkspaceState: expect.objectContaining({
        selection: expect.objectContaining({ objectId: "box" }),
      }),
    }));
  });

  it("commits primitive drafts as create-object transactions and selects the committed object", async () => {
    const registry = registryWithLifecycleCommands();
    const bus = new EventBus<KernelEventMap>();
    const selection = new SelectionController(bus);
    const resources = new ResourceInvalidationController(bus);
    const now = vi.spyOn(Date, "now").mockReturnValue(12345);
    selection.set(
      {
        kind: "builder.primitive",
        label: "New box",
        nodeId: "geometry:draft:box",
        objectId: null,
        ref: null,
      },
      "test",
    );
    const commitTransaction = vi.fn(async () => ({
      committed_scene: { revision: 21 },
      scene_revision: 21,
      transaction_kind: "create_object",
    }));

    const result = await registry.execute("geometry.commit-object-draft", {
      api: {
        model: { commitTransaction },
      } as never,
      resources,
      resourceData: { [MODEL_SCENE_PATH]: { objects: [], revision: 20 } },
      selection,
      source: "test",
    });

    expect(result).toEqual({ status: "completed" });
    expect(commitTransaction).toHaveBeenCalledWith({
      base_revision: 20,
      geometry: {
        geometry_kind: "Box",
        geometry_params: { size: [1e-7, 1e-7, 1e-8] },
      },
      kind: "create_object",
      name: "New box",
      object_id: "box-9ix",
      transform: {
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        translation: [0, 0, 0],
      },
    });
    expect(selection.get()).toMatchObject({
      kind: "object.root",
      label: "New box",
      nodeId: "model:object:box-9ix",
      objectId: "box-9ix",
      ref: {
        kind: "object.root",
        nodeId: "model:object:box-9ix",
        objectId: "box-9ix",
        type: "scene-object",
        visualizationTargetId: "object:box-9ix",
      },
    });
    expect(resources.getRevision(MODEL_SCENE_PATH)).toBe(21);
    now.mockRestore();
  });

  it("adds microstrip antennas with current transport, balanced port, and field solve", async () => {
    const registry = registryWithLifecycleCommands();
    const bus = new EventBus<KernelEventMap>();
    const selection = new SelectionController(bus);
    const resources = new ResourceInvalidationController(bus);
    const now = vi.spyOn(Date, "now").mockReturnValue(12345);
    const scene = vi.fn(async () => ({
      current_modules: {
        modules: [{ id: "existing-source", kind: "antenna_field_source" }],
      },
      field_drives: { drives: [{ id: "existing-drive", kind: "regional" }] },
      current_transports: [],
      objects: [{ id: "waveguide", name: "Waveguide", role: "magnet" }],
      revision: 20,
    }));
    const commitTransaction = vi.fn(async (_request: unknown) => ({
      committed_scene: { revision: 22 },
      scene_revision: 22,
      transaction_kind: "merge_patch",
    }));

    const result = await registry.execute("geometry.add-microstrip-antenna", {
      api: {
        model: { commitTransaction, scene },
      } as never,
      resources,
      selection,
      source: "test",
    });

    expect(result).toEqual({
      message: "Microstrip antenna draft added; field solve requires a mesh-exact ConservativeCurrentView.",
      status: "completed",
    });
    const request = commitTransaction.mock.calls[0]?.[0] as {
      merge_patch?: Record<string, unknown>;
    } | undefined;
    expect(request).toMatchObject({
      base_revision: 20,
      kind: "merge_patch",
      merge_patch: {
        antenna_field_solve_stages: [{
          conservative_current_view_ref: "antenna-9ix:current:rt0",
          current_transport_id: "antenna-9ix:current",
          field_sampling_domain: { kind: "global" },
          id: "antenna-9ix:solve-field",
          model: "quasistatic_conduction_biot_savart3d",
          oersted_realization: "direct_tetra_quadrature",
          outputs: [{ id: "antenna-9ix:field-solution", quantity: "H_ant_basis" }],
          port_mode_ids: ["antenna-9ix:port:common"],
          source_object_id: "antenna-9ix",
          target_refs: [{ kind: "global" }],
        }],
        antenna_port_modes: [{
          schema_version: "antenna_port_mode.v2",
          branches: [
            {
              id: "signal",
              inlet_terminal_ref: "signal_in",
              outlet_terminal_ref: "signal_out",
              signed_weight: 1,
            },
            {
              id: "return",
              inlet_terminal_ref: "return_in",
              outlet_terminal_ref: "return_out",
              signed_weight: -1,
            },
          ],
          current_transport_id: "antenna-9ix:current",
          id: "antenna-9ix:port:common",
          normalization_current_a: 1,
          source_object_id: "antenna-9ix",
        }],
        current_transports: [{
          coupling: "one_way",
          domain: [{ object_id: "antenna-9ix" }],
          kind: "current_transport",
          model: "ohmic_poisson",
          name: "antenna-9ix:current",
        }],
        objects: expect.arrayContaining([
          expect.objectContaining({
            id: "antenna-9ix",
            role: "antenna",
            geometry: expect.objectContaining({
              geometry_kind: "MicrostripAntennaLayout",
              geometry_params: expect.objectContaining({
                stations: [{ s: 0, signal_width_m: 50e-9 }, { s: 1, signal_width_m: 50e-9 }],
                return_width_m: 500e-9,
                return_offset_m: 30e-9,
                conductors: [{ id: "signal", kind: "signal" }, { id: "return", kind: "return" }],
              }),
            }),
          }),
        ]),
      },
    });
    if (!request) throw new Error("antenna add command did not submit a transaction");
    expect((request.merge_patch?.objects as Array<{ id: string }>).map((object) => object.id)).toEqual([
      "waveguide",
      "antenna-9ix",
    ]);
    const currentTransports = request.merge_patch?.current_transports as Array<{
      boundaries?: Array<{
        id?: string;
        kind?: string;
        surfaces?: Array<{ object_id?: string; surface_id?: string }>;
      }>;
      gauge?: string;
      solver?: {
        engine?: string;
        operator_version?: string;
        physical_residual_version?: string;
      };
    }> | undefined;
    expect(currentTransports?.[0]?.boundaries?.map((boundary) => boundary.id)).toEqual([
      "signal_in",
      "signal_out",
      "return_in",
      "return_out",
      "insulating_outer",
    ]);
    expect(currentTransports?.[0]?.boundaries?.slice(0, 4)).toEqual([
      expect.objectContaining({ id: "signal_in", kind: "equipotential_current_terminal", surfaces: [expect.objectContaining({ object_id: "antenna-9ix", surface_id: "antenna_terminal:signal:local_u_min" })] }),
      expect.objectContaining({ id: "signal_out", kind: "equipotential_current_terminal", surfaces: [expect.objectContaining({ object_id: "antenna-9ix", surface_id: "antenna_terminal:signal:local_u_max" })] }),
      expect.objectContaining({ id: "return_in", kind: "equipotential_current_terminal", surfaces: [expect.objectContaining({ object_id: "antenna-9ix", surface_id: "antenna_terminal:return:local_u_min" })] }),
      expect.objectContaining({ id: "return_out", kind: "equipotential_current_terminal", surfaces: [expect.objectContaining({ object_id: "antenna-9ix", surface_id: "antenna_terminal:return:local_u_max" })] }),
    ]);
    expect(currentTransports?.[0]?.gauge).toBe("terminal_reference");
    expect(currentTransports?.[0]?.boundaries?.[4]).toMatchObject({
      id: "insulating_outer",
      surfaces: [{ object_id: "antenna-9ix", surface_id: "antenna_nonterminal" }],
    });
    expect(currentTransports?.[0]?.solver).toEqual({
      engine: "cg",
      linear: { absolute_tolerance: 0, max_iterations: 500, relative_tolerance: 1e-10 },
      operator_version: "fem_charge_conforming_h1_p1.transparent.v1",
      physical_residual_version: "charge_balance_integrated_l2.v1",
    });
    const port = (request.merge_patch?.antenna_port_modes as Array<Record<string, unknown>> | undefined)?.[0];
    expect(port?.schema_version).toBe("antenna_port_mode.v2");
    expect(port?.branches).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ terminal_selector_ref: expect.anything() }),
    ]));
    expect(request.merge_patch).not.toHaveProperty("field_drives");
    expect(selection.get()).toMatchObject({
      kind: "object.root",
      label: "Microstrip antenna",
      nodeId: "model:object:antenna-9ix",
      objectId: "antenna-9ix",
    });
    expect(resources.getRevision(MODEL_SCENE_PATH)).toBe(22);
    now.mockRestore();
  });

  it("turns concurrent antenna adds into a revision conflict instead of a silent overwrite", async () => {
    const registry = registryWithLifecycleCommands();
    const now = vi.spyOn(Date, "now").mockReturnValue(12345);
    const scene = vi.fn(async () => ({
      current_modules: { modules: [] },
      field_drives: { drives: [] },
      current_transports: [],
      objects: [],
      revision: 20,
    }));
    let committed = false;
    const requests: Array<{ base_revision?: number | null }> = [];
    const commitTransaction = vi.fn(async (request: { base_revision?: number | null }) => {
      requests.push(request);
      if (request.base_revision !== 20) {
        throw new Error("missing expected scene revision");
      }
      if (committed) {
        throw new ControlRoomApiError(
          "scene changed",
          409,
          "request-antenna-2",
          "revision_conflict",
        );
      }
      committed = true;
      return {
        committed_scene: { revision: 21 },
        scene_revision: 21,
        transaction_kind: "merge_patch",
      };
    });
    const run = () =>
      registry.execute("geometry.add-microstrip-antenna", {
        api: { model: { commitTransaction, scene } } as never,
        source: "test",
      });

    const [first, second] = await Promise.all([run(), run()]);

    expect([first.status, second.status].sort()).toEqual(["completed", "failed"]);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.base_revision === 20)).toBe(true);
    now.mockRestore();
  });

  it("fails closed when the fetched antenna scene has no canonical revision", async () => {
    const registry = registryWithLifecycleCommands();
    const scene = vi.fn(async () => ({ objects: [] }));
    const commitTransaction = vi.fn();

    await expect(
      registry.execute("geometry.add-microstrip-antenna", {
        api: { model: { commitTransaction, scene } } as never,
        source: "test",
      }),
    ).resolves.toEqual({
      message: "The canonical scene revision is unavailable. Refetch the scene before adding an antenna.",
      status: "failed",
    });
    expect(commitTransaction).not.toHaveBeenCalled();
  });

  it("does not submit an antenna transaction after the session changes during scene read", async () => {
    const registry = registryWithLifecycleCommands();
    const commitTransaction = vi.fn();
    let current = true;
    const result = await registry.execute("geometry.add-microstrip-antenna", {
      source: "test",
      isCurrentSessionScope: () => current,
      api: { model: {
        scene: vi.fn(async () => { current = false; return { objects: [], revision: 4 }; }),
        commitTransaction,
      } } as never,
    });
    expect(result.status).toBe("cancelled");
    expect(commitTransaction).not.toHaveBeenCalled();
  });

  it("does not clear the new workspace selection after a late delete-object ACK", async () => {
    const registry = registryWithLifecycleCommands();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    selection.set({
      kind: "object.root",
      label: "Box",
      nodeId: "model:object:box",
      objectId: "box",
      ref: { kind: "object.root", nodeId: "model:object:box", objectId: "box", type: "scene-object", visualizationTargetId: "object:box" },
    }, "test");
    const clear = vi.spyOn(selection, "clear");
    const invalidate = vi.fn();
    let current = true;
    const result = await registry.execute("geometry.delete-object", {
      source: "test",
      selection,
      resources: { invalidate } as never,
      isCurrentSessionScope: () => current,
      api: { model: { commitTransaction: vi.fn(async () => {
        current = false;
        return { committed_scene: { revision: 5 }, scene_revision: 5, transaction_kind: "delete_object" };
      }) } } as never,
    });
    expect(result.status).toBe("cancelled");
    expect(clear).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("keeps the primitive draft selected when create-object commit fails", async () => {
    const registry = registryWithLifecycleCommands();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    selection.set(
      {
        kind: "builder.primitive",
        label: "New sphere",
        nodeId: "geometry:draft:sphere",
        objectId: null,
        ref: null,
      },
      "test",
    );

    const result = await registry.execute("geometry.commit-object-draft", {
      api: {
        model: {
          commitTransaction: vi.fn(async () => {
            throw new Error("base revision conflict");
          }),
        },
      } as never,
      resourceData: { [MODEL_SCENE_PATH]: { revision: 21 } },
      selection,
      source: "test",
    });

    expect(result).toEqual({
      message: "base revision conflict",
      status: "failed",
    });
    expect(selection.get()).toMatchObject({
      kind: "builder.primitive",
      label: "New sphere",
      nodeId: "geometry:draft:sphere",
      objectId: null,
      ref: null,
    });
  });

  it("fails closed without a canonical scene revision", async () => {
    const registry = registryWithLifecycleCommands();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    selection.set(
      {
        kind: "builder.primitive",
        label: "New box",
        nodeId: "geometry:draft:box",
        objectId: null,
        ref: null,
      },
      "test",
    );
    const commitTransaction = vi.fn();

    expect(registry.isEnabled("geometry.commit-object-draft", { selection, source: "test" }))
      .toBe(false);
    expect(
      await registry.execute("geometry.commit-object-draft", {
        api: { model: { commitTransaction } } as never,
        selection,
        source: "test",
      }),
    ).toEqual({
      message: "The canonical scene revision is unavailable. Refetch the scene before committing.",
      status: "failed",
    });
    expect(commitTransaction).not.toHaveBeenCalled();
  });

  it("fails closed for every FEM mesh command and navigation route without a lane", async () => {
    const registry = registryWithLifecycleCommands();
    const bus = new EventBus<KernelEventMap>();
    const selection = new SelectionController(bus);
    selectBox(selection);
    const context = { selection, source: "test" as const };
    const ids = [
      "mesh.build-selected",
      "mesh.build-shared-domain",
      "mesh.refine-worst-quality-element",
      "mesh.open-overview",
      "mesh.open-shared-domain",
      "mesh.open-builds",
      "mesh.open-quality",
      "mesh.open-size-fields",
      "mesh.open-regions",
      "mesh.open-object-report",
    ];

    for (const id of ids) {
      expect(registry.isEnabled(id, context), id).toBe(false);
      expect(registry.get(id)?.disabledReason?.(context), id).toBe(
        UNKNOWN_MESH_COMMAND_LANE_REASON,
      );
    }

    const submit = vi.fn();
    const result = await registry.execute("mesh.build-shared-domain", {
      ...context,
      api: { commands: { submit } } as never,
    });
    expect(result).toEqual({
      message: UNKNOWN_MESH_COMMAND_LANE_REASON,
      status: "failed",
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it("fails closed for every FEM mesh command and navigation route in an FDM lane", async () => {
    const registry = registryWithLifecycleCommands();
    const bus = new EventBus<KernelEventMap>();
    const selection = new SelectionController(bus);
    selectBox(selection);
    const context = {
      resourceData: sessionStatus("fdm"),
      selection,
      source: "test" as const,
    };
    const ids = [
      "mesh.build-selected",
      "mesh.build-shared-domain",
      "mesh.refine-worst-quality-element",
      "mesh.open-overview",
      "mesh.open-shared-domain",
      "mesh.open-builds",
      "mesh.open-quality",
      "mesh.open-size-fields",
      "mesh.open-regions",
      "mesh.open-object-report",
    ];

    for (const id of ids) {
      expect(registry.isEnabled(id, context), id).toBe(false);
      expect(registry.get(id)?.disabledReason?.(context), id).toBe(
        FDM_MESH_COMMAND_NOT_APPLICABLE_REASON,
      );
    }

    const submit = vi.fn();
    const result = await registry.execute("mesh.build-selected", {
      ...context,
      api: { commands: { submit } } as never,
    });
    expect(result).toEqual({
      message: FDM_MESH_COMMAND_NOT_APPLICABLE_REASON,
      status: "failed",
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it("resolves only explicit FEM/FDM session lanes", () => {
    expect(resolveMeshCommandLane("fem")).toBe("fem");
    expect(resolveMeshCommandLane("FDM")).toBe("fdm");
    expect(resolveMeshCommandLane("auto")).toBe("unknown");
    expect(resolveMeshCommandLane(null)).toBe("unknown");
  });

  it.each([
    ["fem", "fdm", "mesh.build-shared-domain", "grid.build-fdm"],
    ["fdm", "fem", "grid.build-fdm", "mesh.build-shared-domain"],
  ])("uses resolved %s rather than the retained %s domain for mesh commands", (lane, domain, enabledId, disabledId) => {
    const registry = registryWithLifecycleCommands();
    const context = {
      api: { commands: {} } as never,
      resourceData: { ...sessionStatus(lane, domain), [MODEL_SCENE_PATH]: { revision: 17 } },
      source: "test" as const,
    };
    expect(registry.isEnabled(enabledId, context)).toBe(true);
    expect(registry.isEnabled(disabledId, context)).toBe(false);
  });

  it.each(["fem", "fdm"])("never submits a %s build when its planner operation is deferred", async (lane) => {
    const registry = registryWithLifecycleCommands();
    const submit = vi.fn();
    const status = sessionStatus(lane)[SESSION_STATUS_RESOURCE_KEY];
    const operationId = lane === "fem" ? "shared_mesh_build" : "grid_build";
    const reason = "Build deferred by the current planner capability profile.";
    const context = {
      api: { commands: { submit } } as never,
      resourceData: {
        [SESSION_STATUS_RESOURCE_KEY]: {
          ...status,
          capabilities: { active_lane: {
            ...status.capabilities.active_lane,
            operations: { ...status.capabilities.active_lane.operations,
              [operationId]: { state: "deferred", reason, requires: [] },
            },
          } },
        },
        [MODEL_SCENE_PATH]: { revision: 17 },
      },
      source: "test" as const,
    };
    const commandId = lane === "fem" ? "mesh.build-shared-domain" : "grid.build-fdm";
    expect(registry.isEnabled(commandId, context)).toBe(false);
    expect(await registry.execute(commandId, context)).toMatchObject({ status: "failed", message: reason });
    expect(submit).not.toHaveBeenCalled();
  });

  it.each(["fem", "fdm"])("does not infer %s command support from a domain without planner resolution", async (domain) => {
    const registry = registryWithLifecycleCommands();
    const submit = vi.fn();
    const context = {
      api: { commands: { submit } } as never,
      resourceData: { ...sessionStatus("auto", domain), [MODEL_SCENE_PATH]: { revision: 17 } },
      source: "test" as const,
    };
    for (const id of ["mesh.build-shared-domain", "grid.build-fdm"]) {
      expect(registry.isEnabled(id, context)).toBe(false);
      expect(await registry.execute(id, context)).toMatchObject({ status: "failed" });
    }
    expect(submit).not.toHaveBeenCalled();
  });
  it("coalesces double-clicks into one confirmation, submission and terminal observer", async () => {
    const registry = registryWithLifecycleCommands();
    const bus = new EventBus<KernelEventMap>();
    const confirmations = vi.fn();
    bus.on("mesh:build-confirm-requested", confirmations);
    let complete!: (value: unknown) => void;
    const detail = vi.fn(() => new Promise((resolve) => { complete = resolve; }));
    const submit = vi.fn(async () => ({ accepted: true, command_id: "cmd-once" }));
    const context = { api: { commands: { submit, detail } } as never,
      bus, resourceData: sessionStatus("fem"), source: "test" as const };
    const first = registry.execute("mesh.build-shared-domain", context);
    const second = registry.execute("mesh.build-shared-domain", context);
    await vi.waitFor(() => expect(detail).toHaveBeenCalledOnce());
    expect(submit).toHaveBeenCalledOnce();
    expect(confirmations).toHaveBeenCalledOnce();
    complete({ command_id: "cmd-once", status: "completed", seq: 10,
      resource_invalidations: [{ resource_key: "data/domain/topology", revision: 10 }] });
    expect(await first).toEqual({ commandId: "cmd-once", status: "completed" });
    expect(await second).toEqual(await first);
  });

  it("does not submit a mesh build confirmed after its session changes", async () => {
    const bus = new EventBus<KernelEventMap>();
    const requested = vi.fn();
    bus.on("mesh:build-confirm-requested", requested);
    const submit = vi.fn();
    let current = true;
    const command = GEOMETRY_LIFECYCLE_COMMANDS.find((entry) => entry.id === "mesh.build-shared-domain")!;
    const pending = command.run({
      api: { commands: { submit } } as never, bus, source: "test",
      resourceData: sessionStatus("fem"), sessionScopeKey: "session=A&epoch=1",
      isCurrentSessionScope: () => current,
    });
    await vi.waitFor(() => expect(requested).toHaveBeenCalledOnce());
    current = false;
    bus.emit("mesh:build-confirm-resolved", {
      requestId: requested.mock.calls[0]![0].requestId, confirmed: true,
    });
    expect(await pending).toMatchObject({ status: "cancelled" });
    expect(submit).not.toHaveBeenCalled();
  });

  it("isolates accepted mesh operations and publications after a session switch", async () => {
    const bus = new EventBus<KernelEventMap>();
    bus.on("mesh:build-confirm-requested", (request) => {
      if (request.requestId) bus.emit("mesh:build-confirm-resolved", {
        requestId: request.requestId, confirmed: true,
      });
    });
    const observed = vi.fn();
    bus.on("mesh:build-observed", observed);
    const resources = new ResourceInvalidationController(bus);
    let resolveOld!: (value: unknown) => void;
    const submit = vi.fn((_request, options?: { sessionScopeKey?: string }) =>
      options?.sessionScopeKey === "session=A&epoch=1"
        ? new Promise((resolve) => { resolveOld = resolve; })
        : Promise.resolve({ accepted: true, command_id: "cmd-B" }));
    const detail = vi.fn(async (_id, options?: { sessionScopeKey?: string }) => ({
      command_id: options?.sessionScopeKey === "session=B&epoch=2" ? "cmd-B" : "cmd-A",
      status: "completed", seq: 11,
      resource_invalidations: [{ resource_key: "data/domain/topology", revision: 11 }],
    }));
    const api = { commands: { submit, detail } } as never;
    const command = GEOMETRY_LIFECYCLE_COMMANDS.find((entry) => entry.id === "mesh.build-shared-domain")!;
    let currentA = true;
    const old = command.run({ api, bus, resources, source: "test", resourceData: sessionStatus("fem"),
      sessionScopeKey: "session=A&epoch=1", isCurrentSessionScope: () => currentA });
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    currentA = false;
    expect(await command.run({ api, bus, resources, source: "test", resourceData: sessionStatus("fem"),
      sessionScopeKey: "session=B&epoch=2", isCurrentSessionScope: () => true }))
      .toEqual({ commandId: "cmd-B", status: "completed" });
    const revision = resources.getRevision(MESHING_SHARED_DOMAIN_MANIFEST_PATH);
    resolveOld({ accepted: true, command_id: "cmd-A" });
    expect(await old).toMatchObject({ status: "cancelled" });
    expect(resources.getRevision(MESHING_SHARED_DOMAIN_MANIFEST_PATH)).toBe(revision);
    expect(observed).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenNthCalledWith(1, expect.objectContaining({ kind: "mesh_build" }),
      { sessionScopeKey: "session=A&epoch=1" });
    expect(submit).toHaveBeenNthCalledWith(2, expect.objectContaining({ kind: "mesh_build" }),
      { sessionScopeKey: "session=B&epoch=2" });
    expect(detail).toHaveBeenCalledWith("cmd-B", { sessionScopeKey: "session=B&epoch=2" });
  });

  it("resumes a disconnected command without another confirmation or POST", async () => {
    const registry = registryWithLifecycleCommands();
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    resources.invalidate(MESHING_SHARED_DOMAIN_MANIFEST_PATH, 7);
    const confirmations = vi.fn();
    bus.on("mesh:build-confirm-requested", confirmations);
    const submit = vi.fn(async () => ({ accepted: true, command_id: "cmd-resume" }));
    const detail = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({
      command_id: "cmd-resume", status: "completed", seq: 8,
      resource_invalidations: [{ resource_key: "data/domain/topology", revision: 8 }],
    });
    const context = { api: { commands: { submit, detail } } as never,
      bus, resources, resourceData: sessionStatus("fem"), source: "test" as const };
    expect(await registry.execute("mesh.build-shared-domain", context)).toMatchObject({
      commandId: "cmd-resume", observation: "disconnected", status: "pending",
    });
    expect(resources.getRevision(MESHING_SHARED_DOMAIN_MANIFEST_PATH)).toBe(7);
    expect(await registry.execute("mesh.build-shared-domain", context)).toMatchObject({
      commandId: "cmd-resume", observation: "waiting", status: "pending",
    });
    expect(detail).toHaveBeenCalledOnce();
    expect(await resumeMeshBuildObservation(context)).toEqual({
      commandId: "cmd-resume", status: "completed",
    });
    expect(submit).toHaveBeenCalledOnce();
    expect(confirmations).toHaveBeenCalledOnce();
    expect(resources.getRevision(MESHING_SHARED_DOMAIN_MANIFEST_PATH)).toBe(8);
  });

  it("preserves mesh resource generations after an authoritative failed build", async () => {
    const registry = registryWithLifecycleCommands();
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    resources.invalidate(MESHING_SHARED_DOMAIN_MANIFEST_PATH, 7);
    const observed = vi.fn();
    bus.on("mesh:build-observed", observed);
    const submit = vi.fn(async () => ({ accepted: true, command_id: "cmd-failed" }));
    const detail = vi.fn(async () => ({ command_id: "cmd-failed", status: "failed",
      error: "mesher failed", seq: 99, resource_invalidations: [] }));
    expect(await registry.execute("mesh.build-shared-domain", {
      api: { commands: { submit, detail } } as never, bus, resources,
      resourceData: sessionStatus("fem"), source: "test",
    })).toEqual({ commandId: "cmd-failed", message: "mesher failed", status: "failed" });
    expect(resources.getRevision(MESHING_SHARED_DOMAIN_MANIFEST_PATH)).toBe(7);
    expect(observed).toHaveBeenCalledWith(expect.objectContaining({ commandId: "cmd-failed", status: "failed" }));
  });

  it.each(["fem", "fdm"])("releases the %s submission lock after HTTP 409 so a corrected request can succeed", async (lane) => {
    const registry = registryWithLifecycleCommands();
    const bus = new EventBus<KernelEventMap>();
    const observed = vi.fn();
    bus.on("mesh:build-observed", observed);
    const submit = vi.fn()
      .mockRejectedValueOnce(new ControlRoomApiError("scene_revision precondition failed", 409))
      .mockResolvedValue({ accepted: true, command_id: "cmd-retry" });
    const list = vi.fn(async () => ({ commands: [] }));
    const detail = vi.fn(async () => ({
      command_id: "cmd-retry", status: "completed", seq: 10,
      resource_invalidations: [{ resource_key: "data/domain/topology", revision: 10 }],
    }));
    const context = { api: { commands: { submit, detail, list } } as never,
      bus, resourceData: sessionStatus(lane), source: "test" as const };
    const run = () => lane === "fem"
      ? registry.execute("mesh.build-shared-domain", context)
      : runFdmGridRefreshOperation(context, { kind: "fdm_grid_refresh" });
    expect(await run()).toMatchObject({ status: "failed", message: "scene_revision precondition failed" });
    expect(list).not.toHaveBeenCalled();
    expect(observed).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
    expect(await run()).toEqual({ commandId: "cmd-retry", status: "completed" });
    expect(submit).toHaveBeenCalledTimes(2);
  });
  it("reconciles a lost submission ACK by client intent and never retries the POST", async () => {
    const registry = registryWithLifecycleCommands();
    let intentId: string | undefined;
    const submit = vi.fn(async (request) => {
      intentId = request.client_intent_id;
      throw new Error("response lost after acceptance");
    });
    const list = vi.fn().mockResolvedValueOnce({ commands: [] }).mockResolvedValue({
      commands: [{ command_id: "cmd-recovered", kind: "remesh", seq: 10 }],
    });
    const detail = vi.fn(async () => ({ command_id: "cmd-recovered", client_intent_id: intentId,
      status: "completed", seq: 10,
      resource_invalidations: [{ resource_key: "data/domain/topology", revision: 10 }],
    }));
    const context = { api: { commands: { submit, detail, list } } as never,
      resourceData: sessionStatus("fem"), source: "test" as const };
    expect(await registry.execute("mesh.build-shared-domain", context)).toMatchObject({
      status: "pending", observation: "publication-unconfirmed",
    });
    expect(await resumeMeshBuildObservation(context)).toEqual({
      commandId: "cmd-recovered", status: "completed",
    });
    expect(submit).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it.each(["mesh.build-selected", "mesh.build-shared-domain", "mesh.refine-worst-quality-element"])(
    "does not submit %s when the common preflight is cancelled", async (commandId) => {
      const registry = registryWithLifecycleCommands(false);
      const selection = new SelectionController(new EventBus<KernelEventMap>());
      selectBox(selection);
      const submit = vi.fn();
      expect(await registry.execute(commandId, {
        api: { commands: { submit } } as never, selection,
        resourceData: sessionStatus("fem"), source: "test",
      }, { meshOptions: { compute_quality: true } })).toEqual({ status: "cancelled" });
      expect(submit).not.toHaveBeenCalled();
    },
  );

  it("freezes the selected target before waiting for confirmation", async () => {
    const bus = new EventBus<KernelEventMap>();
    const selection = new SelectionController(bus);
    selectBox(selection);
    let confirmation: KernelEventMap["mesh:build-confirm-requested"] | undefined;
    bus.on("mesh:build-confirm-requested", (request) => { confirmation = request; });
    const submit = vi.fn(async () => ({ accepted: true, command_id: "cmd-box" }));
    const detail = vi.fn(async () => ({ command_id: "cmd-box", status: "completed", seq: 9,
      resource_invalidations: [{ resource_key: "data/domain/topology", revision: 9 }] }));
    const command = GEOMETRY_LIFECYCLE_COMMANDS.find((entry) => entry.id === "mesh.build-selected")!;
    const result = command.run({ api: { commands: { submit, detail } } as never, bus,
      resourceData: sessionStatus("fem"), selection, source: "test" });
    expect(confirmation?.input).toMatchObject({ mesh_target: { kind: "object_mesh", object_id: "box" } });
    selection.clear("test");
    bus.emit("mesh:build-confirm-resolved", { requestId: confirmation!.requestId!, confirmed: true,
      precondition: { scene_revision: 21, mesh_revision: 8 },
    });
    expect(await result).toMatchObject({ commandId: "cmd-box", status: "completed" });
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      precondition: { scene_revision: 21, mesh_revision: 8 },
      mesh_target: { kind: "object_mesh", object_id: "box" },
    }));
  });

  it("blocks a different target until the existing command has an authoritative outcome", async () => {
    const registry = registryWithLifecycleCommands();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    selectBox(selection);
    const submit = vi.fn(async () => ({ accepted: true, command_id: "cmd-busy" }));
    const detail = vi.fn().mockRejectedValue(new Error("offline"));
    const context = { api: { commands: { submit, detail } } as never, selection,
      resourceData: sessionStatus("fem"), source: "test" as const };
    expect(await registry.execute("mesh.build-shared-domain", context)).toMatchObject({ status: "pending" });
    expect(await registry.execute("mesh.build-selected", context)).toMatchObject({
      status: "pending", message: expect.stringContaining("existing mesh build"),
    });
    expect(submit).toHaveBeenCalledOnce();
  });

  it("bounds lost-ACK reconciliation and reports pending when the queue is unreachable", async () => {
    const registry = registryWithLifecycleCommands();
    const bus = new EventBus<KernelEventMap>();
    const observed = vi.fn();
    bus.on("mesh:build-observed", observed);
    const submit = vi.fn().mockRejectedValue(new Error("lost ACK"));
    const list = vi.fn().mockResolvedValueOnce({ commands: Array.from({ length: 50 }, (_, seq) => ({
      command_id: "other-" + seq, seq, kind: "mesh_build",
    })) }).mockRejectedValue(new Error("offline"));
    const detail = vi.fn(async (id: string) => ({ command_id: id, client_intent_id: "another-intent" }));
    const context = { api: { commands: { submit, detail, list } } as never, bus,
      resourceData: sessionStatus("fem"), source: "test" as const };
    expect(await registry.execute("mesh.build-shared-domain", context)).toMatchObject({ status: "pending" });
    expect(detail).toHaveBeenCalledTimes(8);
    expect(await resumeMeshBuildObservation(context)).toMatchObject({
      status: "pending", observation: "disconnected",
    });
    expect(submit).toHaveBeenCalledOnce();
    expect(observed).toHaveBeenLastCalledWith(expect.objectContaining({
      requestId: expect.stringMatching(/^mesh-confirm-/), status: "pending", observation: "disconnected",
    }));
  });

  it("does not coalesce a new scene revision with an older in-flight build", async () => {
    const registry = registryWithLifecycleCommands();
    let complete!: (value: unknown) => void;
    const detail = vi.fn(() => new Promise((resolve) => { complete = resolve; }));
    const submit = vi.fn(async () => ({ accepted: true, command_id: "cmd-old-scene" }));
    const context = { api: { commands: { submit, detail } } as never, source: "test" as const,
      resourceData: { [SESSION_STATUS_RESOURCE_KEY]: { ...sessionStatus("fem")[SESSION_STATUS_RESOURCE_KEY], resources: { scene_revision: 3 } } } };
    const first = registry.execute("mesh.build-shared-domain", context);
    await vi.waitFor(() => expect(detail).toHaveBeenCalledOnce());
    const next = await registry.execute("mesh.build-shared-domain", { ...context,
      resourceData: { [SESSION_STATUS_RESOURCE_KEY]: { ...sessionStatus("fem")[SESSION_STATUS_RESOURCE_KEY], resources: { scene_revision: 4 } } },
    });
    expect(next).toMatchObject({ commandId: "cmd-old-scene", status: "pending", observation: "waiting" });
    expect(submit).toHaveBeenCalledOnce();
    complete({ command_id: "cmd-old-scene", status: "completed", seq: 8,
      resource_invalidations: [{ resource_key: "data/domain/topology", revision: 8 }] });
    expect(await first).toMatchObject({ status: "completed" });
  });

  it("releases the submission lock only after terminal observation", async () => {
    const registry = registryWithLifecycleCommands();
    const bus = new EventBus<KernelEventMap>();
    const confirmations = vi.fn();
    bus.on("mesh:build-confirm-requested", confirmations);
    let sequence = 0;
    const submit = vi.fn(async () => ({ accepted: true, command_id: "cmd-" + (++sequence) }));
    const detail = vi.fn(async (id: string) => ({ command_id: id, status: "completed", seq: sequence,
      resource_invalidations: [{ resource_key: "data/domain/topology", revision: sequence }] }));
    const context = { api: { commands: { submit, detail } } as never, bus,
      source: "test" as const, resourceData: sessionStatus("fem") };
    expect(await registry.execute("mesh.build-shared-domain", context)).toEqual({ commandId: "cmd-1", status: "completed" });
    expect(await registry.execute("mesh.build-shared-domain", context)).toEqual({ commandId: "cmd-2", status: "completed" });
    expect(submit).toHaveBeenCalledTimes(2);
    expect(confirmations).toHaveBeenCalledTimes(2);
    expect(await resumeMeshBuildObservation(context)).toMatchObject({ status: "cancelled" });
  });

  it("restores an already completed mesh command after reload without comparing against its published current revision", async () => {
    const bus = new EventBus<KernelEventMap>();
    const events: string[] = [];
    const requested = vi.fn(() => { events.push("requested"); });
    bus.on("mesh:build-observation-requested", requested);
    bus.on("mesh:build-observed", () => { events.push("observed"); });
    const submit = vi.fn();
    const detail = vi.fn(async (id: string) => ({ command_id: id, kind: "remesh", status: "completed",
      client_intent_id: "intent-reload", mesh_target: { kind: "object_mesh", object_id: "box" }, seq: 7,
      resource_invalidations: [{ resource_key: "data/domain/topology", revision: 7 }] }));
    const context = { api: { commands: { submit, detail } } as never, bus, source: "test" as const,
      resourceData: { [SESSION_STATUS_RESOURCE_KEY]: { resources: { mesh_revision: 7 } } } };
    expect(await restoreMeshBuildObservation(context, "cmd-reload")).toEqual({ commandId: "cmd-reload", status: "completed" });
    expect(requested).toHaveBeenCalledWith({ commandId: "cmd-reload", requestId: "intent-reload",
      objectId: "box", targetKind: "object_mesh" });
    expect(events).toEqual(["requested", "observed"]);
    expect(submit).not.toHaveBeenCalled();
    expect(detail.mock.calls.every((args) => args[0] === "cmd-reload")).toBe(true);
  });

  it("keeps restored observation resumable across another disconnect", async () => {
    const submit = vi.fn();
    const detail = vi.fn().mockResolvedValueOnce({ command_id: "cmd-restored", kind: "mesh_build", status: "running",
      mesh_target: { kind: "study_domain" }, seq: 9,
    }).mockRejectedValueOnce(new Error("connection lost")).mockResolvedValue({
      command_id: "cmd-restored", status: "completed", seq: 9,
      resource_invalidations: [{ resource_key: "data/domain/topology", revision: 9 }],
    });
    const context = { api: { commands: { submit, detail } } as never, source: "test" as const };
    expect(await restoreMeshBuildObservation(context, "cmd-restored")).toMatchObject({
      commandId: "cmd-restored", status: "pending", observation: "disconnected",
    });
    expect(await resumeMeshBuildObservation(context)).toEqual({ commandId: "cmd-restored", status: "completed" });
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses a foreign or non-mesh resource when restoring an observation", async () => {
    const submit = vi.fn();
    const detail = vi.fn().mockResolvedValueOnce({ command_id: "foreign", kind: "mesh_build", mesh_target: { kind: "study_domain" } })
      .mockResolvedValue({ command_id: "cmd-invalid", kind: "relax", mesh_target: null });
    const context = { api: { commands: { submit, detail } } as never, source: "test" as const };
    expect(await restoreMeshBuildObservation(context, "cmd-invalid")).toMatchObject({ status: "failed" });
    expect(await restoreMeshBuildObservation(context, "cmd-invalid")).toMatchObject({ status: "failed" });
    expect(await resumeMeshBuildObservation(context)).toMatchObject({ status: "cancelled" });
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not replace an active observation with another restored command", async () => {
    const registry = registryWithLifecycleCommands();
    const submit = vi.fn(async () => ({ accepted: true, command_id: "cmd-owned" }));
    const detail = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({
      command_id: "cmd-owned", status: "completed", seq: 5,
      resource_invalidations: [{ resource_key: "data/domain/topology", revision: 5 }],
    });
    const context = { api: { commands: { submit, detail } } as never, source: "test" as const,
      resourceData: sessionStatus("fem") };
    expect(await registry.execute("mesh.build-shared-domain", context)).toMatchObject({ status: "pending" });
    expect(await restoreMeshBuildObservation(context, "cmd-other")).toMatchObject({ status: "failed" });
    expect(detail).toHaveBeenCalledTimes(1);
    expect(await restoreMeshBuildObservation(context, "cmd-owned")).toEqual({ commandId: "cmd-owned", status: "completed" });
    expect(submit).toHaveBeenCalledOnce();
  });

  it("observes an FDM grid refresh through its terminal command and invalidates the published grid", async () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const submit = vi.fn(async () => ({ accepted: true, command_id: "cmd-fdm-grid" }));
    const detail = vi.fn(async () => ({
      command_id: "cmd-fdm-grid",
      kind: "fdm_grid_refresh",
      status: "completed",
      completion_status: "completed",
      seq: 14,
      resource_invalidations: [
        { resource_key: "data/domain/topology", revision: 14 },
      ],
    }));
    const context: CommandContext = {
      api: { commands: { submit, detail } } as never,
      bus,
      resources,
      source: "test",
    };

    await expect(runFdmGridRefreshOperation(context, {
      kind: "fdm_grid_refresh",
      reason: "test_policy_commit",
      precondition: { scene_revision: 9 },
    })).resolves.toEqual({ commandId: "cmd-fdm-grid", status: "completed" });
    expect(submit).toHaveBeenCalledWith({
      client_intent_id: expect.stringMatching(/^fdm-grid-refresh-/),
      kind: "fdm_grid_refresh",
      precondition: { scene_revision: 9 },
      reason: "test_policy_commit",
    });
    expect(resources.getRevision(MESHING_SHARED_DOMAIN_MANIFEST_PATH)).toBe(14);
  });

  it("builds the committed FDM grid through an explicit command", async () => {
    const registry = registryWithLifecycleCommands();
    const submit = vi.fn(async () => ({
      accepted: true,
      command_id: "cmd-explicit-fdm-grid",
    }));
    const detail = vi.fn(async () => ({
      command_id: "cmd-explicit-fdm-grid",
      completion_status: "completed",
      kind: "fdm_grid_refresh",
      resource_invalidations: [
        { resource_key: "data/domain/topology", revision: 18 },
      ],
      seq: 18,
      status: "completed",
    }));
    const context: CommandContext = {
      api: { commands: { detail, submit } } as never,
      resourceData: {
        ...sessionStatus("fdm"),
        [MODEL_SCENE_PATH]: { revision: 17 },
      },
      source: "test",
    };

    expect(registry.isEnabled("grid.build-fdm", context)).toBe(true);
    await expect(registry.execute("grid.build-fdm", context)).resolves.toEqual({
      commandId: "cmd-explicit-fdm-grid",
      status: "completed",
    });
    expect(submit).toHaveBeenCalledWith({
      client_intent_id: expect.stringMatching(/^fdm-grid-refresh-/),
      kind: "fdm_grid_refresh",
      precondition: { scene_revision: 17 },
      reason: "explicit_build_grid",
    });
  });

  it("exposes Build Grid only for a resolved FDM lane with a canonical scene", () => {
    const registry = registryWithLifecycleCommands();
    const api = { commands: {} } as never;
    const context = (discretization: string, scene: unknown = { revision: 17 }) => ({
      api,
      resourceData: {
        ...sessionStatus(discretization),
        [MODEL_SCENE_PATH]: scene,
      },
      source: "test" as const,
    });

    expect(registry.isEnabled("grid.build-fdm", context("fem"))).toBe(false);
    expect(
      registry.get("grid.build-fdm")?.disabledReason?.(context("fem")),
    ).toBe(FEM_GRID_COMMAND_NOT_APPLICABLE_REASON);
    expect(registry.isEnabled("grid.build-fdm", context("auto"))).toBe(false);
    expect(
      registry.get("grid.build-fdm")?.disabledReason?.(context("auto")),
    ).toBe(UNKNOWN_GRID_COMMAND_LANE_REASON);
    expect(registry.isEnabled("grid.build-fdm", context("fdm", null))).toBe(false);
    expect(
      registry.get("grid.build-fdm")?.disabledReason?.(context("fdm", null)),
    ).toBe(
      "The canonical scene revision is unavailable. Refetch the scene before building the grid.",
    );
  });

  it("restores an FDM grid refresh observation after reload without a FEM mesh target", async () => {
    const resources = new ResourceInvalidationController(new EventBus<KernelEventMap>());
    const detail = vi.fn(async () => ({
      command_id: "cmd-fdm-reload",
      kind: "fdm_grid_refresh",
      status: "completed",
      completion_status: "completed",
      client_intent_id: "fdm-intent-reload",
      reason: "study_global_commit",
      seq: 15,
      resource_invalidations: [
        { resource_key: "data/domain/topology", revision: 15 },
      ],
    }));
    const context: CommandContext = {
      api: { commands: { detail } } as never,
      resources,
      source: "test",
    };

    await expect(
      restoreMeshBuildObservation(context, "cmd-fdm-reload"),
    ).resolves.toEqual({ commandId: "cmd-fdm-reload", status: "completed" });
    expect(resources.getRevision(MESHING_SHARED_DOMAIN_MANIFEST_PATH)).toBe(15);
  });

});
