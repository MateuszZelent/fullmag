import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { SelectionController } from "@/kernel/selection/SelectionController";
import { analysisWorkspaceStore, resetAnalysisWorkspaceForTests } from "@/kernel/workspace/analysisWorkspace";

let activeSurface = "eigenmodes";
let selectedDatasetRef: string | null = null;
let comparisonDatasetRef: string | null = null;
let descriptorPreferences: Record<string, { displayUnits: Record<string, string>; range: null; selectedSeriesIds: string[] }> = {};
const setDescriptorPreference = vi.fn();

vi.mock("@/kernel/workspace/useAnalysisWorkspace", () => ({ useAnalysisWorkspaceSelector: (selector: (state: { activeSurface: string; selectedDatasetRef: string | null; comparisonDatasetRef: string | null; comparisonSelectedSeriesKeys: string[]; hasChartState: boolean; hasComparisonSelection: boolean; selectedSeriesIds: string[]; sourceChartId: string | null; xAxisId: string | null }) => unknown) => selector({ activeSurface, comparisonDatasetRef, comparisonSelectedSeriesKeys: [], hasChartState: false, hasComparisonSelection: false, selectedDatasetRef, selectedSeriesIds: [], sourceChartId: null, xAxisId: null }) }));
vi.mock("@/kernel/workspace/useAnalysisViewPreferencesHydration", () => ({ useAnalysisViewPreferencesHydration: () => ({ isHydrated: false, preferences: { descriptorPreferences, selectedDatasetRef: null }, setActiveSurface: vi.fn(), setDescriptorPreference, setSelectedDatasetRef: vi.fn() }) }));
vi.mock("@/kernel/resources/spinWaveResources", () => ({ useDynamicStructureFactorResource: () => ({ data: null, status: "idle" }), useSpinWaveGammaResource: () => ({ data: null, status: "idle" }) }));
vi.mock("@/kernel/selection/useSelection", () => ({ useSelectionSelector: () => null }));
vi.mock("./hooks/useAnalysisDatasetData", () => ({ useAnalysisDatasetData: () => ({ rows: { status: "idle" }, tableList: { data: null }, unsupportedReason: null, visibleRevision: null, visibleTable: null }) }));
vi.mock("./hooks/useAnalysisFrequencyData", () => ({ useAnalysisFrequencyData: () => ({ frequencyDomainDispersionModel: { points: [] }, frequencyDomainResponseModel: { points: [{ fieldId: "response-field-7", frequencyHz: 12.5e9, frequencyIndex: 7, observableId: "mx" }] }, frequencyDomainRoute: { mode: activeSurface === "frequency-response" ? "fmr_response" : "free_modes" }, frequencyDomainSeries: [{ dataRevision: 1, id: "frequency:artifact://spectrum", label: "frequency", points: [{ rowIndex: 0, x: 1, y: 9 }], quantity: "frequency", source: { kind: "analysis.frequency_domain", resourceKey: "artifact://spectrum", tableId: "frequency" }, status: "ready", unit: "GHz", xUnit: "index" }], frequencyDomainSpectrumModel: { points: [{ modeFieldId: "mode-1", modeFieldResourceKey: "field://mode-1", rawModeIndex: 1, sampleIndex: 0 }] }, frequencyDomainStatus: "ready", frequencyDomainTitle: "Eigen", frequencyDomainUnavailableReason: null }) }));

import { useAnalysisPlotsController } from "./useAnalysisPlotsController";

function Probe({ kernel }: { kernel: any }) { const controller = useAnalysisPlotsController(kernel); useEffect(() => { const isComparison = activeSurface === "comparison"; controller.onPointSelect({ label: "Mode", point: { rowIndex: 0, x: activeSurface === "frequency-response" ? 12.5 : 1, y: 9 }, quantity: "frequency", seriesId: "eigen", source: { kind: isComparison ? "data.table.rows" : "analysis.frequency_domain", resourceKey: isComparison ? "table-b" : "artifact://spectrum", tableId: isComparison ? "table-b" : "eigen" }, unit: "GHz", xUnit: "index" }); }, []); return null; }
function FocusProbe({ kernel }: { kernel: any }) { useAnalysisPlotsController(kernel); return null; }
function RangeProbe({ kernel }: { kernel: any }) { const controller = useAnalysisPlotsController(kernel); useEffect(() => { controller.onRangeChange({ fromValue: 1e-9, toValue: 2e-9 }); }, []); return null; }
let capturedController: ReturnType<typeof useAnalysisPlotsController> | null = null;
function CaptureProbe({ kernel }: { kernel: any }) { capturedController = useAnalysisPlotsController(kernel); return null; }

describe("Analysis controller frequency selection", () => {
  it("mounts eigenmode selection with field-vector and parent artifact provenance", async () => {
    const dom = installSimulationPreparationTestDom(); const root = createRoot(dom.document.createElement("div") as unknown as Element); const selection = new SelectionController(new EventBus<KernelEventMap>());
    try { await act(async () => root.render(<Probe kernel={{ selection }} />)); expect(selection.get().ref).toMatchObject({ artifactPath: "artifact://spectrum", chartId: "eigenmodes:artifact://spectrum", fieldId: "mode-1", resourceRef: "field://mode-1", type: "frequency-domain" }); }
    finally { await act(async () => root.unmount()); dom.restore(); }
  });
  it("mounts response selection with field and observable provenance", async () => {
    activeSurface = "frequency-response";
    const dom = installSimulationPreparationTestDom(); const root = createRoot(dom.document.createElement("div") as unknown as Element); const selection = new SelectionController(new EventBus<KernelEventMap>());
    selectedDatasetRef = "unrelated-table";
    try { await act(async () => root.render(<Probe kernel={{ selection }} />)); expect(selection.get().ref).toMatchObject({ chartId: "frequency-response:artifact://spectrum", fieldId: "response-field-7", frequencyIndex: 7, observableId: "mx", type: "frequency-domain" }); }
    finally { activeSurface = "eigenmodes"; selectedDatasetRef = null; await act(async () => root.unmount()); dom.restore(); }
  });
  it("focuses the right comparison pane from its point rather than the primary dataset", async () => {
    activeSurface = "comparison";
    selectedDatasetRef = "table-a";
    comparisonDatasetRef = "table-b";
    resetAnalysisWorkspaceForTests();
    const dom = installSimulationPreparationTestDom(); const root = createRoot(dom.document.createElement("div") as unknown as Element); const selection = new SelectionController(new EventBus<KernelEventMap>());
    try {
      await act(async () => root.render(<Probe kernel={{ selection }} />));
      expect(analysisWorkspaceStore.getSnapshot().focusedChartId).toBe("comparison:table-b");
      expect(selection.get().ref).toMatchObject({ chartId: "comparison:table-b", tableId: "table-b" });
    } finally {
      activeSurface = "eigenmodes"; selectedDatasetRef = null; comparisonDatasetRef = null;
      await act(async () => root.unmount()); dom.restore();
    }
  });
  it("clears a frequency artifact focus when the active surface changes", async () => {
    activeSurface = "frequency-response";
    selectedDatasetRef = "unrelated-table";
    resetAnalysisWorkspaceForTests();
    const dom = installSimulationPreparationTestDom(); const root = createRoot(dom.document.createElement("div") as unknown as Element); const selection = new SelectionController(new EventBus<KernelEventMap>());
    try {
      await act(async () => root.render(<FocusProbe kernel={{ selection }} />));
      expect(analysisWorkspaceStore.getSnapshot().focusedChartId).toBe("frequency-response:artifact://spectrum");
      activeSurface = "dynamics";
      await act(async () => root.render(<FocusProbe kernel={{ selection }} />));
      expect(analysisWorkspaceStore.getSnapshot().focusedChartId).toBeNull();
    } finally {
      activeSurface = "eigenmodes"; selectedDatasetRef = null;
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
      activeSurface = "eigenmodes"; selectedDatasetRef = null;
      await act(async () => root.unmount()); dom.restore();
    }
  });
  it("owns frequency selection under its artifact descriptor without a selected table", async () => {
    activeSurface = "frequency-response";
    selectedDatasetRef = null;
    descriptorPreferences = {};
    setDescriptorPreference.mockClear();
    const dom = installSimulationPreparationTestDom(); const root = createRoot(dom.document.createElement("div") as unknown as Element); const selection = new SelectionController(new EventBus<KernelEventMap>());
    try {
      await act(async () => root.render(<CaptureProbe kernel={{ selection }} />));
      expect(capturedController?.sourceChartId).toBe("frequency-response:artifact://spectrum");
      expect(capturedController?.selectedSeriesIds).toEqual(["frequency:artifact://spectrum"]);
      expect(analysisWorkspaceStore.getSnapshot()).toMatchObject({
        activeDescriptorId: "artifact:frequency-response:v-artifact%3A%2F%2Fspectrum",
        activeDescriptorSelectedSeriesIds: ["frequency:artifact://spectrum"],
      });

      capturedController?.onSelectedSeriesIdsChange([]);
      expect(setDescriptorPreference).toHaveBeenCalledWith("artifact:frequency-response:v-artifact%3A%2F%2Fspectrum", { displayUnits: {}, range: null, selectedSeriesIds: [] });

      descriptorPreferences = { "artifact:frequency-response:v-artifact%3A%2F%2Fspectrum": { displayUnits: {}, range: null, selectedSeriesIds: [] } };
      await act(async () => root.render(<CaptureProbe kernel={{ selection }} />));
      expect(capturedController?.selectedSeriesIds).toEqual([]);
    } finally {
      activeSurface = "eigenmodes"; selectedDatasetRef = null; descriptorPreferences = {}; capturedController = null;
      await act(async () => root.unmount()); dom.restore();
    }
  });
  it("persists a selected display unit under the artifact descriptor", async () => {
    activeSurface = "eigenmodes";
    selectedDatasetRef = "unrelated-table";
    descriptorPreferences = {};
    setDescriptorPreference.mockClear();
    const dom = installSimulationPreparationTestDom(); const root = createRoot(dom.document.createElement("div") as unknown as Element); const selection = new SelectionController(new EventBus<KernelEventMap>());
    try {
      await act(async () => root.render(<CaptureProbe kernel={{ selection }} />));
      capturedController?.onDisplayUnitsChange({ frequency: "GHz" });
      expect(setDescriptorPreference).toHaveBeenCalledWith("artifact:eigenmodes:v-artifact%3A%2F%2Fspectrum", { displayUnits: { frequency: "GHz" }, range: null, selectedSeriesIds: ["frequency:artifact://spectrum"] });
    } finally {
      selectedDatasetRef = null; descriptorPreferences = {}; capturedController = null;
      await act(async () => root.unmount()); dom.restore();
    }
  });
  it("persists frequency range under the artifact descriptor without a selected table", async () => {
    activeSurface = "frequency-response";
    selectedDatasetRef = null;
    descriptorPreferences = {};
    setDescriptorPreference.mockClear();
    const dom = installSimulationPreparationTestDom(); const root = createRoot(dom.document.createElement("div") as unknown as Element); const selection = new SelectionController(new EventBus<KernelEventMap>());
    try {
      await act(async () => root.render(<CaptureProbe kernel={{ selection }} />));
      capturedController?.onRangeChange({ fromValue: 1, toValue: 2 });
      expect(setDescriptorPreference).toHaveBeenCalledWith("artifact:frequency-response:v-artifact%3A%2F%2Fspectrum", { displayUnits: {}, range: { fromSI: 1, toSI: 2 }, selectedSeriesIds: ["frequency:artifact://spectrum"] });
    } finally {
      activeSurface = "eigenmodes"; descriptorPreferences = {}; capturedController = null;
      await act(async () => root.unmount()); dom.restore();
    }
  });
});
