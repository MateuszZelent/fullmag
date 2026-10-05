import type {
  DevelopmentBackendBuildRequest,
  DevelopmentBackendBuildRequestResource,
  DevelopmentBackendResource,
} from "../api/apiTypes";
import { isApiInstanceId } from "../api/apiInstancePin";
import type { ControlRoomApi } from "../api/ControlRoomApi";

export type DevelopmentBackendBuildActionState =
  | "idle"
  | "submitting"
  | "pending"
  | "building"
  | "unknown"
  | "ready"
  | "failed";

export interface DevelopmentBackendBuildActionSnapshot {
  readonly state: DevelopmentBackendBuildActionState;
  readonly requestId: string | null;
  readonly message: string | null;
  readonly busy: boolean;
}

const IDLE_SNAPSHOT: DevelopmentBackendBuildActionSnapshot = {
  state: "idle",
  requestId: null,
  message: null,
  busy: false,
};

interface BuildIntent {
  readonly api: ControlRoomApi;
  readonly request: DevelopmentBackendBuildRequest;
  readonly token: string;
}

/** Owns one in-flight UI request and reconciles an uncertain POST by its same ID/token. */
export class DevelopmentBackendBuildActionService {
  private snapshot: DevelopmentBackendBuildActionSnapshot = IDLE_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private intent: BuildIntent | null = null;
  private operation: Promise<void> | null = null;

  getSnapshot = (): DevelopmentBackendBuildActionSnapshot => this.snapshot;

  blocksWorkspaceTransition = (): boolean =>
    this.intent !== null &&
    ["submitting", "pending", "building", "unknown"].includes(this.snapshot.state);

  resetForKernelGeneration = (): void => {
    if (this.blocksWorkspaceTransition()) return;
    this.intent = null;
    this.update("idle", null, null);
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start = (
    api: ControlRoomApi,
    backend: DevelopmentBackendResource,
  ): Promise<void> => {
    if (this.operation || ["submitting", "pending", "building", "unknown"].includes(this.snapshot.state)) {
      return this.operation ?? Promise.resolve();
    }

    const apiInstanceId = api.getExpectedApiInstance();
    const workspaceIdentity = backend.workspace_identity;
    if (
      backend.schema_version !== "1.0.0" ||
      !backend.configured ||
      backend.build_available !== true ||
      !apiInstanceId ||
      !isApiInstanceId(apiInstanceId) ||
      workspaceIdentity?.api_instance_id !== apiInstanceId
    ) {
      this.update("failed", null, "A pinned development build coordinator is unavailable.");
      return Promise.resolve();
    }
    if (["disabled", "unknown", "stopped", "building"].includes(backend.state)) {
      this.update("failed", null, "Wait for a fresh idle build status before submitting another request.");
      return Promise.resolve();
    }
    if (backend.build_request_id && backend.state === "waiting") {
      this.update("failed", null, "A backend build request is already pending.");
      return Promise.resolve();
    }

    const request: DevelopmentBackendBuildRequest = {
      schema: "fullmag.development-backend-build-request.v1",
      request_id: crypto.randomUUID(),
      api_instance_id: apiInstanceId,
    };
    const intent = { api, request, token: createToken() };
    this.intent = intent;
    this.update("submitting", request.request_id, "Submitting a build-only request.");
    return this.track(this.submit(intent));
  };

  reconcile = (): Promise<void> => {
    const intent = this.intent;
    if (!intent || this.operation || !["pending", "building", "unknown"].includes(this.snapshot.state)) {
      return this.operation ?? Promise.resolve();
    }
    return this.track(this.readExisting(intent));
  };

  retrySameRequest = (): Promise<void> => {
    const intent = this.intent;
    if (!intent || this.operation || this.snapshot.state !== "unknown") {
      return this.operation ?? Promise.resolve();
    }
    return this.track(this.readThenRetrySame(intent));
  };

  observeBackend = (backend: DevelopmentBackendResource): void => {
    const intent = this.intent;
    if (!intent || this.operation) return;
    if (["ready", "failed"].includes(this.snapshot.state)) return;
    if (!["submitting", "pending", "building", "unknown"].includes(this.snapshot.state)) return;
    const requestId = intent.request.request_id;
    if (backend.build_request_id === requestId) {
      if (backend.state === "waiting") {
        if (["pending", "building"].includes(this.snapshot.state)) return;
        this.update("pending", requestId, "Build request accepted. Preparing compilation.");
      } else if (backend.state === "building") {
        if (this.snapshot.state === "building") return;
        this.update("building", requestId, "Building the backend.");
      } else if (backend.state === "ready" || backend.state === "failed") {
        void this.reconcile();
      } else if (backend.state === "unknown" || backend.state === "stopped" || backend.state === "superseded") {
        if (["pending", "building"].includes(this.snapshot.state)) return;
        this.update("unknown", requestId, "Build outcome is unconfirmed. Check the existing request.");
      }
      return;
    }

    // The native CLI observer can replace the public status while a UI request
    // remains in the inbox; the private GET checks the durable result first.
    if (
      this.snapshot.state === "pending" ||
      this.snapshot.state === "building" ||
      this.snapshot.state === "unknown"
    ) {
      if (backend.state === "ready" || backend.state === "failed") {
        void this.reconcile();
      }
    }
  };

  private async submit(intent: BuildIntent): Promise<void> {
    try {
      const resource = await intent.api.platform.submitDevelopmentBackendBuildRequest(
        intent.request,
        intent.token,
      );
      this.consume(intent.request.request_id, resource);
    } catch {
      this.update(
        "unknown",
        intent.request.request_id,
        "Build request outcome is unconfirmed. Checking the same request before any retry.",
      );
      await this.readExisting(intent);
    }
  }

  private async readExisting(intent: BuildIntent): Promise<void> {
    try {
      const resource = await intent.api.platform.developmentBackendBuildRequest(
        intent.request.request_id,
        intent.token,
      );
      this.consume(intent.request.request_id, resource);
    } catch {
      this.update(
        "unknown",
        intent.request.request_id,
        "Build request status is unavailable. Check this same request again; do not submit another yet.",
      );
    }
  }

  private async readThenRetrySame(intent: BuildIntent): Promise<void> {
    let resource: DevelopmentBackendBuildRequestResource;
    try {
      resource = await intent.api.platform.developmentBackendBuildRequest(
        intent.request.request_id,
        intent.token,
      );
    } catch {
      this.update(
        "unknown",
        intent.request.request_id,
        "Build request status is unavailable. Check the same request before retrying it.",
      );
      return;
    }

    if (
      resource.schema !== "fullmag.development-backend-build-request-resource.v1" ||
      resource.request_id !== intent.request.request_id
    ) {
      this.update("unknown", intent.request.request_id, "Build response does not match the submitted request.");
      return;
    }
    this.consume(intent.request.request_id, resource);
    if (resource.state !== "unknown") return;

    this.update(
      "submitting",
      intent.request.request_id,
      "Retrying the same idempotent build request after an unknown status.",
    );
    await this.submit(intent);
  }

  private consume(requestId: string, resource: DevelopmentBackendBuildRequestResource): void {
    if (
      resource.schema !== "fullmag.development-backend-build-request-resource.v1" ||
      resource.request_id !== requestId
    ) {
      this.update("unknown", requestId, "Build response does not match the submitted request.");
      return;
    }
    switch (resource.state) {
      case "pending":
        this.update("pending", requestId, "Build request accepted. Preparing compilation.");
        return;
      case "building":
        this.update("building", requestId, "Building the backend.");
        return;
      case "ready":
        if (!isLowerHex(resource.ready_build_id, 64) || !isLowerHex(resource.ready_source_sha256, 64)) {
          this.update("unknown", requestId, "Build result identity is invalid; the request remains unconfirmed.");
          return;
        }
        this.update("ready", requestId, "The requested backend build is ready.");
        return;
      case "failed":
        if (resource.ready_build_id !== null || resource.ready_source_sha256 !== null) {
          this.update("unknown", requestId, "Failed build response carried an invalid identity.");
          return;
        }
        this.update("failed", requestId, "The requested backend build failed.");
        return;
      case "unknown":
        this.update("unknown", requestId, "Build outcome is unconfirmed. Check the existing request.");
        return;
    }
  }

  private track(operation: Promise<void>): Promise<void> {
    const tracked = operation.finally(() => {
      if (this.operation === tracked) {
        this.operation = null;
        this.snapshot = {
          ...this.snapshot,
          busy: this.snapshot.state === "submitting",
        };
        for (const listener of this.listeners) listener();
      }
    });
    this.operation = tracked;
    this.snapshot = { ...this.snapshot, busy: true };
    for (const listener of this.listeners) listener();
    return tracked;
  }

  private update(
    state: DevelopmentBackendBuildActionState,
    requestId: string | null,
    message: string | null,
  ): void {
    this.snapshot = {
      state,
      requestId,
      message,
      busy: state === "submitting" || this.operation !== null,
    };
    for (const listener of this.listeners) listener();
  }
}

function createToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isLowerHex(value: string | null, length: number): value is string {
  return typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
}
