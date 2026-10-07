import type { RecentEntry } from "../types";
import {
  parseApiItemDetailAnswer,
  parseApiWorkspaceItem,
  type ApiItemDetailAnswer,
  type ApiWorkspaceItem,
} from "../workspaceApiTypes";

/** The wire shape of one script as the HTTP workspace API sends it. */
export const RAW_API_ITEM = {
  id: "wi-script-1",
  kind: "script",
  path: "C:\\work\\sp4.py",
  name: "sp4",
  first_seen_at: "2026-09-01T08:00:00.000Z",
  last_used_at: "2026-10-03T12:00:00.000Z",
  use_count: 3,
  pinned: true,
  status: "ready",
  size_bytes: 2048,
  modified_at: "2026-10-02T09:30:00.000Z",
  has_thumbnail: false,
  meta: {
    lines: 120,
    summary: "Standard problem 4",
    uses_fullmag: true,
    last_run: { status: "ok", at: "2026-10-03T11:00:00.000Z", duration_seconds: 42.5, device: "cpu" },
  },
} as const;

export const RAW_API_PROJECT_DETAIL = {
  kind: "project",
  schema_version: "1.2",
  revision: 42,
  solver: "FDM",
  migrated: false,
  can_write: true,
  mode: "read_write",
  warnings: [],
  summary: {
    model: {
      discretisation: "512 x 512 x 8",
      cell: "2 x 2 x 5 nm",
      materials: ["YIG"],
      ms: "140 kA/m",
      interactions: ["exchange", "demag"],
    },
    execution: { integrator: "RK45", tolerance: "1e-6" },
    outputs: { frames: 400, size_bytes: 1420000000 },
  },
  authors: [{ name: "Mateusz Zelent", role: "creator", affiliation: "RPTU" }],
  citation: { doi: "10.1234/x" },
  history: [
    { revision: 42, at: "2026-10-03T08:00:00Z", by: "mz", kind: "edit", summary: "Refined the mesh" },
  ],
  runs: [
    {
      run_id: "run-7",
      started_at: "2026-10-03T09:00:00Z",
      status: "ready",
      duration_seconds: 2940,
      output_bytes: 1420000000,
    },
  ],
  preview: { colouring: "mz" },
} as const;

export const RAW_API_SCRIPT_DETAIL = {
  kind: "script",
  lines: 120,
  bytes: 2048,
  sha256: "e4f5a6b7c8d9e0f1a2b3c4d5e6f70819",
  encoding: "utf-8",
  uses_fullmag: true,
  syntax: { ok: false, line: 14, message: "unexpected indent" },
  imports: { unresolved: ["scipy"] },
  env_reads: ["FULLMAG_DEVICE"],
  last_run: { status: "ok", at: "2026-10-03T11:00:00Z", duration_seconds: 42 },
} as const;

export const RAW_API_RESULT_DETAIL = {
  kind: "result",
  format: "zarr",
  format_version: "2",
  run_id: "run-3",
  source: { kind: "script", path: "C:\\work\\sp4.py", sha256: "e4f5a6b7c8d9" },
  stages: [
    { id: "relax", kind: "relaxation", steps: 4210 },
    { id: "pulse", time_s: 1e-9 },
  ],
  quantities: ["m", "H_demag"],
  grid: { nx: 200, ny: 50, nz: 1, dx: 2.5e-9, dy: 2.5e-9, dz: 2.5e-9 },
  frames: 400,
  total_bytes: 318000000,
  status: "completed",
  started_at: "2026-10-03T06:00:00Z",
  finished_at: "2026-10-03T07:00:00Z",
} as const;

/** A parsed API item with sensible defaults; tests override only what they assert on. */
export function apiItem(partial: Partial<ApiWorkspaceItem> & { id: string; kind: ApiWorkspaceItem["kind"] }): ApiWorkspaceItem {
  return {
    path: `/work/${partial.name ?? partial.id}`,
    name: partial.id,
    firstSeenAt: "2026-09-01T08:00:00.000Z",
    lastUsedAt: "2026-10-03T12:00:00.000Z",
    useCount: 1,
    pinned: false,
    status: "ready",
    meta: {},
    hasThumbnail: false,
    ...partial,
  };
}

/** A parsed detail answer built from raw wire pieces. */
export function detailAnswer(raw: {
  readonly item: unknown;
  readonly detail?: unknown;
  readonly events?: unknown;
  readonly linked_results?: unknown;
  readonly linked_source?: unknown;
}): ApiItemDetailAnswer {
  return parseApiItemDetailAnswer(raw);
}

export const parsedItem = (raw: unknown): ApiWorkspaceItem => {
  const item = parseApiWorkspaceItem(raw);
  if (!item) throw new Error("fixture item is not valid");
  return item;
};

export function entry(partial: Partial<RecentEntry> & { projectId: string }): RecentEntry {
  return {
    name: partial.projectId,
    path: `/p/${partial.projectId}.fms`,
    solver: "FDM",
    status: "ready",
    lastOpenedAt: "2026-10-03T12:00:00.000Z",
    ...partial,
  };
}
