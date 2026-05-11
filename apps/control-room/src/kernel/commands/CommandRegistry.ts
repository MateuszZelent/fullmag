import type {
  CommandCategory,
  CommandContext,
  CommandContribution,
  CommandId,
  CommandResult,
} from "./commandTypes";

import type { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";

export class CommandRegistry {
  private readonly commands = new Map<CommandId, CommandContribution>();
  private bus: EventBus<KernelEventMap> | null = null;

  /** Attach bus for event emission. Called once during kernel init. */
  attach(bus: EventBus<KernelEventMap>): void {
    this.bus = bus;
  }

  register(command: CommandContribution): void {
    if (this.commands.has(command.id)) {
      throw new Error(`Command "${command.id}" is already registered.`);
    }
    this.commands.set(command.id, command);
  }

  unregister(id: CommandId): void {
    this.commands.delete(id);
  }

  get(id: CommandId): CommandContribution | undefined {
    return this.commands.get(id);
  }

  all(): CommandContribution[] {
    return Array.from(this.commands.values());
  }

  /** Return all commands matching a category. */
  byCategory(category: CommandCategory): CommandContribution[] {
    return this.all().filter((cmd) => cmd.category === category);
  }

  /** Check if a command is enabled in the given context. */
  isEnabled(id: CommandId, context: CommandContext): boolean {
    const cmd = this.commands.get(id);
    if (!cmd) return false;
    if (!cmd.isEnabled) return true;
    return cmd.isEnabled(context);
  }

  /** Execute a command by id. Emits command:submitted and command:completed events. */
  async execute(
    id: CommandId,
    context: CommandContext,
  ): Promise<CommandResult> {
    const cmd = this.commands.get(id);
    if (!cmd) {
      return { status: "failed", message: `Unknown command: ${id}` };
    }

    this.bus?.emit("command:submitted", { commandId: id });

    try {
      const result = await cmd.run(context);
      this.bus?.emit("command:completed", {
        commandId: id,
        status: result.status,
      });
      return result;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      this.bus?.emit("command:completed", {
        commandId: id,
        status: "failed",
      });
      return { status: "failed", message };
    }
  }
}
