import { describe, expect, it } from "vitest";

import { RAW_API_PROJECT_DETAIL, apiItem, entry } from "./__fixtures__/workspaceApi";
import {
  applyProjectDetail,
  apiProjectToEntry,
  apiScriptToItem,
  detailToModelSummary,
  detailToProvenance,
  thumbnailSource,
} from "./workspaceApiAdapters";
import { parseApiItemDetail, type ProjectDetail } from "./workspaceApiTypes";

const thumbnailUrl = (id: string) => `http://host/v2/workspace/items/${id}/thumbnail`;
const projectDetail = (extra: Record<string, unknown> = {}): ProjectDetail => {
  const detail = parseApiItemDetail({ ...RAW_API_PROJECT_DETAIL, ...extra });
  if (detail?.kind !== "project") throw new Error("fixture is not a project");
  return detail;
};

describe("apiProjectToEntry", () => {
  const item = apiItem({
    id: "wi-1",
    kind: "project",
    projectId: "proj-1",
    name: "YIG",
    path: "D:\\sim\\yig.fms",
    pinned: true,
    sizeBytes: 5,
    modifiedAt: "2026-10-03T10:00:00.000Z",
    hasThumbnail: true,
    meta: {
      solver: "fem",
      revision: 9,
      schema_version: "1.1",
      tags: ["a", "", 3, "b"],
      mode: "read_only",
      mode_reason: "opened from a share",
      last_error: "mesh failed",
    },
  });

  it("maps identity, facts, tags and the thumbnail url", () => {
    expect(apiProjectToEntry(item, { thumbnailUrl })).toMatchObject({
      projectId: "proj-1",
      workspaceId: "wi-1",
      name: "YIG",
      solver: "FEM",
      status: "ready",
      revision: 9,
      manifestSchemaVersion: "1.1",
      tags: ["a", "b"],
      mode: "read_only",
      modeReason: "opened from a share",
      lastError: "mesh failed",
      pinned: true,
      thumbnail: `${thumbnailUrl("wi-1")}?v=2026-10-03T10%3A00%3A00.000Z`,
    });
  });

  it("uses the item id when no project id was recorded", () => {
    expect(apiProjectToEntry({ ...item, projectId: undefined }).projectId).toBe("wi-1");
  });

  it("defaults an unknown solver to FDM and offers no thumbnail without one", () => {
    const bare = apiProjectToEntry(apiItem({ id: "x", kind: "project", meta: {} }), { thumbnailUrl });
    expect(bare.solver).toBe("FDM");
    expect(bare.thumbnail).toBeUndefined();
    expect(bare.tags).toBeUndefined();
    expect(bare.mode).toBeUndefined();
  });

  it("shows the project with a live checkpoint as running, but never hides missing or failed", () => {
    expect(apiProjectToEntry(item, { runningProjectId: "proj-1" }).status).toBe("running");
    expect(apiProjectToEntry({ ...item, status: "missing" }, { runningProjectId: "proj-1" }).status).toBe("missing");
    expect(apiProjectToEntry({ ...item, status: "failed" }, { runningProjectId: "proj-1" }).status).toBe("failed");
  });
});

describe("thumbnailSource", () => {
  it("needs the flag and a builder, and stamps the version", () => {
    const item = apiItem({ id: "a", kind: "result", hasThumbnail: true, lastUsedAt: "2026-10-03" });
    expect(thumbnailSource(item, thumbnailUrl)).toBe(`${thumbnailUrl("a")}?v=2026-10-03`);
    expect(thumbnailSource({ ...item, hasThumbnail: false }, thumbnailUrl)).toBeUndefined();
    expect(thumbnailSource(item, undefined)).toBeUndefined();
    expect(thumbnailSource({ ...item, lastUsedAt: "" }, thumbnailUrl)).toBe(thumbnailUrl("a"));
  });
});

describe("apiScriptToItem", () => {
  it("keeps the string id and reads the last run from meta", () => {
    const script = apiScriptToItem(
      apiItem({
        id: "wi-s",
        kind: "script",
        useCount: 4,
        meta: {
          lines: 10,
          uses_fullmag: true,
          last_run: { status: "failed", at: "2026-10-03T11:00:00Z", duration_seconds: 3 },
        },
      }),
    );
    expect(script).toMatchObject({
      id: "wi-s",
      kind: "script",
      useCount: 4,
      meta: { lines: 10, usesFullmag: true, lastRun: { status: "failed", durationSeconds: 3 } },
    });
  });

  it("has no last run when meta has none", () => {
    expect(apiScriptToItem(apiItem({ id: "s", kind: "script" })).meta.lastRun).toBeUndefined();
  });
});

describe("project detail adapters", () => {
  it("maps the summary onto the overview's model, and nothing without one", () => {
    expect(detailToModelSummary(projectDetail())).toMatchObject({
      discretisation: "512 x 512 x 8",
      cellSize: "2 x 2 x 5 nm",
      materials: ["YIG"],
      integrator: "RK45",
      outputFrames: 400,
      outputBytes: 1420000000,
    });
    expect(detailToModelSummary(projectDetail({ summary: undefined }))).toBeUndefined();
    expect(detailToModelSummary(undefined)).toBeUndefined();
  });

  it("builds provenance newest first and marks an empty record as not recorded", () => {
    const provenance = detailToProvenance(projectDetail());
    expect(provenance.recorded).toBe(true);
    expect(provenance.runs[0]?.runId).toBe("run-7");
    expect(provenance.citation.doi).toBe("10.1234/x");

    const empty = detailToProvenance(
      projectDetail({ authors: [], history: [], runs: [], citation: undefined }),
    );
    expect(empty.recorded).toBe(false);
  });

  it("refines the entry with what the read file knows", () => {
    const refined = applyProjectDetail(
      entry({ projectId: "p", revision: 1, solver: "FDM" }),
      projectDetail({ solver: "FEM", revision: 50, schema_version: "1.3", can_write: false, warnings: ["share is read-only"] }),
    );
    expect(refined).toMatchObject({
      solver: "FEM",
      revision: 50,
      manifestSchemaVersion: "1.3",
      mode: "read_only",
      modeReason: "share is read-only",
    });
  });

  it("takes the last failed run's message for the banner, and leaves the entry alone on a read error", () => {
    const failed = applyProjectDetail(
      entry({ projectId: "p", status: "failed" }),
      projectDetail({ runs: [{ run_id: "r", started_at: "2026-10-03T09:00:00Z", status: "failed", error: "NaN in the field" }] }),
    );
    expect(failed.lastError).toBe("NaN in the field");

    const original = entry({ projectId: "p" });
    expect(applyProjectDetail(original, projectDetail({ read_error: "truncated" }))).toBe(original);
    expect(applyProjectDetail(original, undefined)).toBe(original);
  });
});
