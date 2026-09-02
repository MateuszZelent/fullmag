import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import type { DynamicStructureFactorResource, SpinWaveGammaResource } from "@/kernel/api/apiTypes";
import {
  findElements,
  installSimulationPreparationTestDom,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type { KernelApi } from "@/kernel/types";
import type { AnalysisSubview } from "@/kernel/workspace/analysisViewPreferences";
import { chartTableWindowFromBinary } from "@/shared/domain/analysis/chartDataPlan";
import type { AnalysisResultProjectionSurfaceProps } from "./components/AnalysisResultProjectionSurface";
import type { DynamicStructureFactorPointSelection } from "./dynamicStructureFactorModel";
import type { SpinWaveGammaFeatureSelection } from "./spinWaveGammaModel";

const controllerMocks = vi.hoisted(() => ({
  activeSurface: "dynamics",
  activeSubview: "dynamics.time-traces",
  dynamicStructureFactorEnabled: [] as boolean[],
}));
const legacySelectionFixtures = vi.hoisted(() => ({
  dsf: {
    frequencyHz: 2e9,
    frequencyIndex: 1,
    itemId: "legacy:dsf:1:0",
    itemKind: "dsf_point" as const,
    kRadPerM: 10,
    ordinal: 2,
    power: 3,
    sampleId: "dsf-sample-0000",
    wavevectorIndex: 0,
  },
  gamma: {
    frequencyHz: 12.5e9,
    itemId: "legacy:gamma:peak:7",
    itemKind: "spectral_feature" as const,
    ordinal: 7,
    peakIndex: 7,
    power: 0.25,
    sampleId: "gamma-spectrum-sample-0000",
  },
}));

vi.mock("@/kernel/resources/spinWaveResources", () => ({
  useDynamicStructureFactorResource: (enabled = true) => {
    controllerMocks.dynamicStructureFactorEnabled.push(enabled);
    return { data: null, status: "idle" };
  },
  useSpinWaveGammaResource: () => ({ data: null, status: "idle" }),
}));
vi.mock("@/kernel/selection/useSelection", () => ({
  useSelectionSelector: () => null,
}));
vi.mock("@/kernel/workspace/useAnalysisWorkspace", () => ({
  useAnalysisWorkspaceSelector: (selector: (state: Record<string, unknown>) => unknown) => selector({
    activeSurface: controllerMocks.activeSurface,
    hasChartState: false,
    selectedDatasetRef: null,
    selectedSeriesIds: [],
    sourceChartId: null,
    xAxisId: null,
  }),
}));
vi.mock("@/kernel/workspace/useAnalysisViewPreferencesHydration", () => ({
  useAnalysisViewPreferencesHydration: () => ({
    isHydrated: false,
    preferences: {
      activeSurface: controllerMocks.activeSurface,
      activeSubviews: {
        comparison: "comparison.sources",
        dispersion: controllerMocks.activeSubview,
        dynamics: controllerMocks.activeSubview,
        hysteresis: "hysteresis.loop",
        "resonance-fmr": "resonance.eigenmodes",
      },
      descriptorPreferences: {},
      selectedDatasetRef: null,
    },
    setActiveSubview: vi.fn(),
    setActiveSurface: vi.fn(),
    setDescriptorPreference: vi.fn(),
    setSelectedDatasetRef: vi.fn(),
  }),
}));
vi.mock("./hooks/useAnalysisDatasetData", () => ({
  useAnalysisDatasetData: () => ({
    rows: { status: "idle" },
    tableList: { data: null },
    unsupportedReason: null,
    visibleRevision: null,
    visibleTable: null,
  }),
}));
vi.mock("./hooks/useAnalysisFrequencyData", () => ({
  useAnalysisFrequencyData: () => ({
    frequencyDomainComparisonModel: undefined,
    frequencyDomainDispersionModel: { points: [] },
    frequencyDomainPresentation: { kind: "empty", revision: null },
    frequencyDomainResponseModel: { points: [] },
    frequencyDomainRoute: { mode: undefined },
    frequencyDomainSeries: [],
    frequencyDomainSpectrumModel: { points: [] },
    frequencyDomainStatus: "idle",
    frequencyDomainTitle: "Frequency domain",
    frequencyDomainUnavailableReason: null,
  }),
}));
vi.mock("@/shared/ui/Select", () => ({
  Select: ({ children, onValueChange }: { children: React.ReactNode; onValueChange: (value: string) => void }) => <div onClick={() => onValueChange("table-c")}>{children}</div>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} type="button">{children}</button>,
  SelectValue: () => null,
}));

vi.mock("./DynamicStructureFactorView", () => ({
  DynamicStructureFactorView: ({ onPointSelect }: { onPointSelect?: (selection: DynamicStructureFactorPointSelection) => void }) => <div data-analysis-panel="dynamics.s-k-f">
    <button type="button" data-legacy-dsf-point="true" onClick={() => onPointSelect?.(legacySelectionFixtures.dsf)}>Select DSF point</button>
  </div>,
}));
vi.mock("./SpinWaveGammaView", () => ({
  SpinWaveGammaView: ({ onFeatureSelect }: { onFeatureSelect?: (selection: SpinWaveGammaFeatureSelection) => void }) => <div data-analysis-panel="dynamics.temporal-fft">
    <button type="button" data-legacy-gamma-feature="true" onClick={() => onFeatureSelect?.(legacySelectionFixtures.gamma)}>Select Gamma feature</button>
  </div>,
}));

import {
  AnalysisPlotsView,
  resultProjectionSelectionFromLegacyPoint,
} from "./AnalysisPlotsView";
import { useAnalysisPlotsController } from "./useAnalysisPlotsController";

const props = {
  datasetRefs: [], dynamicStructureFactor: null, dynamicStructureFactorStatus: "idle", frequencyDomainSeries: [], frequencyDomainStatus: "idle", frequencyDomainTitle: "Frequency domain", frequencyDomainUnavailableReason: null,
  kernel: {} as KernelApi, onDatasetRefChange: vi.fn(), onSurfaceChange: vi.fn(), selectedDatasetRef: null, selectedStageId: null, spinWaveGamma: null, spinWaveGammaStatus: "idle", table: null, tableStatus: "idle", tableUnsupportedReason: null,
};

const dynamicStructureFactor = { schema_version: "dynamic_structure_factor.1d.v1:sha256:dsf-1" } as DynamicStructureFactorResource;
const spinWaveGamma = { schema_version: "spin_wave_response.gamma.v1:sha256:gamma-1" } as SpinWaveGammaResource;

function tableFixture(tableId: string, revision: number) {
  return chartTableWindowFromBinary({
    columns: [{ column_id: "step", label: "step", unit: "1" }, { column_id: "mx", label: "mx", unit: "1" }],
    decoded: { columnCount: 2, cursorEnd: 1, cursorStart: 1, resyncRequired: false, revision, rowCount: 1, schemaRevision: 1, totalRows: 1, values: new Float64Array([0, 1]) },
    tableId,
  });
}

describe("Analysis workbench", () => {
  it("maps legacy FFT/DSF clicks to the canonical result point identity", () => {
    expect(
      resultProjectionSelectionFromLegacyPoint({
        itemId: "legacy:dsf:2:4",
        itemKind: "dsf_point",
        ordinal: 204,
        sampleId: "dsf-sample-0000",
      }),
    ).toEqual({
      branchId: null,
      itemId: "legacy:dsf:2:4",
      itemKind: "dsf_point",
      ordinal: 204,
      sampleId: "dsf-sample-0000",
    });
  });

  it("exposes the five physics-first workbench surfaces", () => {
    const html = renderToStaticMarkup(<AnalysisPlotsView {...props} activeSurface="dynamics" />);
    for (const label of ["Dynamics", "Resonance &amp; FMR", "Dispersion", "Hysteresis", "Comparison"]) expect(html).toContain(`>${label}</button>`);
  });

  it("renders each selected workbench surface", () => {
    for (const activeSurface of ["dynamics", "resonance-fmr", "dispersion", "hysteresis", "comparison"] as const) {
      const html = renderToStaticMarkup(<AnalysisPlotsView {...props} activeSurface={activeSurface} />);
      if (activeSurface === "comparison") expect(html).not.toContain('aria-label="Analysis dataset"');
      else expect(html).toContain('aria-label="Analysis dataset"');
    }
  });

  it("renders the controlled subview instead of deriving a decorative value from calculation mode", () => {
    const html = renderToStaticMarkup(
      <AnalysisPlotsView {...props} activeSurface="dynamics" activeSubview="dynamics.temporal-fft" />,
    );

    expect(html).toContain('data-analysis-subview="dynamics.temporal-fft"');
  });

  it("renders the panel selected by a legal dynamics subview", () => {
    const html = renderToStaticMarkup(
      <AnalysisPlotsView
        {...props}
        activeSurface="dynamics"
        activeSubview="dynamics.temporal-fft"
        selectedDatasetRef="table-a"
        spinWaveGamma={spinWaveGamma}
        table={tableFixture("table-a", 7)}
      />,
    );

    expect(html).toContain('data-analysis-panel="dynamics.temporal-fft"');
    expect(html).not.toContain('data-analysis-panel="dynamics.s-k-f"');
  });

  it("renders the S(k,f) controls for the legal dynamics subview", () => {
    const html = renderToStaticMarkup(
      <AnalysisPlotsView
        {...props}
        activeSurface="dynamics"
        activeSubview="dynamics.s-k-f"
        dynamicStructureFactor={dynamicStructureFactor}
      />,
    );

    expect(html).toContain('data-analysis-panel="dynamics.s-k-f"');
    expect(html).not.toContain('data-analysis-panel="dynamics.temporal-fft"');
  });

  it("routes a legacy Gamma click to the kernel selection controller", async () => {
    const setSelection = vi.fn();
    const kernel = { selection: { set: setSelection } } as unknown as KernelApi;
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <AnalysisPlotsView
          {...props}
          activeSurface="dynamics"
          activeSubview="dynamics.temporal-fft"
          kernel={kernel}
          spinWaveGamma={spinWaveGamma}
        />,
      ));
      const feature = findElements(container, (element) => element.getAttribute("data-legacy-gamma-feature") === "true")[0];
      expect(feature).toBeDefined();

      await act(async () => feature.click());

      expect(setSelection).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "results.time_domain.spectral_feature",
          label: "legacy:gamma:peak:7",
          nodeId: "analysis:legacy:time-domain:legacy%3Agamma%3Apeak%3A7",
          objectId: null,
          ref: expect.objectContaining({ source: "time-domain-response" }),
        }),
        "analysis-plots",
      );
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("routes a legacy DSF click to the kernel selection controller", async () => {
    const setSelection = vi.fn();
    const kernel = { selection: { set: setSelection } } as unknown as KernelApi;
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <AnalysisPlotsView
          {...props}
          activeSurface="dynamics"
          activeSubview="dynamics.s-k-f"
          dynamicStructureFactor={dynamicStructureFactor}
          kernel={kernel}
        />,
      ));
      const point = findElements(container, (element) => element.getAttribute("data-legacy-dsf-point") === "true")[0];
      expect(point).toBeDefined();

      await act(async () => point.click());

      expect(setSelection).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "results.time_domain.dsf_point",
          label: "legacy:dsf:1:0",
          nodeId: "analysis:legacy:time-domain:legacy%3Adsf%3A1%3A0",
          objectId: null,
          ref: expect.objectContaining({
            kContextKind: "k_path",
            kPathCoordinateRadPerM: 10,
            source: "time-domain-response",
          }),
        }),
        "analysis-plots",
      );
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("does not use a legacy click fallback while canonical result projection is present", async () => {
    const setSelection = vi.fn();
    const kernel = { selection: { set: setSelection } } as unknown as KernelApi;
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const resultProjection = {
      kernel,
      model: { selectionBySeriesId: {}, series: [] },
      onPointSelect: vi.fn(),
      onProjectionSelect: vi.fn(),
      projections: [],
      productKind: null,
      resource: null,
      selectedProjectionId: null,
      selectedSelection: null,
      status: "loading",
    } as unknown as AnalysisResultProjectionSurfaceProps;
    try {
      await act(async () => root.render(
        <AnalysisPlotsView
          {...props}
          activeSurface="dynamics"
          activeSubview="dynamics.temporal-fft"
          kernel={kernel}
          resultProjection={resultProjection}
          spinWaveGamma={spinWaveGamma}
        />,
      ));
      const feature = findElements(container, (element) => element.getAttribute("data-legacy-gamma-feature") === "true")[0];
      expect(feature).toBeDefined();

      await act(async () => feature.click());

      expect(setSelection).not.toHaveBeenCalled();
      expect(resultProjection.onPointSelect).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("keeps dispersion.modal on the frequency surface when no modal artifact is active", () => {
    const html = renderToStaticMarkup(
      <AnalysisPlotsView
        {...props}
        activeSurface="dispersion"
        activeSubview="dispersion.modal"
        dynamicStructureFactor={dynamicStructureFactor}
      />,
    );

    expect(html).toContain('aria-label="Frequency domain"');
    expect(html).toContain("No frequency-domain series available");
    expect(html).not.toContain('data-analysis-panel="dynamics.s-k-f"');
  });

  it("fails closed for a legacy dispersion surface without a frequency artifact", () => {
    const html = renderToStaticMarkup(
      <AnalysisPlotsView
        {...props}
        activeSurface="dispersion"
        dynamicStructureFactor={dynamicStructureFactor}
      />,
    );

    expect(html).toContain('data-analysis-subview="dispersion.modal"');
    expect(html).toContain("No frequency-domain series available");
    expect(html).not.toContain('data-analysis-panel="dynamics.s-k-f"');
  });

  it("enables DSF only for the dynamics S(k,f) subview", async () => {
    function Probe() {
      useAnalysisPlotsController({} as KernelApi);
      return null;
    }

    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      controllerMocks.dynamicStructureFactorEnabled.length = 0;
      controllerMocks.activeSurface = "dynamics";
      controllerMocks.activeSubview = "dynamics.s-k-f";
      await act(async () => root.render(<Probe />));
      expect(controllerMocks.dynamicStructureFactorEnabled.at(-1)).toBe(true);

      controllerMocks.activeSubview = "dynamics.temporal-fft";
      await act(async () => root.render(<Probe />));
      expect(controllerMocks.dynamicStructureFactorEnabled.at(-1)).toBe(false);

      controllerMocks.activeSurface = "dispersion";
      controllerMocks.activeSubview = "dispersion.modal";
      await act(async () => root.render(<Probe />));
      expect(controllerMocks.dynamicStructureFactorEnabled.at(-1)).toBe(false);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
      controllerMocks.activeSurface = "dynamics";
      controllerMocks.activeSubview = "dynamics.time-traces";
    }
  });

  it("fails closed to the canonical first subview for an illegal selection", () => {
    const html = renderToStaticMarkup(
      <AnalysisPlotsView
        {...props}
        activeSurface="dynamics"
        activeSubview={"resonance.eigenmodes" as AnalysisSubview}
        dynamicStructureFactor={dynamicStructureFactor}
        spinWaveGamma={spinWaveGamma}
      />,
    );

    expect(html).toContain('data-analysis-subview="dynamics.time-traces"');
    expect(html).toContain("Select a dataset or artifact");
    expect(html).not.toContain('data-analysis-panel="dynamics.temporal-fft"');
    expect(html).not.toContain('data-analysis-panel="dynamics.s-k-f"');
  });

  it("filters custom subviews to the active surface before choosing one", () => {
    const html = renderToStaticMarkup(
      <AnalysisPlotsView
        {...props}
        activeSurface="dynamics"
        activeSubview={"resonance.eigenmodes" as AnalysisSubview}
        subviews={["resonance.eigenmodes", "dynamics.s-k-f"]}
        dynamicStructureFactor={dynamicStructureFactor}
      />,
    );

    expect(html).toContain('data-analysis-subview="dynamics.s-k-f"');
    expect(html).not.toContain("Eigenmodes");
  });

  it("marks Comparison unavailable until both typed owner identities exist", () => {
    const html = renderToStaticMarkup(<AnalysisPlotsView {...props} activeSurface="comparison" selectedDatasetRef="table-a" />);
    expect(html).toContain("Comparison unavailable");
    expect(html).toContain("typed owner identities");
  });

  it("does not expose a fake successful Comparison path for matching table columns", () => {
    const html = renderToStaticMarkup(<AnalysisPlotsView {...props} activeSurface="comparison" selectedDatasetRef="table-a" table={tableFixture("table-a", 7)} />);
    expect(html).toContain("Comparison unavailable");
    expect(html).not.toContain("Compatibility verdict: Compatible");
  });

  it("renders surface-specific provenance for all five surfaces", () => {
    const expected: Record<string, string | null> = {
      comparison: null, dynamics: "table-a · revision 7",
      dispersion: "dynamic-structure-factor",
      "resonance-fmr": "response/magnetic-sweep", hysteresis: "hysteresis",
    };
    for (const [surface, provenance] of Object.entries(expected)) {
      const html = renderToStaticMarkup(<AnalysisPlotsView {...props} activeSurface={surface as never} selectedDatasetRef="table-a" table={tableFixture("table-a", 7)} frequencyDomainProvenance={provenance} surfaceProvenance={{ dispersion: provenance!, hysteresis: provenance! }} /> as never);
      if (provenance) expect(html).toContain(provenance);
      if (surface !== "dynamics") expect(html).not.toContain("Dataset provenance: table-a");
    }
  });
});
