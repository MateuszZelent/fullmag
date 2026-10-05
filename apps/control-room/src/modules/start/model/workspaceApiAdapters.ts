/**
 * Maps the HTTP workspace API's items and details onto the shapes the start
 * screen already renders (`RecentEntry`, `WorkspaceItem`, `ModelSummary`,
 * `Provenance`), so the list rows and inspector panels have one set of
 * components whichever source served the data. Pure.
 */

import type { Provenance } from "./provenance";
import type { ModelSummary, ProjectStatus, RecentEntry, SolverKind } from "./types";
import {
  metaLastRun,
  metaNumber,
  metaString,
  type ApiWorkspaceItem,
  type ProjectDetail,
} from "./workspaceApiTypes";
import { parseMeta, type WorkspaceItem } from "./workspaceItems";

const stringList = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry !== "")
    : undefined;

function solverOf(text: string | undefined): SolverKind {
  return text?.toUpperCase() === "FEM" ? "FEM" : "FDM";
}

export interface ProjectEntryOptions {
  /** Builds the thumbnail URL of an item; omitted, no thumbnail is shown. */
  readonly thumbnailUrl?: (id: string) => string;
  /** The project the desktop reports a live run for; its entry shows as running. */
  readonly runningProjectId?: string;
}

export function thumbnailSource(
  item: ApiWorkspaceItem,
  thumbnailUrl: ((id: string) => string) | undefined,
): string | undefined {
  if (!item.hasThumbnail || !thumbnailUrl) return undefined;
  const url = thumbnailUrl(item.id);
  const version = item.modifiedAt ?? item.lastUsedAt;
  // The stamp keeps a re-rendered preview from being served from the browser cache.
  return version ? `${url}?v=${encodeURIComponent(version)}` : url;
}

export function apiProjectToEntry(item: ApiWorkspaceItem, options: ProjectEntryOptions = {}): RecentEntry {
  const projectId = item.projectId ?? item.id;
  const status: ProjectStatus =
    options.runningProjectId === projectId && item.status === "ready" ? "running" : item.status;
  const tags = stringList(item.meta.tags);
  return {
    projectId,
    workspaceId: item.id,
    name: item.name,
    path: item.path,
    solver: solverOf(metaString(item, "solver")),
    status,
    lastOpenedAt: item.lastUsedAt,
    createdAt: item.firstSeenAt || undefined,
    modifiedAt: item.modifiedAt,
    sizeBytes: item.sizeBytes,
    revision: metaNumber(item, "revision"),
    manifestSchemaVersion: metaString(item, "schema_version"),
    createdWithVersion: metaString(item, "created_with_version"),
    mode: metaString(item, "mode") === "read_only" ? "read_only" : undefined,
    modeReason: metaString(item, "mode_reason"),
    pinned: item.pinned,
    tags: tags && tags.length > 0 ? tags : undefined,
    thumbnail: thumbnailSource(item, options.thumbnailUrl),
    lastError: metaString(item, "last_error"),
  };
}

/** A script item in the shape of the desktop list; its id is the API's string. */
export function apiScriptToItem(item: ApiWorkspaceItem): WorkspaceItem {
  const lastRun = metaLastRun(item);
  const meta = parseMeta(item.meta);
  return {
    id: item.id,
    kind: "script",
    path: item.path,
    name: item.name,
    projectId: item.projectId,
    firstSeenAt: item.firstSeenAt,
    lastUsedAt: item.lastUsedAt,
    useCount: item.useCount,
    pinned: item.pinned,
    status: item.status,
    sizeBytes: item.sizeBytes,
    modifiedAt: item.modifiedAt,
    meta: { ...meta, lastRun: lastRun ?? meta.lastRun },
  };
}

/** What the Overview tab lists; `undefined` when the backend sent no summary. */
export function detailToModelSummary(detail: ProjectDetail | undefined): ModelSummary | undefined {
  const summary = detail?.summary;
  if (!summary) return undefined;
  const { model, execution, outputs } = summary;
  return {
    discretisation: model.discretisation,
    cellSize: model.cell,
    periodicity: model.periodicity,
    materials: model.materials,
    ms: model.ms,
    aex: model.aex,
    alpha: model.alpha,
    interactions: model.interactions,
    integrator: execution.integrator,
    tolerance: execution.tolerance,
    excitation: execution.excitation,
    outputFrames: outputs.frames,
    outputBytes: outputs.sizeBytes,
  };
}

/** The provenance panels' input, built from a project detail. */
export function detailToProvenance(detail: ProjectDetail): Provenance {
  const recorded =
    detail.authors.length > 0 || detail.history.length > 0 || detail.runs.length > 0;
  return {
    recorded,
    authors: detail.authors,
    citation: detail.citation,
    history: [...detail.history].sort(
      (a, b) => Date.parse(b.at) - Date.parse(a.at) || b.revision - a.revision,
    ),
    runs: [...detail.runs].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)),
  };
}

/**
 * Facts only the read file knows (revision, schema, write access, the last
 * failure) refine the row's entry for the inspector, so the banner and chips
 * describe the file rather than the index's hint.
 */
export function applyProjectDetail(entry: RecentEntry, detail: ProjectDetail | undefined): RecentEntry {
  if (!detail || detail.readError) return entry;
  const latestRun = [...detail.runs].sort(
    (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt),
  )[0];
  const readOnly = detail.mode === "read_only" || detail.canWrite === false;
  return {
    ...entry,
    solver: detail.solver ? solverOf(detail.solver) : entry.solver,
    revision: detail.revision ?? entry.revision,
    manifestSchemaVersion: detail.schemaVersion ?? entry.manifestSchemaVersion,
    mode: readOnly ? "read_only" : entry.mode,
    modeReason: entry.modeReason ?? (readOnly ? detail.warnings[0] : undefined),
    lastError: entry.lastError ?? (latestRun?.status === "failed" ? latestRun.error : undefined),
  };
}
