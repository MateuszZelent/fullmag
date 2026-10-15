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
import { ObjectMoveToolController } from "../authoring/ObjectMoveToolController";
import { ObjectEditSessionController } from "../authoring/object-edit/ObjectEditSessionController";
import type { KernelApi } from "../types";
import { AnalysisFieldOverlayController } from "../visualization/AnalysisFieldOverlayController";
import { ModeCompositionController } from "../visualization/ModeCompositionController";
import { ChartViewportHandoffController } from "@/kernel/visualization/ChartViewportHandoffController";
import { CameraRegistryController } from "../visualization/CameraRegistryController";
import { ObjectVisualizationController } from "../visualization/ObjectVisualizationController";
import { VisualizationDebugController } from "../visualization/VisualizationDebugController";
import { VisualizationRegistrySyncController } from "../visualization/VisualizationRegistrySyncController";

import { LayoutController } from "./LayoutController";
import { WorkspaceDockLayout } from "./WorkspaceDockLayout";

function TestModule() {
  return <div>Auxiliary viewport</div>;
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

describe("WorkspaceDockLayout", () => {
  it("renders a stable server fallback before client-only dock libraries mount", () => {
    const html = renderToStaticMarkup(
      <KernelContext.Provider value={makeKernel()}>
        <WorkspaceDockLayout />
      </KernelContext.Provider>,
    );

    expect(html).toContain("data-dock-hydration-pending=\"true\"");
    expect(html).toContain("data-slot-id=\"panel-left\"");
    expect(html).not.toContain("data-slot-id=\"viewport-aux\"");
    expect(html).not.toContain("data-panel=\"true\"");
    expect(html).not.toContain("DndDescribedBy");
  });

  it("renders the auxiliary viewport fallback when a module is registered for viewport-aux", () => {
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
        <WorkspaceDockLayout />
      </KernelContext.Provider>,
    );

    expect(html).toContain("data-dock-hydration-pending=\"true\"");
    expect(html).toContain("data-slot-id=\"viewport-main\"");
    expect(html).toContain("data-slot-id=\"viewport-aux\"");
  });

  it("keeps workspace dock panels interactive", () => {
    const html = renderToStaticMarkup(
      <KernelContext.Provider value={makeKernel()}>
        <WorkspaceDockLayout />
      </KernelContext.Provider>,
    );

    const workspaceBodyTag = html.match(
      /<div[^>]*class="fm-workspace-body"[^>]*>/,
    )?.[0];
    const dockColumnTags = Array.from(
      html.matchAll(/<div[^>]*class="fm-dock-column"[^>]*>/g),
      (match) => match[0],
    );

    expect(html).toContain("data-slot-id=\"viewport-main\"");
    expect(html).not.toContain(" inert");
    expect(workspaceBodyTag).toBeDefined();
    expect(workspaceBodyTag ?? "").not.toMatch(/\s(?:inert|aria-hidden)(?:=|\s|>)/);
    expect(dockColumnTags.length).toBeGreaterThan(0);
    for (const tag of dockColumnTags) {
      expect(tag).not.toMatch(/\s(?:inert|aria-hidden)(?:=|\s|>)/);
    }
  });

  it("keeps diagnostics in the existing bottom panel without mounting a second slot", () => {
    const kernel = makeKernel();
    kernel.layout.openBottomPanel("diagnostics");

    const html = renderToStaticMarkup(
      <KernelContext.Provider value={kernel}>
        <WorkspaceDockLayout />
      </KernelContext.Provider>,
    );

    expect(html).not.toContain("data-startup-diagnostics");
    expect(html.match(/data-slot-id="panel-bottom"/g)).toHaveLength(1);
    const bottomPanelTag = html.match(
      /<div[^>]*class="fm-workspace-bottom-panel"[^>]*>/,
    )?.[0];
    expect(bottomPanelTag).toBeDefined();
    expect(bottomPanelTag).not.toContain("inert");
  });
});
