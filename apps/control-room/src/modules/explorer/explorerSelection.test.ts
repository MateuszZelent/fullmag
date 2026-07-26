import { describe, expect, it } from "vitest";

import { ControlRoomApi } from "@/kernel/api/ControlRoomApi";
import {
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
  DATA_FIELD_VECTOR_PATH,
  MESHING_PERIODIC_PAIRS_PATH,
} from "@/kernel/api/apiPaths";
import { RequestDiagnosticsController } from "@/kernel/api/RequestDiagnosticsController";
import { CommandDiagnosticsController } from "@/kernel/commands/CommandDiagnosticsController";
import { CommandRegistry } from "@/kernel/commands/CommandRegistry";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { LayoutController } from "@/kernel/layout/LayoutController";
import { ModuleRegistry } from "@/kernel/module/ModuleRegistry";
import { DiagnosticRecorderController } from "@/kernel/performance/diagnostic-recorder/DiagnosticRecorderController";
import { RealtimeConnectionController } from "@/kernel/realtime/RealtimeConnectionController";
import { RealtimeInvalidationBridge } from "@/kernel/realtime/RealtimeInvalidationBridge";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import { SelectionController } from "@/kernel/selection/SelectionController";
import type { KernelApi } from "@/kernel/types";
import { AnalysisFieldOverlayController } from "@/kernel/visualization/AnalysisFieldOverlayController";
import { ChartViewportHandoffController } from "@/kernel/visualization/ChartViewportHandoffController";
import { CameraRegistryController } from "@/kernel/visualization/CameraRegistryController";
import { ObjectVisualizationController } from "@/kernel/visualization/ObjectVisualizationController";
import { VisualizationDebugController } from "@/kernel/visualization/VisualizationDebugController";
import { VisualizationRegistrySyncController } from "@/kernel/visualization/VisualizationRegistrySyncController";

import { selectExplorerNode } from "./explorerSelection";
import type { ExplorerNode } from "./explorerTypes";

function snapshotVectorResourceKey(snapshotId: string): string {
  return `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?component=full&scope_kind=full&snapshot_id=${snapshotId}`;
}

function analysisFieldVectorResourceKey(fieldId: string): string {
  return `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", fieldId)}?view=phase_rotated_real&phase_rad=0`;
}

function makeKernel(): KernelApi {
  const bus = new EventBus<KernelEventMap>();
  const resources = new ResourceInvalidationController(bus);
  const commands = new CommandRegistry();
  commands.attach(bus);

  const api = new ControlRoomApi({ fetchImpl: async () => new Response("{}") });
  return {
    api,
    analysisFieldOverlay: new AnalysisFieldOverlayController(),
  chartViewportHandoff: new ChartViewportHandoffController(),
    bus,
    cameraRegistry: new CameraRegistryController({ api: api.visualization }),
    commandDiagnostics: new CommandDiagnosticsController(),
    commands,
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

describe("selectExplorerNode", () => {
  it("selects an orphan mesh fallback using its Explorer address and carrier metadata", () => {
    const kernel = makeKernel();
    const node: ExplorerNode = {
      id: "model:mesh:unassigned:part%3Aorphan",
      kind: "mesh.unassigned.part",
      label: "Recovered volume",
      meshPartId: "part:orphan",
      visualizationTargetId: "part:part:orphan",
      parentId: "model:mesh:unassigned",
    };

    selectExplorerNode(kernel, node, "explorer");

    expect(kernel.selection.get()).toMatchObject({
      kind: "mesh-part",
      nodeId: node.id,
      ref: {
        carrierPartId: "part:orphan",
        kind: "mesh-part",
        nodeId: node.id,
        objectId: null,
        type: "mesh-part",
        visualizationTargetId: "part:part:orphan",
      },
    });
  });

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

  it.each([
    ["airbox.root", "model:airbox"],
    ["airbox.mesh.parameters", "model:airbox:mesh:parameters"],
    ["airbox.mesh.quality-gates", "model:airbox:mesh:quality-gates"],
    ["airbox.mesh.statistics", "model:airbox:mesh:statistics"],
    ["airbox.mesh.topology", "model:airbox:mesh:topology"],
    ["airbox.mesh.build", "model:airbox:mesh:build"],
    ["airbox.visualization.debug", "model:airbox:visualization:debug"],
  ] as const)("selects %s with canonical Airbox identity", (kind, id) => {
    const kernel = makeKernel();
    const node: ExplorerNode = {
      id,
      kind,
      label: kind,
      parentId: "model:airbox",
    };

    selectExplorerNode(kernel, node, "explorer");

    expect(kernel.selection.get()).toMatchObject({
      kind,
      nodeId: id,
      objectId: null,
      ref: {
        kind,
        nodeId: id,
        type: "airbox",
        visualizationTargetId: "airbox",
      },
    });
  });

  it("canonicalizes object visualization Debug targets ending in _geom", () => {
    const kernel = makeKernel();
    const node: ExplorerNode = {
      id: "model:object:free-layer_geom:visualization:debug",
      kind: "object.visualization.debug",
      label: "Debug",
      objectId: "free-layer_geom",
      parentId: "model:object:free-layer_geom:visualization",
    };

    selectExplorerNode(kernel, node, "explorer");

    expect(kernel.selection.get().ref).toEqual({
      kind: "object.visualization.debug",
      nodeId: node.id,
      objectId: "free-layer_geom",
      type: "scene-object",
      visualizationTargetId: "object:free-layer",
    });
  });

  it("URL-encodes region visualization Debug target IDs", () => {
    const kernel = makeKernel();
    const node: ExplorerNode = {
      id: "model:object:free-layer:regions:core:visualization:debug",
      kind: "object.region.visualization.debug",
      label: "Debug",
      objectId: "free-layer",
      parentId: "model:object:free-layer:regions:core:visualization",
      regionId: "core/shell:top",
    };

    selectExplorerNode(kernel, node, "explorer");

    expect(kernel.selection.get().ref).toEqual({
      kind: "object.region.visualization.debug",
      nodeId: node.id,
      objectId: "free-layer",
      regionId: "core/shell:top",
      type: "scene-object",
      visualizationTargetId: "region:free-layer:core%2Fshell%3Atop",
    });
  });

  it("selects hysteresis snapshot nodes as replayable snapshot selections", () => {
    const kernel = makeKernel();
    const node: ExplorerNode = {
      id: "model:study:stages:stage:hysteresis-1:field-point:7:snapshot:hysteresis_point_007",
      kind: "study.stage.action",
      label: "Snapshot hysteresis_point_007",
      parentId: "model:study:stages:stage:hysteresis-1:field-point:7",
      hysteresisPointId: 7,
      hysteresisSnapshotId: "hysteresis_point_007",
      resourceRef: snapshotVectorResourceKey("hysteresis_point_007"),
      stageId: "hysteresis-1",
      stageIndex: 0,
    };

    selectExplorerNode(kernel, node, "explorer");

    expect(kernel.selection.get()).toMatchObject({
      kind: "study.stage.action",
      label: "Snapshot hysteresis_point_007",
      nodeId:
        "model:study:stages:stage:hysteresis-1:field-point:7:snapshot:hysteresis_point_007",
      objectId: null,
      ref: {
        kind: "study.stage.action",
        nodeId:
          "model:study:stages:stage:hysteresis-1:field-point:7:snapshot:hysteresis_point_007",
        pointId: 7,
        quantityId: "m",
        resourceRef: snapshotVectorResourceKey("hysteresis_point_007"),
        snapshotId: "hysteresis_point_007",
        stageId: "hysteresis-1",
        stageIndex: 0,
        targetId: "hysteresis-step:hysteresis-1:7",
        type: "hysteresis-snapshot",
      },
    });
  });

  it("preserves hysteresis snapshot replay metadata for viewport compatibility checks", () => {
    const kernel = makeKernel();
    const node: ExplorerNode = {
      id: "model:study:stages:stage:hysteresis-1:field-point:7:snapshot:hysteresis_point_007",
      kind: "study.stage.action",
      label: "Snapshot hysteresis_point_007",
      parentId: "model:study:stages:stage:hysteresis-1:field-point:7",
      fieldOrientation: JSON.stringify({ kind: "preset", preset_name: "in_plane_x" }),
      fieldRevision: 12,
      hysteresisPointId: 7,
      hysteresisSnapshotId: "hysteresis_point_007",
      measurementAxis: JSON.stringify({ kind: "custom", vector: [1, 0, 0] }),
      meshIdentity: "study_domain:rev-12",
      resourceRef: snapshotVectorResourceKey("hysteresis_point_007"),
      stageId: "hysteresis-1",
      stageIndex: 0,
    };

    selectExplorerNode(kernel, node, "explorer");

    expect(kernel.selection.get()).toMatchObject({
      ref: {
        fieldOrientation: JSON.stringify({ kind: "preset", preset_name: "in_plane_x" }),
        fieldRevision: 12,
        measurementAxis: JSON.stringify({ kind: "custom", vector: [1, 0, 0] }),
        meshIdentity: "study_domain:rev-12",
        snapshotId: "hysteresis_point_007",
        type: "hysteresis-snapshot",
      },
    });
  });

  it("preserves hysteresis execution-tree metadata on study-stage selections", () => {
    const kernel = makeKernel();
    const node: ExplorerNode = {
      id: "model:study:stages:stage:hysteresis-1:field-point:7:warning:point-7-warnings",
      kind: "study.stage.action",
      label: "2 warning(s)",
      parentId: "model:study:stages:stage:hysteresis-1:field-point:7",
      hysteresisExecutionNodeId: "point-7:warnings",
      hysteresisExecutionNodeKind: "warning",
      hysteresisPointId: 7,
      resourceRef: "analysis/hysteresis/hysteresis-1/points/7",
      stageId: "hysteresis-1",
      stageIndex: 0,
    };

    selectExplorerNode(kernel, node, "explorer");

    expect(kernel.selection.get()).toMatchObject({
      kind: "study.stage.action",
      label: "2 warning(s)",
      nodeId:
        "model:study:stages:stage:hysteresis-1:field-point:7:warning:point-7-warnings",
      objectId: null,
      ref: {
        hysteresisExecutionNodeId: "point-7:warnings",
        hysteresisExecutionNodeKind: "warning",
        hysteresisPointId: 7,
        kind: "study.stage.action",
        nodeId:
          "model:study:stages:stage:hysteresis-1:field-point:7:warning:point-7-warnings",
        resourceRef: "analysis/hysteresis/hysteresis-1/points/7",
        stageId: "hysteresis-1",
        stageIndex: 0,
        type: "study-stage",
      },
    });
  });

  it("preserves frequency-domain response point metadata for inspectors", () => {
    const kernel = makeKernel();
    const node: ExplorerNode = {
      fieldId: "analysis:frequency-response:frequency-0001",
      frequencyIndex: 1,
      id: "results:frequency-response:frequency-points:1",
      kind: "results.frequency_response.frequency_point",
      label: "Frequency 1",
      parentId: "results:frequency-response:frequency-points",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
    };

    selectExplorerNode(kernel, node, "explorer");

    expect(kernel.selection.get()).toMatchObject({
      kind: "results.frequency_response.frequency_point",
      nodeId: "results:frequency-response:frequency-points:1",
      ref: {
        fieldId: "analysis:frequency-response:frequency-0001",
        frequencyIndex: 1,
        kind: "results.frequency_response.frequency_point",
        nodeId: "results:frequency-response:frequency-points:1",
        resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
        type: "frequency-domain",
      },
    });
  });

  it("preserves frequency-domain response observable metadata for inspectors", () => {
    const kernel = makeKernel();
    const node: ExplorerNode = {
      id: "results:frequency-response:observables:mx",
      kind: "results.frequency_response.observable",
      label: "mx",
      observableId: "mx",
      parentId: "results:frequency-response:observables",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
    };

    selectExplorerNode(kernel, node, "explorer");

    expect(kernel.selection.get()).toMatchObject({
      kind: "results.frequency_response.observable",
      nodeId: "results:frequency-response:observables:mx",
      ref: {
        kind: "results.frequency_response.observable",
        nodeId: "results:frequency-response:observables:mx",
        observableId: "mx",
        resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
        type: "frequency-domain",
      },
    });
  });

  it("preserves frequency-domain eigen mode metadata for inspectors and 3D plotting", () => {
    const kernel = makeKernel();
    const node: ExplorerNode = {
      branchId: "branch-0",
      contextCommands: ["analysis.eigen.plot-mode-3d"],
      fieldId: "analysis:eigen:sample-0000:mode-0002",
      id: "results:eigen:sample:0:mode:2",
      kind: "results.eigen.mode",
      label: "Sample 0 Mode 2",
      modeIndex: 2,
      parentId: "results:eigen:modes",
      resourceRef: analysisFieldVectorResourceKey(
        "analysis:eigen:sample-0000:mode-0002",
      ),
      sampleIndex: 0,
    };

    selectExplorerNode(kernel, node, "explorer");

    expect(kernel.selection.get()).toMatchObject({
      kind: "results.eigen.mode",
      nodeId: "results:eigen:sample:0:mode:2",
      ref: {
        branchId: "branch-0",
        fieldId: "analysis:eigen:sample-0000:mode-0002",
        kind: "results.eigen.mode",
        modeIndex: 2,
        nodeId: "results:eigen:sample:0:mode:2",
        resourceRef: analysisFieldVectorResourceKey(
          "analysis:eigen:sample-0000:mode-0002",
        ),
        sampleIndex: 0,
        type: "frequency-domain",
      },
    });
  });

  it("preserves frequency-domain eigen branch metadata for dispersion inspectors", () => {
    const kernel = makeKernel();
    const node: ExplorerNode = {
      branchId: "branch-0",
      calculationMode: "dispersion_modal",
      id: "results:eigen:branches:branch:branch-0",
      kind: "results.eigen.branch",
      label: "acoustic",
      parentId: "results:eigen:branches",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
    };

    selectExplorerNode(kernel, node, "explorer");

    expect(kernel.selection.get()).toMatchObject({
      kind: "results.eigen.branch",
      nodeId: "results:eigen:branches:branch:branch-0",
      ref: {
        branchId: "branch-0",
        calculationMode: "dispersion_modal",
        kind: "results.eigen.branch",
        nodeId: "results:eigen:branches:branch:branch-0",
        resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
        type: "frequency-domain",
      },
    });
  });

  it("preserves FMR spectrum and sweep metadata for chart and inspector routing", () => {
    const kernel = makeKernel();
    const modalNode: ExplorerNode = {
      artifactPath: "eigen/spectrum.v2.json",
      calculationMode: "fmr_modal",
      id: "results:frequency-domain:fmr:modal-spectrum",
      kind: "results.frequency_domain.fmr_modal_spectrum",
      label: "Modal FMR Spectrum",
      parentId: "results:frequency-domain:fmr",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
    };
    const sweepNode: ExplorerNode = {
      artifactPath: "response/magnetic_response_sweep.v2.json",
      calculationMode: "fmr_response",
      id: "results:frequency-domain:fmr:response-sweep",
      kind: "results.frequency_domain.fmr_response_sweep",
      label: "Driven FMR Sweep",
      parentId: "results:frequency-domain:fmr",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
    };

    selectExplorerNode(kernel, modalNode, "explorer");
    expect(kernel.selection.get()).toMatchObject({
      kind: "results.frequency_domain.fmr_modal_spectrum",
      nodeId: "results:frequency-domain:fmr:modal-spectrum",
      ref: {
        artifactPath: "eigen/spectrum.v2.json",
        calculationMode: "fmr_modal",
        kind: "results.frequency_domain.fmr_modal_spectrum",
        nodeId: "results:frequency-domain:fmr:modal-spectrum",
        resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
        type: "frequency-domain",
      },
    });

    selectExplorerNode(kernel, sweepNode, "explorer");
    expect(kernel.selection.get()).toMatchObject({
      kind: "results.frequency_domain.fmr_response_sweep",
      nodeId: "results:frequency-domain:fmr:response-sweep",
      ref: {
        artifactPath: "response/magnetic_response_sweep.v2.json",
        calculationMode: "fmr_response",
        kind: "results.frequency_domain.fmr_response_sweep",
        nodeId: "results:frequency-domain:fmr:response-sweep",
        resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
        type: "frequency-domain",
      },
    });
  });

  it("preserves FMR peak metadata for modal-driven comparison inspectors", () => {
    const kernel = makeKernel();
    const node: ExplorerNode = {
      artifactPath: "response/magnetic_response_sweep.v2.json",
      calculationMode: "fmr_response",
      id: "results:frequency-domain:fmr:peaks",
      kind: "results.frequency_domain.fmr_peaks",
      label: "FMR Peaks",
      parentId: "results:frequency-domain:fmr",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
    };

    selectExplorerNode(kernel, node, "explorer");

    expect(kernel.selection.get()).toMatchObject({
      kind: "results.frequency_domain.fmr_peaks",
      nodeId: "results:frequency-domain:fmr:peaks",
      ref: {
        artifactPath: "response/magnetic_response_sweep.v2.json",
        calculationMode: "fmr_response",
        kind: "results.frequency_domain.fmr_peaks",
        nodeId: "results:frequency-domain:fmr:peaks",
        resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
        type: "frequency-domain",
      },
    });
  });

  it("preserves frequency-domain eigen k-path resource metadata for dispersion inspectors", () => {
    const kernel = makeKernel();
    const node: ExplorerNode = {
      id: "results:eigen:k-path",
      kind: "results.eigen.k_path",
      label: "k-Path",
      parentId: "results:frequency-domain:dispersion",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
    };

    selectExplorerNode(kernel, node, "explorer");

    expect(kernel.selection.get()).toMatchObject({
      kind: "results.eigen.k_path",
      nodeId: "results:eigen:k-path",
      ref: {
        kind: "results.eigen.k_path",
        nodeId: "results:eigen:k-path",
        resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
        type: "frequency-domain",
      },
    });
  });

  it("preserves frequency-domain cancel-requested resource metadata for inspectors", () => {
    const kernel = makeKernel();
    const node: ExplorerNode = {
      artifactPath: "response/cancel_requested.v1.json",
      id: "results:frequency-response:cancel-requested",
      kind: "results.frequency_response.cancel_requested",
      label: "Cancel Requested",
      parentId: "results:frequency-response",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
    };

    selectExplorerNode(kernel, node, "explorer");

    expect(kernel.selection.get()).toMatchObject({
      kind: "results.frequency_response.cancel_requested",
      nodeId: "results:frequency-response:cancel-requested",
      ref: {
        artifactPath: "response/cancel_requested.v1.json",
        kind: "results.frequency_response.cancel_requested",
        nodeId: "results:frequency-response:cancel-requested",
        resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
        type: "frequency-domain",
      },
    });
  });

  it("preserves periodic-pair resource metadata for frequency-domain PBC inspectors", () => {
    const kernel = makeKernel();
    const node: ExplorerNode = {
      id: "resources:mesh:periodic-pairs",
      kind: "resources.mesh.periodic_pairs",
      label: "Periodic Pairs",
      parentId: "resources:analysis:frequency-domain",
      resourceRef: MESHING_PERIODIC_PAIRS_PATH,
    };

    selectExplorerNode(kernel, node, "explorer");

    expect(kernel.selection.get()).toMatchObject({
      kind: "resources.mesh.periodic_pairs",
      nodeId: "resources:mesh:periodic-pairs",
      ref: {
        kind: "resources.mesh.periodic_pairs",
        nodeId: "resources:mesh:periodic-pairs",
        resourceRef: MESHING_PERIODIC_PAIRS_PATH,
        type: "frequency-domain",
      },
    });
  });

  it.each([
    "study.stage.eigenmodes.boundary",
    "study.stage.eigenmodes.periodic_pairs",
    "study.stage.eigenmodes.k_path",
    "study.stage.frequency_response.boundary",
    "study.stage.frequency_response.periodic_pairs",
    "study.stage.frequency_response.k_grid",
  ] as const)("selects %s as study-stage metadata for inspector routing", (kind) => {
    const kernel = makeKernel();
    const node: ExplorerNode = {
      id: `model:study:stages:stage:fd-1:${kind.split(".").pop()}`,
      kind,
      label: kind,
      parentId: "model:study:stages:stage:fd-1",
      stageId: "fd-1",
      stageIndex: 2,
    };

    selectExplorerNode(kernel, node, "explorer");

    expect(kernel.selection.get()).toMatchObject({
      kind,
      nodeId: node.id,
      ref: {
        kind,
        nodeId: node.id,
        stageId: "fd-1",
        stageIndex: 2,
        type: "study-stage",
      },
    });
  });

  it.each([
    [
      "results.frequency_domain.dispersion",
      "results:frequency-domain:dispersion",
      ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
      "eigen/dispersion.csv",
    ],
    [
      "diagnostics.frequency_domain.periodic_floquet",
      "diagnostics:frequency-domain:periodic-floquet",
      MESHING_PERIODIC_PAIRS_PATH,
      "frequency_domain/periodic_floquet_diagnostics.v1.json",
    ],
  ] as const)(
    "preserves %s resource and artifact metadata for frequency-domain inspectors",
    (kind, nodeId, resourceRef, artifactPath) => {
      const kernel = makeKernel();
      const node: ExplorerNode = {
        artifactPath,
        id: nodeId,
        kind,
        label: kind,
        parentId: "results:frequency-domain",
        resourceRef,
      };

      selectExplorerNode(kernel, node, "explorer");

      expect(kernel.selection.get()).toMatchObject({
        kind,
        nodeId,
        ref: {
          artifactPath,
          kind,
          nodeId,
          resourceRef,
          type: "frequency-domain",
        },
      });
    },
  );

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

  it("selects object extension nodes as scene-object extension selections", () => {
    const kernel = makeKernel();
    const node: ExplorerNode = {
      id: "model:object:permalloy_layer:extensions:topological_charge",
      kind: "object.extension.topological-charge",
      label: "Topological Charge",
      objectId: "permalloy_layer",
      parentId: "model:object:permalloy_layer",
    };

    selectExplorerNode(kernel, node, "explorer");

    expect(kernel.selection.get()).toMatchObject({
      kind: "object.extension.topological-charge",
      label: "Topological Charge",
      nodeId: "model:object:permalloy_layer:extensions:topological_charge",
      objectId: "permalloy_layer",
      ref: {
        extensionId: "topological_charge",
        kind: "object.extension.topological-charge",
        objectId: "permalloy_layer",
        type: "scene-object",
        visualizationTargetId: "object:permalloy_layer",
      },
    });
  });

  it("selects object mode visualization view nodes as analysis overlay targets", () => {
    const kernel = makeKernel();
    const node: ExplorerNode = {
      fieldId: "analysis:frequency-response:field-0001",
      frequencyIndex: 1,
      id: "model:object:film:visualization:mode-visualization:response:frequency:1:view:real",
      kind: "object.mode_visualization.view" as ExplorerNode["kind"],
      label: "Real",
      objectId: "film",
      parentId:
        "model:object:film:visualization:mode-visualization:response:frequency:1",
      status: "ready",
    };

    selectExplorerNode(kernel, node, "explorer");

    expect(kernel.selection.get()).toMatchObject({
      kind: "object.mode_visualization.view",
      label: "Real",
      nodeId:
        "model:object:film:visualization:mode-visualization:response:frequency:1:view:real",
      objectId: "film",
      ref: {
        fieldId: "analysis:frequency-response:field-0001",
        frequencyIndex: 1,
        kind: "object.mode_visualization.view",
        nodeId:
          "model:object:film:visualization:mode-visualization:response:frequency:1:view:real",
        objectId: "film",
        source: "frequency-response",
        type: "mode-visualization",
        view: "real",
        visualizationTargetId:
          "mode:film:frequency-response:analysis%3Afrequency-response%3Afield-0001",
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

  it("selects a canonical planar monitor with its monitor identity", () => {
    const kernel = makeKernel();
    const node: ExplorerNode = {
      id: "model:definitions:planar-monitors:midplane",
      kind: "model.planar.monitor",
      label: "Midplane",
      monitorId: "midplane",
      parentId: "model:definitions:planar-monitors",
    };

    selectExplorerNode(kernel, node, "explorer");

    expect(kernel.selection.get()).toMatchObject({
      kind: "model.planar.monitor",
      label: "Midplane",
      nodeId: "model:definitions:planar-monitors:midplane",
      ref: {
        kind: "model.planar.monitor",
        monitorId: "midplane",
        type: "planar-monitor",
        visualizationTargetId: "planar-monitor:midplane",
      },
    });
  });

  it("selects an uncommitted planar monitor draft with its own identity", () => {
    const kernel = makeKernel();
    const node: ExplorerNode = {
      id: "model:definitions:planar-monitors:draft",
      kind: "model.planar.monitor.draft",
      label: "Midplane",
      parentId: "model:definitions:planar-monitors",
    };

    selectExplorerNode(kernel, node, "explorer");

    expect(kernel.selection.get()).toMatchObject({
      kind: "model.planar.monitor.draft",
      label: "Midplane",
      nodeId: "model:definitions:planar-monitors:draft",
      ref: {
        draftId: "draft",
        kind: "model.planar.monitor.draft",
        type: "planar-monitor-draft",
        visualizationTargetId: "planar-monitor:draft",
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

  it("selects hysteresis child action nodes as study-stage refs", () => {
    const kernel = makeKernel();
    const node: ExplorerNode = {
      id: "model:study:stages:stage:hysteresis-1:live-run",
      kind: "study.stage.action",
      label: "Live Run",
      parentId: "model:study:stages:stage:hysteresis-1",
      stageId: "hysteresis-1",
      stageIndex: 3,
    };

    selectExplorerNode(kernel, node, "explorer");

    expect(kernel.selection.get()).toMatchObject({
      kind: "study.stage.action",
      label: "Live Run",
      nodeId: "model:study:stages:stage:hysteresis-1:live-run",
      objectId: null,
      ref: {
        kind: "study.stage.action",
        nodeId: "model:study:stages:stage:hysteresis-1:live-run",
        stageId: "hysteresis-1",
        stageIndex: 3,
        type: "study-stage",
      },
    });
  });
});
