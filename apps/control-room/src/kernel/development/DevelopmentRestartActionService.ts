import type { DevelopmentBackendResource } from "../api/apiTypes";
import { isApiInstanceId } from "../api/apiInstancePin";
import type { ResourceResult } from "../resources/resourceTypes";
import type { KernelApi } from "../types";
import {
  createDevelopmentRestartController,
  DevelopmentRestartCaptureError,
  type DevelopmentRestartController,
  type DevelopmentRestartSnapshot,
} from "./DevelopmentRestartController";
import type { DevelopmentKernelHost } from "./DevelopmentKernelHost";

const DEVELOPMENT_BACKEND_SCHEMA_VERSION = "1.0.0";

export type DevelopmentRestartActionState = DevelopmentRestartSnapshot["state"] | "checking";

export interface DevelopmentRestartActionSnapshot {
  readonly state: DevelopmentRestartActionState;
  readonly requestId: string | null;
  readonly message: string | null;
  readonly busy: boolean;
}

export const IDLE_DEVELOPMENT_RESTART_ACTION_SNAPSHOT: DevelopmentRestartActionSnapshot = {
  state: "idle",
  requestId: null,
  message: null,
  busy: false,
};

interface WorkspaceIdentity {
  readonly apiInstanceId: string;
  readonly sessionId: string | null;
  readonly sessionEpoch: number;
}

interface RestartCandidate {
  readonly buildId: string;
  readonly sourceSha256: string;
  readonly workspace: WorkspaceIdentity;
}

type CandidateResult =
  | { readonly candidate: RestartCandidate; readonly message: null }
  | { readonly candidate: null; readonly message: string };

/**
 * Host-owned explicit restart action. Its controller and uncertain request custody
 * survive banner remounts and kernel publication generations.
 */
export class DevelopmentRestartActionService {
  private snapshot: DevelopmentRestartActionSnapshot = IDLE_DEVELOPMENT_RESTART_ACTION_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private readonly host: DevelopmentKernelHost;
  private operation: Promise<void> | null = null;
  private operationToken: object | null = null;
  private controller: DevelopmentRestartController | null = null;
  private unsubscribeController: (() => void) | null = null;
  private attempt: { readonly kernel: KernelApi; readonly candidate: RestartCandidate; applied: boolean } | null = null;
  private lastAppliedSourceSha256: string | null = null;

  constructor(host: DevelopmentKernelHost) {
    this.host = host;
    this.host.subscribe(() => this.onHostChange());
  }

  getSnapshot = (): DevelopmentRestartActionSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  canStart = (kernel: KernelApi, resource: ResourceResult<DevelopmentBackendResource>): boolean =>
    this.evaluateResource(kernel, resource).candidate !== null;

  start = (kernel: KernelApi, resource: ResourceResult<DevelopmentBackendResource>): Promise<void> => {
    if (this.operation) return this.operation;

    const eligibility = this.evaluateResource(kernel, resource);
    const candidate = eligibility.candidate;
    if (!candidate) {
      if (!this.hasRetainedIntent()) this.setFailure(eligibility.message);
      return Promise.resolve();
    }

    const previousController = this.controller;
    return this.launch(
      { state: "checking", requestId: null, message: null },
      (token) => this.confirmAndStart(kernel, candidate, previousController, token),
      "Could not confirm the ready build. Refresh development status before trying again.",
    );
  };

  reconcile = (): Promise<void> => {
    if (this.operation) return this.operation;
    const controller = this.controller;
    if (!controller || !["pending", "unknown"].includes(controller.getSnapshot().state)) {
      return Promise.resolve();
    }

    return this.launch(
      this.controllerSnapshot(controller),
      async (token) => {
        if (this.operationToken !== token || this.controller !== controller) return;
        await controller.reconcile();
      },
      "Restart status could not be confirmed. The captured workspace remains protected.",
      true,
    );
  };

  private evaluateResource(
    kernel: KernelApi,
    resource: ResourceResult<DevelopmentBackendResource>,
  ): CandidateResult {
    const hostSnapshot = this.host.getSnapshot();
    if (hostSnapshot.kernel !== kernel) {
      return { candidate: null, message: "This workspace generation is no longer current." };
    }
    if (hostSnapshot.paused || hostSnapshot.publicationError) {
      return { candidate: null, message: "The workspace is protected during a transition." };
    }
    if (this.operation || this.snapshot.busy) {
      return { candidate: null, message: "A restart action is already in progress." };
    }
    if (resource.status !== "ready") {
      return { candidate: null, message: "Wait for a fresh development status before restarting." };
    }
    if (resource.error || resource.refreshError) {
      return { candidate: null, message: "Development status could not be confirmed. Refresh it before restarting." };
    }
    if (!resource.data) {
      return { candidate: null, message: "Development status is unavailable." };
    }
    return this.evaluateBackend(kernel, resource.data);
  }

  private evaluateBackend(kernel: KernelApi, backend: DevelopmentBackendResource): CandidateResult {
    const hostSnapshot = this.host.getSnapshot();
    if (hostSnapshot.kernel !== kernel) {
      return { candidate: null, message: "This workspace generation is no longer current." };
    }
    if (hostSnapshot.paused || hostSnapshot.publicationError) {
      return { candidate: null, message: "The workspace is protected during a transition." };
    }

    const evaluated = this.readCandidate(kernel, backend);
    if (!evaluated.candidate) return evaluated;
    if (this.controller) {
      const controllerSnapshot = this.controller.getSnapshot();
      const retryableCaptureFailure = this.isConfirmedPreIntentFailure(controllerSnapshot, kernel);
      if (!retryableCaptureFailure) {
        return { candidate: null, message: "A previous restart still owns this workspace transition." };
      }
    }
    return evaluated;
  }

  /** Validate a typed observation without requiring the Host to be unpaused. */
  private readCandidate(kernel: KernelApi, backend: DevelopmentBackendResource): CandidateResult {
    const pin = kernel.api.getExpectedApiInstance();
    if (!pin || !isApiInstanceId(pin)) {
      return { candidate: null, message: "Development restart requires a launcher-pinned workspace." };
    }
    if (backend.schema_version !== DEVELOPMENT_BACKEND_SCHEMA_VERSION
      || !Number.isSafeInteger(backend.revision) || backend.revision < 0) {
      return { candidate: null, message: "Development status has an unsupported schema or revision." };
    }
    if (!backend.configured || backend.state !== "ready" || backend.restart_available !== true) {
      return { candidate: null, message: "Development restart is unavailable for the current backend status." };
    }

    const identity = backend.workspace_identity;
    if (!identity || identity.api_instance_id !== pin || !Number.isSafeInteger(identity.session_epoch)
      || identity.session_epoch < 0
      || (identity.session_id != null && (typeof identity.session_id !== "string"
        || !identity.session_id.trim() || identity.session_id !== identity.session_id.trim()))) {
      return { candidate: null, message: "The current workspace identity is unavailable." };
    }

    const readyBuild = backend.ready_build;
    if (!readyBuild || !isValidBuildIdentity(readyBuild)) {
      return { candidate: null, message: "A valid ready build is not available." };
    }
    const currentBuild = backend.current_build;
    if (!currentBuild || !isValidBuildIdentity(currentBuild)) {
      return { candidate: null, message: "The current build identity is unavailable or invalid." };
    }

    const sourceSha256 = readyBuild.source_sha256.toLowerCase();
    if (currentBuild.source_sha256.toLowerCase() === sourceSha256) {
      return { candidate: null, message: "The ready build is already active." };
    }
    if (sourceSha256 === this.lastAppliedSourceSha256) {
      return { candidate: null, message: "This ready build has already been applied." };
    }

    const candidate: RestartCandidate = {
      buildId: readyBuild.id,
      sourceSha256,
      workspace: {
        apiInstanceId: identity.api_instance_id,
        sessionId: identity.session_id ?? null,
        sessionEpoch: identity.session_epoch,
      },
    };
    return { candidate, message: null };
  }

  private async confirmAndStart(
    kernel: KernelApi,
    selected: RestartCandidate,
    previousController: DevelopmentRestartController | null,
    token: object,
  ): Promise<void> {
    let fresh: DevelopmentBackendResource;
    try {
      fresh = await kernel.api.platform.developmentBackend();
    } catch {
      this.setFailure("Could not confirm the ready build. Refresh development status before trying again.");
      return;
    }

    if (this.operationToken !== token || !this.operation || !this.snapshot.busy
      || this.controller !== previousController
      || this.host.getSnapshot().kernel !== kernel || this.host.getSnapshot().paused
      || this.host.getSnapshot().publicationError) {
      this.setFailure("The workspace changed while restart status was being confirmed. No restart was submitted.");
      return;
    }

    const current = this.evaluateBackend(kernel, fresh);
    if (!current.candidate || !sameCandidate(selected, current.candidate)) {
      this.setFailure(current.message
        ?? "The ready build or workspace identity changed. No restart was submitted.");
      return;
    }
    const confirmedCandidate = current.candidate;

    if (previousController && !this.disposeCompletedControllerForNextAttempt(kernel, previousController)) {
      this.setFailure("The previous restart still owns workspace guards. No restart was submitted.");
      return;
    }

    let controller: DevelopmentRestartController;
    try {
      const owners = this.host.createOwners({ applyPendingChanges: false, carryUnsavedDocument: true });
      controller = createDevelopmentRestartController(
        kernel.api,
        {
          capture: async () => {
            const captured = await owners.capture();
            try {
              if (captured.sessionId !== confirmedCandidate.workspace.sessionId
                || captured.sessionEpoch !== confirmedCandidate.workspace.sessionEpoch) {
                throw new Error("Workspace identity changed before capture.");
              }
              const captureObservation = await kernel.api.platform.developmentBackend();
              const captureCandidate = this.readCandidate(kernel, captureObservation);
              const hostSnapshot = this.host.getSnapshot();
              if (!captureCandidate.candidate || !sameCandidate(confirmedCandidate, captureCandidate.candidate)
                || hostSnapshot.kernel !== kernel || !hostSnapshot.paused || hostSnapshot.publicationError
                || this.operationToken !== token || !this.operation || !this.snapshot.busy) {
                throw new Error("Build or workspace identity changed while capturing owners.");
              }
            } catch {
              try { captured.release(); }
              catch { throw new DevelopmentRestartCaptureError(false); }
              throw new DevelopmentRestartCaptureError(true);
            }
            return captured;
          },
          hydrate: (resource) => owners.hydrate(resource),
        },
      );
    } catch {
      this.setFailure("The pinned restart controller could not be created. No restart was submitted.");
      return;
    }

    this.unsubscribeController?.();
    this.controller = controller;
    this.attempt = { kernel, candidate: current.candidate, applied: false };
    this.unsubscribeController = controller.subscribe(() => this.adoptControllerSnapshot());
    await controller.start();
    this.adoptControllerSnapshot();
  }

  private launch(
    initial: Pick<DevelopmentRestartActionSnapshot, "state" | "requestId" | "message">,
    action: (token: object) => Promise<void>,
    safeFailureMessage: string,
    adoptExistingController = false,
  ): Promise<void> {
    let resolveOperation!: () => void;
    const operation = new Promise<void>((resolve) => { resolveOperation = resolve; });
    const token = {};
    const initialController = this.controller;
    this.operation = operation;
    this.operationToken = token;
    this.setSnapshot({ ...initial, busy: true });

    void Promise.resolve().then(() => action(token)).then(
      () => this.finishOperation(operation, token, initialController, adoptExistingController, resolveOperation),
      () => {
        this.setFailure(safeFailureMessage);
        this.finishOperation(operation, token, initialController, adoptExistingController, resolveOperation);
      },
    );
    return operation;
  }

  private finishOperation(
    operation: Promise<void>,
    token: object,
    initialController: DevelopmentRestartController | null,
    adoptExistingController: boolean,
    resolve: () => void,
  ): void {
    if (this.operation === operation && this.operationToken === token) {
      this.operation = null;
      this.operationToken = null;
      if (this.controller && (adoptExistingController || this.controller !== initialController)) {
        this.adoptControllerSnapshot();
      }
      else this.setSnapshot({ ...this.snapshot, busy: false });
    }
    resolve();
  }

  private adoptControllerSnapshot(): void {
    const controller = this.controller;
    if (!controller) return;
    const current = controller.getSnapshot();
    const hostSnapshot = this.host.getSnapshot();
    const cleanConfirmedRestore = current.state === "restored" && current.message === null
      && this.attempt !== null && !this.attempt.applied
      && hostSnapshot.kernel !== this.attempt.kernel
      && !hostSnapshot.paused && !hostSnapshot.publicationError;
    if (cleanConfirmedRestore && this.attempt) {
      this.attempt.applied = true;
      this.lastAppliedSourceSha256 = this.attempt.candidate.sourceSha256;
    }
    this.setSnapshot({ ...current, busy: this.operation !== null });
    if (cleanConfirmedRestore) this.retireCompletedController(controller);
  }

  private controllerSnapshot(controller: DevelopmentRestartController): DevelopmentRestartActionSnapshot {
    return { ...controller.getSnapshot(), busy: false };
  }

  private hasRetainedIntent(): boolean {
    const snapshot = this.controller?.getSnapshot();
    if (!snapshot) return false;
    if (snapshot.state === "failed" && snapshot.requestId === null)
      return !this.isConfirmedPreIntentFailure(snapshot, this.host.getSnapshot().kernel);
    return snapshot.state !== "idle" && snapshot.state !== "restored";
  }

  private isConfirmedPreIntentFailure(
    snapshot: DevelopmentRestartSnapshot,
    kernel: KernelApi,
  ): boolean {
    const hostSnapshot = this.host.getSnapshot();
    return snapshot.state === "failed"
      && snapshot.requestId === null
      && snapshot.captureCleanup === "confirmed"
      && this.attempt?.kernel === kernel
      && hostSnapshot.kernel === kernel
      && !hostSnapshot.paused
      && !hostSnapshot.publicationError;
  }

  private disposeCompletedControllerForNextAttempt(
    kernel: KernelApi,
    controller: DevelopmentRestartController,
  ): boolean {
    const snapshot = controller.getSnapshot();
    const hostSnapshot = this.host.getSnapshot();
    const cleanCaptureFailure = this.isConfirmedPreIntentFailure(snapshot, kernel);
    if (!cleanCaptureFailure) return false;
    if (hostSnapshot.kernel !== kernel || hostSnapshot.paused || hostSnapshot.publicationError) return false;
    if (this.controller !== controller) return false;

    this.unsubscribeController?.();
    this.unsubscribeController = null;
    this.controller = null;
    this.attempt = null;
    return true;
  }

  private retireCompletedController(controller: DevelopmentRestartController): void {
    if (this.controller !== controller) return;
    this.unsubscribeController?.();
    this.unsubscribeController = null;
    this.controller = null;
    this.attempt = null;
  }

  private setFailure(message: string): void {
    const requestId = this.controller?.getSnapshot().requestId ?? this.snapshot.requestId;
    this.setSnapshot({ state: "failed", requestId, message, busy: this.operation !== null });
  }

  private setSnapshot(snapshot: DevelopmentRestartActionSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) {
      try { listener(); } catch { /* Action observers cannot change restart custody. */ }
    }
  }

  private onHostChange(): void {
    if (this.controller) this.adoptControllerSnapshot();
    else this.setSnapshot({ ...this.snapshot });
  }
}

function isValidBuildIdentity(build: { readonly id: string; readonly source_sha256: string }): boolean {
  return typeof build.id === "string" && build.id.trim().length > 0
    && typeof build.source_sha256 === "string" && /^[a-f0-9]{64}$/i.test(build.source_sha256);
}

function sameCandidate(left: RestartCandidate, right: RestartCandidate): boolean {
  return left.buildId === right.buildId && left.sourceSha256 === right.sourceSha256
    && left.workspace.apiInstanceId === right.workspace.apiInstanceId
    && left.workspace.sessionId === right.workspace.sessionId
    && left.workspace.sessionEpoch === right.workspace.sessionEpoch;
}
