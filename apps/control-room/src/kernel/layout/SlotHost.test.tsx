import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ControlRoomApi } from "../api/ControlRoomApi";
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

function makeKernel(): KernelApi {
  const bus = new EventBus<KernelEventMap>();
  const resources = new ResourceInvalidationController(bus);
  return {
    api: new ControlRoomApi({ fetchImpl: async () => new Response("{}") }),
    bus,
    commands: new CommandRegistry(),
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
});
