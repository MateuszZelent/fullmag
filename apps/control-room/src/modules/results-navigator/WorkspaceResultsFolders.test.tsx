import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { KernelApi } from "@/kernel/types";
import type { ApiWorkspaceItem } from "@/kernel/api/workspaceItems";
import type {
  WorkspaceApiListState,
  WorkspaceItemsResourceController,
} from "@/kernel/resources/workspaceItemsResource";
import {
  findElement,
  installSimulationPreparationTestDom,
  TestEvent,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

const fixtures = vi.hoisted(() => ({
  controller: null as unknown as WorkspaceItemsResourceController,
  createCommandContext: vi.fn(() => ({ source: "explorer" })),
}));

vi.mock("@/kernel/resources/workspaceItemsResource", () => ({
  useWorkspaceItemsResource: () => fixtures.controller,
}));
vi.mock("@/kernel/commands/commandContext", () => ({
  createCommandContext: fixtures.createCommandContext,
}));

import { WorkspaceResultsFolders } from "./WorkspaceResultsFolders";

const resultFolder: ApiWorkspaceItem = {
  id: "result-1",
  kind: "result",
  path: "/user-data/results/run-1",
  name: "run-1",
  firstSeenAt: "2026-10-29T08:00:00Z",
  lastUsedAt: "2026-10-29T09:00:00Z",
  useCount: 1,
  pinned: false,
  status: "ready",
  meta: {},
  hasThumbnail: false,
};

const scriptItem: ApiWorkspaceItem = {
  ...resultFolder,
  id: "script-1",
  kind: "script",
  name: "input.py",
  path: "/user-data/projects/input.py",
};

const workspace = (state: WorkspaceApiListState): WorkspaceItemsResourceController => ({
  state,
  refresh: vi.fn(),
  invalidate: vi.fn(),
});

const ready = (items: readonly ApiWorkspaceItem[] = [resultFolder]): WorkspaceApiListState => ({
  kind: "ready",
  list: { items, outcome: { state: "ready" }, skipped: 0 },
});

const kernel = (execute: ReturnType<typeof vi.fn>): KernelApi => ({
  commands: {
    execute,
    getSessionScopeKey: () => null,
  },
} as unknown as KernelApi);

describe("WorkspaceResultsFolders", () => {
  it("lists registered result folders separately from non-result workspace items", () => {
    fixtures.controller = workspace(ready([resultFolder, scriptItem]));
    const html = renderToStaticMarkup(
      <WorkspaceResultsFolders kernel={kernel(vi.fn())} />,
    );

    expect(html).toContain("Workspace result folders");
    expect(html).toContain("Showing up to 500 registered result folders.");
    expect(html).toContain("run-1");
    expect(html).toContain("/user-data/results/run-1");
    expect(html).toContain(">Open folder</button>");
    expect(html).toContain('aria-label="Open run-1"');
    expect(html).not.toContain("input.py");
    expect(html).toContain('aria-label="Workspace result folders"');
  });

  it.each([
    ["loading", workspace({ kind: "loading" }), "Loading workspace result folders…"],
    ["error", workspace({ kind: "error", message: "database is locked" }), "Could not load workspace result folders: database is locked"],
    ["unavailable", workspace({ kind: "unavailable", reason: "route missing" }), "Workspace result folders unavailable: route missing"],
    ["empty", workspace(ready([])), "No registered workspace result folders."],
  ] as const)("renders an explicit %s state", (_name, controller, message) => {
    fixtures.controller = controller;
    const html = renderToStaticMarkup(
      <WorkspaceResultsFolders kernel={kernel(vi.fn())} />,
    );
    expect(html).toContain(message);
  });

  it("routes opening through the workspace command and surfaces dirty/pending guard failures", async () => {
    const execute = vi.fn().mockResolvedValue({
      status: "failed",
      message: "Apply or cancel the current object edit before opening saved results.",
    });
    const testKernel = kernel(execute);
    fixtures.controller = workspace(ready());
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);

    try {
      await act(async () => {
        root.render(<WorkspaceResultsFolders kernel={testKernel} />);
      });
      const open = findElement(
        container,
        (element) => element.getAttribute("aria-label") === "Open run-1",
        "open result folder button",
      );

      await act(async () => {
        open.dispatchEvent(new TestEvent("click", { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(execute).toHaveBeenCalledWith(
        "workspace.open-results-folder",
        expect.anything(),
        { itemId: "result-1", name: "run-1" },
      );
      expect(fixtures.createCommandContext).toHaveBeenCalledWith(
        "explorer",
        testKernel,
        { sourceDetail: "results-saved-workspace-folders", feedback: "local" },
      );
      expect(container.textContent).toContain("Apply or cancel the current object edit");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("marks a registered folder with an unavailable source explicitly", () => {
    fixtures.controller = workspace(ready([{ ...resultFolder, status: "missing" }]));
    const html = renderToStaticMarkup(
      <WorkspaceResultsFolders kernel={kernel(vi.fn())} />,
    );

    expect(html).toContain("run-1");
    expect(html).toContain("Source unavailable");
    expect(html).toContain('role="alert"');
    expect(html).toContain('disabled=""');
  });

  it("keeps long folder actions compact while exposing the full name", () => {
    const name = "results-browser-fem-run-with-a-very-long-folder-name";
    fixtures.controller = workspace(ready([{ ...resultFolder, name }]));
    const html = renderToStaticMarkup(
      <WorkspaceResultsFolders kernel={kernel(vi.fn())} />,
    );

    expect(html).toContain(`aria-label="Open ${name}"`);
    expect(html).toContain(`title="${name}"`);
    expect(html).toContain(">Open folder</button>");
    expect(html).not.toContain(`>Open ${name}</button>`);
  });
});
