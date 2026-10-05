import type {
  ProjectArchiveRequest,
  ProjectAuthoringUpdateRequest,
  ProjectCreateRequest,
  ProjectDocumentResource,
  ProjectFromScriptRequest,
  ProjectFromScriptResource,
  ScriptFidelityResource,
} from "../api/apiTypes";
import type { ControlRoomApi } from "../api/ControlRoomApi";
import {
  assertProjectDocumentReopenMatches,
  captureProjectDocumentDevelopmentHandoff,
  cloneBoundedProjectJsonObject,
  validateProjectDocumentDevelopmentHandoff,
  validateProjectDocumentResource,
  type CaptureProjectDocumentDevelopmentHandoffOptions,
  type ProjectDocumentDevelopmentHandoff,
} from "./ProjectDocumentDevelopmentHandoff";
import type { RunOutcomePreview, RunOutcomeRecord } from "./runOutcome";

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

interface PendingRunOutcome {
  readonly projectId: string;
  readonly preview?: RunOutcomePreview;
  readonly run: RunOutcomeRecord;
}

export type RecordRunOutcomeResult = "recorded" | "queued" | "skipped" | "failed";

type ProjectDocumentOperation =
  | "create"
  | "open"
  | "save"
  | "restore"
  | "authoring"
  | "outcome";

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

/**
 * What the last script import produced, kept beside (not inside) the document
 * snapshot so it survives later saves and authoring updates until dismissed or
 * until another project replaces it.
 */
export interface ScriptImportNotice {
  readonly projectId: string;
  readonly projectName: string;
  readonly scriptName: string;
  readonly sha256: string;
  readonly origin: string;
  readonly fidelity: ScriptFidelityResource;
}

export interface ProjectDocumentApi {
  readonly persistence: {
    readonly projects: {
      create(
        request: ProjectCreateRequest,
      ): Promise<ProjectDocumentResource>;
      fromScript(
        request: ProjectFromScriptRequest,
      ): Promise<ProjectFromScriptResource>;
      open(request: ProjectArchiveRequest): Promise<ProjectDocumentResource>;
      authoringUpdate(
        request: ProjectAuthoringUpdateRequest,
      ): Promise<ProjectDocumentResource>;
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

export interface ProjectDocumentDevelopmentGuard {
  readonly handoff: ProjectDocumentDevelopmentHandoff;
  assertCurrent(): void;
  release(): void;
}

export class ProjectDocumentController {
  private snapshot: ProjectDocumentSnapshot = EMPTY_PROJECT_DOCUMENT_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private developmentGuard: symbol | null = null;
  private activeOperation: ProjectDocumentOperation | null = null;
  private pendingOutcomes: PendingRunOutcome[] = [];
  private flushingOutcomes = false;
  private scheduledRunOutcomeCount = 0;
  private outcomeErrorSnapshot: ProjectDocumentSnapshot | null = null;
  private scriptImportNotice: ScriptImportNotice | null = null;

  constructor(private readonly api: ProjectDocumentApi | ControlRoomApi) {}

  getSnapshot = (): ProjectDocumentSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getScriptImportNotice = (): ScriptImportNotice | null => this.scriptImportNotice;

  dismissScriptImportNotice(): void {
    if (this.scriptImportNotice === null) return;
    this.scriptImportNotice = null;
    this.notify();
  }

  canSave(): boolean {
    const document = this.documentView();
    return (
      this.developmentGuard === null &&
      document !== null &&
      document.resource.mode.kind === "read_write" &&
      document.resource.archive_base64.length > 0
    );
  }

  /**
   * Detach the current project from the workspace without touching runtime
   * state. Dirty documents require an explicit discard decision from the
   * caller; the host-owned file remains unchanged.
   */
  close(discardChanges = false): boolean {
    const snapshot = this.snapshot;
    if (this.developmentGuard !== null || this.activeOperation !== null || snapshot.state === "loading") return false;
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
    this.pendingOutcomes = [];
    this.scriptImportNotice = null;
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
      this.pendingOutcomes = [];
      this.scriptImportNotice = null;
      this.setReady(resource, projectFileName(resource.name));
      return resource;
    } catch (error) {
      this.setError(error);
      throw error;
    } finally {
      this.finishOperation("create");
    }
  }

  /**
   * Create the open project from a script. The API executes the script in the
   * Python helper, so the caller must already hold the person's consent
   * (`request.consent.executed_by_user`). A failure leaves the previous
   * document in place and is rethrown with the helper's message.
   */
  async createFromScript(
    request: ProjectFromScriptRequest,
  ): Promise<ProjectFromScriptResource> {
    this.assertOperationAvailable();
    if (request.consent?.executed_by_user !== true) {
      throw new Error("Creating a project from a script needs the person's consent to run it.");
    }
    this.beginOperation("create");
    try {
      this.setLoading();
      const response = await this.api.persistence.projects.fromScript(request);
      const { script_import: scriptImport, ...project } = response;
      this.pendingOutcomes = [];
      this.scriptImportNotice = {
        projectId: project.project_id,
        projectName: project.name,
        scriptName: scriptImport.name,
        sha256: scriptImport.sha256,
        origin: scriptImport.origin,
        fidelity: scriptImport.fidelity,
      };
      this.setReady(project, projectFileName(project.name));
      return response;
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
      this.pendingOutcomes = [];
      this.scriptImportNotice = null;
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
    this.assertDevelopmentHandoffIdle();
    return captureProjectDocumentDevelopmentHandoff(this.snapshot, options);
  }

  /** Reserve this outcome before asynchronous preview work can outlive capture. */
  tryReserveRunOutcome(): (() => void) | null {
    if (this.developmentGuard !== null) return null;

    this.scheduledRunOutcomeCount += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.scheduledRunOutcomeCount = Math.max(
        0,
        this.scheduledRunOutcomeCount - 1,
      );
    };
  }

  /** Freeze this document owner until a confirmed restart outcome releases its guard. */
  beginDevelopmentHandoff(
    options: CaptureProjectDocumentDevelopmentHandoffOptions = {},
  ): ProjectDocumentDevelopmentGuard {
    this.assertOperationAvailable();
    this.assertDevelopmentHandoffIdle();
    const handoff = captureProjectDocumentDevelopmentHandoff(this.snapshot, options);
    const capturedJson = JSON.stringify(handoff);
    const original = this.snapshot;
    const token = Symbol("project-document-development-handoff");
    this.developmentGuard = token;
    // The immutable snapshot identity also notifies consumers of command availability.
    this.snapshot = { ...original };
    const captured = this.snapshot;
    try {
      this.notify();
    } catch (error) {
      this.developmentGuard = null;
      this.snapshot = original;
      try { this.notify(); } catch { /* The failed guard is not retained. */ }
      throw error;
    }
    let released = false;
    return {
      handoff,
      assertCurrent: () => {
        this.assertDevelopmentHandoffIdle();
        if (released || this.developmentGuard !== token || this.snapshot !== captured
          || JSON.stringify(captureProjectDocumentDevelopmentHandoff(this.snapshot, { carryUnsaved: true })) !== capturedJson) {
          throw new Error("The captured project document is no longer guarded.");
        }
      },
      release: () => {
        if (released) return;
        released = true;
        if (this.developmentGuard === token) {
          this.developmentGuard = null;
          this.snapshot = { ...this.snapshot };
          this.notify();
        }
      },
    };
  }

  /**
   * Restore a captured bytes-only document into a fresh empty controller.
   * The controller remains empty until the API has reproduced and verified the
   * captured identity, mode, migration policy, and canonical archive bytes.
   */
  async restoreDevelopmentHandoff(value: unknown): Promise<void> {
    this.assertOperationAvailable();
    this.assertDevelopmentHandoffIdle();
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

  /**
   * Synchronize an explicit scene document into the current portable archive.
   * This updates only the in-memory project snapshot; durable Save remains a
   * separate user action.
   */
  async synchronizeAuthoring(
    sceneDocument: Record<string, unknown>,
  ): Promise<ProjectDocumentResource> {
    this.assertOperationAvailable();
    const currentSnapshot = this.documentView();
    if (!currentSnapshot) {
      throw new Error("No project document is open.");
    }

    const currentResource = validateProjectDocumentResource(
      currentSnapshot.resource,
    );
    if (
      currentResource.mode.kind !== "read_write" ||
      !currentResource.migration.can_write
    ) {
      throw new Error(
        currentResource.mode.kind === "read_only"
          ? currentResource.mode.reason || "This project is read-only."
          : "This project cannot be authored under its migration policy.",
      );
    }
    if (!Number.isSafeInteger(currentResource.revision)) {
      throw new Error("The current project revision is invalid.");
    }

    this.beginOperation("authoring");
    try {
      const detachedSceneDocument =
        cloneBoundedProjectJsonObject(sceneDocument);
      const request: ProjectAuthoringUpdateRequest = {
        archive_base64: currentResource.archive_base64,
        display_name: currentSnapshot.fileName,
        expected_project_id: currentResource.project_id,
        expected_revision: currentResource.revision,
        scene_document: detachedSceneDocument,
      };
      const response = validateProjectDocumentResource(
        await this.api.persistence.projects.authoringUpdate(request),
      );
      assertAuthoringUpdateStableMetadata(currentResource, response);

      if (response.revision === currentResource.revision) {
        if (response.archive_base64 !== currentResource.archive_base64) {
          throw new Error(
            "Project authoring returned changed archive bytes without advancing the revision.",
          );
        }
        return currentSnapshot.resource;
      }

      const nextRevision = currentResource.revision + 1;
      if (
        !Number.isSafeInteger(nextRevision) ||
        response.revision !== nextRevision
      ) {
        throw new Error(
          "Project authoring must advance the project revision by exactly one.",
        );
      }
      if (response.dirty !== true) {
        throw new Error(
          "Project authoring returned a changed archive that is not marked dirty.",
        );
      }
      if (response.archive_base64 === currentResource.archive_base64) {
        throw new Error(
          "Project authoring advanced the revision without changing archive bytes.",
        );
      }

      const preservedResource: ProjectDocumentResource = {
        ...response,
        dirty: true,
      };
      if (Object.hasOwn(currentResource, "persisted_revision")) {
        preservedResource.persisted_revision =
          currentResource.persisted_revision;
      } else {
        delete preservedResource.persisted_revision;
      }
      if (Object.hasOwn(currentResource, "source_hash")) {
        preservedResource.source_hash = currentResource.source_hash;
      } else {
        delete preservedResource.source_hash;
      }

      const updatedResource =
        validateProjectDocumentResource(preservedResource);
      this.snapshot = {
        error: null,
        fileName: currentSnapshot.fileName,
        hostPath: currentSnapshot.hostPath,
        resource: updatedResource,
        state: "ready",
      };
      this.notify();
      return updatedResource;
    } finally {
      this.finishOperation("authoring");
    }
  }

  async save(): Promise<void> {
    this.assertOperationAvailable();
    const document = this.documentView();
    if (!document) {
      throw new Error("No project document is open.");
    }
    if (document.resource.mode.kind !== "read_write") {
      throw new Error(
        document.resource.mode.reason ||
          "This project is read-only and cannot be saved.",
      );
    }
    this.beginOperation("save");
    let savedToHost = false;
    try {
      const snapshot = this.documentView();
      if (!snapshot) {
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
          state: "ready",
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
        savedToHost = true;
        return;
      }
      downloadProjectArchive(bytes, snapshot.fileName);
    } finally {
      this.finishOperation("save");
      if (savedToHost) await this.flushPendingOutcomes();
    }
  }

  /**
   * Record a finished run (and an optional thumbnail) in the open project file
   * through the desktop host, then adopt the archive the host rewrote. Edits
   * not yet saved cannot be merged into the host's rewrite, so while the
   * document is dirty or another operation is running the outcome is queued
   * and flushed after the next successful save. Never throws: without a host
   * path or outside the desktop app it does nothing, and a host failure is
   * published through the snapshot error while the outcome stays queued.
   */
  async recordRunOutcome(
    run: RunOutcomeRecord,
    preview?: RunOutcomePreview,
  ): Promise<RecordRunOutcomeResult> {
    const snapshot = this.documentView();
    if (
      !tauriInvoke() ||
      !snapshot ||
      !snapshot.hostPath ||
      snapshot.resource.mode.kind !== "read_write" ||
      !snapshot.resource.migration.can_write
    ) {
      return "skipped";
    }

    const projectId = snapshot.resource.project_id;
    const entry: PendingRunOutcome = { projectId, preview, run };
    const existing = this.pendingOutcomes.findIndex(
      (item) => item.projectId === projectId && item.run.run_id === run.run_id,
    );
    if (existing >= 0) this.pendingOutcomes[existing] = entry;
    else this.pendingOutcomes.push(entry);

    if (
      snapshot.resource.dirty ||
      this.developmentGuard !== null ||
      this.activeOperation !== null ||
      this.flushingOutcomes
    ) {
      return "queued";
    }
    await this.flushPendingOutcomes();
    if (!this.pendingOutcomes.includes(entry)) return "recorded";
    return this.snapshot === this.outcomeErrorSnapshot ? "failed" : "queued";
  }

  private async flushPendingOutcomes(): Promise<void> {
    if (this.flushingOutcomes) return;
    this.flushingOutcomes = true;
    try {
      while (this.pendingOutcomes.length > 0) {
        const snapshot = this.documentView();
        if (
          this.developmentGuard !== null ||
          this.activeOperation !== null ||
          !snapshot ||
          snapshot.resource.dirty ||
          !snapshot.hostPath
        ) {
          return;
        }
        const next = this.pendingOutcomes[0];
        if (next.projectId !== snapshot.resource.project_id) {
          this.pendingOutcomes.shift();
          continue;
        }
        if (!(await this.applyRunOutcome(next))) return;
        this.pendingOutcomes.shift();
      }
    } finally {
      this.flushingOutcomes = false;
    }
  }

  private async applyRunOutcome(outcome: PendingRunOutcome): Promise<boolean> {
    const invoke = tauriInvoke();
    const snapshot = this.documentView();
    if (!invoke || !snapshot || !snapshot.hostPath) return false;
    this.beginOperation("outcome");
    try {
      const archive = await invoke<TauriProjectOpenArchive>("project_record_outcome", {
        request: {
          path: snapshot.hostPath,
          preview: outcome.preview,
          run: outcome.run,
        },
      });
      const reopened = validateProjectDocumentResource(
        await this.api.persistence.projects.open({
          archive_base64: archive.archive_base64,
          display_name: archive.file_name,
        }),
      );
      if (
        reopened.project_id !== snapshot.resource.project_id ||
        reopened.revision !== snapshot.resource.revision + 1
      ) {
        throw new Error(
          "Recording the run outcome returned a different project or an unexpected revision.",
        );
      }
      this.setReady(
        reopened,
        projectFileName(archive.file_name || reopened.name),
        archive.path,
      );
      return true;
    } catch (error) {
      this.setError(error, snapshot.fileName);
      this.outcomeErrorSnapshot = this.snapshot;
      return false;
    } finally {
      this.finishOperation("outcome");
    }
  }

  /**
   * The document as a ready snapshot. A failed outcome recording publishes an
   * error but leaves the document itself intact, so that one error state stays
   * saveable; any other error state does not.
   */
  private documentView(): Extract<ProjectDocumentSnapshot, { state: "ready" }> | null {
    const snapshot = this.snapshot;
    if (snapshot.state === "ready") return snapshot;
    if (
      snapshot === this.outcomeErrorSnapshot &&
      snapshot.state === "error" &&
      snapshot.resource &&
      snapshot.fileName
    ) {
      return {
        error: null,
        fileName: snapshot.fileName,
        hostPath: snapshot.hostPath,
        resource: snapshot.resource,
        state: "ready",
      };
    }
    return null;
  }

  private assertOperationAvailable(): void {
    if (this.developmentGuard !== null) {
      throw new Error("The project document is protected during development restart.");
    }
    if (this.activeOperation !== null || this.snapshot.state === "loading") {
      throw new Error("A project document operation is already in progress.");
    }
  }

  private assertDevelopmentHandoffIdle(): void {
    if (
      this.scheduledRunOutcomeCount > 0 ||
      this.pendingOutcomes.length > 0 ||
      this.flushingOutcomes
    ) {
      throw new Error(
        "A project run outcome is pending or being recorded; wait before development handoff.",
      );
    }
  }

  private beginOperation(operation: ProjectDocumentOperation): void {
    this.assertOperationAvailable();
    this.activeOperation = operation;
  }

  private finishOperation(operation: ProjectDocumentOperation): void {
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

function assertAuthoringUpdateStableMetadata(
  current: ProjectDocumentResource,
  updated: ProjectDocumentResource,
): void {
  if (
    updated.project_id !== current.project_id ||
    updated.name !== current.name ||
    updated.schema_version !== current.schema_version ||
    updated.mode.kind !== current.mode.kind ||
    updated.migration.can_write !== current.migration.can_write ||
    updated.migration.target_schema !== current.migration.target_schema
  ) {
    throw new Error(
      "Project authoring changed project identity or writable document metadata.",
    );
  }
}
