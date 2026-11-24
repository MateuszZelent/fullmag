import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { ControlRoomApi } from "../api/ControlRoomApi";
import { RequestDiagnosticsController } from "../api/RequestDiagnosticsController";
import { ObjectEditSessionController } from "../authoring/object-edit/ObjectEditSessionController";
import { ObjectMoveToolController } from "../authoring/ObjectMoveToolController";
import { CommandDiagnosticsController } from "../commands/CommandDiagnosticsController";
import { CommandRegistry } from "../commands/CommandRegistry";
import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import { KernelContext } from "../KernelContext";
import { ModuleRegistry } from "../module/ModuleRegistry";
import { DiagnosticRecorderController } from "../performance/diagnostic-recorder/DiagnosticRecorderController";
import { RealtimeConnectionController } from "../realtime/RealtimeConnectionController";
import { RealtimeInvalidationBridge } from "../realtime/RealtimeInvalidationBridge";
import { ResourceInvalidationController } from "../resources/ResourceInvalidationController";
import { SelectionController } from "../selection/SelectionController";
import type { KernelApi } from "../types";
import { AnalysisFieldOverlayController } from "../visualization/AnalysisFieldOverlayController";
import { CameraRegistryController } from "../visualization/CameraRegistryController";
import { ChartViewportHandoffController } from "../visualization/ChartViewportHandoffController";
import { ModeCompositionController } from "../visualization/ModeCompositionController";
import { ObjectVisualizationController } from "../visualization/ObjectVisualizationController";
import { VisualizationDebugController } from "../visualization/VisualizationDebugController";
import { VisualizationRegistrySyncController } from "../visualization/VisualizationRegistrySyncController";
import { setViewport3DInspectorContext } from "@/modules/viewport-3d/public";
import { resetExplorerStoreForTests } from "@/modules/explorer/explorerStore";
import { sessionErrorStore } from "../diagnostics/sessionErrorStore";

import { LayoutController } from "./LayoutController";
import {
  findElement,
  findElements,
  installSimulationPreparationTestDom,
} from "./simulationPreparationTestDom.test-support";
import { WorkspaceSideRail } from "./WorkspaceSideRail";

function makeKernel(): KernelApi {
  const bus = new EventBus<KernelEventMap>();
  const resources = new ResourceInvalidationController(bus);
  const api = new ControlRoomApi({ fetchImpl: async () => new Response("{}") });
  return {
    api,
    analysisFieldOverlay: new AnalysisFieldOverlayController(),
    chartViewportHandoff: new ChartViewportHandoffController(),
    bus,
    cameraRegistry: new CameraRegistryController({ api: api.visualization }),
    commandDiagnostics: new CommandDiagnosticsController(),
    commands: new CommandRegistry(),
    diagnostics: new RequestDiagnosticsController(),
    diagnosticRecorder: new DiagnosticRecorderController({
      config: { enabled: false },
    }),
    layout: new LayoutController(bus),
    modules: new ModuleRegistry(),
    objectEditSession: new ObjectEditSessionController(),
    objectMoveTool: new ObjectMoveToolController(),
    modeComposition: new ModeCompositionController({
      getActiveModeComposition: (options) =>
        api.visualization.modeComposition.active(options),
      patchActiveModeComposition: (patch, options) =>
        api.visualization.modeComposition.patch(patch, options),
    }),
    realtime: new RealtimeInvalidationBridge(resources),
    realtimeConnection: new RealtimeConnectionController(),
    resources,
    selection: new SelectionController(bus),
    visualization: new ObjectVisualizationController(),
    visualizationDebug: new VisualizationDebugController(),
    visualizationSync: new VisualizationRegistrySyncController({
      api: api.visualization,
      resources,
    }),
  };
}

afterEach(() => {
  setViewport3DInspectorContext("selection");
  resetExplorerStoreForTests();
  sessionErrorStore.resetForTests();
});

describe("WorkspaceSideRail (right)", () => {
  it("exposes Selection, 3D View and Export tabs and toggles the right panel", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const kernel = makeKernel();

    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel}>
            <WorkspaceSideRail side="right" />
          </KernelContext.Provider>,
        );
      });

      const items = findElements(
        container,
        (element) => element.getAttribute("data-rail-item") !== null,
      ).map((element) => element.getAttribute("data-rail-item"));
      expect(items.slice(0, 3)).toEqual(["selection", "view", "export"]);

      const exportButton = findElement(
        container,
        (element) => element.getAttribute("data-rail-item") === "export",
        "export rail item",
      );
      expect(exportButton.getAttribute("aria-label")).toBe("Export");
      expect(exportButton.getAttribute("aria-pressed")).toBe("false");

      await act(async () => {
        exportButton.click();
      });
      expect(exportButton.getAttribute("data-active")).toBe("true");
      expect(exportButton.getAttribute("aria-pressed")).toBe("true");
      expect(kernel.layout.get().panelVisible.right).toBe(true);

      // Clicking the active rail item collapses the panel; clicking again reopens it.
      await act(async () => {
        exportButton.click();
      });
      expect(kernel.layout.get().panelVisible.right).toBe(false);
      expect(exportButton.getAttribute("aria-pressed")).toBe("false");

      await act(async () => {
        exportButton.click();
      });
      expect(kernel.layout.get().panelVisible.right).toBe(true);
      expect(exportButton.getAttribute("aria-pressed")).toBe("true");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

describe("WorkspaceSideRail (left)", () => {
  it("exposes Helper and Errors tabs and displays a live badge when errors are recorded", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const kernel = makeKernel();

    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel}>
            <WorkspaceSideRail side="left" />
          </KernelContext.Provider>,
        );
      });

      const items = findElements(
        container,
        (element) => element.getAttribute("data-rail-item") !== null,
      ).map((element) => element.getAttribute("data-rail-item"));
      expect(items).toEqual([
        "model",
        "resources",
        "results",
        "jobs",
        "diagnostics",
        "helper",
        "errors",
      ]);

      const errorsButton = findElement(
        container,
        (element) => element.getAttribute("data-rail-item") === "errors",
        "errors rail item",
      );
      expect(errorsButton.getAttribute("data-error-count")).toBeNull();

      await act(async () => {
        sessionErrorStore.record({
          category: "backend",
          code: "COMMAND_FAILED",
          message: "Air domain required",
          source: "backend:mesh_build",
          title: "mesh_build failed",
        });
      });

      expect(errorsButton.getAttribute("data-error-count")).toBe("1");
      expect(errorsButton.getAttribute("aria-label")).toBe(
        "Errors (1 error recorded)",
      );

      const helperButton = findElement(
        container,
        (element) => element.getAttribute("data-rail-item") === "helper",
        "helper rail item",
      );
      await act(async () => {
        helperButton.click();
      });
      expect(helperButton.getAttribute("data-active")).toBe("true");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
