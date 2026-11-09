import type { StartScreenHost } from "./startScreenState";

export interface StartScreenHostCommands {
  refresh(): void;
}

export interface StartScreenHostAdapter {
  readonly owner: object;
  readonly host: StartScreenHost;
  commit(host: StartScreenHost, commands: StartScreenHostCommands): void;
  refresh(): void;
  invalidate(): (() => void) | undefined;
}

/** Creates one mutable host binding for a single mounted StartScreen owner. */
export function createStartScreenHostAdapter(owner: object): StartScreenHostAdapter {
  let committedHost: StartScreenHost | null = null;
  let committedCommands: StartScreenHostCommands | null = null;
  const currentHost = () => {
    if (!committedHost) throw new Error("The start-screen host is detached.");
    return committedHost;
  };
  const host: StartScreenHost = {
    get createProblemDisabledReason() {
      return currentHost().createProblemDisabledReason;
    },
    get openScriptDisabledReason() {
      return currentHost().openScriptDisabledReason;
    },
    disabledReason: (commandId, context) => currentHost().disabledReason(commandId, context),
    execute: (commandId, context) => currentHost().execute(commandId, context),
    isEnabled: (commandId, context) => currentHost().isEnabled(commandId, context),
  };

  return {
    owner,
    host,
    commit: (nextHost, commands) => {
      committedHost = nextHost;
      committedCommands = commands;
    },
    refresh: () => committedCommands?.refresh(),
    invalidate: () => {
      const commands = committedCommands;
      committedHost = null;
      committedCommands = null;
      return commands ? () => commands.refresh() : undefined;
    },
  };
}
