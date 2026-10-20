import type { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import type { CommandQueueStatusResource } from "../api/apiTypes";

type CommandOutcomeEvent = KernelEventMap["command:outcome"];

export type CommandFeedbackTone = "error" | "info" | "success" | "warning";

/** One foreground notice; `pending` notices describe an ACK, not completion. */
export interface CommandFeedbackNotice {
  backendCommandId: string | null;
  commandId: string;
  /** Stable identity across one invocation; duplicate delivery bumps `repeatCount`. */
  id: string;
  invocationId: string;
  message: string;
  repeatCount: number;
  sessionScopeKey: string | null;
  status: CommandOutcomeEvent["status"];
  title: string;
  tone: CommandFeedbackTone;
  updatedAtMs: number;
}

export interface CommandFeedbackControllerOptions {
  /** Current session scope; notices from other scopes are never presented. */
  getSessionScopeKey: () => string | null | undefined;
  /**
   * Commands whose run outcomes already have a dedicated presenter (e.g. the
   * mesh build dialog). Admission failures are still foreground feedback.
   */
  isRunOutcomeSelfPresented?: (commandId: string) => boolean;
  maxNotices?: number;
  subscribeSessionScope: (listener: () => void) => () => void;
}

const OBSERVATION_TEXT: Record<NonNullable<CommandOutcomeEvent["observation"]>, string> = {
  disconnected: "Connection lost before completion could be confirmed.",
  "publication-unconfirmed": "Submitted; publication is not confirmed yet.",
  waiting: "Accepted; waiting for the backend to finish.",
};

/**
 * Single kernel owner of foreground command feedback. It consumes
 * `command:outcome` (every execute path, including missing/disabled admission
 * and exceptions), retaining backend tracking independently from the bounded
 * session-scoped notice list shown by one shell presenter.
 */
export class CommandFeedbackController {
  private notices: readonly CommandFeedbackNotice[] = [];
  private readonly pendingBackendCommands = new Map<string, CommandFeedbackNotice>();
  private readonly listeners = new Set<() => void>();
  private readonly maxNotices: number;
  private readonly disposers: Array<() => void> = [];
  private scopeKey: string | null;

  constructor(
    bus: EventBus<KernelEventMap>,
    private readonly options: CommandFeedbackControllerOptions,
  ) {
    this.maxNotices = options.maxNotices ?? 3;
    this.scopeKey = options.getSessionScopeKey() ?? null;
    this.disposers.push(
      bus.on("command:outcome", (event) => this.handleOutcome(event)),
      bus.on("mesh:build-observed", (event) => this.handleBackendObservation(event)),
      bus.on("session:status-changed", ({ status }) => {
        if (status === "idle") this.replace([]);
      }),
      options.subscribeSessionScope(() => this.handleScopeChange()),
    );
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
    this.pendingBackendCommands.clear();
    this.listeners.clear();
  }

  getSnapshot(): readonly CommandFeedbackNotice[] {
    return this.notices;
  }

  hasPendingBackendCommands(): boolean {
    const scopeKey = this.currentScopeKey();
    if (!scopeKey) return false;
    for (const notice of this.pendingBackendCommands.values()) {
      if (notice.sessionScopeKey === scopeKey) return true;
    }
    return false;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dismiss(id: string): void {
    const next = this.notices.filter((notice) => notice.id !== id);
    if (next.length !== this.notices.length) this.replace(next);
  }

  /** Consume the existing session-scoped HTTP ledger, never infer completion
   * from an ACK, runtime status, elapsed time, or another command's outcome. */
  observeCommandQueue(queue: CommandQueueStatusResource, sessionScopeKey: string | null): void {
    if (!sessionScopeKey || sessionScopeKey !== this.currentScopeKey()) return;
    const terminalNotices: CommandFeedbackNotice[] = [];
    for (const [key, notice] of this.pendingBackendCommands) {
      if (notice.sessionScopeKey !== sessionScopeKey || !notice.backendCommandId) continue;
      const record = queue.commands.find((entry) => entry.command_id === notice.backendCommandId);
      if (!record || !["completed", "failed", "rejected", "cancelled"].includes(record.status)) continue;
      // A completed journal entry may carry a failed/cancelled completion.
      const status = record.status === "completed"
        ? record.completion_status ?? record.status
        : record.status;
      if (!["completed", "failed", "rejected", "cancelled"].includes(status)) continue;
      this.pendingBackendCommands.delete(key);
      const terminalStatus = status === "completed"
        ? "completed"
        : status === "cancelled"
          ? "cancelled"
          : "failed";
      terminalNotices.push(terminalNoticeFromPending(
        notice,
        terminalStatus,
        record.error ?? record.reason ?? (terminalStatus === "completed"
          ? "Completed."
          : terminalStatus === "cancelled"
            ? "Cancelled."
            : "The backend reported a failure."),
      ));
    }
    this.upsertMany(terminalNotices);
  }

  private handleOutcome(event: CommandOutcomeEvent): void {
    if (event.feedback !== "foreground") return;
    if (event.status === "cancelled" || event.status === "completed") return;
    if (
      event.phase === "run" &&
      this.options.isRunOutcomeSelfPresented?.(event.commandId)
    ) {
      return;
    }
    // A result that arrives after the session changed belongs to the old session.
    if (event.sessionScopeKey !== this.currentScopeKey()) return;
    this.upsert(noticeFromOutcome(event));
  }

  private handleBackendObservation(event: KernelEventMap["mesh:build-observed"]): void {
    if (!event.commandId) return;
    if (event.status === "pending") return;
    const matching = [...this.pendingBackendCommands.entries()].filter(([, notice]) =>
      notice.sessionScopeKey === this.currentScopeKey()
      && notice.backendCommandId === event.commandId,
    );
    if (matching.length === 0) return;
    if (event.status === "cancelled") {
      for (const [key] of matching) this.pendingBackendCommands.delete(key);
      this.upsertMany(matching.map(([, notice]) => terminalNoticeFromPending(
        notice,
        "cancelled",
        event.message ?? "Cancelled.",
      )));
      return;
    }
    const completed = event.status === "completed";
    for (const [key] of matching) this.pendingBackendCommands.delete(key);
    this.upsertMany(matching.map(([, notice]) => terminalNoticeFromPending(
      notice,
      completed ? "completed" : "failed",
      event.message ?? (completed ? "Completed." : "The backend reported a failure."),
    )));
  }

  private handleScopeChange(): void {
    const next = this.currentScopeKey();
    if (next === this.scopeKey) return;
    this.scopeKey = next;
    let trackingChanged = false;
    for (const [key, notice] of this.pendingBackendCommands) {
      if (notice.sessionScopeKey === next) continue;
      this.pendingBackendCommands.delete(key);
      trackingChanged = true;
    }
    const kept = this.notices.filter((notice) => notice.sessionScopeKey === next);
    if (kept.length !== this.notices.length || trackingChanged) this.replace(kept);
  }

  private currentScopeKey(): string | null {
    return this.options.getSessionScopeKey() ?? null;
  }

  private upsert(notice: CommandFeedbackNotice): void {
    if (notice.status === "pending" && notice.backendCommandId !== null) {
      this.pendingBackendCommands.set(pendingTrackingIdentity(notice), notice);
    }
    this.upsertMany([notice]);
  }

  private upsertMany(notices: readonly CommandFeedbackNotice[]): void {
    if (notices.length === 0) return;
    let next = [...this.notices];
    for (const notice of notices) {
      const existing = next.find((entry) => entry.id === notice.id);
      const rest = next.filter((entry) => entry.id !== notice.id);
      const merged = existing
        ? {
            ...notice,
            repeatCount: existing.status === notice.status && existing.message === notice.message
              ? existing.repeatCount + 1
              : existing.repeatCount,
          }
        : notice;
      next = [...rest, merged].slice(-this.maxNotices);
    }
    this.replace(next);
  }

  private replace(next: readonly CommandFeedbackNotice[]): void {
    this.notices = Object.freeze([...next]);
    for (const listener of this.listeners) listener();
  }
}

function noticeFromOutcome(event: CommandOutcomeEvent): CommandFeedbackNotice {
  const title = event.title ?? event.commandId;
  const tone: CommandFeedbackTone =
    event.status === "pending"
      ? "info"
      : event.status === "disabled"
        ? "warning"
        : "error";
  const fallback =
    event.status === "pending"
      ? (event.observation ? OBSERVATION_TEXT[event.observation] : "Accepted; completion is not confirmed yet.")
      : event.status === "disabled"
        ? "This action is not available right now."
        : event.status === "missing"
          ? "This action is not available in this workspace."
          : "The action failed.";
  const message = event.message?.trim() ? event.message : fallback;
  return {
    backendCommandId: event.backendCommandId,
    commandId: event.commandId,
    // Each invocation has its own stable identity through ACK and completion.
    id: noticeIdentity(event.commandId, event.backendCommandId, event.invocationId),
    invocationId: event.invocationId,
    message,
    repeatCount: 1,
    sessionScopeKey: event.sessionScopeKey,
    status: event.status,
    title: noticeTitle(title, event.status),
    tone,
    updatedAtMs: Date.now(),
  };
}

function terminalNoticeFromPending(
  notice: CommandFeedbackNotice,
  status: "completed" | "failed" | "cancelled",
  message: string,
): CommandFeedbackNotice {
  return {
    ...notice,
    message,
    status,
    title: noticeTitle(notice.title.replace(/: submitted$/, ""), status),
    tone: status === "completed" ? "success" : status === "cancelled" ? "info" : "error",
    updatedAtMs: Date.now(),
  };
}

function noticeIdentity(commandId: string, backendCommandId: string | null, invocationId: string): string {
  return JSON.stringify([commandId, backendCommandId, invocationId]);
}

function pendingTrackingIdentity(notice: CommandFeedbackNotice): string {
  return JSON.stringify([notice.sessionScopeKey, notice.backendCommandId, notice.invocationId]);
}

function noticeTitle(title: string, status: CommandOutcomeEvent["status"]): string {
  switch (status) {
    case "completed":
      return `${title}: completed`;
    case "cancelled":
      return `${title}: cancelled`;
    case "pending":
      return `${title}: submitted`;
    case "disabled":
      return `${title}: unavailable`;
    case "missing":
      return "Unknown action";
    default:
      return `${title}: failed`;
  }
}
