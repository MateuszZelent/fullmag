import { describe, expect, it, vi } from "vitest";

import { applyWorkspaceTabSelection, type WorkspaceTabSelectionApi } from "../tabSelection";
import type { WorkspaceMode, WorkspaceTab } from "@/lib/workspace/workspace-store";

function makeTab(patch: Partial<WorkspaceTab>): WorkspaceTab {
  return {
    id: "core:3d",
    key: "core:3d",
    kind: "viewport-3d",
    title: "3D Viewport",
    closable: false,
    pinned: true,
    mountPolicy: "active-only",
    payload: { viewMode: "3D" },
    ...patch,
  };
}

function makeApi(patch: Partial<WorkspaceTabSelectionApi> = {}): WorkspaceTabSelectionApi {
  return {
    currentWorkspaceMode: "study",
    setWorkspaceMode: vi.fn(),
    handleViewModeChange: vi.fn(),
    effectiveViewMode: "3D",
    requestPreviewQuantity: vi.fn(),
    selectedQuantity: "m",
    activeResultWorkspaceId: null,
    analyzeSelection: {
      domain: "eigenmodes",
      tab: "spectrum",
      selectedModeIndex: null,
    },
    openAnalyzeSurface: vi.fn(),
    ...patch,
  };
}

describe("applyWorkspaceTabSelection", () => {
  const stage: WorkspaceMode = "study";

  it("opens core analyze as a center tab view without changing workspace stage", () => {
    const api = makeApi();
    applyWorkspaceTabSelection(
      stage,
      makeTab({
        id: "core:analyze",
        key: "core:analyze",
        kind: "analyze",
        title: "Analyze",
        payload: { viewMode: "Analyze", analyzeDomain: "eigenmodes", analyzeTab: "spectrum" },
      }),
      api,
    );

    expect(api.setWorkspaceMode).not.toHaveBeenCalledWith("analyze");
    expect(api.openAnalyzeSurface).toHaveBeenCalledWith({
      selection: {
        domain: "eigenmodes",
        tab: "spectrum",
        selectedModeIndex: null,
      },
      source: "dock-tab",
    });
  });

  it("opens result analysis tabs without changing workspace stage", () => {
    const api = makeApi({
      analyzeSelection: { domain: "eigenmodes", tab: "summary", selectedModeIndex: null },
    });
    applyWorkspaceTabSelection(
      stage,
      makeTab({
        id: "result-tab:spectrum",
        key: "result:spectrum",
        kind: "result-spectrum",
        title: "Eigen Spectrum",
        closable: true,
        pinned: false,
      }),
      api,
    );

    expect(api.setWorkspaceMode).not.toHaveBeenCalledWith("analyze");
    expect(api.openAnalyzeSurface).toHaveBeenCalledWith({
      selection: {
        domain: "eigenmodes",
        tab: "spectrum",
        selectedModeIndex: null,
      },
      source: "dock-tab",
    });
  });

  it("keeps quantity result tabs in 3D without changing workspace stage", () => {
    const api = makeApi({ selectedQuantity: "H_demag" });
    applyWorkspaceTabSelection(
      stage,
      makeTab({
        id: "result-tab:quantity",
        key: "result:quantity",
        kind: "result-quantity",
        title: "Magnetization",
        closable: true,
        pinned: false,
        payload: { quantityId: "m" },
      }),
      api,
    );

    expect(api.setWorkspaceMode).not.toHaveBeenCalledWith("analyze");
    expect(api.requestPreviewQuantity).toHaveBeenCalledWith("m");
    expect(api.handleViewModeChange).not.toHaveBeenCalledWith("Analyze");
    expect(api.handleViewModeChange).not.toHaveBeenCalledWith("3D");
    expect(api.openAnalyzeSurface).not.toHaveBeenCalled();
  });

  it("keeps quantity result workspace tabs in 3D even when they carry result ids", () => {
    const api = makeApi({ effectiveViewMode: "Analyze", selectedQuantity: "H_demag" });
    applyWorkspaceTabSelection(
      stage,
      makeTab({
        id: "result-tab:quantity",
        key: "result:quantity",
        kind: "result-quantity",
        title: "Magnetization",
        closable: true,
        pinned: false,
        payload: { resultWorkspaceId: "entry-1", quantityId: "m" },
      }),
      api,
    );

    expect(api.setWorkspaceMode).not.toHaveBeenCalledWith("analyze");
    expect(api.requestPreviewQuantity).toHaveBeenCalledWith("m");
    expect(api.handleViewModeChange).toHaveBeenCalledWith("3D");
    expect(api.openAnalyzeSurface).not.toHaveBeenCalled();
  });

  it("selects 3D mode when the 3D viewport tab is activated", () => {
    const api = makeApi({ effectiveViewMode: "2D" });
    applyWorkspaceTabSelection(stage, makeTab({ kind: "viewport-3d" }), api);

    expect(api.handleViewModeChange).toHaveBeenCalledWith("3D");
  });

  it("selects 2D mode when the 2D viewport tab is activated", () => {
    const api = makeApi({ effectiveViewMode: "3D" });
    applyWorkspaceTabSelection(
      stage,
      makeTab({
        id: "core:2d",
        key: "core:2d",
        kind: "viewport-2d",
        title: "2D Slice",
        payload: { viewMode: "2D" },
      }),
      api,
    );

    expect(api.handleViewModeChange).toHaveBeenCalledWith("2D");
  });

  it("selects Mesh mode when the mesh viewport tab is activated", () => {
    const api = makeApi({ effectiveViewMode: "3D" });
    applyWorkspaceTabSelection(
      stage,
      makeTab({
        id: "core:mesh",
        key: "core:mesh",
        kind: "viewport-mesh",
        title: "Mesh",
        payload: { viewMode: "Mesh" },
      }),
      api,
    );

    expect(api.handleViewModeChange).toHaveBeenCalledWith("Mesh");
  });
});
