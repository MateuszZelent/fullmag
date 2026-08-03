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
  it("exposes the seven explicit dataset-driven workbench surfaces", () => {
    const html = renderToStaticMarkup(<AnalysisPlotsView {...props} activeSurface="dynamics" />);
    for (const label of ["Dynamics", "Spectrum", "Frequency Response", "Eigenmodes", "Dispersion", "Hysteresis", "Comparison"]) expect(html).toContain(`>${label}</button>`);
  });

  it("renders each selected workbench surface", () => {
    for (const activeSurface of ["dynamics", "spectrum", "frequency-response", "eigenmodes", "dispersion", "hysteresis", "comparison"] as const) {
      const html = renderToStaticMarkup(<AnalysisPlotsView {...props} activeSurface={activeSurface} />);
      expect(html).toContain('aria-label="Analysis dataset"');
    }
  });

  it("requires a controlled second published source for Comparison", () => {
    const html = renderToStaticMarkup(<AnalysisPlotsView {...props} activeSurface="comparison" selectedDatasetRef="table-a" />);
    expect(html).toContain("Select a second published dataset compatible with table-a");
  });

  it("renders paired compatible comparison sources with their frozen revisions", () => {
    const html = renderToStaticMarkup(<AnalysisPlotsView {...props} activeSurface="comparison" comparisonDatasetRef="table-b" comparisonTable={tableFixture("table-b", 11)} selectedDatasetRef="table-a" table={tableFixture("table-a", 7)} />);
    expect(html).toContain("table-a · revision 7");
    expect(html).toContain("table-b · revision 11");
    expect(html).toContain("Compatible series");
  });

  it("renders surface-specific provenance for all seven surfaces", () => {
    const expected: Record<string, string | null> = {
      comparison: "table-a · revision 7", dynamics: "table-a · revision 7",
      dispersion: "dynamic-structure-factor", eigenmodes: "eigen/spectrum",
      "frequency-response": "response/magnetic-sweep", hysteresis: "hysteresis",
      spectrum: "spin-wave-gamma",
    };
    for (const [surface, provenance] of Object.entries(expected)) {
      const html = renderToStaticMarkup(<AnalysisPlotsView {...props} activeSurface={surface as never} selectedDatasetRef="table-a" table={tableFixture("table-a", 7)} frequencyDomainProvenance={provenance} surfaceProvenance={{ dispersion: provenance!, hysteresis: provenance!, spectrum: provenance! }} /> as never);
      expect(html).toContain(provenance!);
      if (surface !== "dynamics" && surface !== "comparison") expect(html).not.toContain("Dataset provenance: table-a");
    }
  });
});
