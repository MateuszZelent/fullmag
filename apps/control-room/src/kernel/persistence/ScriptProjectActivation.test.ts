import { describe, expect, it, vi } from "vitest";
import type { KernelApi } from "../types";
import { PendingFormRegistry } from "../authoring/PendingFormRegistry";
import { createAndActivateScriptProject, openAndActivateAuthoringProject } from "./ScriptProjectActivation";
const request = { source: { name: "antenna.py", text: "import fullmag as fm" }, consent: { executed_by_user: true } };
function fixture(active = false) {
  let created = false;
  const scene = { version: "scene.v2", revision: 71, antenna_field_solve_stages: [{ id: "owned" }], study: { requested_backend: "fem", requested_device: "cpu", requested_precision: "double" } };
  const response = { project_id: "project", name: "Antenna", archive_base64: "original", scene_document: scene, script_import: { fidelity: { round_trip: "failed" } } };
  const create = vi.fn(async () => { created = true; return { session_id: "owned" }; });
  const commit = vi.fn(async () => ({ transaction_kind: "replace_scene", scene_revision: 1 }));
  const api = { resourceCacheScope: "api", sessions: { create,
    list: vi.fn(async () => ({ sessions: active || created ? [{ current: true, session_id: active ? "foreign" : "owned" }] : [] })),
    current: { status: vi.fn(async () => ({ session: { session_id: "owned", session_epoch: "epoch", request_scope_epoch: "incarnation" } })) } },
    platform: { outputStorageDefaults: vi.fn(async () => ({ output_parent: "D:/runs", temp_parent: "D:/tmp", data_format: "zarr", cleanup: "on_success", existing_output: "error", supported_formats: ["zarr"] })) },
    model: { scene: vi.fn(async () => ({ revision: 0 })), commitTransaction: commit } };
  const controller = { getSnapshot: () => ({ resource: null }), createFromScript: vi.fn(async (_request: unknown, activate: (value: typeof response, before: () => void, known: () => void) => Promise<unknown>, hooks: { assertCurrent(): void; finalize(): void }) => { await activate(response, () => undefined, () => undefined); hooks.assertCurrent(); hooks.finalize(); return response; }) };
  const kernel = { api, projectDocument: controller, pendingForms: { prepareTransition: vi.fn(async () => ({ assertCurrent: vi.fn(), release: vi.fn() })), clear: vi.fn() },
    resources: { invalidate: vi.fn(), invalidatePrefix: vi.fn() }, authoringHistory: { clear: vi.fn() } } as unknown as KernelApi;
  return { kernel, controller, response, scene, create, commit };
}
describe("script project activation", () => {
  it.each([
    ["fem", "cpu", "double"],
    ["fdm", "gpu", "single"],
    ["auto", "auto", "single"],
    ["hybrid", "auto", "double"],
  ])("preserves authored %s/%s/%s through an empty scratch bootstrap", async (backend, device, precision) => {
    const f = fixture();
    Object.assign(f.scene.study, { requested_backend: backend, requested_device: device, requested_precision: precision });
    const original = JSON.stringify(f.scene);
    await createAndActivateScriptProject(f.kernel, request);
    expect(f.create).toHaveBeenCalledWith(expect.objectContaining({ backend: backend === "fem" ? "fem" : "fdm", device: "cpu", precision: "double", replace_current: false }));
    expect(f.commit).toHaveBeenCalledWith(expect.objectContaining({ scene: expect.objectContaining({ study: expect.objectContaining({ requested_backend: backend, requested_device: device, requested_precision: precision }) }) }), expect.anything());
    expect(JSON.stringify(f.scene)).toBe(original);
  });
  it.each([
    ["requested_backend", "invalid"],
    ["requested_device", "cuda"],
    ["requested_precision", "half"],
    ["requested_backend", ["fem"]],
    ["requested_device", null],
    ["requested_precision", 64],
  ])("refuses invalid %s before session creation", async (field, value) => {
    const f = fixture();
    Object.assign(f.scene.study, { [field as string]: value });
    await expect(createAndActivateScriptProject(f.kernel, request)).rejects.toThrow("invalid execution intent");
    expect(f.create).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled();
  });
  it("preserves a newly edited form after create ACK and sends no replace_scene", async () => {
    const f = fixture(); const registry = new PendingFormRegistry();
    const kernel = { ...f.kernel, pendingForms: registry };
    const originalStatus = kernel.api.sessions.current.status;
    kernel.api.sessions.current.status = async (...args) => {
      registry.register(Symbol("late draft"), { mode: "staged", dirty: true, applying: false, valid: true, apply: () => true, reset: () => undefined });
      return originalStatus(...args);
    };
    await expect(createAndActivateScriptProject(kernel, request)).rejects.toThrow("The prepared workspace transition is no longer current.");
    expect(f.create).toHaveBeenCalledTimes(1); expect(f.commit).not.toHaveBeenCalled();
    expect(registry.getSnapshot().dirty).toBe(true); expect(registry.getTransitionSnapshot().guarded).toBe(false);
  });
  it("keeps the transition guard active while replace_scene is pending", async () => {
    const f = fixture(); const registry = new PendingFormRegistry(); const kernel = { ...f.kernel, pendingForms: registry };
    f.commit.mockImplementationOnce(async () => {
      expect(registry.getTransitionSnapshot().guarded).toBe(true);
      registry.register(Symbol("during commit"), { mode: "staged", dirty: true, applying: false, valid: true, apply: () => true, reset: () => undefined });
      return { transaction_kind: "replace_scene", scene_revision: 1 };
    });
    await expect(createAndActivateScriptProject(kernel, request)).rejects.toThrow("The prepared workspace transition is no longer current.");
    expect(registry.getSnapshot().dirty).toBe(true); expect(registry.getTransitionSnapshot().guarded).toBe(false);
  });

  it("refuses an active workspace before import", async () => {
    const f = fixture(true); await expect(createAndActivateScriptProject(f.kernel, request)).rejects.toThrow("Close the current workspace");
    expect(f.controller.createFromScript).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled();
  });
  it("uses full scene, preserved storage, actual revision and confirmed scope", async () => {
    const f = fixture(); const original = JSON.stringify(f.scene); const result = await createAndActivateScriptProject(f.kernel, request);
    expect(f.create).toHaveBeenCalledWith(expect.objectContaining({ replace_current: false, backend: "fem" }));
    expect(f.commit).toHaveBeenCalledWith(expect.objectContaining({ kind: "replace_scene", base_revision: 0, scene: expect.objectContaining({ antenna_field_solve_stages: f.scene.antenna_field_solve_stages,
      study: expect.objectContaining({ output_storage: expect.objectContaining({ temp_dir: "D:/tmp" }) }) }) }), { sessionScopeKey: "session=owned&epoch=epoch&request_scope_epoch=incarnation" });
    expect(JSON.stringify(f.scene)).toBe(original); expect(result).toBe(f.response); expect(result.archive_base64).toBe("original"); expect(result.script_import.fidelity.round_trip).toBe("failed");
  });
  it("does not retry unknown create", async () => {
    const f = fixture(); f.create.mockRejectedValueOnce(new Error("unknown create")); await expect(createAndActivateScriptProject(f.kernel, request)).rejects.toThrow("unknown create");
    expect(f.create).toHaveBeenCalledTimes(1); expect(f.commit).not.toHaveBeenCalled();
  });
  it("does not retry unknown scene mutation", async () => {
    const f = fixture(); f.commit.mockRejectedValueOnce(new Error("unknown transaction")); await expect(createAndActivateScriptProject(f.kernel, request)).rejects.toThrow("unknown transaction");
    expect(f.create).toHaveBeenCalledTimes(1); expect(f.commit).toHaveBeenCalledTimes(1);
  });
  it("refuses a response without canonical scene before creating a session", async () => {
    const f = fixture(); delete (f.response as { scene_document?: unknown }).scene_document;
    await expect(createAndActivateScriptProject(f.kernel, request)).rejects.toThrow("did not return"); expect(f.create).not.toHaveBeenCalled();
  });
});

describe("runtime-free project archive activation", () => {
  function archiveFixture(authoring = true, active = false) {
    const f = fixture(active);
    const opened = { ...f.response, authoring_scene_document: authoring ? f.scene : undefined };
    const open = vi.fn(async (_source: unknown, activate: (response: typeof opened, before: () => void, known: () => void) => Promise<unknown>, hooks: { assertCurrent(): void; finalize(): void }) => {
      if (opened.authoring_scene_document) {
        await activate(opened, () => undefined, () => undefined);
        hooks.assertCurrent(); hooks.finalize();
      }
      return opened;
    });
    Object.assign(f.controller, { open });
    return { ...f, opened, open };
  }
  const source = { bytes: new Uint8Array([1]), fileName: "authoring.fms" };

  it("uses the same full-scene scratch activation without executing source or changing project metadata", async () => {
    const f = archiveFixture(); const original = JSON.stringify(f.scene);
    const result = await openAndActivateAuthoringProject(f.kernel, source);
    expect(result).toBe(f.opened);
    expect(result.project_id).toBe(f.response.project_id);
    expect(result.archive_base64).toBe("original");
    expect(JSON.stringify(f.scene)).toBe(original);
    expect(f.create).toHaveBeenCalledWith(expect.objectContaining({ replace_current: false }));
    expect(f.commit).toHaveBeenCalledWith(expect.objectContaining({ kind: "replace_scene" }), expect.anything());
    expect(f.controller.createFromScript).not.toHaveBeenCalled();
  });

  it("leaves old and historical responses on the evidence-only path", async () => {
    const f = archiveFixture(false);
    await openAndActivateAuthoringProject(f.kernel, source);
    expect(f.create).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled();
    expect(f.kernel.pendingForms?.prepareTransition).not.toHaveBeenCalled();
  });

  it("refuses another active workspace without replacing it", async () => {
    const f = archiveFixture(true, true);
    await expect(openAndActivateAuthoringProject(f.kernel, source)).rejects.toThrow("Close the current workspace");
    expect(f.create).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled();
  });

  it("keeps newly changed drafts when the scene commit is pending", async () => {
    const f = archiveFixture(); const registry = new PendingFormRegistry();
    const kernel = { ...f.kernel, pendingForms: registry };
    f.commit.mockImplementationOnce(async () => {
      registry.register(Symbol("archive draft"), { mode: "staged", dirty: true, applying: false, valid: true, apply: () => true, reset: () => undefined });
      return { transaction_kind: "replace_scene", scene_revision: 1 };
    });
    await expect(openAndActivateAuthoringProject(kernel, source)).rejects.toThrow("The prepared workspace transition is no longer current.");
    expect(registry.getSnapshot().dirty).toBe(true);
    expect(registry.getTransitionSnapshot().guarded).toBe(false);
    expect(f.create).toHaveBeenCalledTimes(1); expect(f.commit).toHaveBeenCalledTimes(1);
  });
});
