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

  it("canonicalizes quantity aliases in field-vector resource keys", () => {
    const aliasKey = resolveDataPreviewFieldVectorResourceKey({
      component: "full",
      maxSamples: 17,
      quantityId: "h_eff",
    });
    const canonicalKey = resolveDataPreviewFieldVectorResourceKey({
      component: "full",
      maxSamples: 17,
      quantityId: "H_eff",
    });

    expect(aliasKey).toBe(canonicalKey);
    expect(aliasKey).toContain("/H_eff/samples/vector");
  });

  it("keeps analysis field view and phase in field-vector resource keys", () => {
    const key = resolveDataPreviewFieldVectorResourceKey({
      component: "full",
      maxSamples: 12,
      phaseRad: 0.75,
      quantityId: "analysis:eigen:sample-0000:mode-0002",
      view: "phase_rotated_real",
    });

    expect(key).toContain(
      "/analysis%3Aeigen%3Asample-0000%3Amode-0002/samples/vector",
    );
    expect(key).toContain("component=full");
    expect(key).toContain("max_samples=12");
    expect(key).toContain("view=phase_rotated_real");
    expect(key).toContain("phase_rad=0.75");
  });
});
