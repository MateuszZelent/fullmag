import type {
  ProjectArchiveRequest,
  ProjectCreateRequest,
  ProjectDocumentResource,
} from "../api/apiTypes";
import type { ControlRoomApi } from "../api/ControlRoomApi";
import {
  assertProjectDocumentReopenMatches,
  captureProjectDocumentDevelopmentHandoff,
  validateProjectDocumentDevelopmentHandoff,
  validateProjectDocumentResource,
  type CaptureProjectDocumentDevelopmentHandoffOptions,
  type ProjectDocumentDevelopmentHandoff,
} from "./ProjectDocumentDevelopmentHandoff";

const DEFAULT_PROJECT_NAME = "Untitled project";
const DEFAULT_PROJECT_FILE_NAME = "fullmag-project.fms";

export interface ProjectArchiveSource {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly hostPath?: string;
}

export type TauriInvoke = <T = unknown>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

interface TauriProjectOpenArchive {
  readonly path: string;
  readonly file_name: string;
  readonly archive_base64: string;
}

interface TauriProjectSaveSummary {
  readonly path: string;
  readonly project_id?: string;
  readonly revision?: number;
  readonly source_hash?: string | null;
}

declare global {
  interface Window {
    __TAURI__?: {
      core?: {
        invoke?: TauriInvoke;
      };
    };
  }
}

export type ProjectDocumentSnapshot =
  | {
      readonly error: null;
      readonly resource: null;
      readonly state: "empty";
      readonly fileName: null;
      readonly hostPath: null;
    }
  | {
      readonly error: null;
      readonly resource: ProjectDocumentResource | null;
      readonly state: "loading";
      readonly fileName: string | null;
      readonly hostPath: string | null;
    }
  | {
      readonly error: string;
      readonly resource: ProjectDocumentResource | null;
      readonly state: "error";
      readonly fileName: string | null;
      readonly hostPath: string | null;
    }
  | {
      readonly error: null;
      readonly resource: ProjectDocumentResource;
      readonly state: "ready";
      readonly fileName: string;
      readonly hostPath: string | null;
    };

export interface ProjectDocumentApi {
  readonly persistence: {
    readonly projects: {
      create(
        request: ProjectCreateRequest,
      ): Promise<ProjectDocumentResource>;
      open(request: ProjectArchiveRequest): Promise<ProjectDocumentResource>;
    };
  };
}

export const EMPTY_PROJECT_DOCUMENT_SNAPSHOT: ProjectDocumentSnapshot = {
  error: null,
  fileName: null,
  resource: null,
  state: "empty",
  hostPath: null,
};

export class ProjectDocumentController {
  private snapshot: ProjectDocumentSnapshot = EMPTY_PROJECT_DOCUMENT_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private activeOperation: "create" | "open" | "save" | "restore" | null = null;

  constructor(private readonly api: ProjectDocumentApi | ControlRoomApi) {}

  getSnapshot = (): ProjectDocumentSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  canSave(): boolean {
    return (
      this.snapshot.state === "ready" &&
      this.snapshot.resource.mode.kind === "read_write" &&
      this.snapshot.resource.archive_base64.length > 0
    );
  }

  /**
   * Detach the current project from the workspace without touching runtime
   * state. Dirty documents require an explicit discard decision from the
   * caller; the host-owned file remains unchanged.
   */
  close(discardChanges = false): boolean {
    const snapshot = this.snapshot;
    if (this.activeOperation !== null || snapshot.state === "loading") return false;
    if (
      (snapshot.state === "ready" || snapshot.state === "error") &&
      snapshot.resource?.dirty &&
      !discardChanges
    ) {
      const confirm =
        typeof window !== "undefined" && typeof window.confirm === "function"
          ? window.confirm("Discard unsaved project changes?")
          : false;
      if (!confirm) return false;
    }
    if (snapshot.state === "empty") return true;
    this.snapshot = EMPTY_PROJECT_DOCUMENT_SNAPSHOT;
    this.notify();
    return true;
  }

  async create(name = DEFAULT_PROJECT_NAME): Promise<ProjectDocumentResource> {
    this.assertOperationAvailable();
    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new Error("Project name cannot be empty.");
    }
    this.beginOperation("create");
    try {
      this.setLoading();
      const resource = await this.api.persistence.projects.create({
        name: trimmedName,
      });
      this.setReady(resource, projectFileName(resource.name));
      return resource;
    } catch (error) {
      this.setError(error);
      throw error;
    } finally {
      this.finishOperation("create");
    }
  }

  async open(source: ProjectArchiveSource): Promise<ProjectDocumentResource> {
    this.assertOperationAvailable();
    if (source.bytes.byteLength === 0) {
      throw new Error("The selected project archive is empty.");
    }
    this.beginOperation("open");
    try {
      this.setLoading(source.fileName, source.hostPath ?? null);
      const request: ProjectArchiveRequest = {
        archive_base64: bytesToBase64(source.bytes),
        display_name: source.fileName,
      };
      const resource = await this.api.persistence.projects.open(request);
      this.setReady(
        resource,
        projectFileName(source.fileName || resource.name),
        source.hostPath ?? null,
      );
      return resource;
    } catch (error) {
      this.setError(error, source.fileName);
      throw error;
    } finally {
      this.finishOperation("open");
    }
  }

  captureDevelopmentHandoff(
    options: CaptureProjectDocumentDevelopmentHandoffOptions = {},
  ): ProjectDocumentDevelopmentHandoff {
    this.assertOperationAvailable();
    return captureProjectDocumentDevelopmentHandoff(this.snapshot, options);
  }

  /**
   * Restore a captured bytes-only document into a fresh empty controller.
   * The controller remains empty until the API has reproduced and verified the
   * captured identity, mode, migration policy, and canonical archive bytes.
   */
  async restoreDevelopmentHandoff(value: unknown): Promise<void> {
    this.assertOperationAvailable();
    if (this.snapshot.state !== "empty") {
      throw new Error("Project document handoff restore requires an empty controller.");
    }
    const handoff = validateProjectDocumentDevelopmentHandoff(value);
    if (handoff.snapshot.state === "empty") return;

    this.beginOperation("restore");
    try {
      const captured = handoff.snapshot;
      const reopened = await this.api.persistence.projects.open({
        archive_base64: captured.resource.archive_base64,
        display_name: captured.fileName,
      });
      const validatedReopen = validateProjectDocumentResource(reopened);
      assertProjectDocumentReopenMatches(captured.resource, validatedReopen);

      // The API reopen proves the archive is still byte-identical and
      // compatible. Keep the captured metadata as source provenance; no host
      // filesystem save or durability claim is made by this operation.
      this.setReady(captured.resource, captured.fileName, captured.hostPath);
    } finally {
      this.finishOperation("restore");
    }
  }

  async save(): Promise<void> {
    this.assertOperationAvailable();
    if (this.snapshot.state !== "ready") {
      throw new Error("No project document is open.");
    }
    if (this.snapshot.resource.mode.kind !== "read_write") {
      throw new Error(
        this.snapshot.resource.mode.reason ||
          "This project is read-only and cannot be saved.",
      );
    }
    this.beginOperation("save");
    try {
      const snapshot = this.snapshot;
      if (snapshot.state !== "ready") {
        throw new Error("No project document is open.");
      }
      const bytes = base64ToBytes(snapshot.resource.archive_base64);
      const invoke = tauriInvoke();
      if (invoke) {
        const result = await invoke<TauriProjectSaveSummary>("save_project_archive", {
          request: {
            archive_base64: snapshot.resource.archive_base64,
            display_name: snapshot.fileName,
            target_path: snapshot.hostPath,
            expected_project_id: snapshot.resource.project_id,
            expected_revision: snapshot.resource.persisted_revision,
            client_intent_id: `control-room-${Date.now()}`,
          },
        });
        const revision =
          typeof result.revision === "number"
            ? result.revision
            : snapshot.resource.revision;
        const persistedRevision =
          typeof result.revision === "number"
            ? result.revision
            : snapshot.resource.persisted_revision ?? snapshot.resource.revision;
        this.snapshot = {
          ...snapshot,
          error: null,
          hostPath: result.path,
          resource: {
            ...snapshot.resource,
            dirty: false,
            persisted_revision: persistedRevision,
            project_id: result.project_id ?? snapshot.resource.project_id,
            revision,
            source_hash:
              result.source_hash === undefined
                ? snapshot.resource.source_hash
                : result.source_hash,
          },
        };
        this.notify();
        return;
      }
      downloadProjectArchive(bytes, snapshot.fileName);
    } finally {
      this.finishOperation("save");
    }
  }

  private assertOperationAvailable(): void {
    if (this.activeOperation !== null || this.snapshot.state === "loading") {
      throw new Error("A project document operation is already in progress.");
    }
  }

  private beginOperation(operation: "create" | "open" | "save" | "restore"): void {
    this.assertOperationAvailable();
    this.activeOperation = operation;
  }

  private finishOperation(operation: "create" | "open" | "save" | "restore"): void {
    if (this.activeOperation === operation) this.activeOperation = null;
  }

  private setLoading(
    fileName: string | null = null,
    hostPath: string | null = null,
  ): void {
    const previous = this.snapshot;
    this.snapshot = {
      error: null,
      fileName: fileName ?? previous.fileName,
      hostPath: hostPath ?? previous.hostPath,
      resource: previous.resource,
      state: "loading",
    };
    this.notify();
  }

  private setReady(
    resource: ProjectDocumentResource,
    fileName: string,
    hostPath: string | null = null,
  ): void {
    this.snapshot = {
      error: null,
      fileName,
      hostPath,
      resource,
      state: "ready",
    };
    this.notify();
  }

  private setError(error: unknown, fileName: string | null = null): void {
    this.snapshot = {
      error: errorMessage(error),
      fileName,
      hostPath: this.snapshot.hostPath,
      resource: this.snapshot.resource,
      state: "error",
    };
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export async function pickProjectArchive(): Promise<ProjectArchiveSource | null> {
  if (typeof document === "undefined") return null;

  const invoke = tauriInvoke();
  if (invoke) {
    const selected = await invoke<TauriProjectOpenArchive | null>(
      "open_project_archive_dialog",
    );
    if (!selected) return null;
    return {
      bytes: base64ToBytes(selected.archive_base64),
      fileName: selected.file_name,
      hostPath: selected.path,
    };
  }

  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".fms,application/zip,application/octet-stream";
  input.setAttribute("aria-hidden", "true");
  input.style.position = "fixed";
  input.style.left = "-10000px";
  document.body.appendChild(input);

  try {
    return await new Promise<ProjectArchiveSource | null>((resolve) => {
      input.addEventListener(
        "change",
        () => {
          const file = input.files?.[0];
          if (!file) {
            resolve(null);
            return;
          }
          void file.arrayBuffer().then((buffer) => {
            resolve({
              bytes: new Uint8Array(buffer),
              fileName: file.name || DEFAULT_PROJECT_FILE_NAME,
            });
          });
        },
        { once: true },
      );
      input.addEventListener("cancel", () => resolve(null), { once: true });
      input.click();
    });
  } finally {
    input.remove();
  }
}

export function tauriInvoke(): TauriInvoke | null {
  if (typeof window === "undefined") return null;
  return typeof window.__TAURI__?.core?.invoke === "function"
    ? window.__TAURI__.core.invoke
    : null;
}

export function projectFileName(name: string): string {
  const normalized = name.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").toLowerCase();
  if (!normalized) return DEFAULT_PROJECT_FILE_NAME;
  return normalized.endsWith(".fms")
    ? normalized
    : `${normalized}.fms`;
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(
        ...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)),
      );
    }
    return btoa(binary);
  }
  return Buffer.from(bytes).toString("base64");
}

export function base64ToBytes(value: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }
  return new Uint8Array(Buffer.from(value, "base64"));
}

function downloadProjectArchive(bytes: Uint8Array, fileName: string): void {
  if (typeof document === "undefined" || typeof URL === "undefined") {
    throw new Error("Project downloads are unavailable in this environment.");
  }
  const blob = new Blob([bytes], { type: "application/zip" });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.download = fileName;
  anchor.href = href;
  document.body?.appendChild(anchor);
  anchor.click();
  setTimeout(() => {
    anchor.parentNode?.removeChild(anchor);
    URL.revokeObjectURL(href);
  }, 0);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Project document operation failed.";
}
