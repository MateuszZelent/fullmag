import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ControlRoomApi } from "../api/ControlRoomApi";
import { RequestDiagnosticsController } from "../api/RequestDiagnosticsController";
import { CommandDiagnosticsController } from "../commands/CommandDiagnosticsController";
import { CommandRegistry } from "../commands/CommandRegistry";
import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import { KernelContext } from "../KernelContext";
import { LayoutController } from "./LayoutController";
import { ModuleRegistry } from "../module/ModuleRegistry";
import { DiagnosticRecorderController } from "../performance/diagnostic-recorder/DiagnosticRecorderController";
import { RealtimeConnectionController } from "../realtime/RealtimeConnectionController";
import { RealtimeInvalidationBridge } from "../realtime/RealtimeInvalidationBridge";
import { ResourceInvalidationController } from "../resources/ResourceInvalidationController";
import { SelectionController } from "../selection/SelectionController";
import type { KernelApi, ModuleManifest } from "../types";
import { AnalysisFieldOverlayController } from "../visualization/AnalysisFieldOverlayController";
import { ModeCompositionController } from "../visualization/ModeCompositionController";
import { ChartViewportHandoffController } from "@/kernel/visualization/ChartViewportHandoffController";
import { CameraRegistryController } from "../visualization/CameraRegistryController";
import { ObjectVisualizationController } from "../visualization/ObjectVisualizationController";
import { VisualizationDebugController } from "../visualization/VisualizationDebugController";
import { VisualizationRegistrySyncController } from "../visualization/VisualizationRegistrySyncController";
import { viewport3dManifest } from "@/modules/viewport-3d/manifest";

import { resolveSlotModuleManifest, SlotHost } from "./SlotHost";

function TestModule() {
  return <div>Auto-discovered module</div>;
}

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
    modules: new ModuleRegistry(),
    realtime: new RealtimeInvalidationBridge(resources),
    realtimeConnection: new RealtimeConnectionController(),
    resources,
    selection: new SelectionController(bus),
    layout: new LayoutController(bus),
    modeComposition: new ModeCompositionController({
      getActiveModeComposition: (options) =>
        api.visualization.modeComposition.active(options),
      patchActiveModeComposition: (patch, options) =>
        api.visualization.modeComposition.patch(patch, options),
    }),
    visualization: new ObjectVisualizationController(),
    visualizationDebug: new VisualizationDebugController(),
    visualizationSync: new VisualizationRegistrySyncController({
      api: api.visualization,
      resources,
    }),
  };
}

describe("SlotHost", () => {
  it("activates a shared panel module from the canonical Results ribbon tab", () => {
    const explorer: ModuleManifest = {
      id: "explorer",
      title: "Explorer",
      version: "0.1.0",
      slots: ["panel-left"],
      component: async () => ({ default: TestModule }),
    };
    const results: ModuleManifest = {
      ...explorer,
      activationTab: "results" as const,
      id: "results-navigator",
      title: "Results",
    };

    expect(resolveSlotModuleManifest([explorer, results], "results")?.id).toBe(
      "results-navigator",
    );
    expect(resolveSlotModuleManifest([explorer, results], "home")?.id).toBe(
      "explorer",
    );
  });

  it("renders an empty slot fallback when no module is active", () => {
    const kernel = makeKernel();
    const html = renderToStaticMarkup(
      <KernelContext.Provider value={kernel}>
        <SlotHost slotId="panel-left" moduleManifest={null} />
      </KernelContext.Provider>,
    );

    expect(html).toContain("data-slot-id=\"panel-left\"");
    expect(html).toContain("No module mounted");
  });

  it("auto-discovers the first module registered for a slot", () => {
    const kernel = makeKernel();
    kernel.modules.register({
      id: "auto-test",
      title: "Auto Test",
      version: "0.1.0",
      slots: ["panel-left"],
      component: async () => ({ default: TestModule }),
    });

    const html = renderToStaticMarkup(
      <KernelContext.Provider value={kernel}>
        <SlotHost slotId="panel-left" />
      </KernelContext.Provider>,
    );

    expect(html).toContain("data-slot-id=\"panel-left\"");
    expect(html).toContain("Loading");
    expect(html).not.toContain("No module mounted");
  });

  it("auto-discovers the registered 3D viewport module for viewport-main", () => {
    const kernel = makeKernel();
    kernel.modules.register(viewport3dManifest);

    const html = renderToStaticMarkup(
      <KernelContext.Provider value={kernel}>
        <SlotHost slotId="viewport-main" />
      </KernelContext.Provider>,
    );

    expect(html).toContain("data-slot-id=\"viewport-main\"");
    expect(html).toContain("Loading");
    expect(html).not.toContain("No module mounted");
  });

  it("auto-discovers a module registered only for viewport-aux", () => {
    const kernel = makeKernel();
    kernel.modules.register({
      id: "viewport-aux-test",
      title: "2D Test",
      version: "0.1.0",
      slots: ["viewport-aux"],
      component: async () => ({ default: TestModule }),
    });

    const html = renderToStaticMarkup(
      <KernelContext.Provider value={kernel}>
        <SlotHost slotId="viewport-aux" />
      </KernelContext.Provider>,
    );

    expect(html).toContain("data-slot-id=\"viewport-aux\"");
    expect(html).toContain("Loading");
    expect(html).not.toContain("No module mounted");
  });
});
