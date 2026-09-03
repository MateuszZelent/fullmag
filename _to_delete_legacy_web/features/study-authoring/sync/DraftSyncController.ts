/**
 * Layer C: Draft Sync Controller
 *
 * REPLACES the fragile auto-push useEffect in ControlRoomContext.
 * This is the SINGLE module responsible for syncing authoring drafts
 * to the backend.
 *
 * Key design decisions:
 * 1. No auto-push as side-effect of arbitrary state changes
 * 2. Explicit commit queue with states
 * 3. Retry policy distinguishes 4xx (non-retryable) from 5xx/network (retryable)
 * 4. Debouncing is optimization, not logic
 * 5. Cancel superseded commits
 * 6. Map backend errors to authoring UI
 *
 * Lifecycle:
 *   idle → dirty → validating → committing → saved
 *                                          → backend_rejected (4xx, stop)
 *                                          → network_retrying (5xx/net, backoff)
 *                                          → conflict (409, surface to UI)
 */

import { LiveApiError } from "@/src/api/client/errors/LiveApiError";
import type { SceneDocument } from "@/lib/session/types";
import type { DraftSyncStatus, DraftValidationError } from "../model/sceneDraft.types";

export interface DraftCommitEntry {
  id: string;
  payload: SceneDocument;
  signature: string;
  createdAt: number;
  status: DraftSyncStatus;
  retryCount: number;
  error: string | null;
}

export interface DraftSyncCallbacks {
  onStatusChange: (status: DraftSyncStatus, error?: string | null) => void;
  onCommitSuccess: (signature: string) => void;
  onCommitFailed: (entry: DraftCommitEntry) => void;
  onValidationErrors: (errors: DraftValidationError[]) => void;
}

export interface DraftSyncApi {
  updateSceneDocument: (payload: unknown) => Promise<unknown>;
}

const MAX_RETRIES = 3;
const DEBOUNCE_MS = 250;
const RETRY_BACKOFF_BASE_MS = 500;
const RETRY_BACKOFF_MULTIPLIER = 2;
const RETRY_MAX_DELAY_MS = 10_000;

function computeRetryDelay(attempt: number): number {
  const delay = RETRY_BACKOFF_BASE_MS * Math.pow(RETRY_BACKOFF_MULTIPLIER, attempt);
  return Math.min(delay, RETRY_MAX_DELAY_MS);
}

/**
 * DraftSyncController — single orchestrator for scene draft → backend sync.
 *
 * Usage:
 *   const controller = new DraftSyncController(api, callbacks);
 *   controller.markDirty(sceneDraft, signature);
 *   // ... controller handles debounced commit, retry, cancel
 *   controller.dispose();
 */
export class DraftSyncController {
  private api: DraftSyncApi;
  private callbacks: DraftSyncCallbacks;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private currentCommit: DraftCommitEntry | null = null;
  private lastCommittedSignature: string | null = null;
  private nonRetryableSignatures = new Set<string>();
  private disposed = false;
  private enabled = true;
  private startupGateUntil = 0;
  private commitIdCounter = 0;

  constructor(api: DraftSyncApi, callbacks: DraftSyncCallbacks) {
    this.api = api;
    this.callbacks = callbacks;
  }

  /** Enable/disable the auto-sync (diagnostic flag integration) */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.cancelPending();
    }
  }

  /** Set a startup gate — no auto-push until this timestamp */
  setStartupGate(untilMs: number): void {
    this.startupGateUntil = untilMs;
  }

  /** Mark the draft as changed. Controller will debounce and commit. */
  markDirty(sceneDraft: SceneDocument, signature: string): void {
    if (this.disposed || !this.enabled) return;

    // Already committed this exact signature
    if (this.lastCommittedSignature === signature) return;

    // Non-retryable error for this signature — don't retry
    if (this.nonRetryableSignatures.has(signature)) return;

    // Startup gate active
    if (Date.now() < this.startupGateUntil) return;

    // Cancel any pending debounce
    this.clearDebounce();

    // Cancel superseded in-flight commit
    if (this.currentCommit && this.currentCommit.signature !== signature) {
      this.currentCommit = null;
    }

    this.callbacks.onStatusChange("dirty");

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.commit(sceneDraft, signature);
    }, DEBOUNCE_MS);
  }

  /** Force immediate commit (e.g., before navigation) */
  async commitNow(sceneDraft: SceneDocument, signature: string): Promise<void> {
    this.clearDebounce();
    await this.commit(sceneDraft, signature);
  }

  /** Cancel all pending work */
  cancelPending(): void {
    this.clearDebounce();
    this.clearRetry();
    this.currentCommit = null;
    this.callbacks.onStatusChange("idle");
  }

  /** Acknowledge that remote matches this signature (e.g., from SSE update) */
  acknowledgeRemote(remoteSignature: string): void {
    if (this.lastCommittedSignature === null) {
      this.lastCommittedSignature = remoteSignature;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clearDebounce();
    this.clearRetry();
  }

  private async commit(sceneDraft: SceneDocument, signature: string): Promise<void> {
    if (this.disposed || !this.enabled) return;

    const entry: DraftCommitEntry = {
      id: `commit-${++this.commitIdCounter}`,
      payload: sceneDraft,
      signature,
      createdAt: Date.now(),
      status: "committing",
      retryCount: 0,
      error: null,
    };

    this.currentCommit = entry;
    this.callbacks.onStatusChange("committing");

    try {
      await this.api.updateSceneDocument(sceneDraft);

      // Success
      if (this.currentCommit?.id === entry.id) {
        this.lastCommittedSignature = signature;
        this.currentCommit = null;
        this.callbacks.onStatusChange("saved");
        this.callbacks.onCommitSuccess(signature);
      }
    } catch (error) {
      if (this.currentCommit?.id !== entry.id) return; // Superseded

      const isNonRetryable =
        error instanceof LiveApiError &&
        typeof error.status === "number" &&
        error.status >= 400 &&
        error.status < 500;

      if (isNonRetryable) {
        // 4xx: invalid payload, don't retry
        this.nonRetryableSignatures.add(signature);
        this.lastCommittedSignature = signature; // Prevent retry storms
        entry.status = "backend_rejected";
        entry.error = error instanceof Error ? error.message : String(error);
        this.currentCommit = null;
        this.callbacks.onStatusChange("backend_rejected", entry.error);
        this.callbacks.onCommitFailed(entry);
        return;
      }

      // 5xx or network: retry with backoff
      entry.retryCount += 1;
      entry.error = error instanceof Error ? error.message : String(error);

      if (entry.retryCount > MAX_RETRIES) {
        entry.status = "backend_rejected";
        this.currentCommit = null;
        this.lastCommittedSignature = null; // Allow re-attempt later
        this.callbacks.onStatusChange("backend_rejected", entry.error);
        this.callbacks.onCommitFailed(entry);
        return;
      }

      entry.status = "network_retrying";
      this.callbacks.onStatusChange("network_retrying", entry.error);

      const delay = computeRetryDelay(entry.retryCount);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (this.currentCommit?.id === entry.id) {
          void this.commit(sceneDraft, signature);
        }
      }, delay);
    }
  }

  private clearDebounce(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}
