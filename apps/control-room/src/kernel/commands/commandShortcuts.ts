import type {
  CommandContext,
  CommandContribution,
  CommandId,
  CommandResult,
} from "./commandTypes";

export interface ShortcutKeyboardEvent {
  altKey?: boolean;
  ctrlKey?: boolean;
  key: string;
  metaKey?: boolean;
  shiftKey?: boolean;
}

export interface ShortcutDispatchEvent extends ShortcutKeyboardEvent {
  defaultPrevented?: boolean;
  preventDefault?: () => void;
  target?: EventTarget | null;
}

interface ShortcutCommandRegistry {
  all: () => CommandContribution[];
  execute: (id: CommandId, context: CommandContext) => Promise<CommandResult>;
  isEnabled: (id: CommandId, context: CommandContext) => boolean;
}

const MODIFIER_KEYS = new Set(["alt", "ctrl", "cmd", "meta", "shift"]);
const SHORTCUT_SCOPE_PRIORITY: Record<CommandContribution["scope"], number> = {
  viewport: 0,
  selection: 1,
  workspace: 2,
  runtime: 3,
  debug: 4,
  global: 5,
};

function normalizeKey(key: string): string {
  if (key === " ") return "space";
  const normalized = key.trim().toLowerCase();
  if (normalized === "return") return "enter";
  if (normalized === "esc") return "escape";
  return normalized;
}

export function matchesCommandShortcut(
  shortcut: string | undefined,
  event: ShortcutKeyboardEvent,
): boolean {
  if (!shortcut) return false;

  const tokens = shortcut
    .split("+")
    .flatMap((token) => {
      const normalized = normalizeKey(token);
      return normalized ? [normalized] : [];
    });
  const key = tokens.find((token) => !MODIFIER_KEYS.has(token));
  if (!key || normalizeKey(event.key) !== key) return false;

  const wantsAlt = tokens.includes("alt");
  const wantsCtrl = tokens.includes("ctrl");
  const wantsMeta = tokens.includes("meta") || tokens.includes("cmd");
  const wantsShift = tokens.includes("shift");
  const ctrlMatches = wantsCtrl
    ? Boolean(event.ctrlKey || event.metaKey)
    : !event.ctrlKey;
  const metaMatches = wantsMeta
    ? Boolean(event.metaKey)
    : wantsCtrl || !event.metaKey;

  return (
    Boolean(event.altKey) === wantsAlt &&
    ctrlMatches &&
    metaMatches &&
    Boolean(event.shiftKey) === wantsShift
  );
}

export function findShortcutCommand(
  commands: readonly CommandContribution[],
  event: ShortcutKeyboardEvent,
): CommandContribution | null {
  let bestCommand: CommandContribution | null = null;
  let bestPriority = Number.POSITIVE_INFINITY;

  for (const command of commands) {
    if (!matchesCommandShortcut(command.shortcut, event)) continue;
    const priority = SHORTCUT_SCOPE_PRIORITY[command.scope];
    if (priority < bestPriority) {
      bestCommand = command;
      bestPriority = priority;
    }
  }

  return bestCommand;
}

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  const element = target as
    | {
        getAttribute?: (name: string) => string | null;
        isContentEditable?: boolean;
        tagName?: string;
      }
    | null;
  const tagName = element?.tagName?.toLowerCase();

  return (
    tagName === "input" ||
    tagName === "select" ||
    tagName === "textarea" ||
    Boolean(element?.isContentEditable) ||
    element?.getAttribute?.("contenteditable") === "true"
  );
}

export function dispatchShortcutCommand(
  commands: ShortcutCommandRegistry,
  event: ShortcutDispatchEvent,
  context: CommandContext,
): boolean {
  if (event.defaultPrevented) {
    return false;
  }
  if (isEditableShortcutTarget(event.target ?? null)) {
    return false;
  }

  const enabledCommands = commands
    .all()
    .filter((command) => commands.isEnabled(command.id, context));
  const command = findShortcutCommand(enabledCommands, event);
  if (!command) {
    return false;
  }

  event.preventDefault?.();
  void commands.execute(command.id, context);
  return true;
}
