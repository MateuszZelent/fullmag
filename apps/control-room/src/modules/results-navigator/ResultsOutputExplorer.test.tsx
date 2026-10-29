import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ResultsCatalog,
  ResultsEntry,
  ResultsSource,
} from "@/kernel/api/resultsBrowser";
import { ResultsBrowserUiController } from "@/kernel/results-browser/ResultsBrowserUiController";
import {
  findElement,
  findElements,
  installSimulationPreparationTestDom,
  TestElement,
  TestEvent,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

const fixtures = vi.hoisted(() => {
  const selection = {
    kind: null,
    label: null,
    nodeId: null,
    objectId: null,
    ref: null as unknown,
    moduleSource: null,
  };
  const kernel = {
    selection: {
      clear: vi.fn(),
      get: () => selection,
      set: vi.fn(),
      subscribe: () => () => undefined,
    },
    snapshotVisualizations: undefined,
    resultsBrowserUi: undefined as unknown,
  };
  const resourceCalls: Array<string | null> = [];
  const pages = new Map<string, ResultsCatalog>();
  let firstPage: ResultsCatalog | null = null;
  let sessionIdentity: {
    sessionId: string;
    sessionEpoch: string;
    requestScopeEpoch: string;
  } | null = {
    sessionId: "session-1",
    sessionEpoch: "epoch-1",
    requestScopeEpoch: "request-1",
  };

  const useResultsCatalogResource = vi.fn(
    (_source: ResultsSource, cursor: string | null) => {
      resourceCalls.push(cursor);
      const data = cursor === null ? firstPage : pages.get(cursor) ?? null;
      return {
        data,
        error: null,
        refreshError: null,
        refetch: vi.fn(),
        revision: data?.revision ?? null,
        status: data ? "ready" : "loading",
      };
    },
  );

  return {
    kernel,
    pages,
    resourceCalls,
    selection,
    get sessionIdentity() {
      return sessionIdentity;
    },
    setSessionIdentity: (identity: typeof sessionIdentity) => {
      sessionIdentity = identity;
    },
    setFirstPage: (catalog: ResultsCatalog | null) => {
      firstPage = catalog;
    },
    useResultsCatalogResource,
  };
});

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => fixtures.kernel,
}));
vi.mock("@/kernel/resources/resultsBrowserResources", () => ({
  useResultsCatalogResource: fixtures.useResultsCatalogResource,
}));
vi.mock("@/kernel/selection/useSelection", () => ({
  useSelectionSelector: (selector: (selection: unknown) => unknown) =>
    selector(fixtures.selection),
}));
vi.mock("@/kernel/visualization/returnResultsToLive", () => ({
  returnResultsToLive: vi.fn(),
}));
vi.mock("@/kernel/visualization/useSnapshotVisualization", () => ({
  useSnapshotVisualization: () => ({ activeKey: null, definitions: {} }),
}));
vi.mock("@/kernel/resources/useSessionStatus", () => ({
  useSessionResourceIdentity: () => fixtures.sessionIdentity,
}));
vi.mock("@/shared/ui/Input", async () => {
  const React = await import("react");
  return {
    Input: (props: React.ComponentProps<"input">) => {
      const { onChange, ...rest } = props;
      return React.createElement("input", { ...rest, onInput: onChange });
    },
  };
});

import { ResultsOutputExplorer } from "./ResultsOutputExplorer";

let uiController = new ResultsBrowserUiController();
fixtures.kernel.resultsBrowserUi = uiController;

const source: ResultsSource = { kind: "workspace", itemId: "1" };

function entry(
  id: string,
  path: string,
  parentId: string | null = null,
  kind: ResultsEntry["kind"] = "file",
): ResultsEntry {
  return {
    id,
    path,
    parent_id: parentId,
    name: path.split("/").at(-1) ?? path,
    kind,
    size_bytes: 1,
    array_id: kind === "zarr_array" ? id : null,
  };
}

function catalog(
  revision: string,
  runId: string,
  entries: ResultsEntry[],
  nextCursor: string | null = null,
  truncated = false,
): ResultsCatalog {
  return {
    schema: "fullmag.results-catalog.v1",
    revision,
    root_label: "Run outputs",
    run_id: runId,
    entries,
    next_cursor: nextCursor,
    total_count: entries.length,
    truncated,
  };
}

function selectedRef(
  selectedEntry: ResultsEntry,
  revision: string,
  runId: string,
  selectedSource: ResultsSource = source,
) {
  return {
    type: "result-output" as const,
    kind: "results.output.entry" as const,
    nodeId: "results:output:workspace:1:" + encodeURIComponent(selectedEntry.id),
    source: selectedSource,
    entry: selectedEntry,
    revision,
    runId,
  };
}

function findButton(container: TestElement, label: string): TestElement {
  return findElement(
    container,
    (element) => element.tagName === "BUTTON" && element.textContent === label,
    `${label} button`,
  );
}

function changeInput(input: TestElement, value: string): void {
  // The minimal test DOM does not reflect the input `type` IDL property;
  // React's change plugin uses it to classify text controls.
  (input as TestElement & { type?: string }).type = "text";
  const nativeValueSetter = Object.getOwnPropertyDescriptor(TestElement.prototype, "value")?.set;
  if (!nativeValueSetter) throw new Error("Missing native test input value setter");
  nativeValueSetter.call(input, value);
  input.dispatchEvent(new TestEvent("input", { bubbles: true }));
  input.dispatchEvent(new TestEvent("change", { bubbles: true }));
}

async function renderExplorer(
  root: ReturnType<typeof createRoot>,
  renderSource: ResultsSource = source,
): Promise<void> {
  await act(async () => {
    root.render(<ResultsOutputExplorer source={renderSource} />);
  });
}

describe("ResultsOutputExplorer revision-pinned pagination and selection", () => {
  beforeEach(() => {
    fixtures.pages.clear();
    fixtures.resourceCalls.length = 0;
    fixtures.setFirstPage(null);
    fixtures.setSessionIdentity({
      sessionId: "session-1",
      sessionEpoch: "epoch-1",
      requestScopeEpoch: "request-1",
    });
    fixtures.selection.ref = null;
    uiController = new ResultsBrowserUiController();
    fixtures.kernel.resultsBrowserUi = uiController;
    vi.clearAllMocks();
  });

  it("retains filter and collapse across a host remount for the exact source, run and session", async () => {
    const fields = entry("fields", "fields", null, "directory");
    const field = entry("field-m", "fields/m", fields.id, "zarr_array");
    fixtures.setFirstPage(catalog("revision-1", "run-1", [fields, field]));

    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const firstRoot = createRoot(container as unknown as Element);
    try {
      await renderExplorer(firstRoot);
      const search = findElement(
        container,
        (element) => element.getAttribute("aria-label") === "Search saved result outputs",
        "results search",
      );
      await act(async () => changeInput(search, "fields"));
      const fieldsRow = findElement(
        container,
        (element) => element.getAttribute("data-entry-id") === fields.id,
        "fields row",
      );
      const collapse = findElement(
        fieldsRow,
        (element) => element.getAttribute("aria-label") === "Collapse fields",
        "fields disclosure",
      );
      await act(async () => {
        collapse.dispatchEvent(new TestEvent("click", { bubbles: true }));
      });
      await act(async () => firstRoot.unmount());

      const secondRoot = createRoot(container as unknown as Element);
      await renderExplorer(secondRoot);
      const remountedSearch = findElement(
        container,
        (element) => element.getAttribute("aria-label") === "Search saved result outputs",
        "remounted results search",
      );
      const remountedFields = findElement(
        container,
        (element) => element.getAttribute("data-entry-id") === fields.id,
        "remounted fields row",
      );
      expect(remountedSearch.value).toBe("fields");
      expect(remountedFields.getAttribute("aria-expanded")).toBe("false");
      await act(async () => secondRoot.unmount());
    } finally {
      dom.restore();
    }
  });

  it("does not carry the output tree filter into a different run", async () => {
    const fields = entry("fields", "fields", null, "directory");
    fixtures.setFirstPage(catalog("revision-1", "run-1", [fields]));

    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await renderExplorer(root);
      const search = findElement(
        container,
        (element) => element.getAttribute("aria-label") === "Search saved result outputs",
        "results search",
      );
      await act(async () => changeInput(search, "fields"));
      fixtures.setFirstPage(catalog("revision-2", "run-2", [fields]));
      await renderExplorer(root);
      expect(
        findElement(
          container,
          (element) => element.getAttribute("aria-label") === "Search saved result outputs",
          "new-run results search",
        ).value,
      ).toBe("");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("keeps legacy output controls local when run or session identity is unavailable", async () => {
    const fields = entry("fields", "fields", null, "directory");
    const field = entry("field-m", "fields/m", fields.id, "zarr_array");
    fixtures.setFirstPage({
      ...catalog("revision-legacy", "run-legacy", [fields, field]),
      run_id: null,
    });
    fixtures.setSessionIdentity(null);

    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await renderExplorer(root);
      const search = findElement(
        container,
        (element) => element.getAttribute("aria-label") === "Search saved result outputs",
        "legacy results search",
      );
      await act(async () => changeInput(search, "fields"));
      expect(search.value).toBe("fields");

      const fieldsRow = findElement(
        container,
        (element) => element.getAttribute("data-entry-id") === fields.id,
        "legacy fields row",
      );
      const collapse = findElement(
        fieldsRow,
        (element) => element.getAttribute("aria-label") === "Collapse fields",
        "legacy fields disclosure",
      );
      await act(async () => {
        collapse.dispatchEvent(new TestEvent("click", { bubbles: true }));
      });
      expect(fieldsRow.getAttribute("aria-expanded")).toBe("false");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("fences the local legacy state by source, run and session without revision resets", async () => {
    const fields = entry("fields", "fields", null, "directory");
    const field = entry("field-m", "fields/m", fields.id, "zarr_array");
    fixtures.setSessionIdentity(null);
    fixtures.setFirstPage(catalog("revision-a-1", "run-a", [fields, field]));

    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const findSearch = () => findElement(
      container,
      (element) => element.getAttribute("aria-label") === "Search saved result outputs",
      "legacy scoped results search",
    );
    const findFieldsRow = () => findElement(
      container,
      (element) => element.getAttribute("data-entry-id") === fields.id,
      "legacy scoped fields row",
    );
    try {
      await renderExplorer(root);
      await act(async () => changeInput(findSearch(), "fields"));
      const fieldsRow = findFieldsRow();
      await act(async () => {
        findElement(
          fieldsRow,
          (element) => element.getAttribute("aria-label") === "Collapse fields",
          "legacy scoped fields disclosure",
        ).dispatchEvent(new TestEvent("click", { bubbles: true }));
      });

      fixtures.setFirstPage(catalog("revision-a-2", "run-a", [fields, field]));
      await renderExplorer(root);
      expect(findSearch().value).toBe("fields");
      expect(findFieldsRow().getAttribute("aria-expanded")).toBe("false");

      fixtures.setFirstPage(catalog("revision-b-1", "run-b", [fields, field]));
      await renderExplorer(root);
      expect(findSearch().value).toBe("");
      expect(findFieldsRow().getAttribute("aria-expanded")).toBe("true");

      fixtures.setFirstPage(catalog("revision-a-3", "run-a", [fields, field]));
      await renderExplorer(root);
      expect(findSearch().value).toBe("");
      expect(findFieldsRow().getAttribute("aria-expanded")).toBe("true");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("preserves tree query and collapse while dropping pages from an older revision", async () => {
    const fields = entry("fields", "fields", null, "directory");
    const field = entry("field-m", "fields/m", fields.id, "zarr_array");
    const unrelated = entry("logs", "logs/solver.txt");
    const oldPage = entry("old-page", "old/page.json");
    fixtures.setFirstPage(catalog("revision-1", "run-1", [fields, field, unrelated], "page-2", true));
    fixtures.pages.set("page-2", catalog("revision-1", "run-1", [oldPage]));

    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await renderExplorer(root);
      const search = findElement(
        container,
        (element) => element.getAttribute("aria-label") === "Search saved result outputs",
        "results search",
      );
      await act(async () => {
        changeInput(search, "fields");
      });
      expect(search.value).toBe("fields");
      expect(container.textContent).not.toContain("solver.txt");

      const fieldsRow = findElement(
        container,
        (element) => element.getAttribute("data-entry-id") === fields.id,
        "fields row",
      );
      const collapse = findElement(
        fieldsRow,
        (element) => element.getAttribute("aria-label") === "Collapse fields",
        "fields disclosure",
      );
      await act(async () => {
        collapse.dispatchEvent(new TestEvent("click", { bubbles: true }));
      });
      expect(
        findElement(
          container,
          (element) => element.getAttribute("aria-label") === "Search saved result outputs",
          "search after collapse",
        ),
      ).toBe(search);
      expect(search.value).toBe("fields");
      expect(fieldsRow.getAttribute("aria-expanded")).toBe("false");

      await act(async () => {
        findButton(container, "Next page").dispatchEvent(
          new TestEvent("click", { bubbles: true }),
        );
      });
      expect(search.value).toBe("fields");
      expect(container.textContent).toContain("4 loaded");

      const originalSearch = search;
      const revisionTwoFields = entry("fields", "fields", null, "directory");
      const revisionTwoField = entry("field-m", "fields/m", revisionTwoFields.id, "zarr_array");
      fixtures.setFirstPage(
        catalog("revision-2", "run-1", [revisionTwoFields, revisionTwoField]),
      );
      await renderExplorer(root);

      const updatedSearch = findElement(
        container,
        (element) => element.getAttribute("aria-label") === "Search saved result outputs",
        "updated results search",
      );
      expect(updatedSearch).toBe(originalSearch);
      expect(updatedSearch.value).toBe("fields");
      expect(
        findElement(
          container,
          (element) => element.getAttribute("data-entry-id") === fields.id,
          "updated fields row",
        ).getAttribute("aria-expanded"),
      ).toBe("false");
      expect(
        findElements(
          container,
          (element) => element.getAttribute("data-entry-id") === oldPage.id,
        ),
      ).toHaveLength(0);
      expect(container.textContent).toContain("2 loaded of 2 total");
      expect(fixtures.resourceCalls.slice(-2)).toEqual([null, null]);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("offers explicit same-run revision adoption using a loaded matching entry", async () => {
    const oldEntry = entry("array-m", "fields/m", null, "zarr_array");
    const currentEntry = entry("array-m", "fields/m", null, "zarr_array");
    fixtures.setFirstPage(catalog("revision-2", "run-1", [currentEntry]));
    fixtures.selection.ref = selectedRef(oldEntry, "revision-1", "run-1");

    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await renderExplorer(root);
      expect(container.textContent).toContain("pinned to revision revision-1");
      const update = findButton(container, "Update selected output");

      await act(async () => {
        update.dispatchEvent(new TestEvent("click", { bubbles: true }));
      });

      const patch = fixtures.kernel.selection.set.mock.calls[0]?.[0] as {
        ref?: { revision?: string; entry?: ResultsEntry };
      };
      expect(patch.ref?.revision).toBe("revision-2");
      expect(patch.ref?.entry).toEqual(currentEntry);
      expect(fixtures.kernel.selection.clear).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("keeps an opaque selected identity when the incomplete catalog has not loaded its page", async () => {
    const oldEntry = entry("array-m", "fields/m", null, "zarr_array");
    fixtures.setFirstPage(catalog("revision-2", "run-1", [], "page-2", true));
    fixtures.selection.ref = selectedRef(oldEntry, "revision-1", "run-1");

    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await renderExplorer(root);
      expect(container.textContent).toContain("may be on a page that has not been loaded yet");
      await act(async () => {
        findButton(container, "Update selected output").dispatchEvent(
          new TestEvent("click", { bubbles: true }),
        );
      });
      const patch = fixtures.kernel.selection.set.mock.calls[0]?.[0] as {
        ref?: { revision?: string; entry?: ResultsEntry };
      };
      expect(patch.ref?.revision).toBe("revision-2");
      expect(patch.ref?.entry).toEqual(oldEntry);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("does not rebind a selected old-run output by path", async () => {
    const oldEntry = entry("array-m", "fields/m", null, "zarr_array");
    const currentEntry = entry("array-m", "fields/m", null, "zarr_array");
    fixtures.setFirstPage(catalog("revision-2", "run-2", [currentEntry]));
    fixtures.selection.ref = selectedRef(oldEntry, "revision-1", "run-1");

    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await renderExplorer(root);
      expect(container.textContent).toContain("It was not rebound by path.");
      expect(
        findElements(
          container,
          (element) => element.tagName === "BUTTON" && element.textContent === "Update selected output",
        ),
      ).toHaveLength(0);
      expect(fixtures.kernel.selection.set).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("offers clearing when a complete new revision removed the selected output", async () => {
    const oldEntry = entry("array-m", "fields/m", null, "zarr_array");
    fixtures.setFirstPage(catalog("revision-2", "run-1", []));
    fixtures.selection.ref = selectedRef(oldEntry, "revision-1", "run-1");

    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await renderExplorer(root);
      expect(container.textContent).toContain("not present in the complete catalog");
      expect(() => findButton(container, "Update selected output")).toThrow();
      await act(async () => {
        findButton(container, "Clear selected output").dispatchEvent(
          new TestEvent("click", { bubbles: true }),
        );
      });
      expect(fixtures.kernel.selection.clear).toHaveBeenCalledWith("results-navigator");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
