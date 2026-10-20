import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AntennaSourceSpectrumResource,
  BinaryResourceResult,
  AntennaSpectrumPayloadKind,
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
  calls: [] as { kind: string; options: { enabled?: boolean; expectedEtag?: string; maxResponseBytes?: number } }[],
}));

vi.mock("@/kernel/resources/antennaResources", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/kernel/resources/antennaResources")>(),
  useAntennaSourceSpectrumPayloadResource: (
    _outputId: string,
    payloadKind: string,
    options: { enabled?: boolean; expectedEtag?: string; maxResponseBytes?: number },
  ) => {
    mocks.calls.push({ kind: payloadKind, options });
    return mocks.payloads[payloadKind] ?? loadingPayload();
  },
}));

import { AntennaSourceSpectrumPayloadView } from "./AntennaSourceSpectrumPayloadView";

afterEach(() => {
  mocks.payloads = {};
  mocks.calls = [];
});

describe("AntennaSourceSpectrumPayloadView", () => {
  it.each([
    ["missing descriptor", () => spectrumFixture({ payloads: null })],
    ["inconsistent counts", () => spectrumFixture({ amplitude_count: 2 })],
    ["unsafe k-grid", () => spectrumFixture({ k_u_count: Number.MAX_SAFE_INTEGER })],
    ["interactive memory budget", () => spectrumFixture({ k_u_count: 4096, k_v_count: 4096, power_count: 4096 ** 2, amplitude_count: 4096 ** 2 })],
    ["wrong layout", () => {
      const spectrum = spectrumFixture();
      spectrum.payloads!.power.layout = "scalar";
      return spectrum;
    }],
  ] as const)("disables all four hooks for %s without throwing in render", async (_label, fixture) => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <AntennaSourceSpectrumPayloadView outputId="spectrum-1" spectrum={fixture()} />,
      ));
      expect(mocks.calls).toHaveLength(4);
      expect(mocks.calls.map(({ kind }) => kind)).toEqual([
        "k_u_rad_per_m", "k_v_rad_per_m", "amplitudes_re_im", "power",
      ]);
      for (const { options } of mocks.calls) {
        expect(options.enabled).toBe(false);
        expect(options.expectedEtag).toBeUndefined();
        expect(options.maxResponseBytes).toBeUndefined();
      }
      expect(container.textContent).toContain("FFT manifest unavailable:");
      expect(countByRole(container as unknown as TestNode, "gridcell")).toBe(0);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it.each([
    [spectrumFixture(), { k_u_rad_per_m: 16, k_v_rad_per_m: 16, amplitudes_re_im: 64, power: 32 }],
    [spectrumFixture({ component: "vector_power", component_labels: ["x", "y", "z"], amplitude_count: 12 }),
      { k_u_rad_per_m: 16, k_v_rad_per_m: 16, amplitudes_re_im: 192, power: 32 }],
    [spectrumFixture({ k_u_count: 129, power_count: 258, amplitude_count: 258 }),
      { k_u_rad_per_m: 1032, k_v_rad_per_m: 16, amplitudes_re_im: 4128, power: 2064 }],
  ])("pins the exact manifest byte limit for every enabled payload", async (spectrum, limits) => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <AntennaSourceSpectrumPayloadView outputId="spectrum-1" spectrum={spectrum} />,
      ));
      expect(mocks.calls).toHaveLength(4);
      for (const { kind, options } of mocks.calls) {
        expect(options.enabled).toBe(true);
        expect(options.maxResponseBytes).toBe(limits[kind as AntennaSpectrumPayloadKind]);
        expect(options.expectedEtag).toContain(`:${kind}:`);
        expect(options.expectedEtag).toContain(spectrum.payloads![kind as AntennaSpectrumPayloadKind].sha256);
      }
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

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
      expect(container.textContent).toContain("Source FFT · |H̃|²");
      expect(container.textContent).toContain("squared field magnitude, not watts");
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
      const zoomIn = firstByTagNameAndText(container as unknown as TestNode, "button", "Zoom in");
      expect(zoomIn).toBeTruthy();
      await act(async () => zoomIn!.click());
      const zoomedGrid = firstByRole(container as unknown as TestNode, "grid");
      expect(zoomedGrid?.style.transform).toContain("scale(2)");
      expect(countByRole(container as unknown as TestNode, "gridcell")).toBe(4);
      expect(container.textContent).toContain("Zoom 2×");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("draws bounded extrema-preserving cuts and applies logarithmic power scale", async () => {
    const kU = Array.from({ length: 1025 }, (_, index) => index);
    const power = Array<number>(kU.length).fill(0);
    power[518] = 100;
    mocks.payloads = {
      k_u_rad_per_m: readyPayload(kU, "etag-ku"),
      k_v_rad_per_m: readyPayload([0], "etag-kv"),
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
          spectrum={spectrumFixture({
            k_u_count: kU.length,
            k_v_count: 1,
            power_count: power.length,
            amplitude_count: power.length,
          })}
        />,
      ));

      const logRadio = firstByRoleAndText(container as unknown as TestNode, "radio", "Log");
      expect(logRadio?.getAttribute("aria-disabled")).toBeNull();
      expect(allByRole(container as unknown as TestNode, "img")).toHaveLength(2);
      const uChart = allByRole(container as unknown as TestNode, "img")
        .find((chart) => chart.getAttribute("aria-label")?.startsWith("u cut at k_v"));
      const label = uChart?.getAttribute("aria-label") ?? "";
      const plottedCount = Number(/; (\d+) plotted points from 1025 samples/.exec(label)?.[1]);
      expect(plottedCount).toBeGreaterThan(0);
      expect(plottedCount).toBeLessThanOrEqual(512);
      expect(firstByTagName(uChart ?? container as unknown as TestNode, "path")
        ?.getAttribute("d")).toContain("202.75,12.00");
      expect(uChart?.querySelector("circle")).toBeDefined();

      await act(async () => logRadio?.click());
      expect(logRadio?.getAttribute("aria-checked")).toBe("true");
      expect(container.textContent).toContain("Logarithmic squared-field scale");
      expect(container.textContent).toContain("zero-value samples are omitted, leaving gaps");
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
          spectrum={spectrumFixture({ k_u_count: 129, power_count: 258, amplitude_count: 258 })}
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

  it.each(["k_u_rad_per_m", "k_v_rad_per_m", "amplitudes_re_im", "power"])(
    "surfaces retained refresh failure for %s without drawing stale cells",
    async (kind) => {
      mocks.payloads = {
        k_u_rad_per_m: readyPayload([0, 1], "etag-ku"),
        k_v_rad_per_m: readyPayload([0, 2], "etag-kv"),
        amplitudes_re_im: readyPayload([1, 0, 1, 2, Math.SQRT2, 0, Math.sqrt(3), 0], "etag-amplitudes"),
        power: readyPayload([1, 5, 2, 3], "etag-power"),
      };
      mocks.payloads[kind] = { ...mocks.payloads[kind], status: "stale", error: null, refreshError: new Error("Payload refresh rejected") };
      const dom = installSimulationPreparationTestDom();
      const container = dom.document.createElement("div");
      const root = createRoot(container as unknown as Element);
      try {
        await act(async () => root.render(
          <AntennaSourceSpectrumPayloadView outputId="spectrum-1" spectrum={spectrumFixture()} />,
        ));
        expect(container.textContent).toContain("FFT payload unavailable: Payload refresh rejected");
        expect(container.textContent).not.toContain("Loading binary FFT payloads");
        expect(countByRole(container as unknown as TestNode, "gridcell")).toBe(0);
      } finally {
        await act(async () => root.unmount());
        dom.restore();
      }
    },
  );

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
          spectrum={spectrumFixture()}
        />,
      ));
      expect(container.textContent).toContain(
        "amplitude scalar count 4 ≠ manifest 8",
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
          spectrum={spectrumFixture({ component: "vector_power", component_labels: ["x", "y", "z"], amplitude_count: 12 })}
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

function spectrumFixture(overrides: Partial<AntennaSourceSpectrumResource> = {}): AntennaSourceSpectrumResource {
  const u = overrides.k_u_count ?? 2;
  const v = overrides.k_v_count ?? 2;
  const amplitudes = overrides.amplitude_count ?? 4;
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
      amplitudes_re_im: binaryRef("A/m/A", "component_kv_ku_complex_re_im", 2 * amplitudes),
      k_u_rad_per_m: binaryRef("rad/m", "axis_u_1d", u),
      k_v_rad_per_m: binaryRef("rad/m", "axis_v_1d", v),
      power: binaryRef("(A/m/A)^2", "kv_ku_power", overrides.power_count ?? 4),
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
    ...overrides,
  };
}

function binaryRef(unit: string, layout: string, count: number) {
  return {
    layout,
    path: "payload.f64le",
    scalar_type: "float64_le",
    sha256: `sha256:${"a".repeat(64)}`,
    unit,
    value_count: count,
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

function allByRole(root: TestNode, role: string): TestElement[] {
  const matches: TestElement[] = [];
  if (root instanceof TestElement && root.getAttribute("role") === role) {
    matches.push(root);
  }
  for (const child of root.childNodes) matches.push(...allByRole(child, role));
  return matches;
}

function firstByRoleAndText(root: TestNode, role: string, text: string): TestElement | null {
  if (root instanceof TestElement && root.getAttribute("role") === role &&
      root.textContent === text) return root;
  for (const child of root.childNodes) {
    const match = firstByRoleAndText(child, role, text);
    if (match) return match;
  }
  return null;
}

function firstByTagName(root: TestNode, tagName: string): TestElement | null {
  if (root instanceof TestElement && root.tagName === tagName.toUpperCase()) return root;
  for (const child of root.childNodes) {
    const match = firstByTagName(child, tagName);
    if (match) return match;
  }
  return null;
}

function firstByTagNameAndText(root: TestNode, tagName: string, text: string): TestElement | null {
  if (root instanceof TestElement && root.tagName === tagName.toUpperCase() && root.textContent === text) return root;
  for (const child of root.childNodes) {
    const match = firstByTagNameAndText(child, tagName, text);
    if (match) return match;
  }
  return null;
}
