import type { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import type { CommandQueueStatusResource } from "../api/apiTypes";
import {
  isStudyComputeKind,
  logicalSessionOwner,
  parseStudyComputeRequestJson,
  type StudyComputeObservation,
  type StudyComputeObservationStore,
} from "./studyComputeObservations";

type CommandOutcomeEvent = KernelEventMap["command:outcome"];

export type CommandFeedbackTone = "error" | "info" | "success" | "warning";

/** One foreground notice; `pending` notices describe an ACK, not completion. */
export interface CommandFeedbackNotice {
  backendCommandId: string | null;
  clientIntentId: string | null;
  clientIntentKind: string | null;
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

interface PendingBackendCommand extends CommandFeedbackNotice {
  /** Local presenters own the normal outcome, so only retain backend tracking. */
  trackingOnly: boolean;
  /** Original serialized typed request; never rebuilt from current resources. */
  requestJson?: string;
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
  studyComputeObservations?: StudyComputeObservationStore;
  subscribeSessionScope: (listener: () => void) => () => void;
}

const OBSERVATION_TEXT: Record<NonNullable<CommandOutcomeEvent["observation"]>, string> = {
  disconnected: "Connection lost; command confirmation is pending.",
  "publication-unconfirmed": "Submission confirmation is pending. The command was not sent again.",
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
  private readonly pendingBackendCommands = new Map<string, PendingBackendCommand>();
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
      bus.on("study:compute-observation", (event) => this.handleStudyComputeObservation(event)),
      bus.on("mesh:build-observed", (event) => this.handleBackendObservation(event)),
      bus.on("session:status-changed", ({ status }) => {
        if (status === "idle") this.replace([]);
      }),
      options.subscribeSessionScope(() => this.handleScopeChange()),
    );
    if (this.scopeKey) this.restoreStudyCompute(this.scopeKey);
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

  /** Return the original body only when one current unresolved intent is retryable. */
  getRetryableStudyCompute(
    scopeKey: string | null | undefined,
    clientIntentId?: string,
  ): (StudyComputeObservation & { requestJson: string }) | null {
    if (!scopeKey || scopeKey !== this.currentScopeKey()) return null;
    const matching = [...this.pendingBackendCommands.values()].filter((notice) =>
      notice.status === "pending" &&
      notice.sessionScopeKey === scopeKey &&
      notice.clientIntentId !== null &&
      isStudyComputeKind(notice.clientIntentKind) &&
      (clientIntentId === undefined || notice.clientIntentId === clientIntentId),
    );
    if (matching.length !== 1) return null;
    const notice = matching[0];
    if (notice.backendCommandId !== null || !notice.requestJson || !notice.clientIntentId) return null;
    const kind = notice.clientIntentKind;
    if (!isStudyComputeKind(kind)) return null;
    if (!parseStudyComputeRequestJson(notice.requestJson, { clientIntentId: notice.clientIntentId, kind })) return null;
    return {
      clientIntentId: notice.clientIntentId,
      kind,
      sessionScopeKey: scopeKey,
      requestJson: notice.requestJson,
    };
  }

  /** True only for the requested current session and a typed unresolved Compute. */
  hasUnresolvedStudyCompute(
    scopeKey: string | null | undefined,
    clientIntentId?: string,
  ): boolean {
    if (!scopeKey || scopeKey !== this.currentScopeKey()) return false;
    for (const notice of this.pendingBackendCommands.values()) {
      if (
        notice.sessionScopeKey === scopeKey &&
        notice.clientIntentId !== null &&
        (clientIntentId === undefined || notice.clientIntentId === clientIntentId) &&
        isStudyComputeKind(notice.clientIntentKind)
      ) {
        return true;
      }
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
    let trackingOnlyChanged = false;
    for (const [key, originalNotice] of [...this.pendingBackendCommands]) {
      if (originalNotice.sessionScopeKey !== sessionScopeKey) continue;

      let notice = originalNotice;
      let trackingKey = key;
      let record: CommandQueueStatusResource["commands"][number] | undefined;
      if (notice.backendCommandId) {
        const commandRecords = queue.commands.filter(
          (entry) => entry.command_id === notice.backendCommandId,
        );
        if (commandRecords.length !== 1) continue;
        record = commandRecords[0];
        if (
          (notice.clientIntentKind && record.kind !== notice.clientIntentKind) ||
          (notice.clientIntentId && record.client_intent_id != null && record.client_intent_id !== notice.clientIntentId)
        ) {
          continue;
        }
        if (isStudyComputeKind(notice.clientIntentKind)) {
          if (
            !notice.clientIntentId ||
            record.kind !== notice.clientIntentKind ||
            record.client_intent_id !== notice.clientIntentId
          ) {
            continue;
          }
        }
        if (notice.clientIntentId && record.client_intent_id === notice.clientIntentId) {
          const intentRecords = queue.commands.filter(
            (entry) => entry.client_intent_id === notice.clientIntentId,
          );
          if (
            intentRecords.length !== 1 ||
            intentRecords[0].command_id !== notice.backendCommandId ||
            intentRecords[0].kind !== notice.clientIntentKind
          ) {
            continue;
          }
        }
      } else {
        if (!notice.clientIntentId || !notice.clientIntentKind) continue;
        const pendingSameIntent = [...this.pendingBackendCommands.values()].filter(
          (candidate) =>
            candidate.sessionScopeKey === sessionScopeKey &&
            candidate.clientIntentId === notice.clientIntentId,
        );
        if (pendingSameIntent.length !== 1) continue;
        const intentRecords = queue.commands.filter(
          (entry) => entry.client_intent_id === notice.clientIntentId,
        );
        if (
          intentRecords.length !== 1 ||
          intentRecords[0].kind !== notice.clientIntentKind ||
          !intentRecords[0].command_id ||
          queue.commands.filter((entry) => entry.command_id === intentRecords[0].command_id).length !== 1
        ) {
          continue;
        }
        record = intentRecords[0];
        notice = {
          ...notice,
          backendCommandId: record.command_id,
          message: "Command accepted; waiting for the backend result.",
        };
        this.pendingBackendCommands.delete(key);
        trackingKey = pendingTrackingIdentity(notice);
        this.pendingBackendCommands.set(trackingKey, notice);
        if (notice.trackingOnly) trackingOnlyChanged = true;
        else this.upsertMany([notice]);
      }

      if (!record || !["completed", "failed", "rejected", "cancelled"].includes(record.status)) continue;
      // A completed journal entry may carry a failed/cancelled completion.
      const status = record.status === "completed"
        ? record.completion_status ?? record.status
        : record.status;
      if (!["completed", "failed", "rejected", "cancelled"].includes(status)) continue;
      this.pendingBackendCommands.delete(trackingKey);
      if (notice.clientIntentId && record.client_intent_id === notice.clientIntentId) {
        this.options.studyComputeObservations?.forget(sessionScopeKey, notice.clientIntentId);
      }
      const terminalStatus = status === "completed"
        ? "completed"
        : status === "cancelled"
          ? "cancelled"
          : "failed";
      if (notice.trackingOnly) {
        trackingOnlyChanged = true;
      } else {
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
    }
    if (terminalNotices.length > 0) this.upsertMany(terminalNotices);
    else if (trackingOnlyChanged) this.replace([...this.notices]);
  }

  private handleOutcome(event: CommandOutcomeEvent): void {
    if (event.feedback !== "foreground") {
      this.handleLocalStudyComputeOutcome(event);
      return;
    }
    if (event.status === "cancelled" || event.status === "completed") return;
    if (
      event.phase === "run" &&
      this.options.isRunOutcomeSelfPresented?.(event.commandId)
    ) {
      return;
    }
    // A result that arrives after the session changed belongs to the old session.
    if (event.sessionScopeKey !== this.currentScopeKey()) return;
    if (
      event.status === "pending" &&
      event.studyComputeObservationStarted === true &&
      event.backendCommandId === null &&
      event.sessionScopeKey &&
      event.clientIntentId &&
      isStudyComputeKind(event.clientIntentKind) &&
      !this.pendingBackendCommands.has(
        computeTrackingIdentity(event.sessionScopeKey, event.clientIntentId, event.clientIntentKind),
      )
    ) {
      return;
    }
    this.upsert(noticeFromOutcome(event));
  }

  private handleLocalStudyComputeOutcome(event: CommandOutcomeEvent): void {
    if (
      event.status !== "pending" ||
      !event.backendCommandId ||
      !event.clientIntentId ||
      !isStudyComputeKind(event.clientIntentKind) ||
      !event.sessionScopeKey ||
      event.sessionScopeKey !== this.currentScopeKey()
    ) {
      return;
    }
    const key = computeTrackingIdentity(event.sessionScopeKey, event.clientIntentId, event.clientIntentKind);
    const existing = this.pendingBackendCommands.get(key);
    if (!existing || existing.backendCommandId !== null) return;
    this.pendingBackendCommands.set(key, {
      ...existing,
      backendCommandId: event.backendCommandId,
      message: event.message?.trim() ? event.message : existing.message,
    });
    this.replace([...this.notices]);
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
    const nextOwner = next ? logicalSessionOwner(next) : null;
    let trackingChanged = false;
    for (const [key, notice] of [...this.pendingBackendCommands]) {
      if (notice.sessionScopeKey === next) continue;
      if (notice.clientIntentId && isStudyComputeKind(notice.clientIntentKind)) {
        const noticeOwner = notice.sessionScopeKey
          ? logicalSessionOwner(notice.sessionScopeKey)
          : null;
        if (next && nextOwner && noticeOwner === nextOwner) {
          this.pendingBackendCommands.delete(key);
          const rebound = { ...notice, sessionScopeKey: next };
          const reboundKey = pendingTrackingIdentity(rebound);
          const existing = this.pendingBackendCommands.get(reboundKey);
          if (!existing || (!existing.backendCommandId && rebound.backendCommandId)) {
            this.pendingBackendCommands.set(reboundKey, rebound);
          }
          trackingChanged = true;
        }
        // Keep other logical sessions so an A → B → A transport/session switch
        // does not lose an unresolved intent when durable storage is unavailable.
        continue;
      }
      this.pendingBackendCommands.delete(key);
      trackingChanged = true;
    }

    const kept = this.notices.flatMap((notice) => {
      if (notice.sessionScopeKey === next) return [notice];
      if (
        next &&
        nextOwner &&
        notice.clientIntentId &&
        isStudyComputeKind(notice.clientIntentKind) &&
        notice.sessionScopeKey &&
        logicalSessionOwner(notice.sessionScopeKey) === nextOwner
      ) {
        return [{ ...notice, sessionScopeKey: next }];
      }
      return [];
    });
    const visibleChanged =
      kept.length !== this.notices.length || kept.some((notice, index) => notice !== this.notices[index]);
    if (visibleChanged || trackingChanged) this.replace(kept);
    if (next) this.restoreStudyCompute(next);
  }

  private forgetRejectedStudyCompute(event: KernelEventMap["study:compute-observation"]): void {
    if (event.state !== "rejected" || !isStudyComputeKind(event.kind) || !event.clientIntentId) return;
    const owner = logicalSessionOwner(event.sessionScopeKey);
    if (!owner) return;

    const store = this.options.studyComputeObservations;
    if (store) {
      try {
        const matchingStored = store.list(event.sessionScopeKey).filter(
          (entry) => entry.clientIntentId === event.clientIntentId,
        );
        if (
          matchingStored.length > 0 &&
          matchingStored.every((entry) => entry.kind === event.kind)
        ) {
          store.forget(event.sessionScopeKey, event.clientIntentId);
        }
      } catch {
        // Browser storage is only a hint; the in-memory rejection is authoritative.
      }
    }

    let trackingChanged = false;
    for (const [key, notice] of this.pendingBackendCommands) {
      if (
        notice.clientIntentId === event.clientIntentId &&
        notice.clientIntentKind === event.kind &&
        notice.sessionScopeKey !== null &&
        logicalSessionOwner(notice.sessionScopeKey) === owner
      ) {
        this.pendingBackendCommands.delete(key);
        trackingChanged = true;
      }
    }
    const kept = this.notices.filter((notice) => {
      if (
        notice.status === "pending" &&
        notice.clientIntentId === event.clientIntentId &&
        notice.clientIntentKind === event.kind &&
        notice.sessionScopeKey !== null &&
        logicalSessionOwner(notice.sessionScopeKey) === owner
      ) {
        return false;
      }
      return true;
    });
    if (kept.length !== this.notices.length || trackingChanged) this.replace(kept);
  }

  private handleStudyComputeObservation(event: KernelEventMap["study:compute-observation"]): void {
    if (!isStudyComputeKind(event.kind) || !event.clientIntentId.trim() || event.clientIntentId.length > 128) return;
    if (!logicalSessionOwner(event.sessionScopeKey)) return;
    if (event.state === "rejected") {
      this.forgetRejectedStudyCompute(event);
      return;
    }
    if (event.sessionScopeKey !== this.currentScopeKey()) return;

    const notice = pendingStudyComputeNotice(event);
    const key = pendingTrackingIdentity(notice);
    if (!this.pendingBackendCommands.has(key)) {
      this.pendingBackendCommands.set(key, notice);
      this.replace([...this.notices]);
    }
    this.options.studyComputeObservations?.remember(event);
  }

  private restoreStudyCompute(scopeKey: string): void {
    const observations = this.options.studyComputeObservations?.list(scopeKey) ?? [];
    for (const { clientIntentId, kind, requestJson } of observations) {
      const key = computeTrackingIdentity(scopeKey, clientIntentId, kind);
      const existing = this.pendingBackendCommands.get(key);
      const invocationId = `recovered:${clientIntentId}`;
      const recoveredNotice: PendingBackendCommand = {
        ...noticeFromOutcome({
          backendCommandId: null,
          clientIntentId,
          clientIntentKind: kind,
          commandId: kind === "solve" ? "study.run" : "study.execute-stage",
          feedback: "foreground",
          invocationId,
          message: "Checking the previous submission in the session command ledger.",
          observation: "publication-unconfirmed",
          phase: "run",
          sessionScopeKey: scopeKey,
          source: "ribbon",
          sourceDetail: null,
          status: "pending",
          title: kind === "solve" ? "Compute Study" : kind === "relax" ? "Relax stage" : "Run stage",
        }),
        trackingOnly: false,
        ...((existing?.requestJson ?? requestJson) === undefined
          ? {}
          : { requestJson: existing?.requestJson ?? requestJson }),
      };
      if (existing) {
        if (existing.trackingOnly && existing.backendCommandId === null) {
          // Returning to a scope with a durable hint is a recovery boundary;
          // keep the existing foreground recovery notice behavior there.
          this.upsert(recoveredNotice);
        } else if (!existing.trackingOnly && !this.notices.some((notice) => notice.id === existing.id)) {
          this.upsertMany([existing]);
        }
        continue;
      }
      this.upsert(recoveredNotice);
    }
  }

  private currentScopeKey(): string | null {
    return this.options.getSessionScopeKey() ?? null;
  }

  private upsert(notice: CommandFeedbackNotice & Partial<Pick<PendingBackendCommand, "trackingOnly" | "requestJson">>): void {
    if (
      notice.status === "pending" &&
      (notice.backendCommandId !== null ||
        (notice.clientIntentId !== null && notice.clientIntentKind !== null))
    ) {
      const key = pendingTrackingIdentity(notice);
      const existing = this.pendingBackendCommands.get(key);
      const requestJson = notice.requestJson ?? existing?.requestJson;
      this.pendingBackendCommands.set(key, {
        ...notice,
        trackingOnly: notice.trackingOnly ?? false,
        ...(requestJson === undefined ? {} : { requestJson }),
      });
    }
    this.upsertMany([notice]);
  }

  private upsertMany(notices: readonly CommandFeedbackNotice[]): void {
    if (notices.length === 0) return;
    let next = [...this.notices];
    for (const candidate of notices) {
      const notice = foregroundNotice(candidate);
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

function foregroundNotice(notice: CommandFeedbackNotice): CommandFeedbackNotice {
  const visible = { ...notice } as CommandFeedbackNotice & Partial<Pick<PendingBackendCommand, "trackingOnly" | "requestJson">>;
  delete visible.trackingOnly;
  delete visible.requestJson;
  return visible;
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
    clientIntentId: event.clientIntentId,
    clientIntentKind: event.clientIntentKind,
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
  if (notice.sessionScopeKey && notice.clientIntentId && isStudyComputeKind(notice.clientIntentKind)) {
    return computeTrackingIdentity(notice.sessionScopeKey, notice.clientIntentId, notice.clientIntentKind);
  }
  return JSON.stringify([
    notice.sessionScopeKey,
    notice.backendCommandId,
    notice.clientIntentId,
    notice.clientIntentKind,
    notice.invocationId,
  ]);
}

function computeTrackingIdentity(scopeKey: string, clientIntentId: string, kind: string): string {
  return JSON.stringify(["study-compute", scopeKey, clientIntentId, kind]);
}

function pendingStudyComputeNotice(observation: StudyComputeObservation): PendingBackendCommand {
  const { clientIntentId, kind, sessionScopeKey } = observation;
  return {
    backendCommandId: null,
    clientIntentId,
    clientIntentKind: kind,
    commandId: kind === "solve" ? "study.run" : "study.execute-stage",
    id: `study-compute-tracking:${computeTrackingIdentity(sessionScopeKey, clientIntentId, kind)}`,
    invocationId: `study-compute-tracking:${clientIntentId}`,
    message: "Waiting for the session command ledger to confirm this Compute.",
    repeatCount: 1,
    sessionScopeKey,
    status: "pending",
    title: kind === "solve" ? "Compute Study" : kind === "relax" ? "Relax stage" : "Run stage",
    tone: "info",
    updatedAtMs: Date.now(),
    trackingOnly: true,
    ...(observation.requestJson === undefined ? {} : { requestJson: observation.requestJson }),
  };
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
