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

const resultsGroup: ResultsEntry = {
  id: "group-results",
  path: "results",
  parent_id: null,
  name: "results",
  kind: "zarr_group",
  size_bytes: null,
  array_id: null,
};
const resultsArray: ResultsEntry & { shape: readonly number[] } = {
  id: "array-results-m",
  path: "results/m",
  parent_id: "group-results",
  name: "m",
  kind: "zarr_array",
  size_bytes: 64,
  array_id: "array-results-m",
  shape: [3, 1],
};
const zarrAttributes: ResultsEntry = {
  id: "file-zattrs",
  path: ".zattrs",
  parent_id: null,
  name: ".zattrs",
  kind: "file",
  size_bytes: 20,
  array_id: null,
};
const zarrGroupMetadata: ResultsEntry = {
  id: "file-zgroup",
  path: ".zgroup",
  parent_id: null,
  name: ".zgroup",
  kind: "file",
  size_bytes: 18,
  array_id: null,
};
const zarrArrayMetadata: ResultsEntry = {
  id: "file-array-zattrs",
  path: "fields/m/.zattrs",
  parent_id: "array-m",
  name: ".zattrs",
  kind: "file",
  size_bytes: 24,
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
  expandedIds: [],
  focusedEntryId: null,
  setQuery: vi.fn(),
  toggleCollapsed: vi.fn(),
  setCollapsed: vi.fn(),
  toggleExpanded: vi.fn(),
  setExpanded: vi.fn(),
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
  returnActionLabel: "Return to live",
};

function StatefulResultsOutputTree(
  props: Omit<ResultsOutputTreeProps, "ui">,
) {
  const [state, setState] = useState<Pick<ResultsBrowserUiBinding, "query" | "collapsedIds" | "expandedIds" | "focusedEntryId">>({
    query: "",
    collapsedIds: [],
    expandedIds: [],
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
    toggleExpanded: (entryId, defaultCollapsed) => setState((current) => {
      const expanded = defaultCollapsed
        ? current.expandedIds.includes(entryId) && !current.collapsedIds.includes(entryId)
        : !current.collapsedIds.includes(entryId);
      if (defaultCollapsed) {
        return {
          ...current,
          collapsedIds: expanded
            ? [...current.collapsedIds, entryId]
            : current.collapsedIds.filter((id) => id !== entryId),
          expandedIds: expanded
            ? current.expandedIds.filter((id) => id !== entryId)
            : current.expandedIds.includes(entryId)
              ? current.expandedIds
              : [...current.expandedIds, entryId],
        };
      }
      return {
        ...current,
        collapsedIds: expanded
          ? [...current.collapsedIds, entryId]
          : current.collapsedIds.filter((id) => id !== entryId),
      };
    }),
    setExpanded: (entryId, expanded, defaultCollapsed) => setState((current) => ({
      ...current,
      collapsedIds: defaultCollapsed
        ? expanded
          ? current.collapsedIds.filter((id) => id !== entryId)
          : current.collapsedIds.includes(entryId)
            ? current.collapsedIds
            : [...current.collapsedIds, entryId]
        : expanded
          ? current.collapsedIds.filter((id) => id !== entryId)
          : current.collapsedIds.includes(entryId)
            ? current.collapsedIds
            : [...current.collapsedIds, entryId],
      expandedIds: defaultCollapsed
        ? expanded
          ? current.expandedIds.includes(entryId)
            ? current.expandedIds
            : [...current.expandedIds, entryId]
          : current.expandedIds.filter((id) => id !== entryId)
        : current.expandedIds,
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
    expect(html).toContain("overflow-x-clip");
    expect(html).not.toMatch(/<(?:li|ul)[^>]*class="[^"]*\boverflow-hidden\b/);
  });

  it("defaults Zarr arrays closed while ordinary folders remain open", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const arrayCatalog: ResultsCatalog = {
      ...nestedCatalog,
      entries: [...nestedCatalog.entries, zarrArrayMetadata, resultsGroup, resultsArray],
      total_count: 9,
    };

    try {
      await act(async () => {
        root.render(
          <StatefulResultsOutputTree
            {...noopProps}
            catalog={arrayCatalog}
          />,
        );
      });

      expect(findTreeRow(container, "dir-fields").getAttribute("aria-expanded")).toBe("true");
      expect(findTreeRow(container, "group-results").getAttribute("aria-expanded")).toBe("true");
      expect(findTreeRow(container, "array-results-m").getAttribute("aria-expanded")).toBeNull();
      const arrayRow = findTreeRow(container, "array-m");
      expect(arrayRow.getAttribute("aria-expanded")).toBe("false");
      expect(() => findTreeRow(container, zarrArrayMetadata.id)).toThrow();

      arrayRow.focus();
      await act(async () => press(arrayRow, "ArrowRight"));
      expect(arrayRow.getAttribute("aria-expanded")).toBe("true");
      expect(findTreeRow(container, zarrArrayMetadata.id)).toBeTruthy();
      await act(async () => press(arrayRow, "ArrowLeft"));
      expect(arrayRow.getAttribute("aria-expanded")).toBe("false");
      expect(dom.document.activeElement).toBe(arrayRow);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
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
    expect(html).toContain('<details class="min-w-0 text-fm-xs text-fm-muted">');
    expect(html).toContain('Source details</summary>');
    expect(html).toContain('<p class="m-0 break-all">Revision sha256:' + "a".repeat(64));
  });

  it("puts result groups and arrays before metadata files while preserving tree aria order", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const orderedCatalog: ResultsCatalog = {
      ...catalog,
      entries: [zarrAttributes, zarrGroupMetadata, resultsArray, resultsGroup, array, directory],
      next_cursor: null,
      total_count: 6,
      truncated: false,
    };

    try {
      await act(async () => {
        root.render(
          <StatefulResultsOutputTree
            {...noopProps}
            catalog={orderedCatalog}
          />,
        );
      });

      const rows = () => [...container.querySelectorAll('[role="treeitem"]')] as TestElement[];
      expect(rows().map((row) => row.getAttribute("data-entry-id"))).toEqual([
        "dir-fields",
        "array-m",
        "group-results",
        "array-results-m",
        "file-zattrs",
        "file-zgroup",
      ]);
      const groupRow = findTreeRow(container, "group-results");
      const arrayRow = findTreeRow(container, "array-results-m");
      const attributesRow = findTreeRow(container, "file-zattrs");
      const groupMetadataRow = findTreeRow(container, "file-zgroup");
      expect(groupRow.getAttribute("aria-posinset")).toBe("2");
      expect(groupRow.getAttribute("aria-setsize")).toBe("4");
      expect(arrayRow.getAttribute("aria-posinset")).toBe("1");
      expect(arrayRow.getAttribute("aria-setsize")).toBe("1");
      expect(attributesRow.getAttribute("aria-posinset")).toBe("3");
      expect(groupMetadataRow.getAttribute("aria-posinset")).toBe("4");

      groupRow.focus();
      await act(async () => {
        press(groupRow, "ArrowDown");
      });
      expect(dom.document.activeElement).toBe(arrayRow);
      await act(async () => {
        press(arrayRow, "ArrowDown");
      });
      expect(dom.document.activeElement).toBe(attributesRow);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("keeps historical return and error state visible without inventing a live run", () => {
    const html = renderToStaticMarkup(
      <ResultsOutputTree
        {...noopProps}
        error={new Error("Catalog revision is stale.")}
        isHistoricalActive
        catalog={{ ...catalog, run_id: null }}
        returnActionLabel="Close results"
        status="stale"
        ui={noopUi}
      />,
    );

    expect(html).toContain("Catalog revision is stale.");
    expect(html).toContain("Close results");
    expect(html).not.toContain("Return to live");
    expect(html).toContain("Run: —");
    expect(html).not.toContain("Current session");
  });

  it("can leave the historical exit action to the owning shell", () => {
    const html = renderToStaticMarkup(
      <ResultsOutputTree
        {...noopProps}
        isHistoricalActive
        showReturnAction={false}
        ui={noopUi}
      />,
    );

    expect(html).not.toContain("Return to live");
    expect(html).not.toContain("Close results");
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
      const lastRow = findTreeRow(container, "file-log");
      const treeRows = () =>
        [fieldsRow, deepRow, finalRow, findTreeRow(container, "array-m"),
          zetaRow, lastRow];

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
      expect(dom.document.activeElement).toBe(lastRow);
      await act(async () => {
        press(lastRow, "Home");
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
