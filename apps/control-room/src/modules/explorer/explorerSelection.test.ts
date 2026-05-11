import { describe, expect, it } from "vitest";

import { ControlRoomApi } from "@/kernel/api/ControlRoomApi";
import { RequestDiagnosticsController } from "@/kernel/api/RequestDiagnosticsController";
import { CommandRegistry } from "@/kernel/commands/CommandRegistry";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { LayoutController } from "@/kernel/layout/LayoutController";
import { ModuleRegistry } from "@/kernel/module/ModuleRegistry";
import { RealtimeInvalidationBridge } from "@/kernel/realtime/RealtimeInvalidationBridge";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import { SelectionController } from "@/kernel/selection/SelectionController";
import type { KernelApi } from "@/kernel/types";

import { selectExplorerNode } from "./explorerSelection";
import type { ExplorerNode } from "./explorerTypes";

function makeKernel(): KernelApi {
  const bus = new EventBus<KernelEventMap>();
  const resources = new ResourceInvalidationController(bus);
  const commands = new CommandRegistry();
  commands.attach(bus);

  return {
    api: new ControlRoomApi({ fetchImpl: async () => new Response("{}") }),
    bus,
    commands,
    diagnostics: new RequestDiagnosticsController(),
    layout: new LayoutController(bus),
    modules: new ModuleRegistry(),
    realtime: new RealtimeInvalidationBridge(resources),
    resources,
    selection: new SelectionController(bus),
  };
}

describe("selectExplorerNode", () => {
  it("sets kernel selection and emits workspace selection change", () => {
    const kernel = makeKernel();
    const events: KernelEventMap["workspace:selection-changed"][] = [];
    kernel.bus.on("workspace:selection-changed", (event) => events.push(event));

    const node: ExplorerNode = {
      id: "model:object:free-layer",
      kind: "object.root",
      label: "Free layer",
      parentId: "model:objects",
      objectId: "free-layer",
    };

    selectExplorerNode(kernel, node, "explorer");

    expect(kernel.selection.get()).toMatchObject({
      nodeId: "model:object:free-layer",
      objectId: "free-layer",
      kind: "object.root",
      label: "Free layer",
      moduleSource: "explorer",
    });
    expect(events).toEqual([
      {
        selectionId: "free-layer",
        source: "explorer",
      },
    ]);
  });
});
