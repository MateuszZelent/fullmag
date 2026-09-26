import type { CommandContext, CommandResult } from "./commandTypes";

type SessionCommandContext = Pick<CommandContext, "isCurrentSessionScope">;

export class SessionCommandCancelledError extends Error {
  constructor() {
    super("The session changed while the operation was pending.");
    this.name = "SessionCommandCancelledError";
  }
}

export function assertCurrentSessionScope(context: SessionCommandContext): void {
  if (context.isCurrentSessionScope?.() === false) {
    throw new SessionCommandCancelledError();
  }
}

/** Check at async boundaries before publishing session-owned local effects. */
export function obsoleteSessionResult(context: SessionCommandContext): CommandResult | null {
  return context.isCurrentSessionScope?.() === false
    ? { status: "cancelled", message: "The session changed while the operation was pending." }
    : null;
}
