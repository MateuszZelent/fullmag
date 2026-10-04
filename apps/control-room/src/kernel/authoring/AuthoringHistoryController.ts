import type {
  AuthoringTransactionRequest,
  AuthoringTransactionResponse,
  JsonObject,
  RequestOptions,
  SceneResource,
} from "../api/apiTypes";
import { MODEL_SCENE_PATH } from "../api/apiPaths";
import type { ResourceInvalidationController } from "../resources/ResourceInvalidationController";
import type { Selection } from "../selection/selectionTypes";
import {
  invalidateAuthoringMutationDependents,
} from "./authoringMutationInvalidation";
import { publishCommittedSceneResource } from "../resources/geometryLifecycleResources";

export interface AuthoringHistoryApi {
  model: {
    scene(options?: RequestOptions): Promise<SceneResource>;
    commitTransaction(
      transaction: AuthoringTransactionRequest,
      options?: RequestOptions,
    ): Promise<AuthoringTransactionResponse>;
  };
}

export interface AuthoringHistoryRecord {
  before: SceneResource;
  after: SceneResource;
  beforeWorkspaceState?: AuthoringHistoryWorkspaceState | null;
  afterWorkspaceState?: AuthoringHistoryWorkspaceState | null;
  committedRevision?: number | null;
  label: string;
}

export interface AuthoringHistoryWorkspaceState {
  selection: Selection | null;
}

export interface AuthoringHistoryWorkspaceTransition {
  expected: AuthoringHistoryWorkspaceState;
  restore: AuthoringHistoryWorkspaceState;
  scene: SceneResource;
}

export type AuthoringHistoryWorkspaceRestorer = (
  transition: AuthoringHistoryWorkspaceTransition,
) => void;

export interface AuthoringHistorySnapshot {
  canRedo: boolean;
  canUndo: boolean;
  redoLabel: string | null;
  undoLabel: string | null;
  pending: boolean;
}

export interface AuthoringHistoryCommandResult {
  message: string;
  status: "completed" | "failed" | "cancelled" | "pending";
}

interface HistoryEntry {
  after: JsonObject;
  afterWorkspaceState: AuthoringHistoryWorkspaceState | null;
  before: JsonObject;
  beforeWorkspaceState: AuthoringHistoryWorkspaceState | null;
  currentRevision: number;
  id: string;
  label: string;
}

const SCENE_DOCUMENT_FIELDS = [
  "version",
  "revision",
  "scene",
  "universe",
  "objects",
  "couplings",
  "materials",
  "magnetization_assets",
  "field_drives",
  "monitors",
  "selections",
  "magnetization_constraints",
  "current_modules",
  "current_transports",
  "spin_transports",
  "spin_torques",
  "oersted_fields",
  "study",
  "outputs",
  "editor",
] as const;

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneWorkspaceState(
  state: AuthoringHistoryWorkspaceState | null | undefined,
): AuthoringHistoryWorkspaceState | null {
  if (!state) return null;
  return {
    selection: state.selection ? cloneJson(state.selection) : null,
  };
}

function sceneRevision(scene: SceneResource): number | null {
  const revision = scene.scene_revision ?? scene.revision;
  return typeof revision === "number" && Number.isFinite(revision)
    ? revision
    : null;
}

/**
 * Convert the resource envelope back to the SceneDocument accepted by the
 * replace_scene transaction. Resource-only revision metadata is intentionally
 * excluded; the API applies the supplied base revision atomically.
 */
export function sceneDocumentPayload(scene: SceneResource): JsonObject {
  const source = scene as unknown as Record<string, unknown>;
  const payload: Record<string, unknown> = {};
  for (const field of SCENE_DOCUMENT_FIELDS) {
    if (source[field] !== undefined) {
      payload[field] = cloneJson(source[field]);
    }
  }
  return payload as JsonObject;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Revision-fenced semantic history for canonical authoring transactions.
 *
 * History entries contain complete SceneDocument snapshots, while undo and
 * redo are committed through the API's replace_scene transaction. This keeps
 * the operation observable to the same resource/revision machinery as any
 * other authoring mutation and refuses to overwrite a newer external edit.
 */
export class AuthoringHistoryController {
  private readonly listeners = new Set<() => void>();
  private readonly undoStack: HistoryEntry[] = [];
  private readonly redoStack: HistoryEntry[] = [];
  private sequence = 0;
  private historyGeneration = 0;
  private pending = false;

  constructor(
    private readonly api: AuthoringHistoryApi,
    private readonly resources: ResourceInvalidationController,
  ) {}

  getSnapshot = (): AuthoringHistorySnapshot => ({
    canRedo: this.redoStack.length > 0 && !this.pending,
    canUndo: this.undoStack.length > 0 && !this.pending,
    redoLabel: this.redoStack.at(-1)?.label ?? null,
    undoLabel: this.undoStack.at(-1)?.label ?? null,
    pending: this.pending,
  });

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  canUndo(): boolean {
    return this.undoStack.length > 0 && !this.pending;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0 && !this.pending;
  }

  getGeneration(): number {
    return this.historyGeneration;
  }

  record(record: AuthoringHistoryRecord): void {
    const revision =
      record.committedRevision ?? sceneRevision(record.after);
    if (revision === null || revision === undefined) return;

    this.undoStack.push({
      after: sceneDocumentPayload(record.after),
      afterWorkspaceState: cloneWorkspaceState(record.afterWorkspaceState),
      before: sceneDocumentPayload(record.before),
      beforeWorkspaceState: cloneWorkspaceState(record.beforeWorkspaceState),
      currentRevision: revision,
      id: `authoring-history-${++this.sequence}`,
      label: record.label,
    });
    this.redoStack.length = 0;
    this.notify();
  }

  clear(): void {
    // Even an empty stack can have an immediate mutation awaiting its ACK.
    this.historyGeneration += 1;
    if (
      this.undoStack.length === 0 &&
      this.redoStack.length === 0 &&
      !this.pending
    ) {
      return;
    }
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.notify();
  }

  async undo(
    sessionScopeKey?: string | null,
    restoreWorkspace?: AuthoringHistoryWorkspaceRestorer,
  ): Promise<AuthoringHistoryCommandResult> {
    const entry = this.undoStack.at(-1);
    if (!entry) {
      return { message: "Nothing to undo.", status: "cancelled" };
    }
    if (this.pending) {
      return {
        message: "Another authoring history operation is still pending.",
        status: "pending",
      };
    }

    this.pending = true;
    const operationGeneration = this.historyGeneration;
    this.notify();
    try {
      const currentRevision = await this.currentRevision(sessionScopeKey);
      if (this.historyGeneration !== operationGeneration) {
        return this.cancelled("Undo");
      }
      if (currentRevision !== entry.currentRevision) {
        return this.externalChange(
          `Undo stopped: the scene changed outside history at revision ${currentRevision}.`,
        );
      }

      const response = await this.restore(
        entry.before,
        currentRevision,
        operationGeneration,
        sessionScopeKey,
      );
      if (!response || this.historyGeneration !== operationGeneration) {
        return this.cancelled("Undo");
      }
      this.undoStack.pop();
      entry.currentRevision = response.scene_revision;
      this.redoStack.push(entry);
      this.notifyWorkspaceRestore(
        restoreWorkspace,
        response.committed_scene,
        entry.afterWorkspaceState,
        entry.beforeWorkspaceState,
      );
      return {
        message: `Undid ${entry.label}.`,
        status: "completed",
      };
    } catch (error) {
      return { message: `Undo failed: ${errorMessage(error)}`, status: "failed" };
    } finally {
      this.pending = false;
      this.notify();
    }
  }

  async redo(
    sessionScopeKey?: string | null,
    restoreWorkspace?: AuthoringHistoryWorkspaceRestorer,
  ): Promise<AuthoringHistoryCommandResult> {
    const entry = this.redoStack.at(-1);
    if (!entry) {
      return { message: "Nothing to redo.", status: "cancelled" };
    }
    if (this.pending) {
      return {
        message: "Another authoring history operation is still pending.",
        status: "pending",
      };
    }

    this.pending = true;
    const operationGeneration = this.historyGeneration;
    this.notify();
    try {
      const currentRevision = await this.currentRevision(sessionScopeKey);
      if (this.historyGeneration !== operationGeneration) {
        return this.cancelled("Redo");
      }
      if (currentRevision !== entry.currentRevision) {
        return this.externalChange(
          `Redo stopped: the scene changed outside history at revision ${currentRevision}.`,
        );
      }

      const response = await this.restore(
        entry.after,
        currentRevision,
        operationGeneration,
        sessionScopeKey,
      );
      if (!response || this.historyGeneration !== operationGeneration) {
        return this.cancelled("Redo");
      }
      this.redoStack.pop();
      entry.currentRevision = response.scene_revision;
      this.undoStack.push(entry);
      this.notifyWorkspaceRestore(
        restoreWorkspace,
        response.committed_scene,
        entry.beforeWorkspaceState,
        entry.afterWorkspaceState,
      );
      return {
        message: `Redid ${entry.label}.`,
        status: "completed",
      };
    } catch (error) {
      return { message: `Redo failed: ${errorMessage(error)}`, status: "failed" };
    } finally {
      this.pending = false;
      this.notify();
    }
  }

  private async currentRevision(sessionScopeKey?: string | null): Promise<number> {
    const options = sessionScopeKey ? { sessionScopeKey } : undefined;
    const scene = await this.api.model.scene(options);
    const revision = sceneRevision(scene);
    if (revision === null) {
      throw new Error("The canonical scene revision is unavailable.");
    }
    return revision;
  }

  private notifyWorkspaceRestore(
    restoreWorkspace: AuthoringHistoryWorkspaceRestorer | undefined,
    scene: SceneResource,
    expected: AuthoringHistoryWorkspaceState | null,
    restore: AuthoringHistoryWorkspaceState | null,
  ): void {
    if (!restoreWorkspace || !expected || !restore) return;
    try {
      restoreWorkspace({ expected, restore, scene });
    } catch {
      // Workspace restoration is best-effort and cannot undo a committed scene restore.
    }
  }

  private async restore(
    scene: JsonObject,
    baseRevision: number,
    operationGeneration: number,
    sessionScopeKey?: string | null,
  ): Promise<AuthoringTransactionResponse | null> {
    const options = sessionScopeKey ? { sessionScopeKey } : undefined;
    const response = await this.api.model.commitTransaction({
      base_revision: baseRevision,
      kind: "replace_scene",
      scene,
    }, options);
    if (!Number.isFinite(response.scene_revision)) {
      throw new Error("The replace_scene ACK omitted a valid scene revision.");
    }
    if (this.historyGeneration !== operationGeneration) {
      return null;
    }
    publishCommittedSceneResource(
      this.resources,
      response.committed_scene,
      response.scene_revision,
      undefined,
      false,
      sessionScopeKey,
    );
    for (const kind of ["geometry", "magnetization", "material", "interaction"] as const) {
      invalidateAuthoringMutationDependents(
        this.resources,
        kind,
        response.scene_revision,
      );
    }
    return response;
  }

  private cancelled(
    operation: "Undo" | "Redo",
  ): AuthoringHistoryCommandResult {
    return {
      message: `${operation} cancelled because authoring history was cleared while the operation was pending.`,
      status: "cancelled",
    };
  }

  private externalChange(message: string): AuthoringHistoryCommandResult {
    return { message, status: "failed" };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export const AUTHORING_HISTORY_SCENE_RESOURCE_KEY = MODEL_SCENE_PATH;
