import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  EigenModePhaseControls,
  clampEigenModeVisualCycleRateHz,
  eigenModePhaseDegreesToRadians,
  eigenModePhaseRadiansToDegrees,
} from "./EigenModePhaseControls";

describe("EigenModePhaseControls", () => {
  it("converts the degree control to SI radians and back across its full range", () => {
    expect(eigenModePhaseDegreesToRadians(0)).toBe(0);
    expect(eigenModePhaseDegreesToRadians(180)).toBeCloseTo(Math.PI);
    expect(eigenModePhaseDegreesToRadians(360)).toBeCloseTo(2 * Math.PI);
    expect(eigenModePhaseRadiansToDegrees(Math.PI)).toBeCloseTo(180);
    expect(eigenModePhaseRadiansToDegrees(2 * Math.PI)).toBeCloseTo(360);
    expect(eigenModePhaseDegreesToRadians(400)).toBeCloseTo(2 * Math.PI);
  });

  it("wraps saved phases into the 0 to 360 degree slider range", () => {
    expect(eigenModePhaseRadiansToDegrees(-Math.PI / 2)).toBeCloseTo(270);
    expect(eigenModePhaseRadiansToDegrees(5 * Math.PI)).toBeCloseTo(180);
    expect(eigenModePhaseRadiansToDegrees(-5 * Math.PI)).toBeCloseTo(180);
  });

  it("bounds visual playback rate to the kernel animation range", () => {
    expect(clampEigenModeVisualCycleRateHz(0.01)).toBe(0.05);
    expect(clampEigenModeVisualCycleRateHz(12)).toBe(10);
  });

  it("labels playback speed separately from scientific eigenfrequency", () => {
    const html = renderToStaticMarkup(
      <EigenModePhaseControls
        animatePhase
        animationRateHz={2}
        disabled={false}
        phaseRad={Math.PI}
        onAnimationChange={() => {}}
        onSetPhase={() => {}}
      />,
    );

    expect(html).toContain("Display phase");
    expect(html).toContain("deg");
    expect(html).toContain("Visual cycle rate");
    expect(html).toContain("Visual playback speed only");
    expect(html).toContain("scientific eigenfrequency above is unchanged");
    expect(html).toContain('aria-label="Eigen mode display phase in degrees"');
    expect(html).toContain('aria-label="Visual phase cycle rate in Hz"');
    expect(html).toContain('aria-label="Pause eigen mode phase animation"');
    expect(html).toContain('aria-label="Reset eigen mode display phase to zero degrees"');
    expect(html).toContain(">180</output>");
  });
});
