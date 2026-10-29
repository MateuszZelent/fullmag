import { describe, expect, it, vi } from "vitest";

import { downloadPlanarPng, planarExportFilename } from "./fieldMapExport";

describe("field-map PNG export", () => {
  it("builds a unit-safe provenance filename", () => {
    expect(
      planarExportFilename({
        fieldRevision: 17,
        monitorName: "Mid plane / free layer",
        quantityId: "H_demag",
        unit: "A/m",
      }),
    ).toBe("mid-plane-free-layer_h-demag_r17_a-m.png");
  });

  it("keeps the default source and resolved plane in the export filename", () => {
    expect(
      planarExportFilename({
        fieldRevision: 17,
        sourceLabel: "default-xy-z30nm",
        quantityId: "m",
        unit: "A/m",
      }),
    ).toBe("default-xy-z30nm_m_r17_a-m.png");
  });

  it("revokes the object URL after triggering the download", () => {
    const anchor = { click: vi.fn(), download: "", href: "" };
    const objectUrlApi = {
      createObjectURL: vi.fn(() => "blob:planar-png"),
      revokeObjectURL: vi.fn(),
    };

    downloadPlanarPng(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer,
      "map.png",
      objectUrlApi,
      () => anchor,
    );

    expect(anchor).toMatchObject({
      download: "map.png",
      href: "blob:planar-png",
    });
    expect(anchor.click).toHaveBeenCalledTimes(1);
    expect(objectUrlApi.revokeObjectURL).toHaveBeenCalledWith(
      "blob:planar-png",
    );
  });
});

describe("planar data export", () => {
  it("writes one SI row per pixel centre with world coordinates and empty cells", async () => {
    const { planarDataCsv } = await import("./fieldMapExport");
    const csv = planarDataCsv({
      bounds: [0, 2, 0, 1],
      component: "z",
      fieldRevision: 7,
      mask: new Uint8Array([1, 0]),
      origin: [0, 0, 5e-9],
      quantityId: "m",
      resolution: [2, 1],
      sampleToken: "token",
      uAxis: [1, 0, 0],
      unit: "",
      vAxis: [0, 1, 0],
      values: new Float64Array([0.25, 0.5]),
    });
    const lines = csv.trim().split("\n");
    expect(lines[3]).toBe("u_m,v_m,x_m,y_m,z_m,value");
    expect(lines[4]).toBe("5.000000000e-1,5.000000000e-1,5.000000000e-1,5.000000000e-1,5.000000000e-9,2.500000000e-1");
    expect(lines[5]!.endsWith(",")).toBe(true);
  });
});
