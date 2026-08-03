import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ControlRoomApi } from "../api/ControlRoomApi";
import { RequestDiagnosticsController } from "../api/RequestDiagnosticsController";
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
import type { KernelApi, ModuleManifest } from "../types";
import { AnalysisFieldOverlayController } from "../visualization/AnalysisFieldOverlayController";
import { ChartViewportHandoffController } from "@/kernel/visualization/ChartViewportHandoffController";
import { CameraRegistryController } from "../visualization/CameraRegistryController";
import { ObjectVisualizationController } from "../visualization/ObjectVisualizationController";
import { VisualizationDebugController } from "../visualization/VisualizationDebugController";
import { VisualizationRegistrySyncController } from "../visualization/VisualizationRegistrySyncController";

import { LayoutController } from "./LayoutController";
import {
  __viewportTabHostTestUtils,
  ViewportTabHost,
} from "./ViewportTabHost";

function TestModule() {
  return <div>Mounted viewport module</div>;
}

function makeManifest(id: string, title: string): ModuleManifest {
  return {
    id,
    title,
    version: "0.1.0",
    slots: ["viewport-main"],
    component: async () => ({ default: TestModule }),
  };
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
    layout: new LayoutController(bus),
    modules: new ModuleRegistry(),
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

describe("ViewportTabHost", () => {
  it("renders tab triggers for all center surfaces but mounts only the active module", () => {
    const kernel = makeKernel();
    kernel.modules.register(makeManifest("viewport-3d-test", "3D"));
    kernel.modules.register(makeManifest("cross-section-image-test", "Section"));
    kernel.modules.register(makeManifest("live-charts-test", "Live Charts"));
    kernel.modules.register(makeManifest("analysis-plots-test", "Plots"));

    for (const activeModuleId of [
      "viewport-3d-test",
      "live-charts-test",
      "analysis-plots-test",
      "viewport-3d-test",
    ]) {
      kernel.layout.setActiveViewportMainModule(activeModuleId);
      const html = renderToStaticMarkup(
        <KernelContext.Provider value={kernel}>
          <ViewportTabHost />
        </KernelContext.Provider>,
      );

      expect(html).toContain(`data-active-module-id="${activeModuleId}"`);
      expect(html).toContain("3D");
      expect(html).toContain("Live Charts");
      expect(html).toContain("Plots");
      expect(html.match(/Loading/g)).toHaveLength(1);
    }
  });

  it("falls back to the first registered center surface when persisted active id is stale", () => {
    const modules = [
      makeManifest("viewport-3d-test", "3D"),
      makeManifest("analysis-plots-test", "Plots"),
    ];

    expect(
      __viewportTabHostTestUtils.selectActiveViewportModule(modules, "deleted")
        ?.id,
    ).toBe("viewport-3d-test");
  });
});
