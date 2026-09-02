import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ANALYSIS_DYNAMIC_STRUCTURE_FACTOR_V1_PATH } from "@/kernel/api/apiPaths";
import {
  findElements,
  installSimulationPreparationTestDom,
  TestEvent,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

vi.mock("./components/EChartsSurface", () => ({
  EChartsSurface: () => null,
}));
vi.mock("@/shared/ui/Select", () => ({
  Select: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  SelectContent: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  SelectItem: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  SelectTrigger: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  SelectValue: () => null,
}));

import { DynamicStructureFactorView } from "./DynamicStructureFactorView";
import {
  dynamicStructureFactorCells,
  dynamicStructureFactorFrequencyCut,
  dynamicStructureFactorPointSelection,
  dynamicStructureFactorWavevectorCut,
} from "./dynamicStructureFactorModel";

describe("dynamicStructureFactorModel", () => {
  it("preserves physical axes and bounds the rendered heatmap", () => {
    const resource = {
      schema_version: "dynamic_structure_factor.1d.v1",
      artifact_ref: "analysis/dynamic_structure_factor.1d.v1.json",
      bounded: true,
      original_frequency_count: 100,
      original_wavevector_count: 100,
      wavevector_unit: "rad/m",
      frequency_unit: "Hz",
      x_m: Array.from({ length: 100 }, (_, index) => index * 1e-9),
      time_s: Array.from({ length: 198 }, (_, index) => index * 1e-12),
      k_rad_per_m: Array.from({ length: 100 }, (_, index) => index),
      frequency_hz: Array.from({ length: 100 }, (_, index) => index * 1e9),
      power: Array.from({ length: 10_000 }, (_, index) => index),
      spectrum_real: Array.from({ length: 10_000 }, () => 0),
      spectrum_imag: Array.from({ length: 10_000 }, () => 0),
      source_power: Array.from({ length: 10_000 }, () => 0),
      source_spectrum_real: Array.from({ length: 10_000 }, () => 0),
      source_spectrum_imag: Array.from({ length: 10_000 }, () => 0),
      source_observable: "H_drive_y",
      source_unit: "A/m",
      component: "my",
      propagation_axis: "x",
      phase_convention: "exp[-i(k*x-2*pi*f*t)]",
      normalization: "one_sided_abs_fft2_squared_over_Nx_Nt_Ux_Ut",
      spatial_window: Array.from({ length: 100 }, () => 1),
      temporal_window: Array.from({ length: 198 }, () => 1),
      spatial_window_power_sum: 100,
      temporal_window_power_sum: 198,
      mesh_probe_signature: "fixture",
      invalid_probe_mask: Array.from({ length: 100 }, () => false),
      excluded_absorber_ranges_m: [],
      frequency_count: 100,
      wavevector_count: 100,
    };
    const cells = dynamicStructureFactorCells(resource);
    expect(cells.length).toBeLessThanOrEqual(4096);
    expect(cells.at(-1)?.normalizedPower).toBeLessThanOrEqual(1);
    expect(dynamicStructureFactorFrequencyCut(resource, 2)[0].points).toHaveLength(50);
    expect(dynamicStructureFactorWavevectorCut(resource, 3)[0].points).toHaveLength(50);
    expect(dynamicStructureFactorCells(resource, "source")).toHaveLength(cells.length);
    expect(dynamicStructureFactorFrequencyCut(resource, 2, "source")[0].unit).toBe("(A/m)²");
  });

  it("preserves exact chart-series identity, units, points, source, and status", () => {
    const resource = {
      artifact_ref: "analysis/dynamic_structure_factor.1d.v1.json",
      bounded: false,
      frequency_count: 2,
      frequency_hz: [0, 5e9],
      frequency_unit: "Hz",
      invalid_probe_mask: [false, false],
      k_rad_per_m: [10, 20],
      mesh_probe_signature: "probe-signature",
      original_frequency_count: 2,
      original_wavevector_count: 2,
      power: [1, 2, 3, 4],
      schema_version: "dynamic_structure_factor.1d.v1",
      source_observable: "H_drive_y",
      source_power: [10, 20, 30, 40],
      source_unit: "A/m",
      wavevector_count: 2,
      wavevector_unit: "rad/m",
    } as never;

    expect(dynamicStructureFactorFrequencyCut(resource, 1).map((entry) => ({
      dataRevision: entry.dataRevision ?? null,
      id: entry.id,
      points: entry.points,
      source: entry.source,
      status: entry.status,
      unit: entry.unit,
      xUnit: entry.xUnit,
    }))).toEqual([{
      dataRevision: null,
      id: "finite-k-frequency-cut-response",
      points: [{ rowIndex: 0, x: 0, y: 2 }, { rowIndex: 1, x: 5e9, y: 4 }],
      source: { kind: "analysis.spin_wave", resourceKey: ANALYSIS_DYNAMIC_STRUCTURE_FACTOR_V1_PATH, tableId: "dynamic-structure-factor" },
      status: "ready",
      unit: "1",
      xUnit: "Hz",
    }]);
  });

  it("builds deterministic result identity for a selectable DSF point", () => {
    const resource = {
      artifact_ref: "analysis/dynamic_structure_factor.1d.v1.json",
      bounded: false,
      frequency_count: 2,
      frequency_hz: [1e9, 2e9],
      frequency_unit: "Hz",
      invalid_probe_mask: [false, false],
      k_rad_per_m: [10, 20],
      mesh_probe_signature: "probe-signature",
      original_frequency_count: 2,
      original_wavevector_count: 2,
      power: [1, 2, 3, 4],
      schema_version: "dynamic_structure_factor.1d.v1",
      source_power: [1, 2, 3, 4],
      source_observable: "H_drive_y",
      source_unit: "A/m",
      wavevector_count: 2,
      wavevector_unit: "rad/m",
    } as never;

    expect(dynamicStructureFactorPointSelection(resource, 1, 0)).toEqual({
      frequencyHz: 2e9,
      frequencyIndex: 1,
      itemId: "legacy:dsf:1:0",
      itemKind: "dsf_point",
      kRadPerM: 10,
      ordinal: 2,
      power: 3,
      sampleId: "dsf-sample-0000",
      wavevectorIndex: 0,
    });
  });

  it("rejects a DSF selection for an invalid probe", () => {
    const resource = {
      artifact_ref: "analysis/dynamic_structure_factor.1d.v1.json",
      bounded: false,
      frequency_count: 1,
      frequency_hz: [1e9],
      frequency_unit: "Hz",
      invalid_probe_mask: [true],
      k_rad_per_m: [10],
      mesh_probe_signature: "probe-signature",
      original_frequency_count: 1,
      original_wavevector_count: 1,
      power: [1],
      schema_version: "dynamic_structure_factor.1d.v1",
      source_power: [1],
      source_observable: "H_drive_y",
      source_unit: "A/m",
      wavevector_count: 1,
      wavevector_unit: "rad/m",
    } as never;

    expect(dynamicStructureFactorPointSelection(resource, 0, 0)).toBeNull();
  });

  it("rejects a DSF selection when the probe mask is incomplete", () => {
    const resource = {
      artifact_ref: "analysis/dynamic_structure_factor.1d.v1.json",
      bounded: false,
      frequency_count: 1,
      frequency_hz: [1e9],
      frequency_unit: "Hz",
      invalid_probe_mask: [],
      k_rad_per_m: [10],
      mesh_probe_signature: "probe-signature",
      original_frequency_count: 1,
      original_wavevector_count: 1,
      power: [1],
      schema_version: "dynamic_structure_factor.1d.v1",
      source_power: [1],
      source_observable: "H_drive_y",
      source_unit: "A/m",
      wavevector_count: 1,
      wavevector_unit: "rad/m",
    } as never;

    expect(dynamicStructureFactorPointSelection(resource, 0, 0)).toBeNull();
  });

  it("keeps legacy identity on the source grid after bounded rendering", () => {
    const resource = {
      artifact_ref: "analysis/dynamic_structure_factor.1d.v1.json",
      bounded: true,
      frequency_count: 50,
      frequency_hz: Array.from({ length: 50 }, (_, index) => index * 2 + 1),
      frequency_unit: "Hz",
      invalid_probe_mask: Array.from({ length: 50 }, () => false),
      k_rad_per_m: Array.from({ length: 50 }, (_, index) => index),
      mesh_probe_signature: "probe-signature",
      original_frequency_count: 100,
      original_wavevector_count: 100,
      power: Array.from({ length: 50 * 50 }, () => 1),
      schema_version: "dynamic_structure_factor.1d.v1",
      source_power: Array.from({ length: 50 * 50 }, () => 1),
      source_observable: "H_drive_y",
      source_unit: "A/m",
      wavevector_count: 50,
      wavevector_unit: "rad/m",
    } as never;

    expect(dynamicStructureFactorPointSelection(resource, 1, 1)).toMatchObject({
      itemId: "legacy:dsf:2:2",
      ordinal: 202,
    });
  });

  it("renders bounded DSF cells with stable keyboard selection targets", () => {
    const resource = {
      frequency_count: 1,
      frequency_hz: [1e9],
      frequency_unit: "Hz",
      invalid_probe_mask: [false, true],
      k_rad_per_m: [10, 20],
      power: [1, 2],
      schema_version: "dynamic_structure_factor.1d.v1",
      artifact_ref: "analysis/dynamic_structure_factor.1d.v1.json",
      bounded: true,
      mesh_probe_signature: "probe-signature",
      original_frequency_count: 1,
      original_wavevector_count: 2,
      source_power: [1, 2],
      source_observable: "H_drive_y",
      source_unit: "A/m",
      wavevector_count: 2,
      wavevector_unit: "rad/m",
    } as never;

    const html = renderToStaticMarkup(createElement(DynamicStructureFactorView, { onPointSelect: () => undefined, resource, status: "ready" }));

    expect(html).toContain('data-result-item-id="legacy:dsf:0:0"');
    expect(html).not.toContain('data-result-item-id="legacy:dsf:0:1"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain("decimated projection");
    expect(html).toContain("not the full JSON payload");
    expect(html).toContain("Response S(k,f)");
  });

  it("rejects a DSF selection and heatmap when the array dimensions are inconsistent", () => {
    const resource = {
      artifact_ref: "analysis/dynamic_structure_factor.1d.v1.json",
      bounded: false,
      frequency_count: 2,
      frequency_hz: [1e9],
      frequency_unit: "Hz",
      invalid_probe_mask: [false, false],
      k_rad_per_m: [10, 20],
      mesh_probe_signature: "probe-signature",
      original_frequency_count: 2,
      original_wavevector_count: 2,
      power: [1, 2, 3, 4],
      schema_version: "dynamic_structure_factor.1d.v1",
      source_power: [1, 2, 3, 4],
      source_observable: "H_drive_y",
      source_unit: "A/m",
      wavevector_count: 2,
      wavevector_unit: "rad/m",
    } as never;

    expect(dynamicStructureFactorPointSelection(resource, 0, 0)).toBeNull();
    expect(dynamicStructureFactorCells(resource)).toEqual([]);
  });

  it("rejects non-finite response and source cells without manufacturing selection identity", () => {
    const responseResource = {
      artifact_ref: "analysis/dynamic_structure_factor.1d.v1.json",
      bounded: false,
      frequency_count: 1,
      frequency_hz: [1e9],
      frequency_unit: "Hz",
      invalid_probe_mask: [false],
      k_rad_per_m: [10],
      mesh_probe_signature: "probe-signature",
      original_frequency_count: 1,
      original_wavevector_count: 1,
      power: [Number.NaN],
      schema_version: "dynamic_structure_factor.1d.v1",
      source_power: [Number.POSITIVE_INFINITY],
      source_observable: "H_drive_y",
      source_unit: "A/m",
      wavevector_count: 1,
      wavevector_unit: "rad/m",
    } as never;

    expect(dynamicStructureFactorPointSelection(responseResource, 0, 0)).toBeNull();
    expect(dynamicStructureFactorPointSelection(responseResource, 0, 0, "source")).toBeNull();
    expect(dynamicStructureFactorCells(responseResource)).toHaveLength(1);
    expect(dynamicStructureFactorCells(responseResource, "source")).toHaveLength(1);
    const html = renderToStaticMarkup(createElement(DynamicStructureFactorView, {
      onPointSelect: () => undefined,
      resource: responseResource,
      status: "ready",
    }));
    expect(html).not.toContain('data-result-item-id="legacy:dsf:0:0"');
    expect(html).toContain('aria-label="Unavailable Response S(k,f)');
  });

  it("fails closed when the bounded resource has no stable artifact identity", () => {
    const resource = {
      artifact_ref: "",
      bounded: true,
      frequency_count: 1,
      frequency_hz: [1e9],
      frequency_unit: "Hz",
      invalid_probe_mask: [false],
      k_rad_per_m: [10],
      mesh_probe_signature: "probe-signature",
      original_frequency_count: 1,
      original_wavevector_count: 1,
      power: [1],
      schema_version: "dynamic_structure_factor.1d.v1",
      source_power: [1],
      source_observable: "H_drive_y",
      source_unit: "A/m",
      wavevector_count: 1,
      wavevector_unit: "rad/m",
    } as never;

    expect(dynamicStructureFactorPointSelection(resource, 0, 0)).toBeNull();
    expect(dynamicStructureFactorCells(resource)).toEqual([]);
  });

  it("activates only valid cells through click, Enter, and Space", async () => {
    const resource = {
      artifact_ref: "analysis/dynamic_structure_factor.1d.v1.json",
      bounded: true,
      frequency_count: 1,
      frequency_hz: [1e9],
      frequency_unit: "Hz",
      invalid_probe_mask: [false, true],
      k_rad_per_m: [10, 20],
      mesh_probe_signature: "probe-signature",
      original_frequency_count: 1,
      original_wavevector_count: 2,
      power: [1, 2],
      schema_version: "dynamic_structure_factor.1d.v1",
      source_power: [1, 2],
      source_observable: "H_drive_y",
      source_unit: "A/m",
      wavevector_count: 2,
      wavevector_unit: "rad/m",
    } as never;
    const onPointSelect = vi.fn();
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    try {
      await act(async () => {
        root.render(createElement(DynamicStructureFactorView, {
          onPointSelect,
          resource,
          status: "ready",
        }));
      });
      const cells = findElements(container, (element) => element.getAttribute("role") === "gridcell");
      const validCell = cells.find((cell) => cell.getAttribute("data-result-item-id") === "legacy:dsf:0:0");
      const invalidCell = cells.find((cell) => cell.getAttribute("aria-disabled") === "true");
      expect(validCell?.getAttribute("aria-label")).toContain("Select Response S(k,f)");
      expect(validCell?.getAttribute("tabindex")).toBe("0");
      expect(invalidCell?.getAttribute("data-result-item-id")).toBeNull();
      expect(invalidCell?.getAttribute("tabindex")).toBe("-1");

      await act(async () => validCell?.click());
      for (const key of ["Enter", " "]) {
        const event = new TestEvent("keydown", { bubbles: true, key });
        await act(async () => validCell?.dispatchEvent(event));
        expect(event.defaultPrevented).toBe(true);
      }
      expect(onPointSelect).toHaveBeenCalledTimes(3);
      expect(onPointSelect.mock.calls.map(([selection]) => selection.itemId)).toEqual([
        "legacy:dsf:0:0",
        "legacy:dsf:0:0",
        "legacy:dsf:0:0",
      ]);

      await act(async () => invalidCell?.click());
      for (const key of ["Enter", " "]) {
        await act(async () => invalidCell?.dispatchEvent(new TestEvent("keydown", { bubbles: true, key })));
      }
      expect(onPointSelect).toHaveBeenCalledTimes(3);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
