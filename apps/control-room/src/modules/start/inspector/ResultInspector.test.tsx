import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  RAW_API_ITEM,
  RAW_API_RESULT_DETAIL,
  apiItem,
  detailAnswer,
  parsedItem,
} from "../model/__fixtures__/workspaceApi";
import { RESULTS_DOWNLOAD_FOLDER_MISSING, RESULTS_DOWNLOAD_NO_BACKEND } from "../model/downloadUrl";
import type { WorkspaceItemDetailState } from "../model/useWorkspaceItems";
import { parseApiItemDetail, type ResultDetail } from "../model/workspaceApiTypes";

import {
  RESULTS_VIEWER_NEEDS_SOURCE,
  RESULTS_VIEWER_SOURCE_IS_SCRIPT,
  ResultInspector,
  downloadReason,
  resultFacts,
  viewerRoute,
  type ResultInspectorProps,
} from "./ResultInspector";

const rawResult = {
  id: "res-3",
  kind: "result",
  path: "C:\\work\\sp4.out\\run-0003.zarr",
  name: "run-0003",
  first_seen_at: "2026-10-03T06:00:00.000Z",
  last_used_at: "2026-10-03T07:00:00.000Z",
  use_count: 1,
  pinned: false,
  status: "ready",
  size_bytes: 318000000,
  modified_at: "2026-10-03T07:00:00.000Z",
  has_thumbnail: true,
  meta: { run_id: "run-3", status: "completed", source_name: "sp4" },
};
const item = parsedItem(rawResult);
const rawProject = { ...RAW_API_ITEM, id: "wi-p", kind: "project", name: "YIG", path: "D:\\sim\\yig.fms", project_id: "proj" };

const answerOf = (over: Record<string, unknown> = {}) =>
  detailAnswer({
    item: rawResult,
    detail: RAW_API_RESULT_DETAIL,
    events: [{ at: "2026-10-03T07:00:00Z", kind: "create", actor: "scanner", detail: {} }],
    linked_source: RAW_API_ITEM,
    ...over,
  });
const ready = (over: Record<string, unknown> = {}): WorkspaceItemDetailState => ({
  kind: "ready",
  answer: answerOf(over),
});

const props = (over: Partial<ResultInspectorProps> = {}): ResultInspectorProps => ({
  item,
  detail: ready(),
  readOnly: false,
  onTogglePin: vi.fn(),
  onForget: vi.fn(),
  onSelectSource: vi.fn(),
  onOpenResults: vi.fn(),
  openDisabledReason: null,
  ...over,
});
const render = (over: Partial<ResultInspectorProps> = {}) =>
  renderToStaticMarkup(<ResultInspector {...props(over)} />);
const button = (html: string, action: string) =>
  new RegExp(`<button[^>]*data-action="${action}"[^>]*>`).exec(html)?.[0] ?? "";

describe("ResultInspector overview", () => {
  it("has the sketch's parts with its own name and tabs", () => {
    const html = render();
    expect(html).toContain('aria-label="Result details"');
    expect(html).toContain('data-kind="result"');
    expect(html).toContain(">run-0003<");
    expect(html).toContain("C:\\work\\sp4.out\\run-0003.zarr");
    expect(html).toContain(">.zarr<");
    expect(html).toContain("Complete");
    expect(html).toContain("run run-3");
    expect(html).toContain('aria-label="Result sections"');
    const tabs = [...html.matchAll(/<button[^>]*role="tab"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(tabs).toEqual(["Overview", "Stages", "History"]);
  });

  it("shows the run, the source link, the data and the folder", () => {
    const html = render();
    expect(html).toMatch(/Format<\/dt><dd>zarr v2</);
    expect(html).toContain("Source");
    expect(html).toContain("200 × 50 × 1 cells");
    expect(html).toMatch(/Frames<\/dt><dd>400</);
    expect(html).toMatch(/Size<\/dt><dd>318 MB</);
    for (const quantity of ["H_demag", ">m<"]) expect(html).toContain(quantity);
    expect(html).toContain("Folder");
  });

  it("links the source and makes the link a button that selects it", () => {
    const html = render();
    const link = button(html, "select-source");
    expect(link).toContain('title="Show sp4 in the list"');
    expect(html).toContain("sp4</button>");
    expect(html).toContain("Source hash");
  });

  it("names a source that is not in the list instead of linking it", () => {
    const html = render({ detail: ready({ linked_source: undefined }) });
    expect(button(html, "select-source")).toBe("");
    expect(html).toContain("not indexed");
    expect(html).toContain("C:\\work\\sp4.py");
  });

  it("says the folder does not record its source when it has none", () => {
    const html = render({
      detail: {
        kind: "ready",
        answer: detailAnswer({ item: rawResult, detail: { kind: "result", run_id: "r" } }),
      },
    });
    expect(html).toContain("does not record what produced it");
  });

  it("reads 'unavailable' for the facts the backend did not send", () => {
    const html = render({
      detail: { kind: "ready", answer: detailAnswer({ item: rawResult, detail: { kind: "result" } }) },
    });
    expect(html).toMatch(/Grid<\/dt><dd>unavailable</);
    expect(html).toMatch(/Frames<\/dt><dd>unavailable</);
    expect(html).toMatch(/Quantities<\/dt><dd>unavailable</);
    expect(html).toMatch(/Run<\/dt><dd>unavailable</);
    expect(html).toMatch(/Size<\/dt><dd>318 MB</);
  });

  it("shows what the list knows, and why the rest is missing, without a backend detail", () => {
    const idle = render({ detail: { kind: "idle" } });
    expect(idle).toMatch(/Size<\/dt><dd>318 MB</);
    expect(idle).toContain("read by a Fullmag backend");
    expect(render({ detail: { kind: "loading" } })).toContain("Reading the folder");
    expect(render({ detail: { kind: "error", message: "502" } })).toContain("Could not read the folder: 502");
  });

  it("explains a folder the backend could not read", () => {
    const html = render({
      detail: { kind: "ready", answer: detailAnswer({ item: rawResult, detail: { kind: "result", read_error: "zarr metadata is missing" } }) },
    });
    expect(html).toContain('data-banner="unreadable"');
    expect(html).toContain("zarr metadata is missing");
  });
});

describe("ResultInspector banner states", () => {
  it("is quiet for a completed folder", () => {
    expect(render()).not.toContain("data-banner");
  });

  it("warns of a missing folder and offers removal", () => {
    const html = render({ item: { ...item, status: "missing" } });
    expect(html).toContain('data-banner="missing"');
    expect(html).toContain("Remove from recent");
    expect(button(html, "open-results-viewer")).toContain("The folder is missing.");
  });

  it.each([
    ["running", "running"],
    ["failed", "failed"],
    ["partial", "incomplete"],
  ])("describes a %s run", (status, id) => {
    const html = render({
      detail: ready({ detail: { ...RAW_API_RESULT_DETAIL, status } }),
    });
    expect(html).toContain(`data-banner="${id}"`);
  });
});

describe("ResultInspector tabs", () => {
  it("lists the stages with steps and time, 'unavailable' where not sent", () => {
    const html = render({ initialTab: "stages" });
    expect(html).toContain("relax (relaxation)");
    expect(html).toContain("4,210");
    expect(html).toContain("pulse");
    expect(html).toContain("1.00 ns");
    expect(html).toContain("unavailable");
    expect(html).toContain('role="tabpanel"');
  });

  it("says when a folder records no stages, and why without a detail", () => {
    const none = render({
      detail: { kind: "ready", answer: detailAnswer({ item: rawResult, detail: { kind: "result" } }) },
      initialTab: "stages",
    });
    expect(none).toContain("records no stages");
    expect(render({ detail: { kind: "idle" }, initialTab: "stages" })).toContain("read by a Fullmag backend");
  });

  it("lists the folder's events on History", () => {
    const html = render({ initialTab: "history" });
    expect(html).toContain("Created");
    expect(html).toContain("folder scan");
    expect(render({ detail: ready({ events: [] }), initialTab: "history" })).toContain("Nothing has been recorded");
  });
});

describe("the results viewer", () => {
  const project = parsedItem(rawProject);

  it("opens the source project's Results module when the folder is linked to a project", () => {
    const html = render({ detail: ready({ linked_source: rawProject }) });
    const open = button(html, "open-results-viewer");
    expect(open).not.toContain(' disabled=""');
    expect(open).not.toContain("title=");
    expect(viewerRoute(item, answerOf({ linked_source: rawProject }))).toEqual({ project, reason: null });
  });

  it("is disabled, with the reason, when the source is a script", () => {
    const html = render();
    const open = button(html, "open-results-viewer");
    expect(open).toContain(' disabled=""');
    expect(open).toContain(`title="${RESULTS_VIEWER_SOURCE_IS_SCRIPT}"`);
  });

  it("is disabled, with the reason, when no source is known", () => {
    const html = render({ detail: ready({ linked_source: undefined }) });
    expect(button(html, "open-results-viewer")).toContain(`title="${RESULTS_VIEWER_NEEDS_SOURCE}"`);
    expect(viewerRoute(item, undefined).reason).toBe(RESULTS_VIEWER_NEEDS_SOURCE);
  });

  it("is disabled when the source project is missing, the folder is missing, or opening is refused", () => {
    expect(viewerRoute(item, answerOf({ linked_source: { ...rawProject, status: "missing" } })).reason).toBe(
      "The source project is missing.",
    );
    expect(viewerRoute({ status: "missing" }, answerOf({ linked_source: rawProject })).reason).toBe(
      "The folder is missing.",
    );
    const html = render({
      detail: ready({ linked_source: rawProject }),
      openDisabledReason: "Fullmag could not confirm that no session is running.",
    });
    expect(button(html, "open-results-viewer")).toContain("could not confirm");
  });

  it("offers the source in the dropdown only when there is one", () => {
    expect(render()).toContain('aria-label="More open options"');
    expect(render({ detail: ready({ linked_source: undefined }) })).not.toContain(
      'aria-label="More open options"',
    );
  });
});

describe("ResultInspector header", () => {
  it("labels pin by its state and disables it on a read-only database", () => {
    expect(render({ item: { ...item, pinned: true } })).toContain('aria-label="Unpin run-0003"');
    expect(render({ readOnly: true })).toMatch(/<button[^>]*aria-label="Pin run-0003"[^>]*disabled=""/);
  });

  it("previews the folder through the thumbnail URL", () => {
    const html = render({ thumbnailUrl: (id) => `/thumb/${id}/thumbnail` });
    expect(html).toContain('src="/thumb/res-3/thumbnail?v=2026-10-03T07%3A00%3A00.000Z"');
    expect(html).toContain('aria-label="Preview of run-0003"');
  });

  it("labels a source project's preview as such and says what it is in the folder facts", () => {
    const linked = { ...item, thumbnailOrigin: "source_project" as const };
    const html = render({ item: linked, thumbnailUrl: (id) => `/t/${id}` });
    expect(html).toContain("Last result · project preview");
    expect(html).toContain("stored preview of the source project, not a render of this result");
    const none = render({ item: { ...item, hasThumbnail: false }, thumbnailUrl: (id) => `/t/${id}` });
    expect(none).toContain("none: the folder holds no image and its source project has no stored preview");
    expect(none).not.toContain("project preview");
  });

  it("offers the folder as a zip, and says why not without a backend or for a missing folder", () => {
    const archiveUrl = (id: string) => `/a/${id}`;
    expect(downloadReason(item, archiveUrl)).toBeNull();
    expect(downloadReason(item, undefined)).toBe(RESULTS_DOWNLOAD_NO_BACKEND);
    expect(downloadReason({ status: "missing" }, archiveUrl)).toBe(RESULTS_DOWNLOAD_FOLDER_MISSING);
  });

  it("has a placeholder, not a broken image, without a thumbnail", () => {
    const html = render({ item: { ...item, hasThumbnail: false }, thumbnailUrl: (id) => `/t/${id}` });
    expect(html).not.toContain("<img");
  });
});

describe("resultFacts", () => {
  const detail = (raw: Record<string, unknown>): ResultDetail => {
    const parsed = parseApiItemDetail({ kind: "result", ...raw });
    if (parsed?.kind !== "result") throw new Error("not a result");
    return parsed;
  };

  it("lists no run or data rows without a detail, only the folder's own", () => {
    const [run, data, where] = resultFacts(apiItem({ id: "x", kind: "result", sizeBytes: 5 }), undefined);
    expect(run).toEqual([]);
    expect(data.map((r) => r.label)).toEqual(["Size"]);
    expect(where.map((r) => r.label)).toEqual(["Preview", "First seen"]);
  });

  it("prefers the detail's total size over the row's", () => {
    const [, data] = resultFacts(apiItem({ id: "x", kind: "result", sizeBytes: 5 }), detail({ total_bytes: 2000 }));
    expect(data.find((r) => r.label === "Size")?.value).toBe("2 kB");
  });
});
