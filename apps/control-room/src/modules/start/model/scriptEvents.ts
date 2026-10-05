/**
 * What a script's events say, as rows for the History and Runs tabs. Pure:
 * the backend's event detail is free-form, so every field is read defensively
 * and a row never fails to render because one is missing.
 */

import { runChip } from "./scriptRowModel";
import type { ProjectStatus } from "./types";
import { resultChip } from "./resultModel";
import {
  metaNumber,
  metaString,
  type ApiWorkspaceEvent,
  type ApiWorkspaceItem,
} from "./workspaceApiTypes";

const EVENT_LABEL: Readonly<Record<string, string>> = {
  open: "Opened",
  save: "Saved",
  edit: "Edited",
  run: "Run",
  create: "Created",
  import: "Imported",
  pin: "Pinned",
  unpin: "Unpinned",
  forget: "Removed from recent",
  rename: "Renamed",
  move: "Moved",
};

export const ACTOR_LABEL: Readonly<Record<string, string>> = {
  desktop: "desktop app",
  cli: "command line",
  python: "Python",
  web: "browser",
  scanner: "folder scan",
};

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Seven characters of a hash are enough to tell two versions apart. */
export const shortHash = (hash: string | undefined): string | undefined =>
  hash ? hash.slice(0, 7) : undefined;

interface Side {
  readonly hash?: string;
  readonly lines?: number;
}

/** `before`/`after` objects, or flat `before_sha256`/`after_lines`-style keys. */
function side(detail: Readonly<Record<string, unknown>>, name: "before" | "after"): Side {
  const nested = detail[name];
  if (isRecord(nested)) {
    return { hash: str(nested.sha256) ?? str(nested.hash), lines: num(nested.lines) };
  }
  return {
    hash:
      str(detail[`${name}_sha256`]) ??
      str(detail[`${name}_hash`]) ??
      str(detail[`sha256_${name}`]),
    lines: num(detail[`${name}_lines`]) ?? num(detail[`lines_${name}`]),
  };
}

export interface EditChange {
  readonly beforeHash?: string;
  readonly afterHash?: string;
  readonly beforeLines?: number;
  readonly afterLines?: number;
}

export function editChange(detail: Readonly<Record<string, unknown>>): EditChange {
  const before = side(detail, "before");
  const after = side(detail, "after");
  return {
    beforeHash: shortHash(before.hash),
    afterHash: shortHash(after.hash),
    beforeLines: before.lines,
    afterLines: after.lines,
  };
}

/** "12 → 15 lines · a1b2c3d → e4f5a6b"; empty when the event recorded neither. */
export function describeEdit(change: EditChange): string {
  const parts: string[] = [];
  if (change.beforeLines !== undefined && change.afterLines !== undefined) {
    parts.push(`${change.beforeLines} → ${change.afterLines} lines`);
  } else if (change.afterLines !== undefined) {
    parts.push(`${change.afterLines} lines`);
  }
  if (change.beforeHash && change.afterHash) parts.push(`${change.beforeHash} → ${change.afterHash}`);
  else if (change.afterHash) parts.push(change.afterHash);
  return parts.join(" · ");
}

export interface ScriptHistoryRow {
  readonly key: string;
  readonly kind: string;
  readonly label: string;
  readonly at: string;
  readonly actor: string;
  /** The words after the actor: an edit's before/after, a run's outcome. */
  readonly summary: string;
}

function runSummary(detail: Readonly<Record<string, unknown>>): string {
  const status = str(detail.status);
  const chip = status ? runChip({ status, at: "" }) : null;
  const parts: string[] = [];
  if (chip) parts.push(chip.label);
  const duration = num(detail.duration_seconds);
  if (duration !== undefined) parts.push(`${Math.round(duration * 10) / 10} s`);
  const device = str(detail.device);
  if (device) parts.push(device);
  return parts.join(" · ");
}

/** The script's own timeline, newest first as the backend sent it. */
export function scriptHistoryRows(events: readonly ApiWorkspaceEvent[]): ScriptHistoryRow[] {
  return events.map((event) => ({
    key: event.key,
    kind: event.kind,
    label: EVENT_LABEL[event.kind] ?? event.kind,
    at: event.at,
    actor: ACTOR_LABEL[event.actor] ?? event.actor,
    summary:
      event.kind === "edit" || event.kind === "save"
        ? describeEdit(editChange(event.detail))
        : event.kind === "run"
          ? runSummary(event.detail)
          : (str(event.detail.source) ?? ""),
  }));
}

export interface ScriptRunRow {
  readonly key: string;
  readonly label: string;
  readonly status: ProjectStatus;
  readonly statusWord: string;
  readonly startedAt?: string;
  readonly durationSeconds?: number;
  readonly outputBytes?: number;
  /** Set for a result folder, which the inspector can select. */
  readonly resultId?: string;
}

const shortTime = (iso: string): string => iso.replace("T", " ").slice(0, 16);

/**
 * Runs of a script: one row per run event, then the result folders linked to
 * it. A folder that carries a run event's id replaces that event's row, so a
 * run is listed once and its row can open the folder.
 */
export function scriptRunRows(
  events: readonly ApiWorkspaceEvent[],
  linkedResults: readonly ApiWorkspaceItem[],
): ScriptRunRow[] {
  const folderRunIds = new Set(
    linkedResults.flatMap((item) => {
      const runId = metaString(item, "run_id");
      return runId ? [runId] : [];
    }),
  );
  const rows: ScriptRunRow[] = [];
  for (const item of linkedResults) {
    const chip = resultChip(item);
    rows.push({
      key: `result:${item.id}`,
      label: item.name,
      status: chip?.status ?? "draft",
      statusWord: chip?.label || chip?.title || "Result folder",
      startedAt: metaString(item, "started_at") ?? item.firstSeenAt ?? item.modifiedAt,
      durationSeconds: metaNumber(item, "duration_seconds"),
      outputBytes: item.sizeBytes,
      resultId: item.id,
    });
  }
  for (const event of events) {
    if (event.kind !== "run") continue;
    const runId = str(event.detail.run_id);
    if (runId && folderRunIds.has(runId)) continue;
    const status = str(event.detail.status);
    const chip = status ? runChip({ status, at: event.at }) : null;
    rows.push({
      key: `event:${event.key}`,
      label: runId ?? shortTime(event.at),
      status: chip?.status ?? "draft",
      statusWord: chip?.label ?? "Run",
      startedAt: event.at,
      durationSeconds: num(event.detail.duration_seconds),
      outputBytes: num(event.detail.output_bytes),
    });
  }
  return rows.sort((a, b) => Date.parse(b.startedAt ?? "") - Date.parse(a.startedAt ?? "") || 0);
}
