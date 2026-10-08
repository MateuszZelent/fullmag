import { act, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { SelectionController } from "@/kernel/selection/SelectionController";
import type { KernelApi } from "@/kernel/types";
import { analysisWorkspaceStore, resetAnalysisWorkspaceForTests } from "@/kernel/workspace/analysisWorkspace";

let activeSurface = "resonance-fmr";
let frequencyRouteMode: "fmr_response" | "frequency_response" | "free_modes" = "free_modes";
let selectedDatasetRef: string | null = null;
let descriptorPreferences: Record<string, { displayUnits: Record<string, string>; range: null; selectedSeriesIds: string[] }> = {};
const setDescriptorPreference = vi.fn();
const setActiveSubview = vi.fn();

vi.mock("@/kernel/workspace/useAnalysisWorkspace", () => ({ useAnalysisWorkspaceSelector: (selector: (state: { activeSurface: string; hasChartState: boolean; selectedDatasetRef: string | null; selectedSeriesIds: string[]; sourceChartId: string | null; xAxisId: string | null }) => unknown) => selector({ activeSurface, hasChartState: false, selectedDatasetRef, selectedSeriesIds: [], sourceChartId: null, xAxisId: null }) }));
vi.mock("@/kernel/workspace/useAnalysisViewPreferencesHydration", () => ({ useAnalysisViewPreferencesHydration: () => ({ isHydrated: false, preferences: { activeSubviews: { comparison: "comparison.sources", dispersion: "dispersion.modal", dynamics: "dynamics.time-traces", hysteresis: "hysteresis.loop", "resonance-fmr": "resonance.eigenmodes" }, descriptorPreferences, selectedDatasetRef: null }, setActiveSubview, setActiveSurface: vi.fn(), setDescriptorPreference, setSelectedDatasetRef: vi.fn() }) }));
vi.mock("@/kernel/resources/spinWaveResources", () => ({ useDynamicStructureFactorResource: () => ({ data: null, status: "idle" }), useSpinWaveGammaResource: () => ({ data: null, status: "idle" }) }));
vi.mock("@/kernel/selection/useSelection", () => ({ useSelectionSelector: () => null }));
vi.mock("./hooks/useAnalysisDatasetData", () => ({ useAnalysisDatasetData: () => ({ rows: { status: "idle" }, tableList: { data: null }, unsupportedReason: null, visibleRevision: null, visibleTable: null }) }));
vi.mock("./hooks/useAnalysisFrequencyData", () => ({ useAnalysisFrequencyData: () => ({ frequencyDomainDispersionModel: { points: [] }, frequencyDomainPresentation: { kind: "ready", revision: "sha256:artifact-1", physicalContext: { classification: { kContext: { kind: "gamma" } }, equilibriumId: "equilibrium-1", kSampling: { kind: "single", vectorRadPerM: [0, 0, 0] }, normalization: "unit_l2", runId: "run-1", stageId: "stage-1", studyProduct: frequencyRouteMode === "free_modes" ? "modal_eigen" : "driven_response" } }, frequencyDomainResponseModel: { points: [{ fieldId: "response-field-7", frequencyHz: 12.5e9, frequencyIndex: 7, observableId: "mx" }] }, frequencyDomainRoute: { mode: frequencyRouteMode, primaryChart: frequencyRouteMode === "fmr_response" || frequencyRouteMode === "frequency_response" ? "response-sweep" : "modal-spectrum" }, frequencyDomainSeries: [{ dataRevision: 1, id: "frequency:artifact://spectrum", label: "frequency", points: [{ rowIndex: 0, x: 1, y: 9 }], quantity: "frequency", source: { kind: "analysis.frequency_domain", resourceKey: "artifact://spectrum", tableId: "frequency" }, status: "ready", unit: "GHz", xUnit: "index" }], frequencyDomainSpectrumModel: { points: [{ frequencyHz: 9e9, modeFieldId: "mode-1", modeFieldResourceKey: "field://mode-1", modeId: "sample-0000/mode-0001", rawModeIndex: 1, sampleId: "sample-0000", sampleIndex: 0 }] }, frequencyDomainStatus: "ready", frequencyDomainTitle: "Eigen", frequencyDomainUnavailableReason: null }) }));

import { frequencyDomainSelectionFromPoint, useAnalysisPlotsController } from "./useAnalysisPlotsController";
import { frequencyDomainResultContextFromManifest } from "@/shared/domain/analysis/frequencyDomainChartModels";

type TestKernel = Pick<KernelApi, "selection">;

function Probe({ kernel }: { kernel: TestKernel }) {
  const controller = useAnalysisPlotsController(kernel as KernelApi);
  const didSelect = useRef(false);
  useEffect(() => {
    if (didSelect.current) return;
    didSelect.current = true;
    controller.onPointSelect({ label: "Mode", point: { rowIndex: 0, x: frequencyRouteMode === "free_modes" ? 1 : 12.5, y: 9 }, quantity: "frequency", seriesId: "eigen", source: { kind: "analysis.frequency_domain", resourceKey: "artifact://spectrum", tableId: "eigen" }, unit: "GHz", xUnit: "index" });
  }, [controller]);
  return null;
}

function FocusProbe({ kernel }: { kernel: TestKernel }) {
  useAnalysisPlotsController(kernel as KernelApi);
  return null;
}

function RangeProbe({ kernel }: { kernel: TestKernel }) {
  const controller = useAnalysisPlotsController(kernel as KernelApi);
  const didSelectRange = useRef(false);
  useEffect(() => {
    if (didSelectRange.current) return;
    didSelectRange.current = true;
    controller.onRangeChange({ fromValue: 1e-9, toValue: 2e-9 });
  }, [controller]);
  return null;
}

let capturedController: ReturnType<typeof useAnalysisPlotsController> | null = null;
function CaptureProbe({ kernel }: { kernel: TestKernel }) {
  const controller = useAnalysisPlotsController(kernel as KernelApi);
  useEffect(() => {
    capturedController = controller;
  }, [controller]);
  return null;
}

describe("Analysis controller frequency selection", () => {
  it("exposes and persists the active contextual subview", async () => {
    activeSurface = "resonance-fmr";
    setActiveSubview.mockClear();
    const dom = installSimulationPreparationTestDom(); const root = createRoot(dom.document.createElement("div") as unknown as Element); const selection = new SelectionController(new EventBus<KernelEventMap>());
    try {
      await act(async () => root.render(<CaptureProbe kernel={{ selection }} />));
      const controller = capturedController as unknown as { activeSubview?: string; onSubviewChange?: (subview: string) => void };
      expect(controller.activeSubview).toBe("resonance.eigenmodes");
      controller.onSubviewChange?.("resonance.modal-driven");
      expect(setActiveSubview).toHaveBeenCalledWith("resonance-fmr", "resonance.modal-driven");
    } finally {
      capturedController = null;
      await act(async () => root.unmount()); dom.restore();
    }
  });

  it("mounts eigenmode selection with field-vector and parent artifact provenance", async () => {
    const dom = installSimulationPreparationTestDom(); const root = createRoot(dom.document.createElement("div") as unknown as Element); const selection = new SelectionController(new EventBus<KernelEventMap>());
    try { await act(async () => root.render(<Probe kernel={{ selection }} />)); expect(selection.get().ref).toMatchObject({ analysisRunId: "run-1", analysisStageId: "stage-1", artifactPath: "artifact://spectrum", artifactRevision: "sha256:artifact-1", chartId: "resonance-fmr:artifact://spectrum", equilibriumId: "equilibrium-1", fieldId: "mode-1", kContextKind: "gamma", modeId: "sample-0000/mode-0001", normalization: "unit_l2", representation: "complex-vector-xyz", resourceRef: "field://mode-1", sampleId: "sample-0000", source: "eigen-mode", studyProduct: "modal_eigen", type: "frequency-domain", wavevectorKf: [0, 0, 0] }); }
    finally { await act(async () => root.unmount()); dom.restore(); }
  });

  it("binds dispersion point selections to the exact per-sample equilibrium identity", () => {
    const resultContext = frequencyDomainResultContextFromManifest({
      geometry_identity: "geometry-dispersion",
      mesh_identity: "mesh-dispersion",
      run_id: "run-dispersion",
      stage_id: "stage-dispersion",
      study_product: "modal_eigen",
      requested_execution: {
        boundary_context: "floquet_periodic",
        calculation_mode: "dispersion_modal",
        k_sampling: { kind: "path", sample_count: 4 },
      },
      native_provenance_by_sample: {
        "0": { equilibrium_artifact_sha256: "eq-nonzero-k" },
        "1": { equilibrium_artifact_sha256: "eq-nonzero-k" },
        "2": { equilibrium_artifact_sha256: "eq-nonzero-k" },
        "3": { equilibrium_artifact_sha256: "eq-gamma" },
      },
    });
    const dispersionModel = {
      points: [
        {
          frequencyHz: 12.5e9,
          modeFieldAvailable: true,
          modeFieldId: "mode-k",
          modeFieldResourceKey: "field://mode-k",
          modeId: "sample-0002/mode-0001",
          pathS: 2,
          rawModeIndex: 1,
          sampleId: "sample-0002",
          sampleIndex: 2,
          wavevectorKf: [1e7, 0, 0],
        },
        {
          frequencyHz: 12.5e9,
          modeFieldAvailable: true,
          modeFieldId: "mode-gamma",
          modeFieldResourceKey: "field://mode-gamma",
          modeId: "sample-0003/mode-0001",
          pathS: 3,
          rawModeIndex: 1,
          sampleId: "sample-0003",
          sampleIndex: 3,
          wavevectorKf: [0, 0, 0],
        },
      ],
    };
    const selectRow = (rowIndex: number) => frequencyDomainSelectionFromPoint({
      artifactRevision: "dispersion-r7",
      dispersionModel: dispersionModel as never,
      point: {
        label: "Mode",
        point: { rowIndex, x: rowIndex, y: 12.5 },
        quantity: "frequency",
        seriesId: "mode",
        source: {
          kind: "analysis.frequency_domain",
          resourceKey: "artifact://dispersion",
          tableId: "frequency-domain:eigen-dispersion",
        },
        unit: "GHz",
        xUnit: "rad/m",
      } as never,
      resultContext,
      responseModel: { points: [] } as never,
      routeMode: "dispersion_modal",
      routePrimaryChart: "dispersion",
      spectrumModel: { points: [] } as never,
    });

    expect(resultContext.equilibriumId).toBeNull();
    expect(selectRow(0).ref).toMatchObject({
      equilibriumId: "eq-nonzero-k",
      sampleIndex: 2,
    });
    expect(selectRow(1).ref).toMatchObject({
      equilibriumId: "eq-gamma",
      sampleIndex: 3,
    });
  });

  it("mounts response selection with field and observable provenance", async () => {
    activeSurface = "resonance-fmr";
    frequencyRouteMode = "fmr_response";
    const dom = installSimulationPreparationTestDom(); const root = createRoot(dom.document.createElement("div") as unknown as Element); const selection = new SelectionController(new EventBus<KernelEventMap>());
    selectedDatasetRef = "unrelated-table";
    try { await act(async () => root.render(<Probe kernel={{ selection }} />)); expect(selection.get().ref).toMatchObject({ chartId: "resonance-fmr:artifact://spectrum", fieldId: "response-field-7", frequencyIndex: 7, observableId: "mx", type: "frequency-domain" }); }
    finally { activeSurface = "resonance-fmr"; frequencyRouteMode = "free_modes"; selectedDatasetRef = null; await act(async () => root.unmount()); dom.restore(); }
  });
  it("mounts neutral frequency-response selections as driven response points", async () => {
    activeSurface = "resonance-fmr";
    frequencyRouteMode = "frequency_response";
    const dom = installSimulationPreparationTestDom(); const root = createRoot(dom.document.createElement("div") as unknown as Element); const selection = new SelectionController(new EventBus<KernelEventMap>());
    try { await act(async () => root.render(<Probe kernel={{ selection }} />)); expect(selection.get()).toMatchObject({ kind: "results.frequency_response.frequency_point", ref: { calculationMode: "frequency_response", chartId: "resonance-fmr:artifact://spectrum", fieldId: "response-field-7", frequencyIndex: 7, observableId: "mx", type: "frequency-domain" } }); }
    finally { activeSurface = "resonance-fmr"; frequencyRouteMode = "free_modes"; selectedDatasetRef = null; await act(async () => root.unmount()); dom.restore(); }
  });
  it("exposes an honest controller-level Comparison contract gap", async () => {
    activeSurface = "comparison";
    selectedDatasetRef = "table-a";
    resetAnalysisWorkspaceForTests();
    const dom = installSimulationPreparationTestDom(); const root = createRoot(dom.document.createElement("div") as unknown as Element); const selection = new SelectionController(new EventBus<KernelEventMap>());
    try {
      await act(async () => root.render(<CaptureProbe kernel={{ selection }} />));
      expect(capturedController?.comparisonUnavailableReason).toContain("typed owner identities");
      expect(analysisWorkspaceStore.getSnapshot().focusedChartId).toBeNull();
    } finally {
      activeSurface = "resonance-fmr"; selectedDatasetRef = null; capturedController = null;
      await act(async () => root.unmount()); dom.restore();
    }
  });
  it("clears a frequency artifact focus when the active surface changes", async () => {
    activeSurface = "resonance-fmr";
    selectedDatasetRef = "unrelated-table";
    resetAnalysisWorkspaceForTests();
    const dom = installSimulationPreparationTestDom(); const root = createRoot(dom.document.createElement("div") as unknown as Element); const selection = new SelectionController(new EventBus<KernelEventMap>());
    try {
      await act(async () => root.render(<FocusProbe kernel={{ selection }} />));
      expect(analysisWorkspaceStore.getSnapshot().focusedChartId).toBe("resonance-fmr:artifact://spectrum");
      activeSurface = "dynamics";
      await act(async () => root.render(<FocusProbe kernel={{ selection }} />));
      expect(analysisWorkspaceStore.getSnapshot().focusedChartId).toBeNull();
    } finally {
      activeSurface = "resonance-fmr"; selectedDatasetRef = null;
      await act(async () => root.unmount()); dom.restore();
    }
  });
  it("persists a range interaction against the active chart descriptor", async () => {
    activeSurface = "dynamics";
    selectedDatasetRef = "table-a";
    setDescriptorPreference.mockClear();
    const dom = installSimulationPreparationTestDom(); const root = createRoot(dom.document.createElement("div") as unknown as Element); const selection = new SelectionController(new EventBus<KernelEventMap>());
    try {
      await act(async () => root.render(<RangeProbe kernel={{ selection }} />));
      expect(setDescriptorPreference).toHaveBeenCalledWith("dynamics:v-table-a", { displayUnits: {}, range: { fromSI: 1e-9, toSI: 2e-9 }, selectedSeriesIds: [] });
    } finally {
      activeSurface = "resonance-fmr"; selectedDatasetRef = null;
      await act(async () => root.unmount()); dom.restore();
    }
  });
  it("projects range and display units into the active descriptor command state", async () => {
    activeSurface = "dynamics";
    selectedDatasetRef = "table-a";
    descriptorPreferences = {
      "dynamics:v-table-a": {
        displayUnits: { mx: "1" },
        range: { fromSI: 2, toSI: 8 } as never,
        selectedSeriesIds: ["data.table:table-a:step:mx"],
      },
    };
    resetAnalysisWorkspaceForTests();
    const dom = installSimulationPreparationTestDom(); const root = createRoot(dom.document.createElement("div") as unknown as Element); const selection = new SelectionController(new EventBus<KernelEventMap>());
    try {
      await act(async () => root.render(<CaptureProbe kernel={{ selection }} />));
      expect(analysisWorkspaceStore.getSnapshot()).toMatchObject({
        activeDescriptorDisplayUnits: { mx: "1" },
        activeDescriptorRange: { fromSI: 2, toSI: 8 },
        activeDescriptorSelectedSeriesIds: ["data.table:table-a:step:mx"],
      });
    } finally {
      activeSurface = "resonance-fmr"; selectedDatasetRef = null; descriptorPreferences = {}; capturedController = null;
      await act(async () => root.unmount()); dom.restore();
    }
  });
  it("owns frequency selection under its artifact descriptor without a selected table", async () => {
    activeSurface = "resonance-fmr";
    selectedDatasetRef = null;
    descriptorPreferences = {};
    setDescriptorPreference.mockClear();
    const dom = installSimulationPreparationTestDom(); const root = createRoot(dom.document.createElement("div") as unknown as Element); const selection = new SelectionController(new EventBus<KernelEventMap>());
    try {
      await act(async () => root.render(<CaptureProbe kernel={{ selection }} />));
      expect(capturedController?.sourceChartId).toBe("resonance-fmr:artifact://spectrum");
      expect(capturedController?.selectedSeriesIds).toEqual(["frequency:artifact://spectrum"]);
      expect(analysisWorkspaceStore.getSnapshot()).toMatchObject({
        activeDescriptorId: "artifact:resonance-fmr:v-artifact%3A%2F%2Fspectrum",
        activeDescriptorSelectedSeriesIds: ["frequency:artifact://spectrum"],
      });

      capturedController?.onSelectedSeriesIdsChange([]);
      expect(setDescriptorPreference).toHaveBeenCalledWith("artifact:resonance-fmr:v-artifact%3A%2F%2Fspectrum", { displayUnits: {}, range: null, selectedSeriesIds: [] });

      descriptorPreferences = { "artifact:resonance-fmr:v-artifact%3A%2F%2Fspectrum": { displayUnits: {}, range: null, selectedSeriesIds: [] } };
      await act(async () => root.render(<CaptureProbe kernel={{ selection }} />));
      expect(capturedController?.selectedSeriesIds).toEqual([]);
    } finally {
      activeSurface = "resonance-fmr"; selectedDatasetRef = null; descriptorPreferences = {}; capturedController = null;
      await act(async () => root.unmount()); dom.restore();
    }
  });
  it("persists a selected display unit under the artifact descriptor", async () => {
    activeSurface = "resonance-fmr";
    selectedDatasetRef = "unrelated-table";
    descriptorPreferences = {};
    setDescriptorPreference.mockClear();
    const dom = installSimulationPreparationTestDom(); const root = createRoot(dom.document.createElement("div") as unknown as Element); const selection = new SelectionController(new EventBus<KernelEventMap>());
    try {
      await act(async () => root.render(<CaptureProbe kernel={{ selection }} />));
      capturedController?.onDisplayUnitsChange({ frequency: "GHz" });
      expect(setDescriptorPreference).toHaveBeenCalledWith("artifact:resonance-fmr:v-artifact%3A%2F%2Fspectrum", { displayUnits: { frequency: "GHz" }, range: null, selectedSeriesIds: ["frequency:artifact://spectrum"] });
    } finally {
      selectedDatasetRef = null; descriptorPreferences = {}; capturedController = null;
      await act(async () => root.unmount()); dom.restore();
    }
  });
  it("persists frequency range under the artifact descriptor without a selected table", async () => {
    activeSurface = "resonance-fmr";
    selectedDatasetRef = null;
    descriptorPreferences = {};
    setDescriptorPreference.mockClear();
    const dom = installSimulationPreparationTestDom(); const root = createRoot(dom.document.createElement("div") as unknown as Element); const selection = new SelectionController(new EventBus<KernelEventMap>());
    try {
      await act(async () => root.render(<CaptureProbe kernel={{ selection }} />));
      capturedController?.onRangeChange({ fromValue: 1, toValue: 2 });
      expect(setDescriptorPreference).toHaveBeenCalledWith("artifact:resonance-fmr:v-artifact%3A%2F%2Fspectrum", { displayUnits: {}, range: { fromSI: 1, toSI: 2 }, selectedSeriesIds: ["frequency:artifact://spectrum"] });
    } finally {
      activeSurface = "resonance-fmr"; descriptorPreferences = {}; capturedController = null;
      await act(async () => root.unmount()); dom.restore();
    }
  });
});
