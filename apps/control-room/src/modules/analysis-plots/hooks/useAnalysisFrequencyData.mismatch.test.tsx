import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";

const manifest = vi.fn();
const spectrum = vi.fn();
const dispersion = vi.fn();
const branches = vi.fn();
const fieldSweep = vi.fn();
const response = vi.fn();
const selectionFixture = vi.hoisted((): { value: { kind: string } | null } => ({ value: null }));
let manifestState: { data: unknown; status: string } = {
  data: { result_manifest: { payload: { artifacts: { response_sweep_v2_path: "response.json" }, requested_execution: { calculation_mode: "fmr_response" } } } },
  status: "ready",
};
let responseState: { data: unknown; status: string } = {
  data: null,
  status: "idle",
};

vi.mock("@/kernel/selection/useSelection", () => ({
  useSelectionSelector: (selector: (value: { kind: string } | null) => unknown) =>
    selector(selectionFixture.value),
}));
vi.mock("@/kernel/resources/studyRuntimeResources", () => ({
  useFrequencyDomainManifestResource: (options: unknown) => { manifest(options); return manifestState; },
  useFrequencyDomainEigenSpectrumResource: (options: unknown) => { spectrum(options); return { data: null, status: "idle" }; },
  useFrequencyDomainEigenDispersionResource: (options: unknown) => { dispersion(options); return { data: null, status: "idle" }; },
  useFrequencyDomainEigenBranchesResource: (options: unknown) => { branches(options); return { data: null, status: "idle" }; },
  useFrequencyDomainEigenFieldSweepResource: (options: unknown) => { fieldSweep(options); return { data: { resource_key: "field-sweep", status: "ready" }, status: "ready" }; },
  useFrequencyDomainResponseSweepResource: (options: unknown) => { response(options); return responseState; },
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
      for (const call of [spectrum, dispersion, branches, fieldSweep, response]) expect(call).toHaveBeenLastCalledWith({ enabled: false });

      manifestState = { data: { result_manifest: { payload: { artifacts: { response_sweep_v2_path: "response.json" }, requested_execution: { calculation_mode: "fmr_response" } } } }, status: "ready" };
      await act(async () => root.render(<Harness surface="frequency-response" />));
      expect(response).toHaveBeenLastCalledWith({ enabled: true });
      for (const call of [spectrum, dispersion, branches, fieldSweep]) {
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
      for (const call of [spectrum, dispersion, branches, fieldSweep, response]) expect(call).toHaveBeenCalledWith({ enabled: false });
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
      for (const call of [spectrum, dispersion, branches, fieldSweep, response]) expect(call).toHaveBeenLastCalledWith({ enabled: false });
    } finally {
      manifestState = { data: { result_manifest: { payload: { artifacts: { response_sweep_v2_path: "response.json" }, requested_execution: { calculation_mode: "fmr_response" } } } }, status: "ready" };
      await act(async () => root.unmount()); dom.restore();
    }
  });

  it("loads the typed Field Sweep resource but fails closed when typed A2 omits chart fields", async () => {
    manifestState = { data: { result_manifest: { payload: { artifacts: { spectrum_v2_path: "spectrum.json" }, requested_execution: { calculation_mode: "free_modes" } } } }, status: "ready" };
    selectionFixture.value = { kind: "results.eigen.field_sweep" };
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<Harness />));
      expect(container.textContent).toBe("unsupported:0");
      expect(fieldSweep).toHaveBeenLastCalledWith({ enabled: true });
    } finally {
      selectionFixture.value = null;
      manifestState = { data: { result_manifest: { payload: { artifacts: { response_sweep_v2_path: "response.json" }, requested_execution: { calculation_mode: "fmr_response" } } } }, status: "ready" };
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("fails a ready Driven Response resource closed when typed A2 omits observable contracts", async () => {
    responseState = {
      data: {
        artifact_path: "response/magnetic_response_sweep.v2.json",
        payload: {
          points: [{ frequency_hz: 9.5e9, max_response_amplitude: 1.25 }],
          schema_version: "magnetic_response_sweep.v2",
        },
        resource_key: "analysis/frequency-domain/response/magnetic-sweep",
        schema_version: "frequency_domain_response_sweep_resource.v1",
        status: "ready",
      },
      status: "ready",
    };
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<Harness surface="frequency-response" />));
      expect(container.textContent).toBe("unsupported:0");
    } finally {
      responseState = { data: null, status: "idle" };
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
