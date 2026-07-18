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
