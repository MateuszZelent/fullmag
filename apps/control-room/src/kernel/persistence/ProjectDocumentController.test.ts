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
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ProjectDocumentController", () => {
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

  it("normalizes project file names for browser downloads", () => {
    expect(projectFileName("My Study")).toBe("my-study.fms");
    expect(projectFileName("already.FMS")).toBe("already.fms");
    expect(projectFileName(" ")).toBe("fullmag-project.fms");
  });
});
