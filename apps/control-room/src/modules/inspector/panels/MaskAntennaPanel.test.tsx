import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { KernelContext } from "@/kernel/KernelContext";
import type { KernelApi } from "@/kernel/types";

vi.mock("@/kernel/resources/maskAntennaResources", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/kernel/resources/maskAntennaResources")
  >();
  return {
    ...actual,
    useMaskFieldDrivesResource: () => ({
      data: {
        scene_revision: 11,
        drives: [{
          activation: { kind: "all_time_evolution" },
          enabled: true,
          frame: "world",
          id: "antenna",
          name: "Antenna",
          position_m: [0, 0, -1.5e-8],
          schema_version: "mask_field_drive.v1",
          shape: { center: [0, 0, 0], kind: "box", size: [6e-6, 1e-6, 4.5e-8] },
          target: { kind: "object", object_id: "sample" },
          terms: [
            {
              mask: {
                function: {
                  expression_version: "field_expr.v1",
                  locals: [{ expression: "2 * pi / wavelength", name: "k" }],
                  name: "antenna_mask",
                  outputs: ["B01 * sin(k * x - pi / 2)", "0.0", "B01 * sin(k * x)"],
                  parameters: [{ name: "B01", value: 2e-4 }, { name: "wavelength", value: 2.79e-7 }],
                },
                kind: "function",
              },
              name: "carrier",
              time: {
                expression_version: "field_expr.v1",
                name: "antenna_time",
                outputs: ["sin(2 * pi * frequency * (t - t0))"],
                parameters: [{ name: "frequency", value: 3.6e9 }, { name: "t0", value: 2e-9 }],
              },
            },
            {
              mask: {
                cell_m: [5e-9, 5e-9, 5e-9],
                data: "eJw=",
                encoding: "f32le-zlib-base64",
                kind: "sampled",
                origin_m: [-3e-6, -5e-7, -3.75e-8],
                sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                size: [1200, 200, 9],
              },
            },
          ],
          time_origin: "absolute",
        }],
      },
      status: "ready",
    }),
    useReadyAntennasResource: () => ({
      data: {
        antennas: [{
          arguments: [{ doc: "peak field", name: "amplitude", unit: "T" }],
          function: "fullmag.antennas.gaussian_k_source",
          summary: "Gaussian spin-wave source",
        }],
      },
      status: "ready",
    }),
  };
});

vi.mock("@/kernel/resources/fieldDriveResources", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/kernel/resources/fieldDriveResources")
  >();
  return {
    ...actual,
    useFieldDrivesResource: () => ({ data: { drives: [], scene_revision: 11 }, status: "ready" }),
  };
});

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  useSceneResource: () => ({
    data: { objects: [{ id: "sample", name: "Sample", regions: [] }] },
    status: "ready",
  }),
}));

import { MaskAntennaListSection, MaskAntennaPanel } from "./MaskAntennaPanel";

const kernel = {
  api: { model: {} },
  commands: { getSessionScopeKey: () => null },
  resources: { invalidate: vi.fn() },
  selection: { set: vi.fn() },
} as unknown as KernelApi;

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(
    <KernelContext.Provider value={kernel}>{element}</KernelContext.Provider>,
  );
}

describe("MaskAntennaPanel", () => {
  it("shows the functions of a term as editable parameters and equations", () => {
    const html = render(
      <MaskAntennaPanel selection={{
        kind: "physics.field-drive",
        label: "Antenna",
        moduleSource: "explorer",
        nodeId: "model:physics:mask-antennas:antenna",
        objectId: null,
        ref: {
          fieldDriveId: "antenna",
          fieldDriveKind: "mask",
          kind: "physics.field-drive",
          nodeId: "model:physics:mask-antennas:antenna",
          type: "physics-field-drive",
        },
      }} />,
    );

    expect(html).toContain("Term 1 · carrier");
    expect(html).toContain('aria-label="B01"');
    expect(html).toContain('value="0.0002"');
    expect(html).toContain('value="2 * pi / wavelength"');
    expect(html).toContain('value="B01 * sin(k * x)"');
    expect(html).toContain('value="sin(2 * pi * frequency * (t - t0))"');
    expect(html).toContain('value="absolute" selected=""');
    expect(html).not.toContain("Selected mask antenna is unavailable");
  });

  it("shows an array mask read-only", () => {
    const html = render(
      <MaskAntennaPanel selection={{
        kind: "physics.field-drive",
        label: "Antenna",
        moduleSource: "explorer",
        nodeId: "node",
        objectId: null,
        ref: {
          fieldDriveId: "antenna",
          fieldDriveKind: "mask",
          kind: "physics.field-drive",
          nodeId: "node",
          type: "physics-field-drive",
        },
      }} />,
    );

    expect(html).toContain("array (written by a loop), read-only");
    expect(html).toContain("1200 x 200 x 9");
    expect(html).toContain("0123456789abcdef");
  });

  it("offers a draft with a free id and the ready antennas", () => {
    const html = render(
      <MaskAntennaPanel selection={{
        kind: "physics.field-drive",
        label: "New mask antenna",
        moduleSource: "ribbon",
        nodeId: "model:physics:mask-antenna:draft",
        objectId: null,
        ref: {
          draft: true,
          fieldDriveKind: "mask",
          kind: "physics.field-drive",
          nodeId: "model:physics:mask-antenna:draft",
          type: "physics-field-drive",
        },
      }} />,
    );

    expect(html).toContain('aria-label="ID"');
    expect(html).toContain('value="mask-antenna"');
    expect(html).toContain("gaussian_k_source — Gaussian spin-wave source");
    expect(html).toContain("Add term");
  });

  it("lists the antennas of the scene", () => {
    const html = render(<MaskAntennaListSection />);

    expect(html).toContain("Mask Antennas");
    expect(html).toContain("2 terms · 1 array mask · active");
    expect(html).toContain("Inspect Antenna");
    expect(html).toContain("New Mask Antenna");
  });
});
