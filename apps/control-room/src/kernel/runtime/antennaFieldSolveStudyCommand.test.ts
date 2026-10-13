import { describe, expect, it, vi } from "vitest";
import type { SceneResource } from "../api/apiTypes";
import { MODEL_SCENE_PATH } from "../api/apiPaths";
import { AuthoringHistoryController } from "../authoring/AuthoringHistoryController";
import { CommandRegistry } from "../commands/CommandRegistry";
import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import { ResourceInvalidationController } from "../resources/ResourceInvalidationController";
import { STUDY_RUNTIME_COMMANDS } from "./studyRuntimeCommandContributions";
import {
  ADD_ANTENNA_FIELD_SOLVE_STAGE_COMMAND,
  antennaFieldSolveStudyStages,
} from "./antennaFieldSolveStudyCommand";

const target = { objectId: "antenna", stageId: "solve-1" };
const action = {
  kind: "antenna_field_solve", entrypoint_kind: "flat_antenna_field_solve",
  stage_id: "solve-1", port_mode_ids: ["port-1"],
};
function fixture(): SceneResource {
  return {
    scene_revision: 7,
    objects: [{ id: "antenna" }],
    antenna_field_solve_stages: [{
      id: "solve-1", source_object_id: "antenna", current_transport_id: "current",
      port_mode_ids: ["port-1"], model: "quasistatic_conduction_biot_savart3d",
      oersted_realization: "direct_tetra_quadrature", conductor_mesh_policy: "quadrature",
      field_sampling_domain: { kind: "global" }, target_refs: [{ kind: "global" }],
      solver_policy: "direct", outputs: [{ id: "H_ant", quantity: "H" }],
    }],
    antenna_port_modes: ["port-1", "port-2"].map((id) => ({
      id, source_object_id: "antenna", current_transport_id: "current",
      schema_version: "antenna_port_mode.v2", branches: [],
    })),
    study: { stages: [{ kind: "run", stage_id: "run-1", until_seconds: "1e-9" }], backend: "fem" },
  };
}
function registry() {
  const registry = new CommandRegistry();
  for (const command of STUDY_RUNTIME_COMMANDS) registry.register(command);
  return registry;
}

describe("antenna solve Study reference", () => {
  it("appends the exact reference without copying definitions or certifying physics", () => {
    const scene = fixture();
    const original = structuredClone(scene);
    expect(antennaFieldSolveStudyStages(scene, target)).toEqual({
      alreadyAdded: false, stages: [...scene.study!.stages as object[], action],
    });
    expect(scene).toEqual(original);
  });

  it("is idempotent and refuses conflicting or duplicate stage IDs", () => {
    const scene = fixture();
    scene.study!.stages = [action];
    expect(antennaFieldSolveStudyStages(scene, target).alreadyAdded).toBe(true);
    for (const stages of [[{ ...action, port_mode_ids: ["port-2"] }], [{ kind: "run", stage_id: "solve-1" }], [action, action]]) {
      scene.study!.stages = stages;
      expect(() => antennaFieldSolveStudyStages(scene, target)).toThrow("conflicting stage ID");
    }
  });

  it("preserves pipeline nodes and separates outer node identity from the definition reference", () => {
    const scene = fixture();
    const existing = { id: "run-node", label: "Run", node_kind: "primitive", stage_kind: "run", payload: { kind: "run" } };
    scene.study!.study_pipeline = { version: "study_pipeline.v1", nodes: [existing] };
    const before = structuredClone(scene);
    const next = antennaFieldSolveStudyStages(scene, target);
    expect(next.studyPipeline).toEqual({ version: "study_pipeline.v1", nodes: [existing, {
      id: "antenna-field-solve:solve-1", label: "Field solve solve-1", enabled: true,
      source: "ui_authored", node_kind: "primitive", stage_kind: "antenna_field_solve", payload: action,
    }] });
    expect(next.stages).toEqual(scene.study!.stages);
    expect(scene).toEqual(before);
  });

  it("accepts serde document defaults without consulting a malformed dormant flat list", () => {
    const scene = fixture();
    scene.study!.study_pipeline = {};
    scene.study!.stages = [null];
    const before = structuredClone(scene);
    const next = antennaFieldSolveStudyStages(scene, target);
    expect(next.studyPipeline!.nodes).toHaveLength(1);
    expect(scene).toEqual(before);
  });

  it.each([{ ports: [] }, { ports: ["port-1", "port-2"] }, { ports: [" "] }])("rejects unsupported port selection $ports", ({ ports }) => {
    const scene = fixture();
    scene.antenna_field_solve_stages![0].port_mode_ids = ports;
    const before = structuredClone(scene);
    expect(() => antennaFieldSolveStudyStages(scene, target)).toThrow("exactly one port mode");
    expect(scene).toEqual(before);
  });

  it("refuses even an explicit port choice from an unsupported multiport definition", () => {
    const scene = fixture();
    scene.antenna_field_solve_stages![0].port_mode_ids = ["port-2", "port-1"];
    const before = structuredClone(scene);
    for (const portModeId of ["port-2", "port-1", "foreign"]) {
      expect(() => antennaFieldSolveStudyStages(scene, { ...target, portModeId })).toThrow("exactly one port mode");
      expect(scene).toEqual(before);
    }
  });

  it.each([
    { groupEnabled: true, stageEnabled: false },
    { groupEnabled: false, stageEnabled: true },
    { groupEnabled: false, stageEnabled: false },
  ])("reports an inactive nested reference without enabling it: %j", ({ groupEnabled, stageEnabled }) => {
    const scene = fixture();
    scene.study!.study_pipeline = { version: "study_pipeline.v1", nodes: [{
      id: "group", node_kind: "group", enabled: groupEnabled, children: [{
        id: "imported-stage-000", node_kind: "primitive", stage_kind: "antenna_field_solve",
        enabled: stageEnabled, payload: action,
      }],
    }] };
    const before = structuredClone(scene);
    expect(antennaFieldSolveStudyStages(scene, target)).toMatchObject({
      alreadyAdded: true, existingStageEnabled: false,
    });
    expect(scene).toEqual(before);
  });

  it("reports an active nested reference independently of dormant flat stages", () => {
    const scene = fixture();
    scene.study!.study_pipeline = { version: "study_pipeline.v1", nodes: [{
      id: "group", node_kind: "group", children: [{
        id: "active-solve", node_kind: "primitive", stage_kind: "antenna_field_solve", payload: action,
      }],
    }] };
    expect(antennaFieldSolveStudyStages(scene, target)).toMatchObject({
      alreadyAdded: true, existingStageEnabled: true,
    });
  });

  it("explains disabled ancestry without a transaction, history entry or invalidation", async () => {
    const before = fixture();
    before.study!.study_pipeline = { version: "study_pipeline.v1", nodes: [{
      id: "off-group", node_kind: "group", enabled: false, children: [{
        id: "solve-node", node_kind: "primitive", stage_kind: "antenna_field_solve", payload: action,
      }],
    }] };
    const original = structuredClone(before);
    const commitTransaction = vi.fn();
    const api = { model: { scene: vi.fn(async () => before), commitTransaction } };
    const resources = new ResourceInvalidationController(new EventBus<KernelEventMap>());
    const history = new AuthoringHistoryController(api as never, resources);
    const result = await registry().execute(ADD_ANTENNA_FIELD_SOLVE_STAGE_COMMAND, {
      api: api as never, authoringHistory: history, resources, input: target, source: "test",
    });
    expect(result.status).toBe("completed");
    expect(result.message).toContain("ancestor group is disabled");
    expect(commitTransaction).not.toHaveBeenCalled();
    expect(history.getSnapshot().canUndo).toBe(false);
    expect(resources.getRevision(MODEL_SCENE_PATH)).toBeNull();
    expect(before).toEqual(original);
  });

  it("refuses a conflicting outer node ID rather than overwriting another stage", () => {
    const scene = fixture();
    scene.study!.study_pipeline = { version: "study_pipeline.v1", nodes: [{
      id: "antenna-field-solve:solve-1", node_kind: "primitive", stage_kind: "run", payload: { kind: "run" },
    }] };
    expect(() => antennaFieldSolveStudyStages(scene, target)).toThrow("conflicting pipeline node ID");
  });

  it.each(["source", "duplicate-source", "definition", "duplicate-definition", "port", "duplicate-port", "port-owner", "port-transport", "malformed"])("refuses %s without modifying the pipeline", (fault) => {
    const scene = fixture();
    if (fault === "source") scene.objects = [];
    if (fault === "duplicate-source") scene.objects!.push(scene.objects![0]);
    if (fault === "definition") scene.antenna_field_solve_stages![0].source_object_id = "another";
    if (fault === "duplicate-definition") scene.antenna_field_solve_stages!.push(scene.antenna_field_solve_stages![0]);
    if (fault === "port") scene.antenna_port_modes = [];
    if (fault === "duplicate-port") scene.antenna_port_modes!.push(scene.antenna_port_modes![0]);
    if (fault === "port-owner") scene.antenna_port_modes![0].source_object_id = "another";
    if (fault === "port-transport") scene.antenna_port_modes![0].current_transport_id = "other-current";
    if (fault === "malformed") scene.study!.stages = [null];
    const before = structuredClone(scene);
    expect(() => antennaFieldSolveStudyStages(scene, target)).toThrow();
    expect(scene).toEqual(before);
  });

  it("uses current scene revision, scoped transaction and semantic history", async () => {
    const before = fixture();
    const after = { ...before, scene_revision: 8, study: { ...before.study, stages: [...before.study!.stages as object[], action] } };
    const scene = vi.fn(async () => before);
    const commitTransaction = vi.fn(async () => ({ scene_revision: 8, committed_scene: after }));
    const api = { model: { scene, commitTransaction } };
    const resources = new ResourceInvalidationController(new EventBus<KernelEventMap>());
    const history = new AuthoringHistoryController(api as never, resources);
    const result = await registry().execute(ADD_ANTENNA_FIELD_SOLVE_STAGE_COMMAND, {
      api: api as never, authoringHistory: history, resources, input: target,
      source: "test", sessionScopeKey: "session-a", isCurrentSessionScope: () => true,
    });
    expect(result.status).toBe("completed");
    expect(commitTransaction).toHaveBeenCalledWith({
      kind: "merge_patch", base_revision: 7,
      merge_patch: { study: { stages: [...before.study!.stages as object[], action] } },
    }, { sessionScopeKey: "session-a" });
    expect(resources.getRevision(MODEL_SCENE_PATH)).toBe(8);
    expect(history.getSnapshot()).toMatchObject({ canUndo: true, undoLabel: "Add antenna field solve to Study" });
  });

  it("never commits after the session changes during the scene read", async () => {
    let current = true;
    const scene = vi.fn(async () => { current = false; return fixture(); });
    const commitTransaction = vi.fn();
    const result = await registry().execute(ADD_ANTENNA_FIELD_SOLVE_STAGE_COMMAND, {
      api: { model: { scene, commitTransaction } } as never, input: target,
      source: "test", sessionScopeKey: "session-a", isCurrentSessionScope: () => current,
    });
    expect(result.status).toBe("cancelled");
    expect(commitTransaction).not.toHaveBeenCalled();
  });

  it("refuses an unavailable scene revision instead of guessing a base revision", async () => {
    const before = fixture();
    before.scene_revision = null;
    const commitTransaction = vi.fn();
    const result = await registry().execute(ADD_ANTENNA_FIELD_SOLVE_STAGE_COMMAND, {
      api: { model: { scene: async () => before, commitTransaction } } as never,
      input: target, source: "test",
    });
    expect(result.status).toBe("failed");
    expect(commitTransaction).not.toHaveBeenCalled();
  });

  it("does not mutate, invalidate or record history when already enqueued", async () => {
    const before = fixture();
    before.study!.stages = [action];
    const commitTransaction = vi.fn();
    const api = { model: { scene: vi.fn(async () => before), commitTransaction } };
    const resources = new ResourceInvalidationController(new EventBus<KernelEventMap>());
    const history = new AuthoringHistoryController(api as never, resources);
    const result = await registry().execute(ADD_ANTENNA_FIELD_SOLVE_STAGE_COMMAND, {
      api: api as never, authoringHistory: history, resources, input: target, source: "test",
    });
    expect(result.status).toBe("completed");
    expect(commitTransaction).not.toHaveBeenCalled();
    expect(history.getSnapshot().canUndo).toBe(false);
    expect(resources.getRevision(MODEL_SCENE_PATH)).toBeNull();
  });

  it("uses the selected solution identity when explicit input is absent", async () => {
    const commitTransaction = vi.fn(async () => ({ scene_revision: 8, committed_scene: fixture() }));
    const result = await registry().execute(ADD_ANTENNA_FIELD_SOLVE_STAGE_COMMAND, {
      api: { model: { scene: async () => fixture(), commitTransaction } } as never,
      selection: { get: () => ({ ref: {
        type: "scene-object", kind: "object.antenna.solution", objectId: "antenna", antennaResourceId: "solve-1",
      } }) } as never,
      source: "test",
    });
    expect(result.status).toBe("completed");
    expect(commitTransaction).toHaveBeenCalledTimes(1);
  });

  it("suppresses invalidation and history after an obsolete transaction ACK", async () => {
    let current = true;
    const before = fixture();
    const after = { ...before, scene_revision: 8 };
    const api = { model: {
      scene: async () => before,
      commitTransaction: async () => { current = false; return { scene_revision: 8, committed_scene: after }; },
    } };
    const resources = new ResourceInvalidationController(new EventBus<KernelEventMap>());
    const history = new AuthoringHistoryController(api as never, resources);
    const result = await registry().execute(ADD_ANTENNA_FIELD_SOLVE_STAGE_COMMAND, {
      api: api as never, authoringHistory: history, resources, input: target,
      source: "test", sessionScopeKey: "session-a", isCurrentSessionScope: () => current,
    });
    expect(result.status).toBe("cancelled");
    expect(resources.getRevision(MODEL_SCENE_PATH)).toBeNull();
    expect(history.getSnapshot().canUndo).toBe(false);
  });
});
