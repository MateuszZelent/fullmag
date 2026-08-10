import { describe, expect, it, vi } from "vitest";

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
  MODEL_GEOMETRY_VALIDATION_PATH,
  MODEL_SCENE_PATH,
} from "../api/apiPaths";
import type { CommandContext } from "../commands/commandTypes";
import { CommandRegistry } from "../commands/CommandRegistry";
import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import { ResourceInvalidationController } from "../resources/ResourceInvalidationController";
import { SESSION_STATUS_RESOURCE_KEY } from "../resources/useSessionStatus";
import { SelectionController } from "../selection/SelectionController";

import {
  FDM_MESH_COMMAND_NOT_APPLICABLE_REASON,
  GEOMETRY_LIFECYCLE_COMMANDS,
  UNKNOWN_MESH_COMMAND_LANE_REASON,
  resolveMeshCommandLane,
} from "./geometryLifecycleCommandContributions";

function registryWithLifecycleCommands(): CommandRegistry {
  const registry = new CommandRegistry();
  registry.attach(new EventBus<KernelEventMap>());
  for (const command of GEOMETRY_LIFECYCLE_COMMANDS) {
    registry.register(command);
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

function sessionStatus(discretization: string) {
  return {
    [SESSION_STATUS_RESOURCE_KEY]: {
      domain: { discretization },
    },
  };
}

describe("geometry lifecycle command contributions", () => {
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

    expect(result).toEqual({ status: "completed" });
    expect(submit).toHaveBeenCalledWith({
      kind: "mesh_build",
      mesh_reason: "selected-object",
      mesh_target: { kind: "object_mesh", object_id: "box" },
    });
    expect(resources.getRevision(MESHING_BUILDS_CURRENT_PATH)).toBe(1);
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

    expect(result).toEqual({ status: "completed" });
    expect(submit).toHaveBeenCalledWith({
      kind: "mesh_build",
      mesh_reason: "shared-domain",
      mesh_target: { kind: "study_domain" },
    });
    expect(resources.getRevision(MESHING_BUILDS_CURRENT_PATH)).toBe(2);
    expect(meshEvents).toEqual([
      {
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

    expect(result).toEqual({ status: "completed" });
    expect(submit).toHaveBeenCalledWith({
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
          selection,
          source: "test",
        }),
      ).toEqual({ status: "completed" });
      expect(commitTransaction).toHaveBeenCalledWith({
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
    const commitTransaction = vi.fn(async () => ({
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
      selection,
      source: "test",
    });

    expect(result).toEqual({ status: "completed" });
    expect(commitTransaction).toHaveBeenCalledWith({
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

  it("adds microstrip antennas as auxiliary scene objects with canonical field drives", async () => {
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
      objects: [{ id: "waveguide", name: "Waveguide", role: "magnet" }],
      revision: 20,
    }));
    const commitTransaction = vi.fn(async () => ({
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
      message: "Microstrip antenna added.",
      status: "completed",
    });
    expect(commitTransaction).toHaveBeenCalledWith({
      kind: "merge_patch",
      merge_patch: {
        field_drives: {
          drives: [
            { id: "existing-drive", kind: "regional" },
            {
              activation: { kind: "all_time_evolution" },
              amplitude_B_T: 0.001,
              direction: [0, 1, 0],
              enabled: true,
              id: "antenna-9ix:H_ant",
              kind: "regional",
              name: "Microstrip antenna field",
              spatial_profile: { kind: "geometry_mask", object_id: "antenna-9ix", envelope: { kind: "uniform" } },
              target: { kind: "global" },
              time_origin: "stage_local",
              waveform: { amplitude: 1, cutoff_hz: 20e9, kind: "sinc_pulse", t0: 5e-11 },
            },
          ],
        },
        objects: [
          { id: "waveguide", name: "Waveguide", role: "magnet" },
          {
            geometry: {
              geometry_kind: "Box",
              geometry_params: { size: [50e-9, 1e-6, 10e-9] },
            },
            id: "antenna-9ix",
            locked: false,
            magnetization_ref: null,
            material_ref: "",
            name: "Microstrip antenna",
            physics_stack: [],
            role: "antenna",
            tags: ["role:antenna"],
            transform: {
              rotation: [0, 0, 0],
              scale: [1, 1, 1],
              translation: [0, 0, 0],
            },
            visible: true,
          },
        ],
      },
    });
    expect(selection.get()).toMatchObject({
      kind: "object.root",
      label: "Microstrip antenna",
      nodeId: "model:object:antenna-9ix",
      objectId: "antenna-9ix",
    });
    expect(resources.getRevision(MODEL_SCENE_PATH)).toBe(22);
    now.mockRestore();
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
});
