import { describe, expect, it } from "vitest";

import { ControlRoomApi } from "@/kernel/api/ControlRoomApi";
import { RequestDiagnosticsController } from "@/kernel/api/RequestDiagnosticsController";
import { CommandDiagnosticsController } from "@/kernel/commands/CommandDiagnosticsController";
import { CommandRegistry } from "@/kernel/commands/CommandRegistry";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { LayoutController } from "@/kernel/layout/LayoutController";
import { ModuleRegistry } from "@/kernel/module/ModuleRegistry";
import { RealtimeInvalidationBridge } from "@/kernel/realtime/RealtimeInvalidationBridge";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import { SelectionController } from "@/kernel/selection/SelectionController";
import type { KernelApi } from "@/kernel/types";
import { CameraRegistryController } from "@/kernel/visualization/CameraRegistryController";
import { ObjectVisualizationController } from "@/kernel/visualization/ObjectVisualizationController";
import { VisualizationRegistrySyncController } from "@/kernel/visualization/VisualizationRegistrySyncController";

import { selectExplorerNode } from "./explorerSelection";
import type { ExplorerNode } from "./explorerTypes";

function makeKernel(): KernelApi {
  const bus = new EventBus<KernelEventMap>();
  const resources = new ResourceInvalidationController(bus);
  const commands = new CommandRegistry();
  commands.attach(bus);

  const api = new ControlRoomApi({ fetchImpl: async () => new Response("{}") });
  return {
    api,
    bus,
    cameraRegistry: new CameraRegistryController({ api: api.visualization }),
    commandDiagnostics: new CommandDiagnosticsController(),
    commands,
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
      ref: {
        kind: "object.root",
        nodeId: "model:object:free-layer",
        objectId: "free-layer",
        type: "scene-object",
        visualizationTargetId: "object:free-layer",
      },
    });
    expect(events).toEqual([
      {
        selectionId: "free-layer",
        source: "explorer",
      },
    ]);
  });

  it("selects Airbox mesh policy nodes as inspector-only airbox selections", () => {
    const kernel = makeKernel();
    const node: ExplorerNode = {
      id: "model:airbox:mesh",
      kind: "airbox.mesh",
      label: "Airbox Mesh Policy",
      parentId: "model:universe",
    };

    selectExplorerNode(kernel, node, "explorer");

    expect(kernel.selection.get()).toMatchObject({
      kind: "airbox.mesh",
      label: "Airbox Mesh Policy",
      nodeId: "model:airbox:mesh",
      objectId: null,
      ref: {
        kind: "airbox.mesh",
        nodeId: "model:airbox:mesh",
        type: "airbox",
        visualizationTargetId: "airbox",
      },
    });
  });

  it("selects object authoring child groups as scene-object selections", () => {
    const kernel = makeKernel();
    const node: ExplorerNode = {
      id: "model:object:free-layer:magnetic-texture",
      kind: "object.magnetic-texture",
      label: "Magnetic Texture",
      objectId: "free-layer",
      parentId: "model:object:free-layer",
    };

    selectExplorerNode(kernel, node, "explorer");

    expect(kernel.selection.get()).toMatchObject({
      kind: "object.magnetic-texture",
      label: "Magnetic Texture",
      nodeId: "model:object:free-layer:magnetic-texture",
      objectId: "free-layer",
      ref: {
        kind: "object.magnetic-texture",
        objectId: "free-layer",
        type: "scene-object",
        visualizationTargetId: "object:free-layer",
      },
    });
  });

  it("selects region magnetic texture nodes as inspector-only region selections", () => {
    const kernel = makeKernel();
    const node: ExplorerNode = {
      id: "model:object:free-layer:regions:primary:magnetic-texture",
      kind: "object.region-magnetic-texture",
      label: "Magnetic Texture",
      objectId: "free-layer",
      parentId: "model:object:free-layer:regions:primary",
      regionId: "region:free-layer",
    };

    selectExplorerNode(kernel, node, "explorer");

    expect(kernel.selection.get()).toMatchObject({
      kind: "object.region-magnetic-texture",
      label: "Magnetic Texture",
      nodeId: "model:object:free-layer:regions:primary:magnetic-texture",
      objectId: "free-layer",
      ref: {
        kind: "object.region-magnetic-texture",
        objectId: "free-layer",
        regionId: "region:free-layer",
        type: "scene-object",
        visualizationTargetId: "object:free-layer",
      },
    });
  });
});
