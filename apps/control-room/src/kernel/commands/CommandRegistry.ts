import type {
  CommandCategory,
  CommandContext,
  CommandContribution,
  CommandId,
  CommandResult,
} from "./commandTypes";
import type { CommandDiagnosticsController } from "./CommandDiagnosticsController";

import type { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";

export class CommandRegistry {
  private readonly commands = new Map<CommandId, CommandContribution>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private bus: EventBus<KernelEventMap> | null = null;
  private diagnostics: CommandDiagnosticsController | null = null;

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

  /** Execute a command by id. Emits command:submitted and command:completed events. */
  async execute(
    id: CommandId,
    context: CommandContext,
    input?: unknown,
  ): Promise<CommandResult> {
    const cmd = this.commands.get(id);
    if (!cmd) {
      this.diagnostics?.record({
        commandId: id,
        message: `Unknown command: ${id}`,
        source: context.source,
        sourceDetail: context.sourceDetail,
        status: "missing",
      });
      return { status: "failed", message: `Unknown command: ${id}` };
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
        message: disabledReason,
        source: commandContext.source,
        sourceDetail: commandContext.sourceDetail,
        status: "disabled",
      });
      return {
        status: "failed",
        message: disabledReason,
      };
    }

    this.diagnostics?.record({
      commandId: id,
      source: commandContext.source,
      sourceDetail: commandContext.sourceDetail,
      status: "submitted",
    });
    this.bus?.emit("command:submitted", { commandId: id });

    try {
      const result = await cmd.run(commandContext);
      this.diagnostics?.record({
        commandId: id,
        message: result.message,
        source: commandContext.source,
        sourceDetail: commandContext.sourceDetail,
        status: result.status,
      });
      this.bus?.emit("command:completed", {
        commandId: id,
        status: result.status,
      });
      this.notify();
      return result;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      this.bus?.emit("command:completed", {
        commandId: id,
        status: "failed",
      });
      this.diagnostics?.record({
        commandId: id,
        message,
        source: commandContext.source,
        sourceDetail: commandContext.sourceDetail,
        status: "failed",
      });
      this.notify();
      return { status: "failed", message };
    }
  }

  private notify(): void {
    this.version += 1;
    for (const listener of this.listeners) {
      listener();
    }
  }
}
