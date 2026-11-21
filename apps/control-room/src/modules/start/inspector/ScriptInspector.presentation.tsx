import type { WorkspaceItem } from "../model/workspaceItems";
import { Copy, FolderSearch, Terminal, Trash2 } from "lucide-react";
import { type MenuAction } from "./InspectorParts";
import type { ScriptDetail } from "../model/workspaceApiTypes";
import { kvRowOrUnavailable, type KvRow } from "./KeyValueGroup.model";
import { chipList } from "./KeyValueGroup.presentation";

export const READ_ONLY_REASON = "The workspace database is read-only";

/** The checks the backend ran on the file: parse, imports, environment. */
export function scriptChecks(script: ScriptDetail): KvRow[] {
  const notChecked = script.syntax === undefined && script.syntaxChecked === false;
  const syntax = notChecked
    ? "not checked"
    : script.syntax
    ? script.syntax.ok
      ? "No syntax errors"
      : `Error${script.syntax.line !== undefined ? ` at line ${script.syntax.line}` : ""}${script.syntax.message ? `: ${script.syntax.message}` : ""}`
    : undefined;
  // "Not found" is relative to the interpreter the backend chose: a run may use another.
  const imports = script.unresolvedImports
    ? script.unresolvedImports.length === 0
      ? "All found by the interpreter"
      : chipList(script.unresolvedImports)
    : script.imports
      ? script.imports.length === 0
        ? "None"
        : chipList(script.imports)
      : undefined;
  const env = script.envReads
    ? script.envReads.length === 0
      ? "None"
      : chipList(script.envReads)
    : undefined;
  return [
    ...kvRowOrUnavailable("Syntax", syntax),
    ...kvRowOrUnavailable(
      script.unresolvedImports ? "Imports not found" : script.syntaxChecked ? "Imports" : "Imports (line scan)",
      imports,
    ),
    ...kvRowOrUnavailable("Environment reads", env),
    ...(script.degraded && script.degradedReason
      ? [{ label: "Checked by", value: <span title={script.degradedReason}>line scan only</span> }]
      : []),
  ];
}

export interface ScriptMenus {
  readonly more: readonly MenuAction[];
  readonly split: readonly MenuAction[];
}

/** The two menus of the inspector, as data so their reasons are testable. */
export function scriptMenus(input: {
  readonly item: WorkspaceItem;
  readonly readOnly: boolean;
  readonly busy: boolean;
  /** Why the desktop-only actions are unavailable (no desktop host); null when they work. */
  readonly desktopReason: string | null;
  readonly onCopyPath: () => void;
  readonly onReveal: () => void;
  readonly onCopyScript: () => void;
  readonly onCopyCommand: () => void;
  readonly onForget: () => void;
}): ScriptMenus {
  const missing = input.item.status === "missing";
  const fileGone = missing ? "The file is missing." : null;
  return {
    more: [
      { id: "copy-path", label: "Copy path", icon: <Copy aria-hidden="true" size={14} />, onSelect: input.onCopyPath },
      {
        id: "reveal-script",
        label: "Reveal in folder",
        icon: <FolderSearch aria-hidden="true" size={14} />,
        onSelect: input.onReveal,
        disabledReason:
          fileGone ?? input.desktopReason ?? (input.busy ? "Another action is running" : null),
      },
      {
        id: "forget-script",
        label: "Remove from recent",
        icon: <Trash2 aria-hidden="true" size={14} />,
        onSelect: input.onForget,
        disabledReason: input.readOnly ? READ_ONLY_REASON : null,
        separatorBefore: true,
      },
    ],
    split: [
      {
        id: "copy-script",
        label: "Copy script",
        icon: <Copy aria-hidden="true" size={14} />,
        onSelect: input.onCopyScript,
        disabledReason:
          fileGone ?? input.desktopReason ?? (input.busy ? "Another action is running" : null),
      },
      {
        id: "copy-command",
        label: "Copy launch command",
        icon: <Terminal aria-hidden="true" size={14} />,
        onSelect: input.onCopyCommand,
      },
    ],
  };
}
