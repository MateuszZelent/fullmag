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
let frequencyRouteMode: "fmr_response" | "free_modes" = "free_modes";
let selectedDatasetRef: string | null = null;
let descriptorPreferences: Record<string, { displayUnits: Record<string, string>; range: null; selectedSeriesIds: string[] }> = {};
const setDescriptorPreference = vi.fn();
const setActiveSubview = vi.fn();

vi.mock("@/kernel/workspace/useAnalysisWorkspace", () => ({ useAnalysisWorkspaceSelector: (selector: (state: { activeSurface: string; hasChartState: boolean; selectedDatasetRef: string | null; selectedSeriesIds: string[]; sourceChartId: string | null; xAxisId: string | null }) => unknown) => selector({ activeSurface, hasChartState: false, selectedDatasetRef, selectedSeriesIds: [], sourceChartId: null, xAxisId: null }) }));
vi.mock("@/kernel/workspace/useAnalysisViewPreferencesHydration", () => ({ useAnalysisViewPreferencesHydration: () => ({ isHydrated: false, preferences: { activeSubviews: { comparison: "comparison.sources", dispersion: "dispersion.modal", dynamics: "dynamics.time-traces", hysteresis: "hysteresis.loop", "resonance-fmr": "resonance.eigenmodes" }, descriptorPreferences, selectedDatasetRef: null }, setActiveSubview, setActiveSurface: vi.fn(), setDescriptorPreference, setSelectedDatasetRef: vi.fn() }) }));
vi.mock("@/kernel/resources/spinWaveResources", () => ({ useDynamicStructureFactorResource: () => ({ data: null, status: "idle" }), useSpinWaveGammaResource: () => ({ data: null, status: "idle" }) }));
vi.mock("@/kernel/selection/useSelection", () => ({ useSelectionSelector: () => null }));
vi.mock("./hooks/useAnalysisDatasetData", () => ({ useAnalysisDatasetData: () => ({ rows: { status: "idle" }, tableList: { data: null }, unsupportedReason: null, visibleRevision: null, visibleTable: null }) }));
vi.mock("./hooks/useAnalysisFrequencyData", () => ({ useAnalysisFrequencyData: () => ({ frequencyDomainDispersionModel: { points: [] }, frequencyDomainResponseModel: { points: [{ fieldId: "response-field-7", frequencyHz: 12.5e9, frequencyIndex: 7, observableId: "mx" }] }, frequencyDomainRoute: { mode: frequencyRouteMode }, frequencyDomainSeries: [{ dataRevision: 1, id: "frequency:artifact://spectrum", label: "frequency", points: [{ rowIndex: 0, x: 1, y: 9 }], quantity: "frequency", source: { kind: "analysis.frequency_domain", resourceKey: "artifact://spectrum", tableId: "frequency" }, status: "ready", unit: "GHz", xUnit: "index" }], frequencyDomainSpectrumModel: { points: [{ modeFieldId: "mode-1", modeFieldResourceKey: "field://mode-1", rawModeIndex: 1, sampleIndex: 0 }] }, frequencyDomainStatus: "ready", frequencyDomainTitle: "Eigen", frequencyDomainUnavailableReason: null }) }));

import { useAnalysisPlotsController } from "./useAnalysisPlotsController";

type TestKernel = Pick<KernelApi, "selection">;

function Probe({ kernel }: { kernel: TestKernel }) {
  const controller = useAnalysisPlotsController(kernel as KernelApi);
  const didSelect = useRef(false);
  useEffect(() => {
    if (didSelect.current) return;
    didSelect.current = true;
    controller.onPointSelect({ label: "Mode", point: { rowIndex: 0, x: frequencyRouteMode === "fmr_response" ? 12.5 : 1, y: 9 }, quantity: "frequency", seriesId: "eigen", source: { kind: "analysis.frequency_domain", resourceKey: "artifact://spectrum", tableId: "eigen" }, unit: "GHz", xUnit: "index" });
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
    try { await act(async () => root.render(<Probe kernel={{ selection }} />)); expect(selection.get().ref).toMatchObject({ artifactPath: "artifact://spectrum", chartId: "resonance-fmr:artifact://spectrum", fieldId: "mode-1", resourceRef: "field://mode-1", type: "frequency-domain" }); }
    finally { await act(async () => root.unmount()); dom.restore(); }
  });
  it("mounts response selection with field and observable provenance", async () => {
    activeSurface = "resonance-fmr";
    frequencyRouteMode = "fmr_response";
    const dom = installSimulationPreparationTestDom(); const root = createRoot(dom.document.createElement("div") as unknown as Element); const selection = new SelectionController(new EventBus<KernelEventMap>());
    selectedDatasetRef = "unrelated-table";
    try { await act(async () => root.render(<Probe kernel={{ selection }} />)); expect(selection.get().ref).toMatchObject({ chartId: "resonance-fmr:artifact://spectrum", fieldId: "response-field-7", frequencyIndex: 7, observableId: "mx", type: "frequency-domain" }); }
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
