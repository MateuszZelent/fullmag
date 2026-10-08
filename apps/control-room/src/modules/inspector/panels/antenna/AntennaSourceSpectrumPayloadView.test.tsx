import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AntennaSourceSpectrumResource,
  BinaryResourceResult,
} from "@/kernel/api/apiTypes";
import { ControlRoomApiError } from "@/kernel/api/ControlRoomApi";
import type { ResourceResult } from "@/kernel/resources/resourceTypes";
import {
  installSimulationPreparationTestDom,
  TestElement,
  TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

type PayloadResource = ResourceResult<BinaryResourceResult<ArrayBuffer> | null>;

const mocks = vi.hoisted(() => ({
  payloads: {} as Record<string, PayloadResource>,
}));

vi.mock("@/kernel/resources/antennaResources", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/kernel/resources/antennaResources")>(),
  useAntennaSourceSpectrumPayloadResource: (
    _outputId: string,
    payloadKind: string,
  ) => mocks.payloads[payloadKind] ?? loadingPayload(),
}));

import { AntennaSourceSpectrumPayloadView } from "./AntennaSourceSpectrumPayloadView";

afterEach(() => {
  mocks.payloads = {};
});

describe("AntennaSourceSpectrumPayloadView", () => {
  it("decodes little-endian payloads and renders a bounded heatmap", async () => {
    mocks.payloads = {
      k_u_rad_per_m: readyPayload([0, 1], "etag-ku"),
      k_v_rad_per_m: readyPayload([0, 2], "etag-kv"),
      amplitudes_re_im: readyPayload([1, 0, 1, 2, Math.SQRT2, 0, Math.sqrt(3), 0], "etag-amplitudes"),
      power: readyPayload([1, 5, 2, 3], "etag-power"),
    };
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () =>
        root.render(
          <AntennaSourceSpectrumPayloadView
            outputId="spectrum-1"
            spectrum={spectrumFixture()}
          />,
        ),
      );
      expect(container.textContent).toContain("Source FFT power");
      expect(container.textContent).toContain(
        "per 1 A port-current basis; drive waveform not applied",
      );
      expect(container.textContent).not.toContain("declared current");
      expect(container.textContent).toContain("cells: 4");
      expect(container.textContent).toContain("Peak 5.000e+0 (A/m/A)^2");
      expect(container.querySelector('[role="grid"]')).toBeDefined();
      expect(countByRole(container as unknown as TestNode, "gridcell")).toBe(4);
      const firstCell = firstByRole(container as unknown as TestNode, "gridcell");
      expect(firstCell?.getAttribute("aria-label")).toContain("(A/m/A)^2");
      expect(firstCell?.getAttribute("title")).toContain("(A/m/A)^2");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("keeps a narrow peak visible when the k grid is bounded", async () => {
    const kU = Array.from({ length: 129 }, (_, index) => index);
    const power = Array(258).fill(1) as number[];
    power[1] = 100;
    mocks.payloads = {
      k_u_rad_per_m: readyPayload(kU, "etag-ku"),
      k_v_rad_per_m: readyPayload([0, 1], "etag-kv"),
      amplitudes_re_im: readyPayload(power.flatMap((value) => [Math.sqrt(value), 0]), "etag-amplitudes"),
      power: readyPayload(power, "etag-power"),
    };
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <AntennaSourceSpectrumPayloadView
          outputId="spectrum-1"
          spectrum={{ ...spectrumFixture(), k_u_count: 129, power_count: 258, amplitude_count: 258 }}
        />,
      ));
      expect(countByRole(container as unknown as TestNode, "gridcell")).toBe(128);
      expect(hasGridCellTitle(container as unknown as TestNode, "k_u=1.000e+0")).toBe(true);
      expect(container.textContent).toContain("Peak 1.000e+2");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("surfaces a failed binary resource without drawing stale cells", async () => {
    mocks.payloads = {
      k_u_rad_per_m: readyPayload([0, 1], "etag-ku"),
      k_v_rad_per_m: readyPayload([0, 2], "etag-kv"),
      amplitudes_re_im: readyPayload([1, 0, 1, 2, Math.SQRT2, 0, Math.sqrt(3), 0], "etag-amplitudes"),
      power: errorPayload("checksum mismatch"),
    };
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () =>
        root.render(
          <AntennaSourceSpectrumPayloadView
            outputId="spectrum-1"
            spectrum={spectrumFixture()}
          />,
        ),
      );
      expect(container.textContent).toContain("FFT payload unavailable: checksum mismatch");
      expect(countByRole(container as unknown as TestNode, "gridcell")).toBe(0);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("does not render retained binary data while one payload is stale", async () => {
    mocks.payloads = {
      k_u_rad_per_m: readyPayload([0, 1], "etag-ku"),
      k_v_rad_per_m: readyPayload([0, 2], "etag-kv"),
      amplitudes_re_im: readyPayload([1, 0, 1, 2, Math.SQRT2, 0, Math.sqrt(3), 0], "etag-amplitudes"),
      power: { ...readyPayload([1, 5, 2, 3], "etag-power"), status: "stale" },
    };
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <AntennaSourceSpectrumPayloadView outputId="spectrum-1" spectrum={spectrumFixture()} />,
      ));
      expect(container.textContent).toContain("Loading binary FFT payloads");
      expect(countByRole(container as unknown as TestNode, "gridcell")).toBe(0);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it.each([
    ["k_u_rad_per_m", [Number.NaN, 1], "wave-vector payload contains a non-finite value"],
    ["amplitudes_re_im", [1, 0, Number.POSITIVE_INFINITY, 2, Math.SQRT2, 0, Math.sqrt(3), 0], "amplitude payload contains a non-finite value"],
    ["power", [1, -5, 2, 3], "power payload contains a non-finite or negative value"],
  ] as const)("rejects invalid numeric data in %s", async (kind, values, expected) => {
    mocks.payloads = {
      k_u_rad_per_m: readyPayload([0, 1], "etag-ku"),
      k_v_rad_per_m: readyPayload([0, 2], "etag-kv"),
      amplitudes_re_im: readyPayload([1, 0, 1, 2, Math.SQRT2, 0, Math.sqrt(3), 0], "etag-amplitudes"),
      power: readyPayload([1, 5, 2, 3], "etag-power"),
      [kind]: readyPayload([...values], `etag-${kind}`),
    };
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <AntennaSourceSpectrumPayloadView outputId="spectrum-1" spectrum={spectrumFixture()} />,
      ));
      expect(container.textContent).toContain(expected);
      expect(countByRole(container as unknown as TestNode, "gridcell")).toBe(0);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("rejects an amplitude payload with fewer complex samples than the k grid", async () => {
    mocks.payloads = {
      k_u_rad_per_m: readyPayload([0, 1], "etag-ku"),
      k_v_rad_per_m: readyPayload([0, 2], "etag-kv"),
      amplitudes_re_im: readyPayload([1, 0, 2, -1], "etag-amplitudes"),
      power: readyPayload([1, 5, 2, 3], "etag-power"),
    };
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <AntennaSourceSpectrumPayloadView
          outputId="spectrum-1"
          spectrum={{ ...spectrumFixture(), amplitude_count: 2 }}
        />,
      ));
      expect(container.textContent).toContain(
        "complex amplitudes do not match the component and k-grid counts",
      );
      expect(countByRole(container as unknown as TestNode, "gridcell")).toBe(0);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("rejects a finite positive power payload inconsistent with complex amplitudes", async () => {
    mocks.payloads = {
      k_u_rad_per_m: readyPayload([0, 1], "etag-ku"),
      k_v_rad_per_m: readyPayload([0, 2], "etag-kv"),
      amplitudes_re_im: readyPayload([1, 0, 1, 2, Math.SQRT2, 0, Math.sqrt(3), 0], "etag-amplitudes"),
      power: readyPayload([1, 6, 2, 3], "etag-power"),
    };
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <AntennaSourceSpectrumPayloadView outputId="spectrum-1" spectrum={spectrumFixture()} />,
      ));
      expect(container.textContent).toContain(
        "power payload disagrees with complex amplitudes at k-grid cell 1",
      );
      expect(countByRole(container as unknown as TestNode, "gridcell")).toBe(0);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("accepts vector power summed across three component-major amplitude planes", async () => {
    mocks.payloads = {
      k_u_rad_per_m: readyPayload([0, 1], "etag-ku"),
      k_v_rad_per_m: readyPayload([0, 2], "etag-kv"),
      amplitudes_re_im: readyPayload([
        1, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 1, 2, 0, 0, 0, 0,
        0, 0, 0, 0, 1, 1, 0, Math.sqrt(3),
      ], "etag-amplitudes"),
      power: readyPayload([1, 5, 2, 3], "etag-power"),
    };
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <AntennaSourceSpectrumPayloadView
          outputId="spectrum-1"
          spectrum={{ ...spectrumFixture(), component: "vector_power", component_labels: ["x", "y", "z"], amplitude_count: 12 }}
        />,
      ));
      expect(container.textContent).toContain("Peak 5.000e+0");
      expect(countByRole(container as unknown as TestNode, "gridcell")).toBe(4);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("does not mask a missing published payload as an absent spectrum", async () => {
    mocks.payloads = {
      k_u_rad_per_m: readyPayload([0, 1], "etag-ku"),
      k_v_rad_per_m: readyPayload([0, 2], "etag-kv"),
      amplitudes_re_im: readyPayload([1, 0, 1, 2, Math.SQRT2, 0, Math.sqrt(3), 0], "etag-amplitudes"),
      power: errorPayload(
        new ControlRoomApiError(
          "payload is missing",
          404,
          "request-1",
          "missing_payload",
        ),
      ),
    };
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () =>
        root.render(
          <AntennaSourceSpectrumPayloadView
            outputId="spectrum-1"
            spectrum={spectrumFixture()}
          />,
        ),
      );
      expect(container.textContent).toContain(
        "published spectrum manifest references a missing binary payload",
      );
      expect(countByRole(container as unknown as TestNode, "gridcell")).toBe(0);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

function loadingPayload(): PayloadResource {
  return {
    data: null,
    error: null,
    refetch: vi.fn(),
    revision: null,
    status: "loading",
  };
}

function readyPayload(values: number[], etag: string): PayloadResource {
  const data = new ArrayBuffer(values.length * 8);
  const view = new DataView(data);
  values.forEach((value, index) => view.setFloat64(index * 8, value, true));
  return {
    data: {
      byteLength: data.byteLength,
      data,
      etag,
      status: "ready",
    },
    error: null,
    refetch: vi.fn(),
    revision: etag,
    status: "ready",
  };
}

function errorPayload(error: Error | string): PayloadResource {
  return {
    data: null,
    error: typeof error === "string" ? new Error(error) : error,
    refetch: vi.fn(),
    revision: null,
    status: "error",
  };
}

function spectrumFixture(): AntennaSourceSpectrumResource {
  return {
    amplitude_count: 4,
    amplitude_unit: "A/m/A",
    coherent_gain: 1,
    component: "x",
    component_labels: ["x"],
    content_digest: "sha256:spectrum",
    equivalent_noise_bandwidth_bins: 1,
    field_signature: "sha256:field",
    k_u_count: 2,
    k_v_count: 2,
    normalization: "unitary_discrete",
    output_id: "spectrum-1",
    payload: {
      content_type: "application/octet-stream",
      format: "float64_le",
      path: "antenna/source_spectra/spectrum-1/spectrum.v1.json",
    },
    payloads: {
      amplitudes_re_im: binaryRef("A/m/A"),
      k_u_rad_per_m: binaryRef("rad/m"),
      k_v_rad_per_m: binaryRef("rad/m"),
      power: binaryRef("(A/m/A)^2"),
    },
    port_mode_id: "mode-1",
    power_count: 4,
    quantity: "H_ant_source_spectrum",
    request_id: "request-1",
    resource_id: "antenna/source-spectrum/spectrum-1",
    sampling: {} as AntennaSourceSpectrumResource["sampling"],
    schema_version: "antenna_source_spectrum.v2",
    session_epoch: "epoch-1",
    request_scope_epoch: "instance-1:7",
    session_id: "session-1",
    solution_content_digest: "sha256:solution",
    solution_id: "solution-1",
    source_object_id: "antenna-1",
    wave_vector_unit: "rad/m",
  };
}

function binaryRef(unit: string) {
  return {
    layout: "scalar",
    path: "payload.f64le",
    scalar_type: "float64_le",
    sha256: "sha256:payload",
    unit,
    value_count: 1,
  };
}

function countByRole(root: TestNode, role: string): number {
  let count = 0;
  const visit = (node: TestNode): void => {
    if (node instanceof TestElement && node.getAttribute("role") === role) {
      count += 1;
    }
    node.childNodes.forEach(visit);
  };
  visit(root);
  return count;
}

function hasGridCellTitle(root: TestNode, needle: string): boolean {
  if (root instanceof TestElement && root.getAttribute("role") === "gridcell" &&
      root.getAttribute("title")?.includes(needle)) return true;
  return root.childNodes.some((child) => hasGridCellTitle(child, needle));
}

function firstByRole(root: TestNode, role: string): TestElement | null {
  if (root instanceof TestElement && root.getAttribute("role") === role) {
    return root;
  }
  for (const child of root.childNodes) {
    const match = firstByRole(child, role);
    if (match) return match;
  }
  return null;
}
