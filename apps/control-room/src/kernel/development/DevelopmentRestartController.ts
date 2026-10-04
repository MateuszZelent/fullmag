import type { DevelopmentRestartRequest, DevelopmentRestartResource } from "../api/apiTypes";
import type { ControlRoomApi } from "../api/ControlRoomApi";
import { isApiInstanceId } from "../api/apiInstancePin";

export interface DevelopmentRestartOwners {
  /** Acquire all owner guards before capturing; retain them through uncertain outcomes. */
  capture(): Promise<{
    readonly sessionId: string | null;
    readonly sessionEpoch: number;
    readonly editor: Record<string, unknown>;
    readonly workspace: Record<string, unknown>;
    readonly projectDocument: Record<string, unknown>;
    assertCurrent(): void;
    release(): void;
  }>;
  /** Validate/restore into fresh owners and publish the new pin only after all succeed. */
  hydrate(resource: DevelopmentRestartResource): Promise<void>;
}

export interface DevelopmentRestartTransport {
  submit(input: DevelopmentRestartRequest, token: string): Promise<DevelopmentRestartResource>;
  read(requestId: string, token: string): Promise<DevelopmentRestartResource>;
}

export interface DevelopmentRestartSnapshot {
  readonly state: "idle" | "capturing" | "pending" | "unknown" | "hydrating" | "restored" | "failed";
  readonly requestId: string | null;
  readonly message: string | null;
}

/** One durable intent. A lost POST response permits reconciliation, never resubmission. */
export class DevelopmentRestartController {
  private snapshot: DevelopmentRestartSnapshot = { state: "idle", requestId: null, message: null };
  private readonly listeners = new Set<() => void>();
  private intent: { request: DevelopmentRestartRequest; token: string; release(): void } | null = null;
  private busy = false;
  private readonly oldApiInstance: string;
  private readonly transport: DevelopmentRestartTransport;
  private readonly owners: DevelopmentRestartOwners;

  constructor(
    oldApiInstance: string,
    transport: DevelopmentRestartTransport,
    owners: DevelopmentRestartOwners,
  ) {
    if (!isApiInstanceId(oldApiInstance)) throw new Error("A pinned API instance is required for restart.");
    this.oldApiInstance = oldApiInstance;
    this.transport = transport;
    this.owners = owners;
  }

  getSnapshot = (): DevelopmentRestartSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async start(): Promise<void> {
    if (this.busy || this.intent || this.snapshot.state !== "idle") {
      throw new Error("This restart controller already owns an intent.");
    }
    this.busy = true;
    this.update("capturing", null);
    let captured: Awaited<ReturnType<DevelopmentRestartOwners["capture"]>> | null = null;
    try {
      captured = await this.owners.capture();
      if (!Number.isSafeInteger(captured.sessionEpoch) || captured.sessionEpoch < 0
        || (captured.sessionId !== null && typeof captured.sessionId !== "string")) {
        throw new Error("Invalid captured workspace identity.");
      }
      const tokenBytes = crypto.getRandomValues(new Uint8Array(16));
      const token = Array.from(tokenBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
      const request: DevelopmentRestartRequest = {
        schema: "fullmag.development-ui-restart-request.v1",
        request_id: crypto.randomUUID(),
        session_id: captured.sessionId,
        session_epoch: captured.sessionEpoch,
        editor: structuredClone(captured.editor),
        workspace: structuredClone(captured.workspace),
        project_document: structuredClone(captured.projectDocument),
      };
      captured.assertCurrent();
      this.intent = { request, token, release: captured.release.bind(captured) };
      this.update("pending", null);
      // The intent is retained before sending: cancellation is not proof of nonpublication.
      await this.consume(await this.transport.submit(request, token));
    } catch {
      if (this.intent) {
        this.update("unknown", "Restart outcome is unconfirmed. Reconcile the existing request.");
      } else {
        let message = "Workspace capture failed; no restart was submitted.";
        try { captured?.release(); } catch {
          message = "Workspace capture failed and guard cleanup is unconfirmed. Keep the workspace protected.";
        }
        this.update("failed", message);
      }
    } finally {
      this.busy = false;
    }
  }

  async reconcile(): Promise<void> {
    if (this.busy || !this.intent || !["pending", "unknown"].includes(this.snapshot.state)) return;
    this.busy = true;
    try {
      await this.consume(await this.transport.read(this.intent.request.request_id, this.intent.token));
    } catch {
      this.update("unknown", "Restart outcome is unconfirmed. The captured workspace is retained.");
    } finally {
      this.busy = false;
    }
  }

  private async consume(resource: DevelopmentRestartResource): Promise<void> {
    const intent = this.intent;
    if (!intent || resource.schema !== "fullmag.development-ui-restart-resource.v1"
      || resource.request_id !== intent.request.request_id) {
      throw new Error("Restart response does not belong to this intent.");
    }
    if (resource.state === "pending" || resource.state === "unknown") {
      this.update(resource.state, resource.state === "unknown" ? "Native restart outcome is unconfirmed." : null);
      return;
    }
    if (resource.state === "failed") {
      this.finalize("failed", "Native restart failed; the captured workspace remains available.");
      return;
    }
    if (resource.state !== "ready" || typeof resource.new_api_instance_id !== "string"
      || !isApiInstanceId(resource.new_api_instance_id) || resource.new_api_instance_id === this.oldApiInstance
      || !restoredSessionIsFresh(resource, intent.request.session_id)
      || !sameJson(resource.editor, intent.request.editor)
      || !sameJson(resource.workspace, intent.request.workspace)
      || !sameJson(resource.project_document, intent.request.project_document)) {
      throw new Error("Restart readiness or restored owner payload is invalid.");
    }
    this.update("hydrating", null);
    // Failure retains old-owner guards; hydration is never silently retried.
    try {
      await this.owners.hydrate(structuredClone(resource));
    } catch {
      this.update("failed", "Backend is ready, but UI restoration failed. Captured owners remain guarded.");
      return;
    }
    this.finalize("restored", null);
  }

  private finalize(state: "failed" | "restored", message: string | null): void {
    try {
      this.intent?.release();
    } catch {
      message = "Restart outcome is confirmed, but owner guard cleanup failed. Keep the workspace protected.";
    }
    // A cleanup failure must not turn a confirmed restore into a repeatable hydration.
    this.update(state, message);
  }

  private update(state: DevelopmentRestartSnapshot["state"], message: string | null): void {
    this.snapshot = { state, requestId: this.intent?.request.request_id ?? null, message };
    for (const listener of this.listeners) {
      try { listener(); } catch { /* Subscribers cannot change a confirmed restart outcome. */ }
    }
  }
}

function restoredSessionIsFresh(resource: DevelopmentRestartResource, oldSession: string | null): boolean {
  if (oldSession === null) return resource.session_id === null && resource.session_epoch === 0;
  return typeof resource.session_id === "string" && resource.session_id.trim().length > 0
    && resource.session_id !== oldSession && resource.session_epoch === 1;
}

export function createDevelopmentRestartController(
  api: ControlRoomApi,
  owners: DevelopmentRestartOwners,
): DevelopmentRestartController {
  const pin = api.getExpectedApiInstance();
  if (!pin) throw new Error("Restart requires a launcher-pinned API client.");
  return new DevelopmentRestartController(pin, {
    submit: (input, token) => api.platform.submitDevelopmentRestartRequest(input, token),
    read: (requestId, token) => api.platform.developmentRestartRequest(requestId, token),
  }, owners);
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameJson(value, right[index]));
  }
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  return Object.keys(a).length === Object.keys(b).length
    && Object.keys(a).every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]));
}
