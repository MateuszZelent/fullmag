import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectDocumentResource } from "../api/apiTypes";

import {
  ProjectDocumentController,
  bytesToBase64,
  pickProjectArchive,
  projectFileName,
} from "./ProjectDocumentController";

function resource(
  overrides: Partial<ProjectDocumentResource> = {},
): ProjectDocumentResource {
  return {
    archive_base64: bytesToBase64(new Uint8Array([80, 75, 3, 4])),
    dirty: false,
    durability: "memory_only",
    migration: {
      can_write: true,
      migrated: false,
      preserved_paths: [],
      source_schema: "fullmag.project.v1",
      target_schema: "fullmag.project.v1",
      warnings: [],
    },
    mode: { kind: "read_write" },
    name: "Demo project",
    persisted_revision: 0,
    project_id: "project-1",
    revision: 0,
    schema_version: "fullmag.project.v1",
    source_hash: "sha256:demo",
    ...overrides,
  };
}

function apiFor(
  createResponse = resource(),
  openResponse = resource(),
) {
  return {
    persistence: {
      projects: {
        create: vi.fn(async () => createResponse),
        open: vi.fn(async () => openResponse),
        authoringUpdate: vi.fn(async () => openResponse),
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ProjectDocumentController", () => {
  it("rejects a competing project operation while the first response is pending", async () => {
    let release!: (value: ProjectDocumentResource) => void;
    const pending = new Promise<ProjectDocumentResource>((resolve) => { release = resolve; });
    const api = apiFor();
    api.persistence.projects.create.mockImplementationOnce(() => pending);
    const controller = new ProjectDocumentController(api);
    const creating = controller.create("First project");
    await expect(controller.open({ bytes: new Uint8Array([1]), fileName: "second.fms" }))
      .rejects.toThrow("already in progress");
    expect(api.persistence.projects.open).not.toHaveBeenCalled();
    expect(controller.close(true)).toBe(false);
    release(resource({ name: "First project" }));
    await creating;
    expect(controller.getSnapshot().resource?.name).toBe("First project");
  });
  it("creates a project through the resource facade and exposes a ready snapshot", async () => {
    const api = apiFor(resource({ name: "New study" }));
    const controller = new ProjectDocumentController(api);

    const result = await controller.create("New study");

    expect(api.persistence.projects.create).toHaveBeenCalledWith({ name: "New study" });
    expect(result.name).toBe("New study");
    expect(controller.getSnapshot()).toMatchObject({
      fileName: "new-study.fms",
      state: "ready",
    });
    expect(controller.canSave()).toBe(true);
  });

  it("opens raw bytes without touching runtime APIs", async () => {
    const api = apiFor(undefined, resource({ name: "Opened study" }));
    const controller = new ProjectDocumentController(api);

    await controller.open({
      bytes: new Uint8Array([1, 2, 3, 4]),
      fileName: "opened.fms",
    });

    expect(api.persistence.projects.open).toHaveBeenCalledWith({
      archive_base64: "AQIDBA==",
      display_name: "opened.fms",
    });
    expect(controller.getSnapshot()).toMatchObject({
      fileName: "opened.fms",
      state: "ready",
    });
  });

  it("keeps unknown-schema projects read-only", async () => {
    const api = apiFor(undefined, resource({ mode: { kind: "read_only", reason: "unknown schema" } }));
    const controller = new ProjectDocumentController(api);

    await controller.open({ bytes: new Uint8Array([1]), fileName: "legacy.fms" });

    expect(controller.canSave()).toBe(false);
    await expect(controller.save()).rejects.toThrow("unknown schema");
  });

  it("downloads a writable archive without publishing runtime state", async () => {
    const click = vi.fn();
    const anchor = { click, download: "", href: "" };
    vi.stubGlobal("document", {
      createElement: vi.fn(() => anchor),
    });
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:project"),
      revokeObjectURL: vi.fn(),
    });
    const api = apiFor(resource({ name: "Download me" }));
    const controller = new ProjectDocumentController(api);
    await controller.create("Download me");

    await controller.save();

    expect(anchor.download).toBe("download-me.fms");
    expect(anchor.href).toBe("blob:project");
    expect(click).toHaveBeenCalledOnce();
  });

  it("uses the host persistence bridge for a durable desktop save", async () => {
    const invoke = vi.fn(async () => ({
      path: "C:\\projects\\demo.fms",
      project_id: "project-1",
      revision: 3,
      source_hash: "sha256:desktop",
    }));
    vi.stubGlobal("window", {
      __TAURI__: { core: { invoke } },
    });
    const api = apiFor(resource({ name: "Desktop project" }));
    const controller = new ProjectDocumentController(api);
    await controller.create("Desktop project");

    await controller.save();

    expect(invoke).toHaveBeenCalledWith("save_project_archive", {
      request: expect.objectContaining({
        display_name: "desktop-project.fms",
        expected_project_id: "project-1",
        expected_revision: 0,
        target_path: null,
      }),
    });
    expect(controller.getSnapshot()).toMatchObject({
      hostPath: "C:\\projects\\demo.fms",
      state: "ready",
      resource: {
        dirty: false,
        persisted_revision: 3,
        project_id: "project-1",
        revision: 3,
        source_hash: "sha256:desktop",
      },
    });
  });

  it("opens a project through the host persistence bridge", async () => {
    const invoke = vi.fn(async () => ({
      archive_base64: "AQI=",
      file_name: "desktop-project.fms",
      path: "C:\\projects\\desktop-project.fms",
    }));
    vi.stubGlobal("document", {});
    vi.stubGlobal("window", {
      __TAURI__: { core: { invoke } },
    });

    await expect(pickProjectArchive()).resolves.toEqual({
      bytes: new Uint8Array([1, 2]),
      fileName: "desktop-project.fms",
      hostPath: "C:\\projects\\desktop-project.fms",
    });
    expect(invoke).toHaveBeenCalledWith("open_project_archive_dialog");
  });

  it("keeps the last document available when a replacement open fails", async () => {
    const api = apiFor(resource({ name: "Current" }));
    api.persistence.projects.open = vi.fn(async () => {
      throw new Error("archive unavailable");
    });
    const controller = new ProjectDocumentController(api);
    await controller.create("Current");

    await expect(
      controller.open({ bytes: new Uint8Array([1]), fileName: "replacement.fms" }),
    ).rejects.toThrow("archive unavailable");

    expect(controller.getSnapshot()).toMatchObject({
      error: "archive unavailable",
      resource: { name: "Current" },
      state: "error",
    });
  });

  it("closes a clean document without touching runtime state", async () => {
    const controller = new ProjectDocumentController(apiFor(resource({ dirty: false })));
    await controller.create("Closable");

    expect(controller.close()).toBe(true);
    expect(controller.getSnapshot()).toEqual({
      error: null,
      fileName: null,
      hostPath: null,
      resource: null,
      state: "empty",
    });
  });

  it("requires an explicit discard decision for a dirty document", async () => {
    const controller = new ProjectDocumentController(apiFor(resource({ dirty: true })));
    await controller.create("Dirty");
    const confirm = vi.fn(() => false);
    vi.stubGlobal("window", { confirm });

    expect(controller.close()).toBe(false);
    expect(controller.getSnapshot().state).toBe("ready");
    expect(confirm).toHaveBeenCalledWith("Discard unsaved project changes?");

    expect(controller.close(true)).toBe(true);
    expect(controller.getSnapshot().state).toBe("empty");
  });

  describe("recordRunOutcome", () => {
    const run = {
      run_id: "run-1",
      started_at: "2026-10-04T10:00:00.000Z",
      status: "ready" as const,
      finished_at: "2026-10-04T10:05:00.000Z",
      duration_seconds: 300,
    };
    const preview = { png_base64: "iVBORw0KGgo=", colouring: "hsl-sphere" };
    const hostPath = "C:\\projects\\demo.fms";

    async function openedController(
      initial: ProjectDocumentResource,
      adopted: ProjectDocumentResource,
      invoke: ReturnType<typeof vi.fn>,
    ) {
      vi.stubGlobal("window", { __TAURI__: { core: { invoke } } });
      const api = apiFor();
      api.persistence.projects.open
        .mockResolvedValueOnce(initial)
        .mockResolvedValueOnce(adopted);
      const controller = new ProjectDocumentController(api);
      await controller.open({ bytes: new Uint8Array([1, 2]), fileName: "demo.fms", hostPath });
      return { api, controller };
    }

    const hostArchive = {
      archive_base64: "AQIDBA==",
      file_name: "demo.fms",
      path: hostPath,
    };

    it("adopts the archive the host rewrote when the document is clean", async () => {
      const invoke = vi.fn(async (_command: string, _args?: unknown) => hostArchive);
      const adopted = resource({ revision: 4, persisted_revision: 4, source_hash: "sha256:after" });
      const { api, controller } = await openedController(
        resource({ revision: 3, persisted_revision: 3 }),
        adopted,
        invoke,
      );

      await expect(controller.recordRunOutcome(run, preview)).resolves.toBe("recorded");

      expect(invoke).toHaveBeenCalledWith("project_record_outcome", {
        request: { path: hostPath, preview, run },
      });
      expect(api.persistence.projects.open).toHaveBeenLastCalledWith({
        archive_base64: "AQIDBA==",
        display_name: "demo.fms",
      });
      expect(controller.getSnapshot()).toMatchObject({
        error: null,
        fileName: "demo.fms",
        hostPath,
        resource: { revision: 4, source_hash: "sha256:after" },
        state: "ready",
      });
    });

    it("queues while the document has unsaved edits and flushes after the next save", async () => {
      const invoke = vi.fn(async (command: string, _args?: unknown) =>
        command === "save_project_archive"
          ? { path: hostPath, project_id: "project-1", revision: 5 }
          : hostArchive,
      );
      const { controller } = await openedController(
        resource({ dirty: true, revision: 5, persisted_revision: 4 }),
        resource({ revision: 6, persisted_revision: 6 }),
        invoke,
      );

      await expect(controller.recordRunOutcome(run, preview)).resolves.toBe("queued");
      expect(invoke).not.toHaveBeenCalled();
      expect(controller.getSnapshot().resource?.revision).toBe(5);

      await controller.save();

      expect(invoke.mock.calls.map(([command]) => command)).toEqual([
        "save_project_archive",
        "project_record_outcome",
      ]);
      expect(controller.getSnapshot()).toMatchObject({
        resource: { dirty: false, revision: 6 },
        state: "ready",
      });
    });

    it("keeps one queued entry per run and sends the newest", async () => {
      const invoke = vi.fn(async (command: string, _args?: unknown) =>
        command === "save_project_archive"
          ? { path: hostPath, project_id: "project-1", revision: 5 }
          : hostArchive,
      );
      const { controller } = await openedController(
        resource({ dirty: true, revision: 5, persisted_revision: 4 }),
        resource({ revision: 6, persisted_revision: 6 }),
        invoke,
      );

      await controller.recordRunOutcome({ ...run, status: "failed" });
      await controller.recordRunOutcome(run, preview);
      await controller.save();

      const outcomeCalls = invoke.mock.calls.filter(
        ([command]) => command === "project_record_outcome",
      );
      expect(outcomeCalls).toHaveLength(1);
      expect(outcomeCalls[0][1]).toEqual({ request: { path: hostPath, preview, run } });
    });

    it("does nothing outside the desktop host or without a host path", async () => {
      const api = apiFor(undefined, resource());
      const controller = new ProjectDocumentController(api);
      await controller.open({ bytes: new Uint8Array([1]), fileName: "demo.fms", hostPath });
      const before = controller.getSnapshot();

      await expect(controller.recordRunOutcome(run, preview)).resolves.toBe("skipped");
      expect(controller.getSnapshot()).toBe(before);

      const invoke = vi.fn(async (_command: string, _args?: unknown) => hostArchive);
      vi.stubGlobal("window", { __TAURI__: { core: { invoke } } });
      const unsaved = new ProjectDocumentController(apiFor(resource()));
      await unsaved.create("Unsaved");
      await expect(unsaved.recordRunOutcome(run)).resolves.toBe("skipped");
      await expect(
        new ProjectDocumentController(apiFor()).recordRunOutcome(run),
      ).resolves.toBe("skipped");
      expect(invoke).not.toHaveBeenCalled();
    });

    it("surfaces a host failure without losing the project or the queued outcome", async () => {
      let failing = true;
      const invoke = vi.fn(async (command: string, _args?: unknown) => {
        if (command === "save_project_archive") {
          return { path: hostPath, project_id: "project-1", revision: 5 };
        }
        if (failing) throw new Error("disk full");
        return hostArchive;
      });
      const { api, controller } = await openedController(
        resource({ revision: 3, persisted_revision: 3 }),
        resource({ revision: 6, persisted_revision: 6 }),
        invoke,
      );

      await expect(controller.recordRunOutcome(run, preview)).resolves.toBe("failed");

      expect(controller.getSnapshot()).toMatchObject({
        error: "disk full",
        hostPath,
        resource: { revision: 3 },
        state: "error",
      });
      expect(api.persistence.projects.open).toHaveBeenCalledTimes(1);

      expect(controller.canSave()).toBe(true);

      failing = false;
      await controller.save();

      const outcomeCalls = invoke.mock.calls.filter(
        ([command]) => command === "project_record_outcome",
      );
      expect(outcomeCalls).toHaveLength(2);
      expect(controller.getSnapshot()).toMatchObject({
        error: null,
        resource: { revision: 6 },
        state: "ready",
      });
    });

    it("rejects an adopted archive that is a different project or revision", async () => {
      const invoke = vi.fn(async (_command: string, _args?: unknown) => hostArchive);
      const { controller } = await openedController(
        resource({ revision: 3, persisted_revision: 3 }),
        resource({ project_id: "other", revision: 4 }),
        invoke,
      );

      await expect(controller.recordRunOutcome(run)).resolves.toBe("failed");

      expect(controller.getSnapshot()).toMatchObject({
        resource: { project_id: "project-1", revision: 3 },
        state: "error",
      });
    });

    it("drops queued outcomes when the project is closed", async () => {
      const invoke = vi.fn(async (_command: string, _args?: unknown) => hostArchive);
      const { controller } = await openedController(
        resource({ dirty: true, revision: 5 }),
        resource({ revision: 6 }),
        invoke,
      );
      await controller.recordRunOutcome(run);

      expect(controller.close(true)).toBe(true);
      await controller.open({ bytes: new Uint8Array([1]), fileName: "demo.fms", hostPath });
      await controller.save();

      expect(invoke.mock.calls.map(([command]) => command)).not.toContain(
        "project_record_outcome",
      );
    });
  });

  it("normalizes project file names for browser downloads", () => {
    expect(projectFileName("My Study")).toBe("my-study.fms");
    expect(projectFileName("already.FMS")).toBe("already.fms");
    expect(projectFileName(" ")).toBe("fullmag-project.fms");
  });
});
