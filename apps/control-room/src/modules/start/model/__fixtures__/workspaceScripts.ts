import type { RecentEntry } from "../types";
import type { WorkspaceItem } from "../workspaceItems";

/** A script item with sensible defaults; tests override only what they assert on. */
export function script(partial: Partial<WorkspaceItem> & { id: number }): WorkspaceItem {
  return {
    kind: "script",
    path: `/work/${partial.name ?? `s${partial.id}`}.py`,
    name: `s${partial.id}`,
    firstSeenAt: "2026-09-01T08:00:00.000Z",
    lastUsedAt: "2026-10-03T12:00:00.000Z",
    useCount: 1,
    pinned: false,
    status: "ready",
    meta: {},
    ...partial,
  };
}

export function project(partial: Partial<RecentEntry> & { projectId: string }): RecentEntry {
  return {
    name: partial.projectId,
    path: `/p/${partial.projectId}.fms`,
    solver: "FDM",
    status: "ready",
    lastOpenedAt: "2026-10-03T12:00:00.000Z",
    ...partial,
  };
}

/** The wire shape of one script exactly as the host sends it. */
export const RAW_SCRIPT = {
  id: 7,
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
  meta: {
    lines: 120,
    summary: "Standard problem 4",
    uses_fullmag: true,
    truncated: false,
    last_run: { status: "ok", at: "2026-10-03T11:00:00.000Z", duration_seconds: 42.5, device: "cpu" },
  },
} as const;
