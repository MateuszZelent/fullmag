import { describe, expect, it, vi } from "vitest";

import { createObjectUrl, revokeObjectUrl, type ObjectUrlApi } from "./objectUrl";

describe("cross-section image object URL helpers", () => {
  it("creates a typed blob URL from PNG bytes", async () => {
    const createdBlobs: Blob[] = [];
    const objectUrlApi: ObjectUrlApi = {
      createObjectURL: vi.fn((blob: Blob) => {
        createdBlobs.push(blob);
        return "blob:cross-section";
      }),
      revokeObjectURL: vi.fn(),
    };

    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
    const url = createObjectUrl(data, "image/png", objectUrlApi);

    expect(url).toBe("blob:cross-section");
    expect(objectUrlApi.createObjectURL).toHaveBeenCalledTimes(1);
    const createdBlob = createdBlobs[0];
    expect(createdBlob?.type).toBe("image/png");
    expect(Array.from(new Uint8Array(await createdBlob!.arrayBuffer()))).toEqual([
      0x89,
      0x50,
      0x4e,
      0x47,
    ]);
  });

  it("revokes only existing object URLs", () => {
    const objectUrlApi: ObjectUrlApi = {
      createObjectURL: vi.fn(),
      revokeObjectURL: vi.fn(),
    };

    revokeObjectUrl(null, objectUrlApi);
    revokeObjectUrl("blob:cross-section", objectUrlApi);

    expect(objectUrlApi.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(objectUrlApi.revokeObjectURL).toHaveBeenCalledWith(
      "blob:cross-section",
    );
  });
});
