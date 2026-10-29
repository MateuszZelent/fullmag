import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Selection } from "@/kernel/selection/selectionTypes";
import { ResultsHistoryExitOwnerProvider } from "@/kernel/visualization/ResultsHistoryExitOwnerContext";

import InspectorModule from "./InspectorModule";

const inspectorTestState = vi.hoisted(() => ({
  kernel: {} as unknown,
  savedPlayback: null as unknown,
  selection: {
    kind: "object.geometry",
    label: "Geometry",
    moduleSource: "inspector",
    nodeId: "geometry-1",
    objectId: "object-1",
    ref: null,
  } as Selection,
  sessionIdentity: null as unknown,
  snapshot: { activeKey: null as string | null },
}));

vi.mock("@/kernel/KernelContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/kernel/KernelContext")>()),
  useKernel: () => inspectorTestState.kernel,
}));

vi.mock("@/kernel/selection/useSelection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/kernel/selection/useSelection")>()),
  useSelectionSelector: (selector: (selection: Selection) => unknown) =>
    selector(inspectorTestState.selection),
}));

vi.mock("@/kernel/resources/useSessionStatus", () => ({
  useSessionResourceIdentity: () => inspectorTestState.sessionIdentity,
}));

vi.mock("@/kernel/saved-results/useSavedResultsPlayback", () => ({
  useSavedResultsPlaybackSelection: () => inspectorTestState.savedPlayback,
}));

vi.mock("@/kernel/visualization/useSnapshotVisualization", () => ({
  useSnapshotVisualization: () => inspectorTestState.snapshot,
}));

vi.mock("@/kernel/layout/WorkspaceContentScope", () => ({
  useWorkspaceContentScope: () => "session",
}));

vi.mock("@/kernel/performance/reactRenderProfiler", async () => {
  const React = await import("react");
  return {
    WorkspaceRenderProfiler: ({ children }: { children: ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

vi.mock("./InspectorDirtySelectionGuard", async () => {
  const React = await import("react");
  return {
    InspectorDirtySelectionGuard: ({
      children,
      selection,
    }: {
      children: (selection: Selection) => ReactNode;
      selection: Selection;
    }) => children(selection),
  };
});

vi.mock("./InspectorEditSession", async () => {
  const React = await import("react");
  return {
    InspectorEditSessionProvider: ({ children }: { children: ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    useInspectorEditSession: () => null,
  };
});

vi.mock("./InspectorShell", async () => {
  const React = await import("react");
  return {
    InspectorShell: ({ children }: { children: ReactNode }) =>
      React.createElement("div", { "data-testid": "inspector-shell" }, children),
  };
});

vi.mock("./inspectorDescriptor", () => ({
  resolveInspectorDescriptor: () => ({
    breadcrumbs: [],
    icon: "object",
    metadata: [],
    ownerId: "test-inspector",
    status: null,
    tabs: [],
    title: "Test inspector",
    typeLabel: "Test",
  }),
}));

vi.mock("./inspectorRegistry", async () => {
  const React = await import("react");
  return {
    resolveInspectorPanel: () => ({
      title: "Test panel",
      component: () => React.createElement("div", null, "Test panel"),
    }),
  };
});

vi.mock("./inspectorRouteCatalog", () => ({
  resolveUnknownInspectorRoute: () => ({ contribution: null }),
}));

vi.mock("./panels/SavedResultsPlaybackInspector", () => ({
  SavedResultsPlaybackInspector: () => null,
}));

function renderInspector(owner: "saved" | "current" | null): string {
  return renderToStaticMarkup(
    <ResultsHistoryExitOwnerProvider owner={owner}>
      <InspectorModule />
    </ResultsHistoryExitOwnerProvider>,
  );
}

describe("InspectorModule results-history exit ownership", () => {
  beforeEach(() => {
    inspectorTestState.savedPlayback = null;
    inspectorTestState.selection = {
      kind: "object.geometry",
      label: "Geometry",
      moduleSource: "inspector",
      nodeId: "geometry-1",
      objectId: "object-1",
      ref: null,
    };
    inspectorTestState.sessionIdentity = null;
    inspectorTestState.snapshot = { activeKey: null };
  });

  it("keeps the browser-only local fallback only when no shell owner exists", () => {
    inspectorTestState.savedPlayback = { browserOnly: true };

    expect(renderInspector(null)).toContain("Close results");
    expect(renderInspector("saved")).not.toContain("Close results");

    inspectorTestState.sessionIdentity = {
      requestScopeEpoch: "scope-1",
      sessionEpoch: "epoch-1",
      sessionId: "session-1",
    };
    expect(renderInspector(null)).toContain("Return to live");
    expect(renderInspector("saved")).not.toContain("Return to live");
  });

  it("keeps the historical viewport notice but delegates its exit to the current owner", () => {
    inspectorTestState.snapshot = { activeKey: "snapshot-1" };

    const fallbackMarkup = renderInspector(null);
    expect(fallbackMarkup).toContain("Historical viewport context");
    expect(fallbackMarkup).toContain("A saved 3D snapshot is selected. This Inspector belongs to the current workspace.");
    expect(fallbackMarkup).not.toContain("The viewport shows a saved snapshot.");
    expect(fallbackMarkup).toContain("Return to live");

    const ownedMarkup = renderInspector("current");
    expect(ownedMarkup).toContain("Historical viewport context");
    expect(ownedMarkup).not.toContain("Return to live");
  });
});
