import { describe, expect, it } from "vitest";

import { preferScalarMetricWhenLiveLooksMissing } from "../useEffectiveLiveTelemetry";

describe("preferScalarMetricWhenLiveLooksMissing", () => {
  it("prefers a same-step scalar metric when the live metric is zero", () => {
    expect(
      preferScalarMetricWhenLiveLooksMissing({
        liveValue: 0,
        scalarValue: 2.5e-4,
        liveStep: 5459,
        scalarStep: 5459,
      }),
    ).toBe(2.5e-4);
  });

  it("keeps the live metric when it is already populated", () => {
    expect(
      preferScalarMetricWhenLiveLooksMissing({
        liveValue: 1.25e-3,
        scalarValue: 2.5e-4,
        liveStep: 5459,
        scalarStep: 5459,
      }),
    ).toBe(1.25e-3);
  });

  it("does not replace a zero live metric with an older scalar row", () => {
    expect(
      preferScalarMetricWhenLiveLooksMissing({
        liveValue: 0,
        scalarValue: 2.5e-4,
        liveStep: 5459,
        scalarStep: 5458,
      }),
    ).toBe(0);
  });
});
