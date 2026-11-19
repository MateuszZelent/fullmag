import {
  defaultCommandFeedbackOwner,
  type CommandCategory,
  type CommandContext,
  type CommandContribution,
  type CommandId,
  type CommandOutcomeStatus,
  type CommandResult,
} from "./commandTypes";
import type { CommandDiagnosticsController } from "./CommandDiagnosticsController";
import { SessionCommandCancelledError } from "./commandSessionScope";

import type { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";

export interface CommandSessionScopeSource {
  getScopeKey(): string | null;
  subscribe(listener: () => void): () => void;
}

interface CommandOutcomeDetails {
  backendCommandId?: string;
  clientIntentId?: string;
  clientIntentKind?: string;
  message?: string | null;
  observation?: CommandResult["observation"];
  title?: string;
}

export class CommandRegistry {
  private readonly commands = new Map<CommandId, CommandContribution>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private bus: EventBus<KernelEventMap> | null = null;
  private diagnostics: CommandDiagnosticsController | null = null;
  private sessionScopeSource: CommandSessionScopeSource | null = null;
  private invocationSequence = 0;

  attachSessionScopeSource(source: CommandSessionScopeSource): void {
    this.sessionScopeSource = source;
  }

  getSessionScopeKey(): string | null | undefined {
    return this.sessionScopeSource?.getScopeKey();
  }

  /** Observe session scope changes; a no-op when no scope source is attached. */
  subscribeSessionScope(listener: () => void): () => void {
    return this.sessionScopeSource?.subscribe(listener) ?? (() => {});
  }

  /** Attach bus for event emission. Called once during kernel init. */
  attach(bus: EventBus<KernelEventMap>): void {
    this.bus = bus;
  }

  attachDiagnostics(diagnostics: CommandDiagnosticsController): void {
    this.diagnostics = diagnostics;
  }

  register(command: CommandContribution): void {
    if (this.commands.has(command.id)) {
      throw new Error(`Command "${command.id}" is already registered.`);
    }
    this.commands.set(command.id, command);
    this.notify();
  }

  unregister(id: CommandId): void {
    if (this.commands.delete(id)) {
      this.notify();
    }
  }

  get(id: CommandId): CommandContribution | undefined {
    return this.commands.get(id);
  }

  all(): CommandContribution[] {
    return Array.from(this.commands.values());
  }

  getVersion(): number {
    return this.version;
  }

  /** Return all commands matching a category. */
  byCategory(category: CommandCategory): CommandContribution[] {
    return this.all().filter((cmd) => cmd.category === category);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Notify command surfaces that contextual enabled/active state changed. */
  refresh(): void {
    this.notify();
  }

  /** Check if a command is enabled in the given context. */
  isEnabled(id: CommandId, context: CommandContext): boolean {
    const cmd = this.commands.get(id);
    if (!cmd) return false;
    if (!cmd.isEnabled) return true;
    return cmd.isEnabled(context);
  }

  /** Check if a command is currently active/toggled in the given context. */
  isActive(id: CommandId, context: CommandContext): boolean {
    const cmd = this.commands.get(id);
    if (!cmd?.isActive) return false;
    return cmd.isActive(context);
  }

  /**
   * Execute a command by id. Runs emit command:submitted/command:completed;
   * every invocation, admission failures included, emits exactly one
   * command:outcome so a single feedback owner can present it.
   */
  async execute(
    id: CommandId,
    context: CommandContext,
    input?: unknown,
  ): Promise<CommandResult> {
    return this.executeAdmitted(id, context, input);
  }

  private async executeAdmitted(
    id: CommandId,
    context: CommandContext,
    input?: unknown,
  ): Promise<CommandResult> {
    const invocationId = `cmd-${++this.invocationSequence}`;
    const admissionScopeKey =
      context.sessionScopeKey === undefined
        ? (this.sessionScopeSource?.getScopeKey() ?? null)
        : context.sessionScopeKey;
    const emitOutcome = (
      status: CommandOutcomeStatus,
      phase: "admission" | "run",
      details: CommandOutcomeDetails = {},
    ) => {
      this.bus?.emit("command:outcome", {
        backendCommandId: details.backendCommandId ?? null,
        clientIntentId: details.clientIntentId ?? null,
        clientIntentKind: details.clientIntentKind ?? null,
        commandId: id,
        feedback: context.feedback ?? defaultCommandFeedbackOwner(context.source),
        invocationId,
        message: details.message ?? null,
        observation: details.observation ?? null,
        phase,
        sessionScopeKey: admissionScopeKey,
        source: context.source,
        sourceDetail: context.sourceDetail ?? null,
        status,
        title: details.title ?? null,
      });
    };

    const cmd = this.commands.get(id);
    if (!cmd) {
      const message = `Unknown command: ${id}`;
      this.diagnostics?.record({
        commandId: id,
        invocationId,
        message,
        sessionScopeKey: admissionScopeKey,
        source: context.source,
        sourceDetail: context.sourceDetail,
        status: "missing",
      });
      emitOutcome("missing", "admission", { message });
      return { status: "failed", message };
    }
    const commandContext =
      input === undefined
        ? context
        : {
            ...context,
            input,
          };
    if (cmd.isEnabled && !cmd.isEnabled(commandContext)) {
      const disabledReason =
        cmd.disabledReason?.(commandContext) ?? `Command disabled: ${id}`;
      this.diagnostics?.record({
        commandId: id,
        disabledReason,
        invocationId,
        message: disabledReason,
        sessionScopeKey: admissionScopeKey,
        source: commandContext.source,
        sourceDetail: commandContext.sourceDetail,
        status: "disabled",
      });
      emitOutcome("disabled", "admission", {
        message: disabledReason,
        title: cmd.title,
      });
      return {
        status: "failed",
        message: disabledReason,
      };
    }

    const sessionContext = this.captureSessionContext(commandContext);
    try {
      this.diagnostics?.record({
        commandId: id,
        invocationId,
        sessionScopeKey: admissionScopeKey,
        source: commandContext.source,
        sourceDetail: commandContext.sourceDetail,
        status: "submitted",
      });
      this.bus?.emit("command:submitted", { commandId: id });
      const result = await cmd.run(sessionContext.context);
      this.diagnostics?.record({
        backendCommandId: result.commandId ?? null,
        commandId: id,
        invocationId,
        message: result.message,
        observation: result.observation ?? null,
        sessionScopeKey: admissionScopeKey,
        source: commandContext.source,
        sourceDetail: commandContext.sourceDetail,
        status: result.status,
      });
      this.bus?.emit("command:completed", {
        commandId: id,
        status: result.status,
      });
      emitOutcome(result.status, "run", {
        backendCommandId: result.commandId,
        clientIntentId: result.clientIntentId,
        clientIntentKind: result.clientIntentKind,
        message: result.message ?? null,
        observation: result.observation,
        title: cmd.title,
      });
      this.notify();
      return result;
    } catch (error) {
      const status = error instanceof SessionCommandCancelledError ? "cancelled" : "failed";
      const message =
        error instanceof Error ? error.message : "Unknown error";
      this.bus?.emit("command:completed", {
        commandId: id,
        status,
      });
      this.diagnostics?.record({
        commandId: id,
        invocationId,
        message,
        sessionScopeKey: admissionScopeKey,
        source: commandContext.source,
        sourceDetail: commandContext.sourceDetail,
        status,
      });
      emitOutcome(status, "run", { message, title: cmd.title });
      this.notify();
      return { status, message };
    } finally {
      sessionContext.release();
    }
  }

  private captureSessionContext(context: CommandContext): {
    context: CommandContext;
    release: () => void;
  } {
    const source = this.sessionScopeSource;
    if (!source) return { context, release: () => {} };
    const scopeKey = context.sessionScopeKey === undefined
      ? source.getScopeKey()
      : context.sessionScopeKey;
    let current = scopeKey !== null && source.getScopeKey() === scopeKey;
    const observe = () => {
      // Once obsolete, a command stays obsolete even if A -> B -> A occurs.
      current = current && source.getScopeKey() === scopeKey;
    };
    const unsubscribe = source.subscribe(observe);
    observe();
    return {
      context: {
        ...context,
        sessionScopeKey: scopeKey,
        isCurrentSessionScope: () => {
          observe();
          return current && (context.isCurrentSessionScope?.() ?? true);
        },
      },
      release: () => {
        current = false;
        unsubscribe();
      },
    };
  }

  private notify(): void {
    this.version += 1;
    for (const listener of this.listeners) {
      listener();
    }
  }
}
