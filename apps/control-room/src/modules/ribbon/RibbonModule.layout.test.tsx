import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { CommandRegistry } from "@/kernel/commands/CommandRegistry";
import { KernelContext } from "@/kernel/KernelContext";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { LayoutController } from "@/kernel/layout/LayoutController";
import {
  findElement,
  installSimulationPreparationTestDom,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { SelectionController } from "@/kernel/selection/SelectionController";
import type { KernelApi } from "@/kernel/types";

import {
  RIBBON_ANALYSIS_SHOW_CHART_AND_FIELD_COMMAND,
  RIBBON_ANALYSIS_SHOW_CHART_COMMAND,
  RIBBON_ANALYSIS_SHOW_FIELD_COMMAND,
  RIBBON_COMMANDS,
} from "./ribbonCommands";
import RibbonModule from "./RibbonModule";

vi.mock(
  "@/kernel/resources/geometryLifecycleResources",
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import("@/kernel/resources/geometryLifecycleResources")
    >();
    const loading = { data: null, status: "loading" } as never;
    return {
      ...actual,
      useGeometryCapabilitiesResource: () => loading,
      useGeometryValidationResource: () => loading,
      useMeshBuildCurrent: () => loading,
      useMeshBuildLatestSuccessful: () => loading,
      useMeshCapabilitiesResource: () => loading,
      useMeshSemanticsResource: () => loading,
      useMeshSharedDomainManifestResource: () => loading,
      useMeshSummaryResource: () => loading,
      useSceneResource: () => loading,
    };
  },
);

vi.mock("@/kernel/resources/studyRuntimeResources", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/kernel/resources/studyRuntimeResources")
  >();
  const loading = { data: null, status: "loading" } as never;
  return {
    ...actual,
    useCommandQueueResource: () => loading,
    useCommandDetailResource: () => loading,
    useCheckpointCatalogResource: () => loading,
    useFieldCatalogResource: () => loading,
    useQuantityCatalogResource: () => loading,
    useModelReadinessResource: () => loading,
    useSolverStatusResource: () => loading,
    useStageExecutionResource: () => loading,
  };
});

vi.mock(
  "@/kernel/resources/useSessionStatus",
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import("@/kernel/resources/useSessionStatus")
    >();
    return { ...actual, useSessionStatusSelector: <T,>() => null as T };
  },
);

vi.mock(
  "@/kernel/visualization/AnalysisFieldOverlayController",
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import("@/kernel/visualization/AnalysisFieldOverlayController")
    >();
    return { ...actual, useAnalysisFieldOverlay: () => null };
  },
);

vi.mock(
  "@/kernel/visualization/useObjectVisualization",
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import("@/kernel/visualization/useObjectVisualization")
    >();
    return {
      ...actual,
      useObjectVisualizationController: () => ({} as never),
      useObjectVisualizationSelector: <T,>(
        selector: (snapshot: typeof actual.EMPTY_OBJECT_VISUALIZATION_SNAPSHOT) => T,
      ) => selector(actual.EMPTY_OBJECT_VISUALIZATION_SNAPSHOT),
    };
  },
);

vi.mock(
  "@/kernel/visualization/useVisualizationStateResource",
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import("@/kernel/visualization/useVisualizationStateResource")
    >();
    return {
      ...actual,
      useVisualizationStateResource: () =>
        ({ data: null, status: "loading" }) as never,
    };
  },
);

describe("RibbonModule layout-driven active actions", () => {
  it("refreshes Chart, 3D, and Chart + 3D highlights when viewport composition changes", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);

    const bus = new EventBus<KernelEventMap>();
    const layout = new LayoutController(bus);
    layout.setActiveTab("results");
    const selection = new SelectionController(bus);
    selection.set(
      {
        kind: "results.dispersion.k_sampling",
        label: "Dispersion k sampling",
        nodeId: "results:dispersion:k_sampling",
        ref: null,
      },
      "ribbon-layout-test",
    );

    const commands = new CommandRegistry();
    const analysisViewCommandIds = new Set([
      RIBBON_ANALYSIS_SHOW_CHART_COMMAND,
      RIBBON_ANALYSIS_SHOW_FIELD_COMMAND,
      RIBBON_ANALYSIS_SHOW_CHART_AND_FIELD_COMMAND,
    ]);
    for (const command of RIBBON_COMMANDS) {
      if (analysisViewCommandIds.has(command.id)) commands.register(command);
    }

    const kernel = {
      api: { visualization: {} },
      analysisFieldOverlay: {},
      bus,
      commands,
      layout,
      objectMoveTool: {
        getSnapshot: () => null,
        subscribe: () => () => undefined,
      },
      resources: {},
      selection,
      visualization: {},
    } as unknown as KernelApi;
    const root = createRoot(container as unknown as Element);
    const renderRibbon = () => (
      <KernelContext.Provider value={kernel}>
        <RibbonModule
          config={{}}
          kernel={kernel}
          moduleId="ribbon"
          setConfig={() => undefined}
          slotId="ribbon"
        />
      </KernelContext.Provider>
    );
    const activeState = (actionId: string) =>
      findElement(
        container,
        (element) => element.getAttribute("data-action-id") === actionId,
        `${actionId} ribbon action`,
      ).getAttribute("data-active");

    try {
      await act(async () => root.render(renderRibbon()));
      expect([
        activeState("analysis-show-chart"),
        activeState("analysis-show-field"),
        activeState("analysis-show-chart-and-field"),
      ]).toEqual(["false", "true", "false"]);

      await act(async () => layout.setActiveViewportMainModule("analysis-plots"));
      expect([
        activeState("analysis-show-chart"),
        activeState("analysis-show-field"),
        activeState("analysis-show-chart-and-field"),
      ]).toEqual(["true", "false", "false"]);

      await act(async () =>
        layout.setViewportCompanion({ moduleId: "viewport-3d", placement: "beside" }),
      );
      expect([
        activeState("analysis-show-chart"),
        activeState("analysis-show-field"),
        activeState("analysis-show-chart-and-field"),
      ]).toEqual(["false", "false", "true"]);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
