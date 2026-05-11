import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ControlRoomApi } from "../api/ControlRoomApi";
import { RequestDiagnosticsController } from "../api/RequestDiagnosticsController";
import { CommandRegistry } from "../commands/CommandRegistry";
import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import { KernelContext } from "../KernelContext";
import { LayoutController } from "./LayoutController";
import { ModuleRegistry } from "../module/ModuleRegistry";
import { RealtimeInvalidationBridge } from "../realtime/RealtimeInvalidationBridge";
import { ResourceInvalidationController } from "../resources/ResourceInvalidationController";
import { SelectionController } from "../selection/SelectionController";
import type { KernelApi } from "../types";

import { SlotHost } from "./SlotHost";

function TestModule() {
  return <div>Auto-discovered module</div>;
}

function makeKernel(): KernelApi {
  const bus = new EventBus<KernelEventMap>();
  const resources = new ResourceInvalidationController(bus);
  return {
    api: new ControlRoomApi({ fetchImpl: async () => new Response("{}") }),
    bus,
    commands: new CommandRegistry(),
    diagnostics: new RequestDiagnosticsController(),
    modules: new ModuleRegistry(),
    realtime: new RealtimeInvalidationBridge(resources),
    resources,
    selection: new SelectionController(bus),
    layout: new LayoutController(bus),
  };
}

describe("SlotHost", () => {
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
});
