import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

let commandState = {
  session: null as { problem_name?: string | null } | null,
  error: null as string | null,
  domainCapabilities: null,
  isFemBackend: false,
  sessionFooter: { scriptPath: null as string | null },
  quantities: [] as unknown[],
  latestBackendError: null,
  artifacts: [] as unknown[],
  run: null,
  workspaceStatus: null,
  scriptBuilderCurrentModules: [] as unknown[],
  engineLog: null as string | null,
};

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/workspace",
}));

vi.mock("@/components/runs/control-room/ControlRoomAppBar", () => ({
  default: () => React.createElement("div", { "data-testid": "app-bar" }, "app-bar"),
}));

vi.mock("@/components/workspace/docking/WorkspaceDockingShell", () => ({
  default: () =>
    React.createElement("div", { "data-testid": "workspace-docking-shell" }, "workspace-docking-shell"),
}));

vi.mock("@/components/brand/FullmagLogo", () => ({
  default: () => React.createElement("div", { "data-testid": "fullmag-logo" }, "logo"),
}));

vi.mock("@/components/runs/control-room/ControlRoomContext", () => ({
  ControlRoomProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/components/runs/control-room/context-hooks", () => ({
  useTransport: () => ({
    preview: null,
    scalarRows: [],
    liveState: null,
  }),
  useViewport: () => ({
    sidebarCollapsed: false,
    setSidebarCollapsed: vi.fn(),
    workspaceStage: "study",
    setWorkspaceStage: vi.fn(),
    effectiveViewMode: "3D",
    handleViewModeChange: vi.fn(),
    quickPreviewTargets: [],
    requestPreviewQuantity: vi.fn(),
    requestedPreviewQuantity: "m",
    requestedPreviewComponent: "magnitude",
    plane: "xy",
    sliceIndex: 0,
    previewBusy: false,
    patchDisplay: vi.fn(),
    previewGrid: [0, 0, 0],
    previewIsInitialSampleStale: false,
    previewIsStale: false,
    previewMessage: null,
  }),
  useCommand: () => commandState,
  useModel: () => ({
    studyPipeline: null,
    studyStages: [],
    effectiveFemMesh: null,
    selectSidebarNode: vi.fn(),
    resolvedRenderPlan: null,
    meshWorkspace: null,
  }),
}));

vi.mock("@/components/runs/control-room/useViewport3DStatus", () => ({
  useViewport3DStatus: () => ({
    handleViewportHealthChange: vi.fn(),
    viewport3DStatus: { status: "active", reason: null, detail: null },
  }),
}));

vi.mock("@/components/runs/control-room/useBuilderRibbonActions", () => ({
  useBuilderRibbonActions: () => ({
    builderModeEnabled: false,
    handleBuilderAddPrimitive: vi.fn(),
    handleBuilderBuildAll: vi.fn(),
    handleBuilderBuildGeometry: vi.fn(),
    handleBuilderBuildMesh: vi.fn(),
    handleBuilderCenterInUniverse: vi.fn(),
    handleBuilderFocusSelected: vi.fn(),
    handleBuilderFrameAll: vi.fn(),
    handleBuilderSetTransformTool: vi.fn(),
    handleBuilderSetViewportMode: vi.fn(),
    handleBuilderValidateGeometry: vi.fn(),
    toggleBuilderSnap: vi.fn(),
  }),
}));

vi.mock("@/components/runs/control-room/useRibbonHandlers", () => ({
  useRibbonHandlers: () => ({
    selectedAntennaName: null,
    openAnalyzeCenterTab: vi.fn(),
    handleSelectModelNode: vi.fn(),
    handleAddAntenna: vi.fn(),
    handleCreateVisualizationPreset: vi.fn(),
    handleObjectAddInteraction: vi.fn(),
    handleAssignMagnetizationPreset: vi.fn(),
    handleSetTransformScope: vi.fn(),
    handleSetTextureTransformMode: vi.fn(),
    handleStudyAddPrimitive: vi.fn(),
    handleStudyAddMacro: vi.fn(),
    handleStudyDuplicateSelected: vi.fn(),
    handleStudyToggleSelectedEnabled: vi.fn(),
    handleAddResultAnalysis: vi.fn(),
  }),
}));

vi.mock("@/components/runs/control-room/useMeshBuildFlow", () => ({
  useMeshBuildFlow: () => ({
    activeMeshIntent: { targetLabel: null },
    effectiveMeshTargets: [],
    meshBuildBackendError: null,
    meshBuildDialogOpen: false,
    meshBuildError: null,
    meshBuildIntent: null,
    meshBuildNotice: null,
    meshBuildProgress: 0,
    meshBuildRuntime: { generating: false, errorMessage: null },
    meshBuildStages: [],
    handleBackgroundMeshBuild: vi.fn(),
    handleBuildMeshAll: vi.fn(),
    handleBuildMeshSelected: vi.fn(),
    handleCloseMeshBuildDialog: vi.fn(),
    handleOpenMeshInspector: vi.fn(),
    handleOpenMeshMethod: vi.fn(),
    handleOpenMeshOptimization: vi.fn(),
    handleOpenMeshPipeline: vi.fn(),
    handleOpenMeshQuality: vi.fn(),
    handleOpenMeshSize: vi.fn(),
    handleOpenMeshStatistics: vi.fn(),
    handleOpenMeshTransition: vi.fn(),
  }),
}));

vi.mock("@/components/runs/control-room/useRibbonVisualizationActions", () => ({
  useRibbonVisualizationActions: () => ({
    airboxDisplayState: {
      geometryVisible: false,
      surface: false,
      wireframe: false,
      points: false,
      vectorsVisible: false,
      wireframeScope: "surface",
      pointsScope: "surface",
      vectorsScope: "surface",
    },
    airMeshRenderMode: "surface",
    handleDispatchVisualization: vi.fn(),
    handleRibbonAirboxDisplay: vi.fn(),
    handleRibbonFemArrowStyle: vi.fn(),
    handleRibbonMeshRenderMode: vi.fn(),
    handleRibbonPreviewAutoScale: vi.fn(),
    handleRibbonPreviewColormap: vi.fn(),
    handleRibbonPreviewComponent: vi.fn(),
    handleRibbonPreviewEveryN: vi.fn(),
    handleRibbonPreviewMaxPoints: vi.fn(),
    handleRibbonSlice2DToolbar: vi.fn(),
    ribbonAirboxVisible: false,
    ribbonFemLayers: {
      showPrimitives: false,
      showMagneticTexture: false,
      showQuantity: true,
    },
    slice2DToolbar: null,
  }),
}));

vi.mock("@/components/runs/control-room/useSelectedObjectRibbonDisplay", () => ({
  useSelectedObjectRibbonDisplay: () => ({
    selectedObjectOpacity: null,
    selectedObjectRenderMode: null,
    selectedObjectTextureVisible: null,
    handleClearSelectedDisplayOverrides: vi.fn(),
    handleSelectedObjectOpacity: vi.fn(),
    handleSelectedObjectRenderMode: vi.fn(),
    handleSelectedObjectTextureVisible: vi.fn(),
  }),
}));

vi.mock("@/components/runs/control-room/useAutoResultsNavigation", () => ({
  useAutoResultsNavigation: () => undefined,
}));

vi.mock("@/features/workspace-graph", () => ({
  useWorkspaceGraphBridge: () => undefined,
}));

vi.mock("@/hooks/useKeyboardShortcuts", () => ({
  useKeyboardShortcuts: () => undefined,
}));

vi.mock("@/features/selection", () => ({
  useSelectionActions: () => ({ setSelectedObjectId: vi.fn() }),
  useSelectedSidebarNodeId: () => null,
}));

vi.mock("@/features/visualization/hooks/useVizSlice", () => ({
  useRenderMode: () => "surface",
}));

vi.mock("@/features/visualization/store/useVisualizationStore", () => ({
  useVisualizationStore: (selector: (state: { setFemTextureDownsampleCells: ReturnType<typeof vi.fn> }) => unknown) =>
    selector({ setFemTextureDownsampleCells: vi.fn() }),
}));

vi.mock("@/features/analyze", () => ({
  useAnalyzeStore: (selector: (state: { resultsWorkspace: unknown[] }) => unknown) =>
    selector({ resultsWorkspace: [] }),
}));

vi.mock("@/lib/workspace/workspace-store", () => ({
  useActiveStageLayout: () => ({
    leftDock: "study-tree",
    centerDock: "viewport-controls",
    rightDock: "solver",
    bottomDock: "jobs",
  }),
  useWorkspaceStore: (
    selector: (state: Record<string, unknown>) => unknown,
  ) =>
    selector({
      launchIntent: null,
      rightInspectorOpen: true,
      setRightInspectorOpen: vi.fn(),
      setRightInspectorTab: vi.fn(),
      dockLayoutByStage: { study: {}, build: {} },
      setLeftDock: vi.fn(),
      setRightDock: vi.fn(),
      setBottomDock: vi.fn(),
      setDockLayout: vi.fn(),
      activeCoreTab: "view",
      setActiveCoreTab: vi.fn(),
      setActiveContextualTab: vi.fn(),
      workspaceTabsByStage: { study: [], build: [] },
      activeWorkspaceTabByStage: { study: "core:3d", build: "core:3d" },
      currentStage: "study",
    }),
}));

vi.mock("@/src/domain/capabilities", () => ({
  resolveFemDiscretization: () => false,
}));

vi.mock("@/lib/debug/frontendDiagnosticFlags", () => ({
  FRONTEND_DIAGNOSTIC_FLAGS: {
    renderDebug: { enableRenderLogging: false },
    workspace: {
      enableControlRoomShell: true,
      enableWorkspaceDockingShell: true,
      enableRunControlRoom: true,
      enableDockingTooltipProviders: false,
      enableGraphV2: false,
      enableWorkspaceGraphBridge: false,
    },
    shell: {
      showRibbonBar: false,
      showBackendErrorNotice: false,
      useDockingShell: true,
      showViewportBar: false,
      showPreviewNotices: false,
      showStatusBar: false,
      showWorkspaceOverlays: false,
    },
  },
}));

vi.mock("@/components/runs/control-room/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/runs/control-room/shared")>();
  return {
    ...actual,
    PANEL_SIZES: {
      ...actual.PANEL_SIZES,
      rightInspectorDefault: "22%",
      rightInspectorMin: "12%",
      rightInspectorMax: "42%",
    },
  };
});

vi.mock("@/components/runs/control-room/RunSidebar", () => ({
  default: () => React.createElement("div"),
}));
vi.mock("@/components/runs/control-room/ViewportPanels", () => ({
  ViewportBar: () => React.createElement("div"),
  ViewportCanvasArea: () => React.createElement("div"),
}));
vi.mock("@/components/runs/control-room/ViewportTabBar", () => ({
  ViewportTabBar: () => React.createElement("div"),
}));
vi.mock("@/components/runs/control-room/WorkspaceBodyLayout", () => ({
  WorkspaceBodyLayout: ({ center }: { center?: React.ReactNode }) => React.createElement("div", null, center),
}));
vi.mock("@/components/runs/control-room/ControlRoomPreviewNotices", () => ({
  default: () => React.createElement("div"),
}));
vi.mock("@/components/runs/control-room/ControlRoomRibbonBar", () => ({
  default: () => React.createElement("div"),
}));
vi.mock("@/components/runs/control-room/ControlRoomStatusBar", () => ({
  default: () => React.createElement("div"),
}));
vi.mock("@/components/runs/control-room/DataPlaneStatusBadges", () => ({
  DataPlaneStatusBadges: () => React.createElement("div"),
}));
vi.mock("@/components/runs/control-room/BackendErrorNotice", () => ({
  default: () => React.createElement("div"),
}));
vi.mock("@/components/runs/control-room/MeshBuildModal", () => ({
  default: () => React.createElement("div"),
}));
vi.mock("@/components/workspace/modes/WorkspaceModeInspectors", () => ({
  WorkspaceRightToolbox: () => React.createElement("div"),
}));
vi.mock("@/components/workspace/overlays/SettingsDialog", () => ({
  default: () => React.createElement("div"),
}));
vi.mock("@/components/workspace/overlays/PhysicsDocsDrawer", () => ({
  default: () => React.createElement("div"),
}));

import { ControlRoomShell } from "../RunControlRoom";

describe("ControlRoomShell startup overlay", () => {
  it("keeps workspace shell markup mounted while showing the initializing overlay", () => {
    commandState = {
      ...commandState,
      session: null,
      error: null,
    };

    const html = renderToString(React.createElement(ControlRoomShell, { initialWorkspaceMode: "study" }));

    expect(html).toContain("workspace-docking-shell");
    expect(html).toContain("Initializing Workspace");
    expect(html).not.toContain("No active workspace");
  });

  it("keeps no-active-workspace as the only hard replacement state", () => {
    commandState = {
      ...commandState,
      session: null,
      error: "no active local live workspace",
    };

    const html = renderToString(React.createElement(ControlRoomShell, { initialWorkspaceMode: "study" }));

    expect(html).toContain("No active workspace");
    expect(html).not.toContain("workspace-docking-shell");
    expect(html).not.toContain("Initializing Workspace");
  });
});
