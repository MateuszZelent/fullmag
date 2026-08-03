import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";

const manifest = vi.fn();
const spectrum = vi.fn();
const dispersion = vi.fn();
const branches = vi.fn();
const response = vi.fn();
let manifestState: { data: unknown; status: string } = {
  data: { result_manifest: { payload: { artifacts: { response_sweep_v2_path: "response.json" }, requested_execution: { calculation_mode: "fmr_response" } } } },
  status: "ready",
};

vi.mock("@/kernel/selection/useSelection", () => ({ useSelectionSelector: () => null }));
vi.mock("@/kernel/resources/studyRuntimeResources", () => ({
  useFrequencyDomainManifestResource: (options: unknown) => { manifest(options); return manifestState; },
  useFrequencyDomainEigenSpectrumResource: (options: unknown) => { spectrum(options); return { data: null, status: "idle" }; },
  useFrequencyDomainEigenDispersionResource: (options: unknown) => { dispersion(options); return { data: null, status: "idle" }; },
  useFrequencyDomainEigenBranchesResource: (options: unknown) => { branches(options); return { data: null, status: "idle" }; },
  useFrequencyDomainResponseSweepResource: (options: unknown) => { response(options); return { data: null, status: "idle" }; },
}));

import { useAnalysisFrequencyData } from "./useAnalysisFrequencyData";

function Harness({ surface = "eigenmodes" }: { surface?: "eigenmodes" | "frequency-response" }) {
  const data = useAnalysisFrequencyData(surface);
  return <span>{`${data.frequencyDomainStatus}:${data.frequencyDomainSeries.length}`}</span>;
}

describe("frequency surface mismatch", () => {
  it("keeps every artifact resource disabled until a ready manifest resolves the matching response route", async () => {
    manifestState = { data: null, status: "loading" };
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<Harness surface="frequency-response" />));
      expect(container.textContent).toBe("loading:0");
      for (const call of [spectrum, dispersion, branches, response]) expect(call).toHaveBeenLastCalledWith({ enabled: false });

      manifestState = { data: { result_manifest: { payload: { artifacts: { response_sweep_v2_path: "response.json" }, requested_execution: { calculation_mode: "fmr_response" } } } }, status: "ready" };
      await act(async () => root.render(<Harness surface="frequency-response" />));
      expect(response).toHaveBeenLastCalledWith({ enabled: true });
      for (const call of [spectrum, dispersion, branches]) {
        expect(call.mock.calls.every(([options]) => (options as { enabled: boolean }).enabled === false)).toBe(true);
      }
    } finally { manifestState = { data: { result_manifest: { payload: { artifacts: { response_sweep_v2_path: "response.json" }, requested_execution: { calculation_mode: "fmr_response" } } } }, status: "ready" }; await act(async () => root.unmount()); dom.restore(); }
  });

  it("mounts eigenmodes against a response artifact without loading any nonmatching artifact resource", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<Harness />));
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
      await act(async () => root.render(<Harness surface="frequency-response" />));
      expect(container.textContent).toBe("unsupported:0");
      for (const call of [spectrum, dispersion, branches, response]) expect(call).toHaveBeenLastCalledWith({ enabled: false });
    } finally {
      manifestState = { data: { result_manifest: { payload: { artifacts: { response_sweep_v2_path: "response.json" }, requested_execution: { calculation_mode: "fmr_response" } } } }, status: "ready" };
      await act(async () => root.unmount()); dom.restore();
    }
  });
});
