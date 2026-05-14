import { describe, expect, it } from "vitest";

import {
  resolveMagnetizationTextureTarget,
  sameMagnetizationTextureTarget,
} from "./targetResolver";

describe("magnetization texture target resolver", () => {
  it("resolves object magnetic texture selection to object target", () => {
    expect(
      resolveMagnetizationTextureTarget({
        kind: "object.magnetic-texture",
        objectId: "body",
      }),
    ).toEqual({ kind: "object", objectId: "body" });
  });

  it("resolves region texture selection to region target", () => {
    expect(
      resolveMagnetizationTextureTarget({
        kind: "object.region-magnetic-texture",
        objectId: "body",
        regionId: "region:body",
      }),
    ).toEqual({ kind: "region", objectId: "body", regionId: "region:body" });
  });

  it("treats ribbon region context as the same target as explorer region context", () => {
    const explorerTarget = resolveMagnetizationTextureTarget({
      kind: "object.region-magnetic-texture",
      objectId: "body",
      regionId: "region:body",
    });
    const ribbonTarget = resolveMagnetizationTextureTarget({
      kind: "ribbon.magnetization-texture.assign-uniform",
      objectId: "body",
      regionId: "region:body",
    });

    expect(sameMagnetizationTextureTarget(explorerTarget, ribbonTarget)).toBe(
      true,
    );
  });
});
