import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ControlRoomApi } from "../api/ControlRoomApi";
import { RequestDiagnosticsController } from "../api/RequestDiagnosticsController";
import { CommandRegistry } from "../commands/CommandRegistry";
import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import { KernelContext } from "../KernelContext";
import { ModuleRegistry } from "../module/ModuleRegistry";
import { RealtimeInvalidationBridge } from "../realtime/RealtimeInvalidationBridge";
import { ResourceInvalidationController } from "../resources/ResourceInvalidationController";
import { SelectionController } from "../selection/SelectionController";
import type { KernelApi } from "../types";

import { LayoutController } from "./LayoutController";
import { WorkspaceDockLayout } from "./WorkspaceDockLayout";

function makeKernel(): KernelApi {
  const bus = new EventBus<KernelEventMap>();
  const resources = new ResourceInvalidationController(bus);
  return {
    api: new ControlRoomApi({ fetchImpl: async () => new Response("{}") }),
    bus,
    commands: new CommandRegistry(),
    diagnostics: new RequestDiagnosticsController(),
    layout: new LayoutController(bus),
    modules: new ModuleRegistry(),
    realtime: new RealtimeInvalidationBridge(resources),
    resources,
    selection: new SelectionController(bus),
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
    expect(html).not.toContain("data-panel=\"true\"");
    expect(html).not.toContain("DndDescribedBy");
  });
});
