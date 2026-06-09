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

  it("selects Airbox quality nodes as realized airbox mesh selections", () => {
    const kernel = makeKernel();
    const node: ExplorerNode = {
      id: "model:mesh:airbox-quality",
      kind: "airbox.mesh-quality",
      label: "Airbox Quality",
      parentId: "model:mesh",
    };

    selectExplorerNode(kernel, node, "explorer");

    expect(kernel.selection.get()).toMatchObject({
      kind: "airbox.mesh-quality",
      label: "Airbox Quality",
      nodeId: "model:mesh:airbox-quality",
      objectId: null,
      ref: {
        kind: "airbox.mesh-quality",
        nodeId: "model:mesh:airbox-quality",
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

  it("selects object texture load nodes as scene-object selections", () => {
    const kernel = makeKernel();
    const node: ExplorerNode = {
      id: "model:object:free-layer:magnetic-texture:load",
      kind: "object.magnetic-texture.load",
      label: "Load texture",
      objectId: "free-layer",
      parentId: "model:object:free-layer:magnetic-texture",
    };

    selectExplorerNode(kernel, node, "explorer");

    expect(kernel.selection.get()).toMatchObject({
      kind: "object.magnetic-texture.load",
      label: "Load texture",
      nodeId: "model:object:free-layer:magnetic-texture:load",
      objectId: "free-layer",
      ref: {
        kind: "object.magnetic-texture.load",
        objectId: "free-layer",
        type: "scene-object",
        visualizationTargetId: "object:free-layer",
      },
    });
  });

  it("selects object texture asset and transform nodes as distinct scene-object selections", () => {
    const kernel = makeKernel();
    const assetNode: ExplorerNode = {
      id: "model:object:free-layer:magnetic-texture:asset",
      kind: "object.magnetic-texture.asset",
      label: "Uniform",
      objectId: "free-layer",
      parentId: "model:object:free-layer:magnetic-texture",
    };
    const transformNode: ExplorerNode = {
      id: "model:object:free-layer:magnetic-texture:transform",
      kind: "object.magnetic-texture.transform",
      label: "Texture Transform",
      objectId: "free-layer",
      parentId: "model:object:free-layer:magnetic-texture",
    };

    selectExplorerNode(kernel, assetNode, "explorer");
    expect(kernel.selection.get()).toMatchObject({
      kind: "object.magnetic-texture.asset",
      label: "Uniform",
      ref: {
        kind: "object.magnetic-texture.asset",
        objectId: "free-layer",
        type: "scene-object",
      },
    });

    selectExplorerNode(kernel, transformNode, "explorer");
    expect(kernel.selection.get()).toMatchObject({
      kind: "object.magnetic-texture.transform",
      label: "Texture Transform",
      ref: {
        kind: "object.magnetic-texture.transform",
        objectId: "free-layer",
        type: "scene-object",
      },
    });
  });

  it("selects primary region texture nodes as region-scoped selections", () => {
    const kernel = makeKernel();
    const node: ExplorerNode = {
      id: "model:object:free-layer:regions:primary:texture",
      kind: "object.region.texture",
      label: "Texture",
      objectId: "free-layer",
      parentId: "model:object:free-layer:regions:primary",
      regionId: "region:free-layer",
    };

    selectExplorerNode(kernel, node, "explorer");

    expect(kernel.selection.get()).toMatchObject({
      kind: "object.region.texture",
      label: "Texture",
      nodeId: "model:object:free-layer:regions:primary:texture",
      objectId: "free-layer",
      ref: {
        kind: "object.region.texture",
        objectId: "free-layer",
        regionId: "region:free-layer",
        type: "scene-object",
        visualizationTargetId: "region:free-layer:region%3Afree-layer",
      },
    });
  });

  it("selects region sub-object nodes with region-scoped visualization targets", () => {
    const kernel = makeKernel();
    const node: ExplorerNode = {
      id: "model:object:free-layer:regions:reg-core:visualization",
      kind: "object.region.visualization",
      label: "Visualization",
      objectId: "free-layer",
      parentId: "model:object:free-layer:regions:reg-core",
      regionId: "reg-core",
    };

    selectExplorerNode(kernel, node, "explorer");

    expect(kernel.selection.get()).toMatchObject({
      kind: "object.region.visualization",
      label: "Visualization",
      nodeId: "model:object:free-layer:regions:reg-core:visualization",
      objectId: "free-layer",
      ref: {
        kind: "object.region.visualization",
        objectId: "free-layer",
        regionId: "reg-core",
        type: "scene-object",
        visualizationTargetId: "region:free-layer:reg-core",
      },
    });
  });

  it("selects authored coupling nodes as coupling selections", () => {
    const kernel = makeKernel();
    const node: ExplorerNode = {
      couplingId: "exchange:core-shell",
      id: "model:physics:couplings:exchange:core-shell",
      kind: "physics.coupling",
      label: "core -> shell exchange",
      parentId: "model:physics:couplings",
    };

    selectExplorerNode(kernel, node, "explorer");

    expect(kernel.selection.get()).toMatchObject({
      kind: "physics.coupling",
      label: "core -> shell exchange",
      nodeId: "model:physics:couplings:exchange:core-shell",
      objectId: null,
      ref: {
        couplingId: "exchange:core-shell",
        kind: "physics.coupling",
        nodeId: "model:physics:couplings:exchange:core-shell",
        type: "physics-coupling",
      },
    });
  });

  it("selects saved cross-section parameter rows as the owning 2D plot", () => {
    const kernel = makeKernel();
    const node: ExplorerNode = {
      crossSectionPlotId: "plot-1",
      id: "model:visualizations-2d:plot-1:quality",
      kind: "visualizations-2d.parameter",
      label: "Quality",
      parentId: "model:visualizations-2d:plot-1",
    };

    selectExplorerNode(kernel, node, "explorer");

    expect(kernel.selection.get()).toMatchObject({
      kind: "mesh.cross-section.plot",
      label: "Quality",
      nodeId: "model:visualizations-2d:plot-1:quality",
      objectId: null,
      ref: {
        kind: "mesh.cross-section.plot",
        nodeId: "model:visualizations-2d:plot-1:quality",
        plotId: "plot-1",
        type: "cross-section-plot",
        visualizationTargetId: "cross-section:plot:plot-1",
      },
    });
  });

  it("selects concrete study stage nodes with stage id and index refs", () => {
    const kernel = makeKernel();
    const node: ExplorerNode = {
      id: "model:study:stages:stage:hysteresis-1",
      kind: "study.stage.hysteresis",
      label: "Hysteresis 4",
      parentId: "model:study:stages",
      stageId: "hysteresis-1",
      stageIndex: 3,
    };

    selectExplorerNode(kernel, node, "explorer");

    expect(kernel.selection.get()).toMatchObject({
      kind: "study.stage.hysteresis",
      label: "Hysteresis 4",
      nodeId: "model:study:stages:stage:hysteresis-1",
      objectId: null,
      ref: {
        kind: "study.stage.hysteresis",
        nodeId: "model:study:stages:stage:hysteresis-1",
        stageId: "hysteresis-1",
        stageIndex: 3,
        type: "study-stage",
      },
    });
  });
});
