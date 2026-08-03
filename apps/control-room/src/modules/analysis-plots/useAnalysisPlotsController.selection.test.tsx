import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { SelectionController } from "@/kernel/selection/SelectionController";

let activeSurface = "eigenmodes";

vi.mock("@/kernel/workspace/useAnalysisWorkspace", () => ({ useAnalysisWorkspaceSelector: (selector: (state: { activeSurface: string; selectedDatasetRef: string | null; comparisonDatasetRef: string | null }) => unknown) => selector({ activeSurface, selectedDatasetRef: null, comparisonDatasetRef: null }) }));
vi.mock("@/kernel/workspace/useAnalysisViewPreferencesHydration", () => ({ useAnalysisViewPreferencesHydration: () => ({ isHydrated: false, preferences: { descriptorPreferences: {}, selectedDatasetRef: null }, setActiveSurface: vi.fn(), setDescriptorPreference: vi.fn(), setSelectedDatasetRef: vi.fn() }) }));
vi.mock("@/kernel/resources/spinWaveResources", () => ({ useDynamicStructureFactorResource: () => ({ data: null, status: "idle" }), useSpinWaveGammaResource: () => ({ data: null, status: "idle" }) }));
vi.mock("@/kernel/selection/useSelection", () => ({ useSelectionSelector: () => null }));
vi.mock("./hooks/useAnalysisDatasetData", () => ({ useAnalysisDatasetData: () => ({ rows: { status: "idle" }, tableList: { data: null }, unsupportedReason: null, visibleRevision: null, visibleTable: null }) }));
vi.mock("./hooks/useAnalysisFrequencyData", () => ({ useAnalysisFrequencyData: () => ({ frequencyDomainDispersionModel: { points: [] }, frequencyDomainResponseModel: { points: [{ fieldId: "response-field-7", frequencyHz: 12.5e9, frequencyIndex: 7, observableId: "mx" }] }, frequencyDomainRoute: { mode: activeSurface === "frequency-response" ? "fmr_response" : "free_modes" }, frequencyDomainSeries: [], frequencyDomainSpectrumModel: { points: [{ modeFieldId: "mode-1", modeFieldResourceKey: "field://mode-1", rawModeIndex: 1, sampleIndex: 0 }] }, frequencyDomainStatus: "ready", frequencyDomainTitle: "Eigen", frequencyDomainUnavailableReason: null }) }));

import { useAnalysisPlotsController } from "./useAnalysisPlotsController";

function Probe({ kernel }: { kernel: any }) { const controller = useAnalysisPlotsController(kernel); useEffect(() => { controller.onPointSelect({ label: "Mode", point: { rowIndex: 0, x: activeSurface === "frequency-response" ? 12.5 : 1, y: 9 }, quantity: "frequency", seriesId: "eigen", source: { kind: "analysis.frequency_domain", resourceKey: "artifact://spectrum", tableId: "eigen" }, unit: "GHz", xUnit: "index" }); }, []); return null; }

describe("Analysis controller frequency selection", () => {
  it("mounts eigenmode selection with field-vector and parent artifact provenance", async () => {
    const dom = installSimulationPreparationTestDom(); const root = createRoot(dom.document.createElement("div") as unknown as Element); const selection = new SelectionController(new EventBus<KernelEventMap>());
    try { await act(async () => root.render(<Probe kernel={{ selection }} />)); expect(selection.get().ref).toMatchObject({ artifactPath: "artifact://spectrum", fieldId: "mode-1", resourceRef: "field://mode-1", type: "frequency-domain" }); }
    finally { await act(async () => root.unmount()); dom.restore(); }
  });
  it("mounts response selection with field and observable provenance", async () => {
    activeSurface = "frequency-response";
    const dom = installSimulationPreparationTestDom(); const root = createRoot(dom.document.createElement("div") as unknown as Element); const selection = new SelectionController(new EventBus<KernelEventMap>());
    try { await act(async () => root.render(<Probe kernel={{ selection }} />)); expect(selection.get().ref).toMatchObject({ fieldId: "response-field-7", frequencyIndex: 7, observableId: "mx", type: "frequency-domain" }); }
    finally { activeSurface = "eigenmodes"; await act(async () => root.unmount()); dom.restore(); }
  });
});
