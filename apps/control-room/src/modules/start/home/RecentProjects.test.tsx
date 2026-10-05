import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  findElement,
  findElements,
  installSimulationPreparationTestDom,
} from "../../../kernel/layout/simulationPreparationTestDom.test-support";
import { apiItem, entry } from "../model/__fixtures__/workspaceApi";
import { script } from "../model/__fixtures__/workspaceScripts";
import { startScreenStore } from "../model/startScreenState";
import { startSettings } from "../model/startSettings";
import type { RecentIndexController } from "../model/useRecentIndex";
import type {
  WorkspaceResultsView,
  WorkspaceScriptsView,
} from "../model/workspaceSource";

import { RecentProjects, UNAVAILABLE_NOTE, type RecentProjectsProps } from "./RecentProjects";

const recent = (state: RecentIndexController["state"]): RecentIndexController => ({
  state,
  rebuilding: false,
  announcement: "",
  refresh: vi.fn(async () => undefined),
  rebuild: vi.fn(async () => undefined),
  pin: vi.fn(async () => undefined),
  forget: vi.fn(async () => undefined),
});

const readyRecent = recent({
  kind: "ready",
  index: {
    formatVersion: 1,
    generatedAt: "t",
    entries: [entry({ projectId: "p1", name: "YIG waveguide", pinned: true })],
  },
});

const scripts = (state: WorkspaceScriptsView["state"]): WorkspaceScriptsView => ({
  state,
  readOnly: false,
  announcement: "",
  refresh: vi.fn(async () => undefined),
  pin: vi.fn(async () => null),
  forget: vi.fn(async () => null),
  open: vi.fn(async () => null),
  reveal: vi.fn(async () => null),
  pickAndOpen: vi.fn(async () => ({ item: null, failure: null })),
  saveNew: vi.fn(async () => ({ kind: "cancelled" as const })),
  readText: vi.fn(async () => ({ text: "" })),
  desktopIdOf: () => null,
});

const readyScripts = scripts({
  kind: "ready",
  items: [script({ id: "s1", name: "sp4", path: "C:\\work\\sp4.py" })],
  outcome: { state: "ready" },
  skipped: 0,
});

const results = (state: WorkspaceResultsView["state"]): WorkspaceResultsView => ({
  state,
  pin: vi.fn(async () => null),
  forget: vi.fn(async () => null),
});

const readyResults = results({
  kind: "ready",
  items: [
    apiItem({
      id: "r1",
      kind: "result",
      name: "run-0003",
      path: "C:\\work\\out\\run-0003.zarr",
      sizeBytes: 318_000_000,
      meta: { status: "completed", source_name: "sp4" },
    }),
  ],
});

const props = (over: Partial<RecentProjectsProps> = {}): RecentProjectsProps => ({
  recent: readyRecent,
  scripts: readyScripts,
  results: readyResults,
  onAddPath: vi.fn(async () => null),
  browseDisabledReason: null,
  onBrowse: vi.fn(),
  onOpenScript: vi.fn(),
  canOpenScript: false,
  onOpen: vi.fn(),
  ...over,
});
/** Server render: the stores answer with their server snapshots (nothing selected, defaults). */
const render = (over: Partial<RecentProjectsProps> = {}) =>
  renderToStaticMarkup(<RecentProjects {...props(over)} />);

let restoreDom: (() => void) | null = null;
let mounted: Root[] = [];

/** Client render: the stores answer with their live snapshots (a selection, a remembered kind). */
async function renderClient(over: Partial<RecentProjectsProps> = {}): Promise<string> {
  const dom = installSimulationPreparationTestDom();
  restoreDom = dom.restore;
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  mounted.push(root);
  await act(async () => root.render(<RecentProjects {...props(over)} />));
  return container.innerHTML;
}

beforeEach(() => {
  startScreenStore.resetForTests();
  startSettings.resetForTests();
});
afterEach(async () => {
  await act(async () => mounted.forEach((root) => root.unmount()));
  mounted = [];
  restoreDom?.();
  restoreDom = null;
  startScreenStore.resetForTests();
  startSettings.resetForTests();
});

describe("RecentProjects kinds", () => {
  it("offers All, Projects, Scripts and Results when the backend lists result folders", () => {
    const html = render();
    expect(html).toContain('aria-label="Show projects, scripts, results or all"');
    for (const label of ["All", "Projects", "Scripts", "Results"]) {
      expect(html).toMatch(new RegExp(`<button[^>]*role="radio"[^>]*>${label}<|>${label}</button>`));
    }
  });

  it("does not offer Results where nothing serves them", () => {
    const html = render({ results: results({ kind: "unavailable" }) });
    expect(html).toContain('aria-label="Show projects, scripts or both"');
    expect(html).not.toContain(">Results<");
    expect(html).not.toContain("run-0003");
  });

  it("merges all three kinds in one list, each row with its own glyph and badge", () => {
    const html = render();
    expect(html.match(/role="option"/g)).toHaveLength(3);
    expect(html).toContain('data-kind="script"');
    expect(html).toContain('data-kind="result"');
    expect(html).toContain(">.zarr<");
    expect(html).toContain(">.py<");
    expect(html).toContain("YIG waveguide");
    expect(html).toContain("run-0003");
    expect(html).toContain("from sp4");
    expect(html).toContain("318 MB");
    expect(html).toContain("Complete");
    expect(html).toContain("3 of 3 items");
  });

  it("shows only result folders for the Results kind, with their own title and filter name", async () => {
    startSettings.update({ recentKind: "result" });
    const html = await renderClient();
    expect(html.match(/role="option"/g)).toHaveLength(1);
    expect(html).toContain("Result folders");
    expect(html).toContain('aria-label="Filter result folders"');
    expect(html).toContain('aria-label="Filter results"');
    expect(html).toContain("1 of 1 result folders");
    // No solver chips for a kind without a solver.
    expect(html).not.toContain(">FDM<");
  });

  it("falls back to All when Results was remembered but is no longer served", async () => {
    startSettings.update({ recentKind: "result" });
    const html = await renderClient({ results: results({ kind: "unavailable" }) });
    expect(html).toContain("Recent work");
  });

  it("marks the selected result row and describes the list to assistive technology", async () => {
    startScreenStore.setSelectedResult("r1");
    const html = await renderClient();
    expect(html).toMatch(/id="fm-start-result-r1"[^>]*aria-selected="true"|aria-selected="true"[^>]*id="fm-start-result-r1"/);
    expect(html).toContain('aria-activedescendant="fm-start-result-r1"');
    expect(html).toContain('role="listbox"');
  });

  it("selects a script by its string id", async () => {
    startScreenStore.setSelectedScript("s1");
    const html = await renderClient();
    expect(html).toContain('aria-activedescendant="fm-start-script-s1"');
  });
});

describe("RecentProjects empty and unavailable states", () => {
  it("says the index needs the desktop app or a backend, with neither", () => {
    const html = render({
      recent: recent({ kind: "unavailable" }),
      scripts: scripts({ kind: "unavailable", reason: "no desktop" }),
      results: results({ kind: "unavailable" }),
      onAddPath: null,
    });
    expect(html).toContain(UNAVAILABLE_NOTE);
    expect(UNAVAILABLE_NOTE).toContain("desktop app");
    expect(UNAVAILABLE_NOTE).toContain("backend");
    expect(html).not.toContain("Add file by path");
  });

  it("shows skeleton rows while the first answer is pending", () => {
    const html = render({
      recent: recent({ kind: "loading" }),
      scripts: scripts({ kind: "loading" }),
      results: results({ kind: "loading" }),
    });
    expect(html).toContain('aria-busy="true"');
  });

  it("tells an empty Results list how it fills", async () => {
    startSettings.update({ recentKind: "result" });
    const html = await renderClient({ results: results({ kind: "ready", items: [] }) });
    expect(html).toContain("Nothing here yet");
  });
});

describe("Add file by path", () => {
  it("is offered, with its own name, only where a backend can take the path", () => {
    const html = render();
    expect(html).toContain("Add file by path…");
    expect(html).toContain('data-action="add-by-path"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("fm-start-addpath");
    expect(render({ onAddPath: null })).not.toContain("Add file by path");
  });
});

describe("Add file by path form", () => {
  it("opens a labelled form from the footer button and closes it again", async () => {
    const dom = installSimulationPreparationTestDom();
    restoreDom = dom.restore;
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    mounted.push(root);
    await act(async () => root.render(<RecentProjects {...props()} />));
    const toggle = findElement(container, (e) => e.getAttribute("data-action") === "add-by-path", "add button");
    expect(findElements(container, (e) => e.tagName === "FORM")).toHaveLength(0);

    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.innerHTML).toContain("Absolute path of a project (.fms), script (.py) or result folder (.zarr)");
    const add = findElement(container, (e) => e.tagName === "BUTTON" && e.textContent === "Add", "Add button");
    expect(add.hasAttribute("disabled")).toBe(true);

    const cancel = findElement(container, (e) => e.tagName === "BUTTON" && e.textContent === "Cancel", "Cancel");
    await act(async () => cancel.click());
    expect(findElements(container, (e) => e.tagName === "FORM")).toHaveLength(0);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });
});
