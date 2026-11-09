import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlRoomApi } from "../api/ControlRoomApi";
import type { ProjectDocumentResource } from "../api/apiTypes";
import { createProjectAuthoringSessionBinding } from "./ProjectAuthoringSessionBinding";
import { bytesToBase64, ProjectDocumentController } from "./ProjectDocumentController";

function fixture() {
  const state = { revision: 41, sceneRevision: 41 as number | undefined, sessionId: "owned" };
  const api = {
    resourceCacheScope: "api",
    sessions: {
      list: vi.fn(async () => ({ sessions: [{ current: true, session_id: state.sessionId }] })),
      current: { status: vi.fn(async () => ({
        session: { session_id: state.sessionId, session_epoch: "owned@1", request_scope_epoch: "api:1" },
        resources: { scene_revision: state.revision },
      })) },
    },
    model: { scene: vi.fn(async () => ({ version: "scene.v2", revision: state.sceneRevision, study: {} })) },
  };
  const binding = createProjectAuthoringSessionBinding(
    api as unknown as Pick<ControlRoomApi, "sessions" | "model" | "resourceCacheScope">,
    "project", "owned",
  );
  return { state, api, binding };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("project Save scene revision fence", () => {
  it("retains the captured revision throughout authoring synchronization", async () => {
    const f = fixture();
    await expect(f.binding.readSceneDocument()).resolves.toMatchObject({ revision: 41 });
    await expect(f.binding.verifyCurrent(41)).resolves.toBeUndefined();
    f.state.revision = 42;
    await expect(f.binding.verifyCurrent(41)).rejects.toThrow(/scene changed/i);
  });

  it("rejects a scene changed between snapshot read and identity verification", async () => {
    const f = fixture();
    f.api.model.scene.mockImplementationOnce(async () => {
      f.state.revision = 42;
      return { version: "scene.v2", revision: 41, study: {} };
    });
    await expect(f.binding.readSceneDocument()).rejects.toThrow(/scene changed/i);
  });

  it("lets a later explicit Save capture the newly edited scene", async () => {
    const f = fixture();
    await f.binding.readSceneDocument();
    f.state.revision = 42; f.state.sceneRevision = 42;
    await expect(f.binding.readSceneDocument()).resolves.toMatchObject({ revision: 42 });
    await expect(f.binding.verifyCurrent(42)).resolves.toBeUndefined();
  });

  it("keeps two concurrent snapshot fences independent", async () => {
    const f = fixture();
    const first = await f.binding.readSceneDocument();
    f.state.revision = 42; f.state.sceneRevision = 42;
    const second = await f.binding.readSceneDocument();
    await expect(f.binding.verifyCurrent(first.revision as number)).rejects.toThrow(/scene changed/i);
    await expect(f.binding.verifyCurrent(second.revision as number)).resolves.toBeUndefined();
  });

  it.each([undefined, -1, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "refuses an unavailable or invalid captured scene revision: %s", async (revision) => {
      const f = fixture(); f.state.sceneRevision = revision;
      await expect(f.binding.readSceneDocument()).rejects.toThrow(/scene revision/i);
    },
  );

  it("keeps existing session and API incarnation checks", async () => {
    const f = fixture(); await f.binding.readSceneDocument();
    f.state.sessionId = "foreign";
    await expect(f.binding.verifyCurrent(41)).rejects.toThrow(/workspace changed/i);
    f.state.sessionId = "owned"; f.api.resourceCacheScope = "new-api";
    await expect(f.binding.verifyCurrent(41)).rejects.toThrow(/connection changed/i);
  });

  it("does not mark a desktop copy current when Analysis changes during host Save", async () => {
    const f = fixture();
    const resource: ProjectDocumentResource = {
      archive_base64: bytesToBase64(new Uint8Array([80, 75, 3, 4])),
      dirty: false, durability: "memory_only", name: "Project", project_id: "project",
      revision: 0, persisted_revision: 0, schema_version: "fullmag.project.v1",
      mode: { kind: "read_write" }, migration: { can_write: true, migrated: false,
        preserved_paths: [], source_schema: "fullmag.project.v1", target_schema: "fullmag.project.v1", warnings: [] },
    };
    const persistence = { projects: {
      create: vi.fn(async () => resource), open: vi.fn(async () => resource),
      fromScript: vi.fn(), authoringUpdate: vi.fn(async () => resource),
    } };
    const controller = new ProjectDocumentController({ persistence });
    await controller.create("Project"); controller.bindAuthoringSession(f.binding);
    const invoke = vi.fn(async () => {
      f.state.revision = 42;
      return { path: "C:\\projects\\project.fms", project_id: "project", revision: 0 };
    });
    vi.stubGlobal("window", { __TAURI__: { core: { invoke } } });
    await expect(controller.save()).rejects.toThrow(/scene changed/i);
    expect(invoke).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().resource?.dirty).toBe(true);
    expect(controller.getSnapshot().resource?.archive_base64).toBe(resource.archive_base64);
  });
});
