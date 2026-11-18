import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ResourceResult } from "@/kernel/resources/resourceTypes";
import type {
  FdmCellPhysicsSnapshot,
  FdmCellPhysicsTarget,
} from "@/kernel/resources/fdmCellPhysicsResources";

const { useFdmCellPhysicsResourceMock } = vi.hoisted(() => ({
  useFdmCellPhysicsResourceMock: vi.fn(),
}));

vi.mock("@/kernel/resources/fdmCellPhysicsResources", () => ({
  useFdmCellPhysicsResource: useFdmCellPhysicsResourceMock,
}));

import { FdmCellPhysicsPanel } from "./FdmCellPhysicsPanel";

const target: FdmCellPhysicsTarget = {
  ordinal: 5,
  generationId: "generation-7",
  gridFingerprint: "grid-fingerprint-7",
  membershipRevision: "11:12",
  meshRevision: 11,
  centerM: [3e-9, 2.5e-9, 0.25],
  cellSizeM: [2e-9, 1e-9, 0.5],
};

const refetch = vi.fn();

function row(
  overrides: Partial<FdmCellPhysicsSnapshot["rows"][number]>,
): FdmCellPhysicsSnapshot["rows"][number] {
  return {
    id: "mat_ms",
    label: "Saturation magnetization",
    unit: "A/m",
    group: "material",
    status: "ready",
    scalar: 600_000,
    vector: null,
    sourceStep: 12,
    sourceTimeSeconds: 3.5e-12,
    reason: null,
    ...overrides,
  };
}

function snapshot(
  rows: FdmCellPhysicsSnapshot["rows"],
): FdmCellPhysicsSnapshot {
  return { runId: "run-42-with-a-long-runtime-identity", volumeM3: 1e-27, rows };
}

function resource(
  status: ResourceResult<FdmCellPhysicsSnapshot>["status"],
  data: FdmCellPhysicsSnapshot | null,
): ResourceResult<FdmCellPhysicsSnapshot> {
  return {
    data,
    error: status === "error" ? new Error("Cell field request failed") : null,
    refetch,
    revision: "field-revision-12",
    status,
  };
}

describe("FdmCellPhysicsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFdmCellPhysicsResourceMock.mockReturnValue(resource("idle", null));
  });

  it("presents concise material, vector, and signed energy values with raw semantic values", () => {
    useFdmCellPhysicsResourceMock.mockReturnValue(resource("ready", snapshot([
      row({ id: "mat_ms", unit: "A/m", scalar: 600_000 }),
      row({ id: "mat_aex", label: "Exchange stiffness", unit: "J/m", scalar: 1.25e-11 }),
      row({ id: "mat_alpha", label: "Gilbert damping", unit: "1", scalar: 0.5 }),
      row({
        id: "m",
        label: "Magnetization",
        unit: "1",
        group: "magnetization",
        scalar: null,
        vector: [0.6, -0.8, 0],
      }),
      row({
        id: "eden_ex",
        label: "Exchange energy density",
        unit: "J/m³",
        group: "energy",
        scalar: -2_000_000,
      }),
      row({
        id: "eden_ext",
        label: "External energy density",
        unit: "J/m^3",
        group: "energy",
        scalar: 0,
      }),
      row({
        id: "eden_total",
        label: "Total energy density",
        unit: "J/m³",
        group: "energy",
        scalar: -2_000_000,
      }),
    ])));

    const html = renderToStaticMarkup(<FdmCellPhysicsPanel target={target} />);

    expect(html).toContain('data-fdm-cell-physics-status="ready"');
    expect(html).toContain('data-fdm-cell-ordinal="5"');
    expect(html).toContain("Cell 5");
    expect(html).toContain("Material parameters");
    expect(html).toContain("Magnetization (m)");
    expect(html).toContain("Cell energies");
    expect(html).toContain('data-fdm-quantity-id="mat_ms" data-fdm-sample-status="ready"');
    expect(html).toContain("Ms");
    expect(html).toContain('data-fdm-value="scalar" value="600000" title="600000">600,000</data>');
    expect(html).toContain('data-fdm-value="scalar" value="1.25e-11" title="1.25e-11">1.250e-11</data>');
    expect(html).toContain('data-fdm-value="scalar" value="0.5" title="0.5">0.5</data>');
    expect(html).toContain('data-fdm-value="mx" value="0.6" title="0.6">0.6</data>');
    expect(html).toContain('data-fdm-value="my" value="-0.8" title="-0.8">-0.8</data>');
    expect(html).toContain('data-fdm-value="mz" value="0" title="0">0</data>');
    expect(html).toContain('data-fdm-value="magnitude" value="1" title="1">1</data>');
    expect(html).toContain("Dimensionless");
    expect((html.match(/Dimensionless/g) ?? []).length).toBe(1);
    expect(html).toContain("Exchange");
    expect(html).toContain("Zeeman");
    expect(html).toContain("Total");
    expect(html).toContain('data-fdm-value="scalar" value="-2000000" title="-2000000">-2.000e+6</data>');
    const energy = html.match(/data-fdm-value="cell-energy" value="([^"]+)"[^>]*>-2\.000e-21<\/data>/);
    expect(energy).not.toBeNull();
    expect(Math.abs(Number(energy?.[1]) + 2e-21)).toBeLessThan(1e-35);
    expect(html).toContain('data-fdm-value="scalar" value="0" title="0">0</data>');
    expect(html).toContain('data-fdm-value="cell-energy" value="0" title="0">0</data>');
    expect(html).toContain('data-fdm-energy-term="total"');
    expect(html).toContain('data-slot="inspector-group-trigger"');
    expect(html).toContain('data-open="false"');
    expect(html).toContain("run-42-with-a-long-runtime-identity");
    expect(html).toContain("step 12");
    expect(html).toContain("t = 3.500e-12 s");
  });

  it("withholds every retained number and source while the resource is stale", () => {
    useFdmCellPhysicsResourceMock.mockReturnValue(resource("stale", snapshot([
      row({ scalar: 9.87654e123 }),
    ])));

    const html = renderToStaticMarkup(<FdmCellPhysicsPanel target={target} />);

    expect(html).toContain('data-fdm-cell-physics-status="stale"');
    expect(html).toContain("Refreshing current fields. Previous values are hidden.");
    expect(html).not.toContain("data-fdm-value=");
    expect(html).not.toContain("9.87654e");
    expect(html).not.toContain("run-42");
    expect(html).not.toContain("step 12");
  });

  it("shows unavailable reasons without inventing zero-valued samples or energies", () => {
    useFdmCellPhysicsResourceMock.mockReturnValue(resource("ready", snapshot([
      row({
        id: "mat_aex",
        label: "Exchange stiffness",
        unit: "J/m",
        status: "unavailable",
        scalar: null,
        reason: "Material field was not published.",
      }),
      row({
        id: "m",
        label: "Magnetization",
        unit: "1",
        group: "magnetization",
        status: "unavailable",
        scalar: null,
        vector: null,
        reason: "Magnetization was not published.",
      }),
      row({
        id: "eden_custom",
        label: "Custom energy density",
        unit: "kJ/m³",
        group: "energy",
        scalar: 125,
        reason: null,
      }),
      row({
        id: "eden_total",
        label: "Total energy density",
        unit: "J/m³",
        group: "energy",
        status: "unavailable",
        scalar: null,
        reason: "Total energy density was not published.",
      }),
    ])));

    const html = renderToStaticMarkup(<FdmCellPhysicsPanel target={target} />);

    expect(html).toContain("Material field was not published.");
    expect(html).toContain("Magnetization was not published.");
    expect(html).toContain("Cannot interpret kJ/m³ as energy density in J/m³.");
    expect(html).toContain("Total energy density was not published.");
    expect(html).toContain('data-fdm-quantity-id="eden_custom" data-fdm-sample-status="unavailable"');
    expect(html).not.toContain('data-fdm-value="scalar" value="125"');
    expect(html).not.toContain('data-fdm-value="cell-energy"');
    expect(html).not.toContain('data-fdm-value="scalar" value="0"');
  });

  it("shows a clear no-cell state and never leaks retained values", () => {
    useFdmCellPhysicsResourceMock.mockReturnValue(resource("ready", snapshot([
      row({ scalar: 123_456 }),
    ])));

    const html = renderToStaticMarkup(
      <FdmCellPhysicsPanel target={null} notice="This cell is no longer current." />,
    );

    expect(html).toContain('data-fdm-cell-physics-status="unavailable"');
    expect(html).toContain("This cell is no longer current.");
    expect(html).toContain("No current cell");
    expect(html).not.toContain("data-fdm-value=");
    expect(html).not.toContain("123,456");
    expect(html).not.toContain("run-42");
  });

  it("provides a shared retry action after a read error without showing old values", () => {
    useFdmCellPhysicsResourceMock.mockReturnValue(resource("error", snapshot([
      row({ scalar: 654_321 }),
    ])));

    const html = renderToStaticMarkup(<FdmCellPhysicsPanel target={target} />);

    expect(html).toContain("Cell field request failed");
    expect(html).toContain("Retry cell physics read");
    expect(html).not.toContain("data-fdm-value=");
    expect(html).not.toContain("654,321");
  });
});
