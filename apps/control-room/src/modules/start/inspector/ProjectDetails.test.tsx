import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  RAW_API_ITEM,
  RAW_API_PROJECT_DETAIL,
  detailAnswer,
  entry,
} from "../model/__fixtures__/workspaceApi";
import type { ContinueSession } from "../model/types";
import type { WorkspaceItemDetailState } from "../model/useWorkspaceItems";

import { ProjectDetails, type ProjectDetailsProps } from "./ProjectDetails";
import { RESULTS_DOWNLOAD_NO_BACKEND, RESULTS_DOWNLOAD_NO_FOLDER } from "../model/downloadUrl";

const rawProject = {
  ...RAW_API_ITEM,
  id: "wi-p",
  kind: "project",
  name: "YIG",
  path: "D:\\sim\\yig.fms",
  project_id: "proj",
};
const rawResult = {
  id: "res-1",
  kind: "result",
  path: "D:\\sim\\out\\run-0002.zarr",
  name: "run-0002",
  size_bytes: 318000000,
  first_seen_at: "2026-10-02T06:00:00Z",
  meta: { run_id: "run-2", status: "completed", duration_seconds: 412 },
};

const ready = (
  detail: Record<string, unknown> = RAW_API_PROJECT_DETAIL,
  linked: unknown[] = [rawResult],
): WorkspaceItemDetailState => ({
  kind: "ready",
  answer: detailAnswer({ item: rawProject, detail, linked_results: linked }),
});

const session: ContinueSession = {
  projectId: "proj",
  runId: "r",
  checkpointAt: "2026-10-03T10:00:00Z",
  device: "RTX 4090",
  resumable: true,
  progress: { fraction: 0.64, simTimeS: 3.2e-9, simTimeTotalS: 5e-9, etaSeconds: 720 },
};

const base = entry({
  projectId: "proj",
  workspaceId: "wi-p",
  name: "YIG waveguide",
  path: "D:\\sim\\yig.fms",
  revision: 42,
  manifestSchemaVersion: "1.2",
  tags: ["magnonics"],
  pinned: true,
  thumbnail: "/t/wi-p?v=1",
});

const props = (over: Partial<ProjectDetailsProps> = {}): ProjectDetailsProps => ({
  entry: base,
  openDisabledReason: null,
  onOpen: vi.fn(),
  onTogglePin: vi.fn(),
  onForget: vi.fn(),
  ...over,
});
const render = (over: Partial<ProjectDetailsProps> = {}) =>
  renderToStaticMarkup(<ProjectDetails {...props(over)} />);
const button = (html: string, action: string) =>
  new RegExp(`<button[^>]*data-action="${action}"[^>]*>`).exec(html)?.[0] ?? "";

describe("ProjectDetails layout", () => {
  it("has the sketch's parts: preview, title with star and menu, path, chips, tabs, action bar", () => {
    const html = render({ detail: ready() });
    expect(html).toContain('aria-label="Project details"');
    expect(html).toContain('aria-label="Last result of YIG waveguide"');
    expect(html).toContain('src="/t/wi-p?v=1"');
    expect(html).toContain(">YIG waveguide<");
    expect(html).toContain('aria-label="Unpin YIG waveguide"');
    expect(html).toContain('aria-label="More actions"');
    expect(html).toContain('aria-label="Copy path"');
    expect(html).toContain("D:\\sim\\yig.fms");
    for (const chip of ["FDM", "Ready", "rev 42", "schema 1.2", "#magnonics"]) expect(html).toContain(chip);
    const tabs = [...html.matchAll(/<button[^>]*role="tab"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(tabs).toEqual(["Overview", "Authors", "History", "Runs"]);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Project sections"');
    expect(html).toContain('aria-label="Reveal in file manager"');
  });

  it("names the primary action by what opening will do", () => {
    expect(button(render(), "open-project")).toBeTruthy();
    expect(render()).toContain("Open project");
    expect(render({ entry: { ...base, status: "migrate" } })).toContain("Migrate &amp; open");
    expect(render({ entry: { ...base, status: "running" }, session })).toContain("Open running project");
  });

  it("disables opening for a missing file or a refused session, with the reason", () => {
    expect(button(render({ entry: { ...base, status: "missing" } }), "open-project")).toContain(
      'title="The file is missing."',
    );
    const refused = render({ openDisabledReason: "Fullmag could not confirm that no session is running." });
    expect(button(refused, "open-project")).toContain(' disabled=""');
    expect(button(refused, "open-project")).toContain("could not confirm");
  });

  it("offers the results viewer in the dropdown only where it can be opened", () => {
    expect(render()).not.toContain('aria-label="More open options"');
    expect(render({ onOpenResults: vi.fn() })).toContain('aria-label="More open options"');
  });
});

describe("ProjectDetails banner states", () => {
  it("is quiet for a ready project", () => {
    expect(render({ detail: ready() })).not.toContain("data-banner");
  });

  it("describes a run in progress, a paused run, a missing file, a failure, a migration and read-only", () => {
    expect(render({ entry: { ...base, status: "running" }, session })).toContain('data-banner="running"');
    expect(render({ session })).toContain('data-banner="paused"');
    expect(render({ entry: { ...base, status: "missing" } })).toContain('data-banner="missing"');
    expect(render({ entry: { ...base, status: "failed", lastError: "NaN in the field" } })).toContain(
      "NaN in the field",
    );
    expect(render({ entry: { ...base, status: "migrate" } })).toContain('data-banner="migrate"');
    expect(render({ entry: { ...base, mode: "read_only", modeReason: "Shipped benchmark." } })).toContain(
      'data-banner="readonly"',
    );
  });

  it("takes the migration steps, read-only reason and the failure from the read file", () => {
    const migrate = render({
      entry: { ...base, status: "migrate" },
      detail: ready({ ...RAW_API_PROJECT_DETAIL, warnings: ["terms to interactions", "mesh quality added"] }),
    });
    expect(migrate).toContain("terms to interactions · mesh quality added");

    const readOnly = render({
      detail: ready({ ...RAW_API_PROJECT_DETAIL, can_write: false, warnings: ["opened from a read-only share"] }),
    });
    expect(readOnly).toContain('data-banner="readonly"');
    expect(readOnly).toContain("opened from a read-only share");

    const failed = render({
      entry: { ...base, status: "failed" },
      detail: ready({
        ...RAW_API_PROJECT_DETAIL,
        runs: [{ run_id: "r9", started_at: "2026-10-03T09:00:00Z", status: "failed", error: "Exchange length below the cell size" }],
      }),
    });
    expect(failed).toContain("Exchange length below the cell size");
  });

  it("explains a file the backend could not read and keeps the list's facts", () => {
    const html = render({ detail: ready({ kind: "project", read_error: "archive is truncated" }) });
    expect(html).toContain('data-banner="unreadable"');
    expect(html).toContain("archive is truncated");
    expect(html).toContain("rev 42");
  });
});

describe("ProjectDetails Overview", () => {
  it("lists the model, execution and outputs the backend read", () => {
    const html = render({ detail: ready() });
    for (const text of ["Model", "512 x 512 x 8", "YIG", "140 kA/m", "Execution", "RK45", "Outputs", "400"]) {
      expect(html).toContain(text);
    }
  });

  it("reads 'unavailable' for a field the backend did not send, when it sent a summary", () => {
    const html = render({ detail: ready() });
    expect(html).toMatch(/Periodicity<\/dt><dd>unavailable</);
    expect(html).toMatch(/Excitation<\/dt><dd>unavailable</);
  });

  it("leaves absent fields out for the desktop's own summary", () => {
    const html = render({ entry: { ...base, summary: { discretisation: "64 x 64 x 1" } } });
    expect(html).toContain("64 x 64 x 1");
    expect(html).not.toContain("unavailable");
    expect(html).not.toContain("Periodicity");
  });

  it("says no summary was recorded, and shows a wait while the backend reads", () => {
    expect(render()).toContain("No model summary was recorded");
    expect(render({ detail: { kind: "loading" } })).toContain("Reading the project");
  });
});

describe("ProjectDetails Runs tab", () => {
  it("lists the project's runs and its linked result folders as a Run, Started, Duration, Output table", () => {
    const html = render({ detail: ready(), initialTab: "runs", onSelectResult: vi.fn() });
    expect([...html.matchAll(/<th scope="col">([^<]*)</g)].map((m) => m[1])).toEqual([
      "Run",
      "Started",
      "Duration",
      "Output",
    ]);
    expect(html).toContain("run-7");
    expect(html).toContain("49 min");
    expect(html).toMatch(/1[.,]42 GB/);
    expect(html).toContain("run-0002");
    expect(html).toContain("318 MB");
    expect(html).toContain('title="Show run-0002"');
  });

  it("shows a failed run's message and a dash where nothing was written", () => {
    const html = render({
      detail: ready({
        ...RAW_API_PROJECT_DETAIL,
        runs: [{ run_id: "run-6", started_at: "2026-10-03T09:00:00Z", status: "failed", error: "mesh did not converge" }],
      }, []),
      initialTab: "runs",
    });
    expect(html).toContain("Failed: mesh did not converge");
    expect(html).toContain("—");
    expect(html).toContain("fm-start-pill--failed");
  });

  it("lists a folder once when it is the output of a listed run", () => {
    const html = render({
      detail: ready(RAW_API_PROJECT_DETAIL, [{ ...rawResult, name: "same-run", meta: { run_id: "run-7" } }]),
      initialTab: "runs",
    });
    expect(html).not.toContain("same-run");
  });

  it("offers Open results viewer beside a download of the newest linked folder as a zip", () => {
    const html = render({
      detail: ready(),
      initialTab: "runs",
      onOpenResults: vi.fn(),
      archiveUrl: (id) => `http://host/v2/workspace/items/${id}/archive`,
    });
    const open = button(html, "open-results-viewer");
    expect(open).not.toContain(' disabled=""');
    const download = button(html, "download-results");
    expect(download).not.toContain(' disabled=""');
    expect(download).toContain('title="Download the newest result folder as a zip"');
    expect(html).toContain('aria-label="Download results"');
  });

  it("says why the download is off: no backend, or no linked folder", () => {
    const withoutBackend = render({ detail: ready(), initialTab: "runs", onOpenResults: vi.fn() });
    const off = button(withoutBackend, "download-results");
    expect(off).toContain(' disabled=""');
    expect(off).toContain(`title="${RESULTS_DOWNLOAD_NO_BACKEND}"`);
    const none = render({
      detail: ready(RAW_API_PROJECT_DETAIL, []),
      initialTab: "runs",
      onOpenResults: vi.fn(),
      archiveUrl: (id) => `http://host/archive/${id}`,
    });
    expect(button(none, "download-results")).toContain(`title="${RESULTS_DOWNLOAD_NO_FOLDER}"`);
  });

  it("disables the viewer, with the reason, when the project cannot be opened", () => {
    const html = render({
      detail: ready(),
      initialTab: "runs",
      onOpenResults: vi.fn(),
      openDisabledReason: "Fullmag could not confirm that no session is running.",
    });
    expect(button(html, "open-results-viewer")).toContain(' disabled=""');
    expect(button(html, "open-results-viewer")).toContain("could not confirm");
  });

  it("offers no viewer button without a route to it", () => {
    expect(render({ detail: ready(), initialTab: "runs" })).not.toContain("open-results-viewer");
  });

  it("says a project with no runs predates tracking or has none yet", () => {
    const html = render({
      detail: ready({ kind: "project", authors: [], history: [], runs: [] }, []),
      initialTab: "runs",
    });
    expect(html).toContain("No runs are recorded");
  });
});

describe("ProjectDetails Authors and History tabs", () => {
  it("lists the authors, their role, and the citation", () => {
    const html = render({ detail: ready(), initialTab: "authors" });
    expect(html).toContain("Mateusz Zelent");
    expect(html).toContain("creator");
    expect(html).toContain("RPTU");
    expect(html).toContain("Cite this project");
    expect(html).toContain("10.1234/x");
  });

  it("lists the history with revisions and what changed", () => {
    const html = render({ detail: ready(), initialTab: "history" });
    expect(html).toContain("fm-start-timeline");
    expect(html).toContain("rev 42");
    expect(html).toContain("Refined the mesh");
  });

  it("waits while the backend reads, and without a detail asks the desktop", () => {
    expect(render({ detail: { kind: "loading" }, initialTab: "authors" })).toContain("Reading the project");
    expect(render({ initialTab: "history" })).toContain("Reading the project");
  });

  it("falls back to asking the desktop when the backend cannot detail the project", () => {
    const html = render({ detail: { kind: "unavailable", reason: "x" }, initialTab: "runs" });
    expect(html).toContain("Reading the project");
  });
});
