/**
 * Text and status mappings for script rows and the script inspector, pure so
 * the parts a screenshot cannot show (quoting, odd run states) are testable.
 */

import type { ProjectStatus } from "./types";
import type { WorkspaceItem, WorkspaceLastRun } from "./workspaceItems";

/** `\\?\C:\x` is a Windows verbatim path; the prefix means nothing to a person. */
const stripVerbatim = (path: string): string =>
  path.startsWith("\\\\?\\UNC\\")
    ? `\\\\${path.slice(8)}`
    : path.startsWith("\\\\?\\")
      ? path.slice(4)
      : path;

/**
 * `fullmag "<path>"`, quoted for the shell the path style implies. A Windows
 * path (drive letter or backslashes) keeps its backslashes literal, which both
 * cmd and PowerShell do inside double quotes; a POSIX path has the characters
 * a double-quoted word still expands (`\`, `"`, `$`, backtick) escaped.
 */
export function launchCommand(path: string): string {
  const clean = stripVerbatim(path);
  const windowsStyle = /^[A-Za-z]:[\\/]/.test(clean) || clean.startsWith("\\\\");
  const quoted = windowsStyle
    ? clean.replace(/"/g, "")
    : clean.replace(/[\\"$`]/g, (c) => `\\${c}`);
  return `fullmag "${quoted}"`;
}

export interface RunChip {
  readonly status: ProjectStatus;
  readonly label: string;
  readonly title: string;
}

/**
 * The CLI records `started`, then `ok` or `failed`; the desktop may add
 * others. A `started` that never finished (the process was killed) is shown
 * as such, never as running: nothing here knows it still is.
 */
export function runChip(lastRun: WorkspaceLastRun | undefined): RunChip | null {
  if (!lastRun) return null;
  switch (lastRun.status.toLowerCase()) {
    case "ok":
    case "succeeded":
    case "success":
    case "completed":
    case "ready":
      return { status: "ready", label: "Run ok", title: "The last run completed" };
    case "failed":
    case "error":
      return { status: "failed", label: "Run failed", title: "The last run failed" };
    case "started":
      return {
        status: "draft",
        label: "Run started",
        title: "The last run started and did not report an outcome",
      };
    case "cancelled":
    case "canceled":
    case "stopped":
      return { status: "draft", label: "Run stopped", title: "The last run was stopped" };
    default:
      return { status: "draft", label: lastRun.status, title: `Last run: ${lastRun.status}` };
  }
}

/** "1 line", "240 lines", "5,000+ lines" when the host counted only a prefix. */
export function formatLines(item: Pick<WorkspaceItem, "meta">): string | null {
  const lines = item.meta.lines;
  if (lines === undefined) return null;
  const count = lines.toLocaleString("en-US");
  if (item.meta.truncated) return `${count}+ lines`;
  return lines === 1 ? "1 line" : `${count} lines`;
}

export function formatDuration(seconds: number | undefined): string | null {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 90) return `${Math.round(seconds * 10) / 10} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Folder of a path, without the file name, for the row's second line. */
export function folderOf(path: string): string {
  const clean = stripVerbatim(path);
  const cut = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return cut > 0 ? clean.slice(0, cut) : clean;
}

export const displayPath = stripVerbatim;

/** Copy to the clipboard; false when the browser refuses (no permission, no API). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
