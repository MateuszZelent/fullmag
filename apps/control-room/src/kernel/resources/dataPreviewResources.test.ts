import { describe, expect, it } from "vitest";

import { DATA_FIELDS_PATH } from "@/kernel/api/apiPaths";

import { resolveDataPreviewFieldVectorResourceKey } from "./dataPreviewResources";

describe("dataPreviewResources", () => {
  it("uses the v2 field-vector resource family with a bounded sample query", () => {
    const key = resolveDataPreviewFieldVectorResourceKey({
      component: "full",
      maxSamples: 17,
      quantityId: "m",
    });

    expect(key.startsWith(DATA_FIELDS_PATH)).toBe(true);
    expect(key).toContain("/m/samples/vector");
    expect(key).toContain("component=full");
    expect(key).toContain("max_samples=17");
  });

  it("normalizes blank quantity input to magnetization", () => {
    const key = resolveDataPreviewFieldVectorResourceKey({
      component: "",
      maxSamples: 5,
      quantityId: " ",
    });

    expect(key).toContain("/m/samples/vector");
    expect(key).toContain("component=full");
  });
});
