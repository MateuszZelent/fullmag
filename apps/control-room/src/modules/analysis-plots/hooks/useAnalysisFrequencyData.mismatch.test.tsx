import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type { AnalysisSubview } from "@/kernel/workspace/analysisViewPreferences";

const manifest = vi.fn();
const spectrum = vi.fn();
const dispersion = vi.fn();
const branches = vi.fn();
const response = vi.fn();
let manifestState: { data: unknown; status: string } = {
  data: { result_manifest: { payload: { artifacts: { response_sweep_v2_path: "response.json" }, requested_execution: { calculation_mode: "fmr_response" }, run_id: "run-current" } } },
  status: "ready",
};
let selectedResultRunId: string | null = null;
let spectrumState: { data: unknown; status: string } = { data: null, status: "idle" };
let responseState: { data: unknown; status: string } = { data: null, status: "idle" };

vi.mock("@/kernel/selection/useSelection", () => ({
  useSelectionSelector: (selector: (selection: unknown) => unknown) =>
    selector({ ref: selectedResultRunId ? { analysisRunId: selectedResultRunId, type: "frequency-domain" } : null }),
}));
vi.mock("@/kernel/resources/studyRuntimeResources", () => ({
  useFrequencyDomainManifestResource: (options: unknown) => { manifest(options); return manifestState; },
  useFrequencyDomainEigenSpectrumResource: (options: unknown) => { spectrum(options); return spectrumState; },
  useFrequencyDomainEigenDispersionResource: (options: unknown) => { dispersion(options); return { data: null, status: "idle" }; },
  useFrequencyDomainEigenBranchesResource: (options: unknown) => { branches(options); return { data: null, status: "idle" }; },
  useFrequencyDomainResponseSweepResource: (options: unknown) => { response(options); return responseState; },
}));

import { useAnalysisFrequencyData } from "./useAnalysisFrequencyData";

function Harness({ surface = "resonance-fmr", activeSubview, showRoute = false }: { surface?: "dispersion" | "resonance-fmr"; activeSubview?: AnalysisSubview; showRoute?: boolean }) {
  const data = useAnalysisFrequencyData(surface, activeSubview);
  return <span>{`${data.frequencyDomainStatus}:${data.frequencyDomainSeries.length}${showRoute ? `:${data.frequencyDomainRoute.primaryChart}:${data.frequencyDomainComparisonModel.readiness}` : ""}`}</span>;
}

describe("frequency surface mismatch", () => {
  it("keeps every artifact resource disabled until a ready manifest resolves the matching response route", async () => {
    manifestState = { data: null, status: "loading" };
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<Harness surface="resonance-fmr" />));
      expect(container.textContent).toBe("loading:0");
      for (const call of [spectrum, dispersion, branches, response]) expect(call).toHaveBeenLastCalledWith({ enabled: false });

      manifestState = { data: { result_manifest: { payload: { artifacts: { response_sweep_v2_path: "response.json" }, requested_execution: { calculation_mode: "fmr_response" }, run_id: "run-current" } } }, status: "ready" };
      await act(async () => root.render(<Harness surface="resonance-fmr" />));
      expect(response).toHaveBeenLastCalledWith({ enabled: true });
      for (const call of [spectrum, dispersion, branches]) {
        expect(call.mock.calls.every(([options]) => (options as { enabled: boolean }).enabled === false)).toBe(true);
      }
    } finally { manifestState = { data: { result_manifest: { payload: { artifacts: { response_sweep_v2_path: "response.json" }, requested_execution: { calculation_mode: "fmr_response" }, run_id: "run-current" } } }, status: "ready" }; await act(async () => root.unmount()); dom.restore(); }
  });

  it("rejects a response artifact on the dispersion surface without loading it", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<Harness surface="dispersion" />));
      expect(container.textContent).toBe("unsupported:0");
      expect(manifest).toHaveBeenCalledWith({ enabled: true });
      for (const call of [spectrum, dispersion, branches, response]) expect(call).toHaveBeenCalledWith({ enabled: false });
    } finally { await act(async () => root.unmount()); dom.restore(); }
  });

  it("marks a ready manifest without its required response artifact unsupported", async () => {
    manifestState = { data: { result_manifest: { payload: { artifacts: {}, requested_execution: { calculation_mode: "fmr_response" } } } }, status: "ready" };
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<Harness surface="resonance-fmr" />));
      expect(container.textContent).toBe("unsupported:0");
      for (const call of [spectrum, dispersion, branches, response]) expect(call).toHaveBeenLastCalledWith({ enabled: false });
    } finally {
      manifestState = { data: { result_manifest: { payload: { artifacts: { response_sweep_v2_path: "response.json" }, requested_execution: { calculation_mode: "fmr_response" } } } }, status: "ready" };
      await act(async () => root.unmount()); dom.restore();
    }
  });
  it("fails closed when a selected FMR subview is not published by the manifest", async () => {
    manifestState = { data: { result_manifest: { payload: { artifacts: { response_sweep_v2_path: "response.json" }, requested_execution: { calculation_mode: "fmr_response" }, run_id: "run-current" } } }, status: "ready" };
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<Harness activeSubview="resonance.eigenmodes" />));
      expect(container.textContent).toBe("unsupported:0");
      for (const call of [spectrum, dispersion, branches, response]) {
        expect(call).toHaveBeenLastCalledWith({ enabled: false });
      }
    } finally { await act(async () => root.unmount()); dom.restore(); }
  });

  it("does not display current-session data for a selected historical result run", async () => {
    selectedResultRunId = "run-history";
    manifestState = { data: { result_manifest: { payload: { artifacts: { response_sweep_v2_path: "response.json" }, requested_execution: { calculation_mode: "fmr_response" }, run_id: "run-current" } } }, status: "ready" };
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<Harness surface="resonance-fmr" />));
      expect(container.textContent).toBe("unsupported:0");
      expect(response).toHaveBeenLastCalledWith({ enabled: false });
    } finally {
      selectedResultRunId = null;
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("loads both compatible owners for the modal-driven comparison route", async () => {
    manifestState = {
      data: {
        result_manifest: {
          payload: {
            artifacts: {
              response_sweep_v2_path: "response.json",
              spectrum_v2_path: "spectrum.json",
            },
            equilibrium_identity: "eq-1",
            geometry_identity: "geometry-1",
            mesh_identity: "mesh-1",
            requested_execution: {
              boundary_context: "finite_open",
              calculation_mode: "fmr_response",
            },
            run_id: "run-1",
            stage_id: "stage-1",
            study_product: "driven_response",
          },
        },
      },
      status: "ready",
    };
    spectrumState = {
      data: { payload: { modes: [{ frequency_hz: 1e9, raw_mode_index: 0, sample_index: 0 }] } },
      status: "ready",
    };
    responseState = {
      data: {
        payload: {
          points: [
            { frequency_hz: 0.9e9, max_response_amplitude: 0.5, observable_id: "mx" },
            { frequency_hz: 1e9, max_response_amplitude: 2, observable_id: "mx" },
            { frequency_hz: 1.1e9, max_response_amplitude: 0.5, observable_id: "mx" },
          ],
        },
      },
      status: "ready",
    };
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<Harness activeSubview="resonance.modal-driven" showRoute />));
      expect(container.textContent).toBe("ready:0:comparison:modal-and-driven");
      expect(spectrum).toHaveBeenLastCalledWith({ enabled: true });
      expect(response).toHaveBeenLastCalledWith({ enabled: true });
    } finally {
      spectrumState = { data: null, status: "idle" };
      responseState = { data: null, status: "idle" };
      manifestState = { data: { result_manifest: { payload: { artifacts: { response_sweep_v2_path: "response.json" }, requested_execution: { calculation_mode: "fmr_response" }, run_id: "run-current" } } }, status: "ready" };
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
