import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  findElement,
  installSimulationPreparationTestDom,
  TestElement,
  TestEvent,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type {
  ResultsCatalog,
  ResultsEntry,
} from "@/kernel/api/resultsBrowser";
import type { ResultsBrowserUiBinding } from "@/kernel/results-browser/ResultsBrowserUiController";

import { ResultsOutputTree, type ResultsOutputTreeProps } from "./ResultsOutputTree";

const directory: ResultsEntry = {
  id: "dir-fields",
  path: "fields",
  parent_id: null,
  name: "fields",
  kind: "directory",
  size_bytes: null,
  array_id: null,
};
const array: ResultsEntry & { shape: readonly number[] } = {
  id: "array-m",
  path: "fields/m",
  parent_id: "dir-fields",
  name: "m",
  kind: "zarr_array",
  size_bytes: 64,
  array_id: "array-m",
  shape: [101, 6],
};
const unknownFile: ResultsEntry = {
  id: "file-log",
  path: "logs/solver.txt",
  parent_id: null,
  name: "solver.txt",
  kind: "file",
  size_bytes: 17,
  array_id: null,
};
const deepDirectory: ResultsEntry = {
  id: "dir-deep",
  path: "fields/deep",
  parent_id: "dir-fields",
  name: "deep",
  kind: "directory",
  size_bytes: null,
  array_id: null,
};
const deepFile: ResultsEntry = {
  id: "file-deep",
  path: "fields/deep/final-state.json",
  parent_id: "dir-deep",
  name: "final-state.json",
  kind: "file",
  size_bytes: 42,
  array_id: null,
};
const secondRoot: ResultsEntry = {
  id: "dir-zeta",
  path: "zeta",
  parent_id: null,
  name: "zeta",
  kind: "directory",
  size_bytes: null,
  array_id: null,
};

const catalog: ResultsCatalog = {
  schema: "fullmag.results-catalog.v1",
  revision: "sha256:catalog-1",
  root_label: "Run outputs",
  run_id: "run-1",
  entries: [array, unknownFile, directory],
  next_cursor: "cursor-2",
  total_count: 3,
  truncated: true,
};

const nestedCatalog: ResultsCatalog = {
  ...catalog,
  entries: [array, unknownFile, directory, deepDirectory, deepFile, secondRoot],
  next_cursor: null,
  total_count: 6,
  truncated: false,
};

const noopUi: ResultsBrowserUiBinding = {
  query: "",
  collapsedIds: [],
  focusedEntryId: null,
  setQuery: vi.fn(),
  toggleCollapsed: vi.fn(),
  setCollapsed: vi.fn(),
  setFocusedEntryId: vi.fn(),
};

const noopProps: Omit<ResultsOutputTreeProps, "ui"> = {
  catalog,
  status: "ready",
  error: null,
  selectedEntryId: null,
  onSelect: vi.fn(),
  onRefresh: vi.fn(),
  onNextPage: vi.fn(),
  onReturnToLive: vi.fn(),
  isHistoricalActive: false,
};

function StatefulResultsOutputTree(
  props: Omit<ResultsOutputTreeProps, "ui">,
) {
  const [state, setState] = useState<Pick<ResultsBrowserUiBinding, "query" | "collapsedIds" | "focusedEntryId">>({
    query: "",
    collapsedIds: [],
    focusedEntryId: null,
  });
  const ui: ResultsBrowserUiBinding = {
    ...state,
    setQuery: (query) => setState((current) => ({ ...current, query })),
    toggleCollapsed: (entryId) => setState((current) => ({
      ...current,
      collapsedIds: current.collapsedIds.includes(entryId)
        ? current.collapsedIds.filter((id) => id !== entryId)
        : [...current.collapsedIds, entryId],
    })),
    setCollapsed: (entryId, collapsed) => setState((current) => ({
      ...current,
      collapsedIds: collapsed
        ? current.collapsedIds.includes(entryId)
          ? current.collapsedIds
          : [...current.collapsedIds, entryId]
        : current.collapsedIds.filter((id) => id !== entryId),
    })),
    setFocusedEntryId: (focusedEntryId) => setState((current) => ({ ...current, focusedEntryId })),
  };
  return <ResultsOutputTree {...props} ui={ui} />;
}

function findTreeRow(container: TestElement, entryId: string): TestElement {
  return findElement(
    container,
    (element) =>
      element.getAttribute("role") === "treeitem" &&
      element.getAttribute("data-entry-id") === entryId,
    `${entryId} tree row`,
  );
}

function press(row: TestElement, key: string): TestEvent {
  const event = new TestEvent("keydown", { bubbles: true, key });
  row.dispatchEvent(event);
  return event;
}

describe("ResultsOutputTree", () => {
  it("renders actual hierarchical paths, ordinary files, revision and bounded paging state", () => {
    const html = renderToStaticMarkup(<ResultsOutputTree {...noopProps} ui={noopUi} />);

    expect(html).toContain("Run outputs");
    expect(html).toContain("fields");
    expect(html).toContain("fields/m");
    expect(html).toContain("logs/solver.txt");
    expect(html).toContain("zarr_array");
    expect(html).toContain("Revision sha256:catalog-1");
    expect(html).toContain("truncated");
    expect(html).toContain("Next page");
    expect(html).not.toContain("4 × 4");
    expect(html).toContain('aria-label="Search saved result outputs"');
    expect(html).toContain(">m</span>");
    expect(html).toContain(">solver.txt</span>");
    expect(html).toContain("Filter searches loaded entries only");
  });

  it("keeps output availability explicit without presenting an analysis gap as missing results", () => {
    const html = renderToStaticMarkup(
      <ResultsOutputTree
        {...noopProps}
        catalog={{ ...catalog, status: "ready" }}
        ui={noopUi}
      />,
    );

    expect(html).toContain("Saved result outputs");
    expect(html).toContain("Run outputs");
    expect(html).not.toContain("Results missing");
  });

  it("keeps full paths accessible while constraining the nested tree width", () => {
    const html = renderToStaticMarkup(
      <ResultsOutputTree {...noopProps} catalog={nestedCatalog} ui={noopUi} />,
    );

    expect(html).toContain(">final-state.json</span>");
    expect(html).toContain('title="fields/deep/final-state.json — file · 42 B"');
    expect(html).toContain('aria-label="Select fields/deep/final-state.json"');
    expect(html).toContain("fm-results-output");
    expect(html).toContain("fm-results-output__children");
    expect(html).toContain("fm-results-output__kind");
    expect(html).toContain("fm-results-output__shape");
    expect(html).toContain("fm-results-output__bytes");
    expect(html).toContain('title="fields/deep/final-state.json — file · 42 B"');
    expect(html).toContain("max-w-full");
    expect(html).toContain("overflow-x-hidden");
  });

  it("keeps long catalog metadata inside a shrinkable single grid track", () => {
    const html = renderToStaticMarkup(
      <ResultsOutputTree
        {...noopProps}
        catalog={{
          ...catalog,
          revision: `sha256:${"a".repeat(64)}`,
        }}
        ui={noopUi}
      />,
    );

    expect(html).toContain("grid-cols-1");
    expect(html).toContain('class="m-0 min-w-0 truncate text-fm-xs text-fm-muted"');
  });

  it("keeps historical return and error state visible without inventing a live run", () => {
    const html = renderToStaticMarkup(
      <ResultsOutputTree
        {...noopProps}
        error={new Error("Catalog revision is stale.")}
        isHistoricalActive
        catalog={{ ...catalog, run_id: null }}
        status="stale"
        ui={noopUi}
      />,
    );

    expect(html).toContain("Catalog revision is stale.");
    expect(html).toContain("Return to live");
    expect(html).toContain("Run: —");
    expect(html).not.toContain("Current session");
  });

  it("routes entry selection and refresh actions through props", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const onSelect = vi.fn();
    const onRefresh = vi.fn();

    try {
      await act(async () => {
        root.render(
          <StatefulResultsOutputTree
            {...noopProps}
            onRefresh={onRefresh}
            onSelect={onSelect}
          />,
        );
      });
      const arrayButton = findElement(
        container,
        (element) =>
          element.getAttribute("data-entry-kind") === "zarr_array" &&
          element.getAttribute("data-entry-select") === "true",
        "array output button",
      );
      const refreshButton = findElement(
        container,
        (element) => element.getAttribute("aria-label") === "Refresh results output",
        "refresh button",
      );

      await act(async () => {
        arrayButton.dispatchEvent(new TestEvent("click", { bubbles: true }));
        refreshButton.dispatchEvent(new TestEvent("click", { bubbles: true }));
      });

      expect(onSelect).toHaveBeenCalledWith(array);
      expect(onRefresh).toHaveBeenCalledOnce();
      expect(arrayButton).toBeInstanceOf(TestElement);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("keeps the owning treeitem focused after row actions and nested focus bubbling", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const onSelect = vi.fn();

    try {
      await act(async () => {
        root.render(
          <StatefulResultsOutputTree
            {...noopProps}
            catalog={nestedCatalog}
            onSelect={onSelect}
          />,
        );
      });

      const fieldsRow = findTreeRow(container, "dir-fields");
      const deepRow = findTreeRow(container, "dir-deep");
      const finalRow = findTreeRow(container, "file-deep");
      const selectFields = findElement(
        fieldsRow,
        (element) => element.getAttribute("data-entry-select") === "true",
        "fields selection button",
      );

      selectFields.focus();
      await act(async () => {
        selectFields.dispatchEvent(new TestEvent("click", { bubbles: true }));
      });
      expect(dom.document.activeElement).toBe(fieldsRow);
      expect(onSelect).toHaveBeenCalledWith(directory);

      await act(async () => {
        press(fieldsRow, "ArrowDown");
      });
      expect(dom.document.activeElement).toBe(deepRow);

      fieldsRow.focus();
      await act(async () => {
        deepRow.dispatchEvent(new TestEvent("focusin", { bubbles: true }));
      });
      expect(deepRow.getAttribute("tabindex")).toBe("0");
      expect(fieldsRow.getAttribute("tabindex")).toBe("-1");

      await act(async () => {
        press(deepRow, "ArrowDown");
      });
      expect(dom.document.activeElement).toBe(finalRow);

      const collapseFields = findElement(
        fieldsRow,
        (element) => element.getAttribute("aria-label") === "Collapse fields",
        "fields collapse button",
      );
      collapseFields.focus();
      await act(async () => {
        collapseFields.dispatchEvent(new TestEvent("click", { bubbles: true }));
      });
      expect(dom.document.activeElement).toBe(fieldsRow);
      expect(fieldsRow.getAttribute("aria-expanded")).toBe("false");

      const expandFields = findElement(
        fieldsRow,
        (element) => element.getAttribute("aria-label") === "Expand fields",
        "fields expand button",
      );
      expandFields.focus();
      await act(async () => {
        expandFields.dispatchEvent(new TestEvent("click", { bubbles: true }));
      });
      expect(dom.document.activeElement).toBe(fieldsRow);
      expect(fieldsRow.getAttribute("aria-expanded")).toBe("true");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("uses one roving tab stop and APG tree navigation without keyboard bubbling", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const onSelect = vi.fn();

    try {
      await act(async () => {
        root.render(
          <StatefulResultsOutputTree
            {...noopProps}
            catalog={nestedCatalog}
            onSelect={onSelect}
          />,
        );
      });

      const fieldsRow = findTreeRow(container, "dir-fields");
      const deepRow = findTreeRow(container, "dir-deep");
      const finalRow = findTreeRow(container, "file-deep");
      const zetaRow = findTreeRow(container, "dir-zeta");
      const treeRows = () =>
        [fieldsRow, deepRow, finalRow, findTreeRow(container, "array-m"),
          findTreeRow(container, "file-log"), zetaRow];

      expect(treeRows().filter((row) => row.getAttribute("tabindex") === "0"))
        .toHaveLength(1);
      expect(fieldsRow.getAttribute("tabindex")).toBe("0");

      fieldsRow.focus();
      await act(async () => {
        press(fieldsRow, "ArrowDown");
      });
      expect(dom.document.activeElement).toBe(deepRow);
      expect(deepRow.getAttribute("tabindex")).toBe("0");
      expect(fieldsRow.getAttribute("tabindex")).toBe("-1");

      await act(async () => {
        press(deepRow, "ArrowUp");
        press(fieldsRow, "ArrowRight");
      });
      expect(dom.document.activeElement).toBe(deepRow);

      await act(async () => {
        press(deepRow, "ArrowRight");
      });
      expect(dom.document.activeElement).toBe(finalRow);

      await act(async () => {
        press(finalRow, "ArrowLeft");
      });
      expect(dom.document.activeElement).toBe(deepRow);

      await act(async () => {
        press(deepRow, "ArrowLeft");
      });
      expect(deepRow.getAttribute("aria-expanded")).toBe("false");
      expect(dom.document.activeElement).toBe(deepRow);

      await act(async () => {
        press(deepRow, "ArrowRight");
      });
      expect(deepRow.getAttribute("aria-expanded")).toBe("true");
      expect(dom.document.activeElement).toBe(deepRow);

      await act(async () => {
        press(deepRow, "End");
      });
      expect(dom.document.activeElement).toBe(zetaRow);
      await act(async () => {
        press(zetaRow, "Home");
      });
      expect(dom.document.activeElement).toBe(fieldsRow);

      const expandButton = findElement(
        fieldsRow,
        (element) => element.getAttribute("aria-label") === "Collapse fields",
        "fields disclosure button",
      );
      await act(async () => {
        press(expandButton, "Enter");
        press(expandButton, " ");
      });
      expect(onSelect).not.toHaveBeenCalled();

      await act(async () => {
        press(fieldsRow, "Enter");
        press(fieldsRow, " ");
      });
      expect(onSelect).toHaveBeenNthCalledWith(1, directory);
      expect(onSelect).toHaveBeenNthCalledWith(2, directory);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
