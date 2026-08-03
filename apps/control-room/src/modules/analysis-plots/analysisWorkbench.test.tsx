import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { KernelApi } from "@/kernel/types";
import { AnalysisPlotsView } from "./AnalysisPlotsView";

const props = {
  datasetRefs: [], dynamicStructureFactor: null, dynamicStructureFactorStatus: "idle", frequencyDomainSeries: [], frequencyDomainStatus: "idle", frequencyDomainTitle: "Frequency domain", frequencyDomainUnavailableReason: null,
  kernel: {} as KernelApi, onDatasetRefChange: vi.fn(), onSurfaceChange: vi.fn(), selectedDatasetRef: null, selectedStageId: null, spinWaveGamma: null, spinWaveGammaStatus: "idle", table: null, tableStatus: "idle", tableUnsupportedReason: null,
};

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
});
