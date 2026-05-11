import type { CommandContribution, CommandId } from "./commandTypes";

export class CommandRegistry {
  private readonly commands = new Map<CommandId, CommandContribution>();

  register(command: CommandContribution): void {
    if (this.commands.has(command.id)) {
      throw new Error(`Command "${command.id}" is already registered.`);
    }
    this.commands.set(command.id, command);
  }

  get(id: CommandId): CommandContribution | undefined {
    return this.commands.get(id);
  }

  all(): CommandContribution[] {
    return Array.from(this.commands.values());
  }
}
