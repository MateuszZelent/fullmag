import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { KernelApi } from "@/kernel/types";
import { chartTableWindowFromBinary } from "@/shared/domain/analysis/chartDataPlan";
import { AnalysisPlotsView } from "./AnalysisPlotsView";

const props = {
  datasetRefs: [], dynamicStructureFactor: null, dynamicStructureFactorStatus: "idle", frequencyDomainSeries: [], frequencyDomainStatus: "idle", frequencyDomainTitle: "Frequency domain", frequencyDomainUnavailableReason: null,
  kernel: {} as KernelApi, onDatasetRefChange: vi.fn(), onSurfaceChange: vi.fn(), selectedDatasetRef: null, selectedStageId: null, spinWaveGamma: null, spinWaveGammaStatus: "idle", table: null, tableStatus: "idle", tableUnsupportedReason: null,
};

function tableFixture(tableId: string, revision: number) {
  return chartTableWindowFromBinary({
    columns: [{ column_id: "step", label: "step", unit: "1" }, { column_id: "mx", label: "mx", unit: "1" }],
    decoded: { columnCount: 2, cursorEnd: 1, cursorStart: 1, resyncRequired: false, revision, rowCount: 1, schemaRevision: 1, totalRows: 1, values: new Float64Array([0, 1]) },
    tableId,
  });
}

describe("Analysis workbench", () => {
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
