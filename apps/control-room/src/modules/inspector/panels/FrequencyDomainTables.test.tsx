import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  FrequencyDomainBranchTable,
  FrequencyDomainFmrPeakTable,
  FrequencyDomainModeTable,
  FrequencyDomainResponsePointTable,
} from "./FrequencyDomainTables";

describe("FrequencyDomainTables", () => {
  it("renders sub-GHz result frequencies in MHz instead of fractional GHz", () => {
    const onPlotMode = vi.fn();
    const onPlotResponsePoint = vi.fn();

    const html = [
      renderToStaticMarkup(
        <FrequencyDomainModeTable
          onPlotMode={onPlotMode}
          points={[
            {
              branchId: null,
              dampingRateHz: null,
              frequencyHz: 750e6,
              imaginaryFrequencyHz: null,
              modeFieldId: "analysis:eigen:sample-0000:mode-0001",
              modeFieldResourceKey: null,
              rawModeIndex: 1,
              residualNorm: null,
              sampleIndex: 0,
              tangentLeakageMax: null,
            },
          ]}
        />,
      ),
      renderToStaticMarkup(
        <FrequencyDomainResponsePointTable
          onPlotResponsePoint={onPlotResponsePoint}
          points={[
            {
              absorbedPowerDensity: null,
              amplitude: 2,
              fieldId: "analysis:frequency-response:frequency-0000",
              frequencyHz: 500e6,
              frequencyIndex: 0,
              observableId: "mx",
              phaseRad: null,
              residualNorm: null,
              susceptibility: null,
            },
          ]}
        />,
      ),
      renderToStaticMarkup(
        <FrequencyDomainBranchTable
          branches={[
            {
              branchId: "acoustic",
              frequencyMaxHz: 950e6,
              frequencyMinHz: 250e6,
              label: null,
              overlapPrevMin: null,
              points: [],
              sampleMax: 1,
              sampleMin: 0,
              trackingConfidenceMin: null,
            },
          ]}
        />,
      ),
      renderToStaticMarkup(
        <FrequencyDomainFmrPeakTable
          peaks={[
            {
              absorbedPowerDensity: null,
              amplitude: null,
              fieldId: null,
              frequencyHz: 600e6,
              frequencyPointIndex: null,
              linewidthHz: null,
              modeRef: null,
              phaseRad: null,
              source: "modal",
              validationStatus: "pass",
            },
          ]}
        />,
      ),
    ].join("\n");

    expect(html).toContain("750 MHz");
    expect(html).toContain("500 MHz");
    expect(html).toContain("250 MHz-950 MHz");
    expect(html).toContain("600 MHz");
    expect(html).toContain("Select");
    expect(html).not.toContain("0.75 GHz");
    expect(html).not.toContain("0.5 GHz");
    expect(html).not.toContain("0.25 GHz-0.95 GHz");
    expect(html).not.toContain("0.6 GHz");
  });

  it("keeps eigen mode inspection available when the 3D field artifact is missing", () => {
    const onPlotMode = vi.fn();

    const html = renderToStaticMarkup(
      <FrequencyDomainModeTable
        onPlotMode={onPlotMode}
        points={[
          {
            branchId: "raw",
            dampingRateHz: null,
            frequencyHz: 1.2e9,
            imaginaryFrequencyHz: null,
            modeFieldId: null,
            modeFieldResourceKey: null,
            rawModeIndex: 2,
            residualNorm: null,
            sampleIndex: 0,
            tangentLeakageMax: null,
          },
        ]}
      />,
    );

    expect(html).toContain(
      '<button class="fm-inspector-action-button" title="Select this eigen mode for inspector controls" type="button">Select</button>',
    );
    expect(html).toContain("Mode field artifact is missing");
    expect(html).toContain("disabled=\"\"");
  });
});
