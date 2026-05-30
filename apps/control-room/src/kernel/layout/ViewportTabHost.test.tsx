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
import { RealtimeInvalidationBridge } from "../realtime/RealtimeInvalidationBridge";
import { ResourceInvalidationController } from "../resources/ResourceInvalidationController";
import { SelectionController } from "../selection/SelectionController";
import type { KernelApi, ModuleManifest } from "../types";
import { CameraRegistryController } from "../visualization/CameraRegistryController";
import { ObjectVisualizationController } from "../visualization/ObjectVisualizationController";
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
    bus,
    cameraRegistry: new CameraRegistryController({ api: api.visualization }),
    commandDiagnostics: new CommandDiagnosticsController(),
    commands: new CommandRegistry(),
    diagnostics: new RequestDiagnosticsController(),
    layout: new LayoutController(bus),
    modules: new ModuleRegistry(),
    realtime: new RealtimeInvalidationBridge(resources),
    resources,
    selection: new SelectionController(bus),
    visualization: new ObjectVisualizationController(),
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
    kernel.modules.register(makeManifest("analysis-plots-test", "Plots"));
    kernel.layout.setActiveViewportMainModule("cross-section-image-test");

    const html = renderToStaticMarkup(
      <KernelContext.Provider value={kernel}>
        <ViewportTabHost />
      </KernelContext.Provider>,
    );

    expect(html).toContain('data-active-module-id="cross-section-image-test"');
    expect(html).toContain("3D");
    expect(html).toContain("Section");
    expect(html).toContain("Plots");
    expect(html.match(/Loading/g)).toHaveLength(1);
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
