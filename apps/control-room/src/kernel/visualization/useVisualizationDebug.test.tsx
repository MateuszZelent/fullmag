import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ControlRoomApi } from "../api/ControlRoomApi";
import { RequestDiagnosticsController } from "../api/RequestDiagnosticsController";
import { CommandDiagnosticsController } from "../commands/CommandDiagnosticsController";
import { CommandRegistry } from "../commands/CommandRegistry";
import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import { KernelContext } from "../KernelContext";
import { LayoutController } from "../layout/LayoutController";
import { ModuleRegistry } from "../module/ModuleRegistry";
import { DiagnosticRecorderController } from "../performance/diagnostic-recorder/DiagnosticRecorderController";
import { RealtimeInvalidationBridge } from "../realtime/RealtimeInvalidationBridge";
import { ResourceInvalidationController } from "../resources/ResourceInvalidationController";
import { SelectionController } from "../selection/SelectionController";
import type { KernelApi } from "../types";
import { AnalysisFieldOverlayController } from "./AnalysisFieldOverlayController";
import { CameraRegistryController } from "./CameraRegistryController";
import { ObjectVisualizationController } from "./ObjectVisualizationController";
import { VisualizationDebugController } from "./VisualizationDebugController";
import type { VisualizationDebugSnapshot } from "./visualizationDebugTypes";
import { VisualizationRegistrySyncController } from "./VisualizationRegistrySyncController";
import {
  useVisualizationDebugDemand,
  useVisualizationDebugSnapshots,
} from "./useVisualizationDebug";

function makeKernel(): KernelApi {
  const bus = new EventBus<KernelEventMap>();
  const resources = new ResourceInvalidationController(bus);
  const api = new ControlRoomApi({ fetchImpl: async () => new Response("{}") });
  return {
    api,
    analysisFieldOverlay: new AnalysisFieldOverlayController(),
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

interface HookObservation {
  demand: { expanded: boolean; targetId: string };
  snapshots: readonly VisualizationDebugSnapshot[];
}

function Probe({
  observations,
  targetId,
}: {
  observations: HookObservation[];
  targetId: string;
}) {
  const snapshots = useVisualizationDebugSnapshots(targetId);
  const demand = useVisualizationDebugDemand(targetId);
  observations.push({ demand, snapshots });
  return (
    <output data-expanded={String(demand.expanded)} data-target-id={demand.targetId}>
      {snapshots.length}
    </output>
  );
}

describe("visualization debug external-store hooks", () => {
  it("shares stable empty server snapshots with the initial client getters", () => {
    const kernel = makeKernel();
    const observations: HookObservation[] = [];

    const html = renderToStaticMarkup(
      <KernelContext.Provider value={kernel}>
        <Probe observations={observations} targetId="object:free-layer" />
        <Probe observations={observations} targetId="object:free-layer" />
        <Probe observations={observations} targetId="airbox" />
      </KernelContext.Provider>,
    );

    expect(html).toContain('data-target-id="object:free-layer"');
    expect(html).toContain('data-target-id="airbox"');
    expect(html).not.toContain('data-expanded="true"');
    expect(observations).toHaveLength(3);
    expect(observations[0]!.snapshots).toBe(observations[1]!.snapshots);
    expect(observations[0]!.snapshots).toBe(
      kernel.visualizationDebug.getSnapshots("object:free-layer"),
    );
    expect(observations[0]!.demand).toBe(observations[1]!.demand);
    expect(observations[0]!.demand).toBe(
      kernel.visualizationDebug.getDemandSnapshot("object:free-layer"),
    );
    expect(observations[2]!.demand).toEqual({
      expanded: false,
      targetId: "airbox",
    });
    expect(observations[2]!.demand).not.toBe(observations[0]!.demand);
  });
});
