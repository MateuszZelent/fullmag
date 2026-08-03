import { readFileSync } from "node:fs";
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

  it("presents ready postprocessing as Ready rather than Live", () => {
    const gamma = readFileSync(new URL("./SpinWaveGammaView.tsx", import.meta.url), "utf8");
    const structureFactor = readFileSync(new URL("./DynamicStructureFactorView.tsx", import.meta.url), "utf8");
    expect(gamma).toContain('status === "ready" ? "Ready"');
    expect(structureFactor).toContain('status === "ready" ? "Ready"');
    expect(gamma).not.toContain('status === "ready" ? "Live"');
    expect(structureFactor).not.toContain('status === "ready" ? "Live"');
  });

  it("keeps Analysis separate from active runtime ownership", () => {
    const controller = readFileSync(new URL("./useAnalysisPlotsController.ts", import.meta.url), "utf8");
    expect(controller).toContain("useAnalysisDatasetData");
    expect(controller).toContain('activeSurface === "spectrum"');
    expect(controller).toContain('activeSurface === "dispersion"');
    expect(controller).not.toContain("useAnalysis" + "TableData");
    expect(controller).not.toContain("useAnalysis" + "EnergyData");
  });

  it("owns chart interactions through explicit Analysis state and dataset identity", () => {
    const view = readFileSync(new URL("./AnalysisPlotsView.tsx", import.meta.url), "utf8");
    const manifest = readFileSync(new URL("./manifest.ts", import.meta.url), "utf8");
    expect(view).not.toContain("onPointSelect={() => undefined}");
    expect(view).not.toContain("onRangeChange={() => undefined}");
    expect(view).not.toContain("onSelectedSeriesIdsChange={() => undefined}");
    expect(manifest).not.toContain('const chartId = "default"');
    expect(manifest).not.toContain('const tableId = "default"');
  });

  it("requires a controlled second published source for Comparison", () => {
    const view = readFileSync(new URL("./AnalysisPlotsView.tsx", import.meta.url), "utf8");
    expect(view).toContain("Select a second published dataset compatible with");
    expect(view).not.toContain("Select comparison datasets");
  });

  it("uses distinct artifact kinds for frequency response and eigenmodes", () => {
    const controller = readFileSync(new URL("./useAnalysisPlotsController.ts", import.meta.url), "utf8");
    const frequency = readFileSync(new URL("./hooks/useAnalysisFrequencyData.ts", import.meta.url), "utf8");
    expect(controller).toContain('? activeSurface : "idle"');
    expect(frequency).toContain('"frequency-response" | "eigenmodes" | "idle"');
  });

  it("labels provenance by the selected surface rather than every surface as a table", () => {
    const view = readFileSync(new URL("./AnalysisPlotsView.tsx", import.meta.url), "utf8");
    expect(view).toContain('surface === "dynamics" || surface === "comparison"');
    expect(view).toContain("frequencyDomainProvenance");
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
