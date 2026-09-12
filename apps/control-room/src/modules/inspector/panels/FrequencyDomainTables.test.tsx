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
              displayModeIndex: 1,
              frequencyHz: 750e6,
              imaginaryFrequencyHz: 20e6,
              modeFieldId: "analysis:eigen:sample-0000:mode-0001",
              modeFieldResourceKey: null,
              modeId: null,
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
          absorbedPowerDensityUnit="W/m^3"
          amplitudeUnit="A/m"
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
          onPlotPeak={vi.fn()}
          onSelectPeak={vi.fn()}
          peaks={[
            {
              absorbedPowerDensity: null,
              absorbedPowerDensityUnit: "W/m^3",
              amplitude: null,
              amplitudeUnit: "A/m",
              fieldId: null,
              frequencyHz: 600e6,
              frequencyPointIndex: null,
              linewidthHz: null,
              modeRef: null,
              phaseRad: null,
              source: "driven_response",
              validationStatus: "pass",
            },
          ]}
        />,
      ),
    ].join("\n");

    expect(html).toContain("750 MHz");
    expect(html).toContain("Imag freq.");
    expect(html).toContain("20 MHz");
    expect(html).toContain("500 MHz");
    expect(html).toContain("Amplitude [A/m]");
    expect(html).toContain("Absorbed power [W/m^3]");
    expect(html).toContain("250 MHz-950 MHz");
    expect(html).toContain("600 MHz");
    expect(html).toContain("Select");
    expect(html).toContain("Plot 3D");
    expect(html).toContain(
      'aria-label="Plot this eigen mode with phase-rotated real display for sample 0 mode 1"',
    );
    expect(html).toContain('title="Plot this eigen mode with phase-rotated real display"');
    expect(html).toContain('title="Plot the real part of this eigen mode"');
    expect(html).toContain(
      'title="Plot this response field with phase-rotated real display"',
    );
    expect(html).toContain("fm-inspector-action-button");
    expect(html).toContain("lucide lucide-rotate-cw");
    expect(html).toContain("lucide lucide-eye");
    expect(html).toContain("lucide lucide-activity");
    expect(html).toContain("<span>Rotated</span>");
    expect(html).toContain("<span>Real</span>");
    expect(html).toContain("<span>Plot 3D</span>");
    expect(html).not.toContain("fm-button--ghost");
    expect(html).not.toMatch(
      /disabled=""[^>]*><svg[^>]*><span>(?:Rotated|Real|Imag|Abs|Phase)<\/span><\/button>/,
    );
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
            displayModeIndex: 2,
            frequencyHz: 1.2e9,
            imaginaryFrequencyHz: null,
            modeFieldId: null,
            modeFieldResourceKey: null,
            modeId: null,
            rawModeIndex: 2,
            residualNorm: null,
            sampleIndex: 0,
            tangentLeakageMax: null,
          },
        ]}
      />,
    );

    expect(html).toContain(
      'aria-label="Select this eigen mode for inspector controls for sample 0 mode 2"',
    );
    expect(html).toContain('title="Select this eigen mode for inspector controls"');
    expect(html).toContain("lucide lucide-eye");
    expect(html).toContain("<span>Select</span>");
    expect(html).toContain("Mode field artifact is missing");
    expect(html).toContain("disabled=\"\"");
  });

  it("marks the selected eigen mode row for spectrum navigation", () => {
    const html = renderToStaticMarkup(
      <FrequencyDomainModeTable
        onPlotMode={vi.fn()}
        selectedModeKey="0:2"
        points={[
          {
            branchId: "acoustic",
            dampingRateHz: null,
            displayModeIndex: 1,
            frequencyHz: 1e9,
            imaginaryFrequencyHz: null,
            modeFieldId: "analysis:eigen:sample-0000:mode-0001",
            modeFieldResourceKey: null,
            modeId: null,
            rawModeIndex: 1,
            residualNorm: null,
            sampleIndex: 0,
            tangentLeakageMax: null,
          },
          {
            branchId: "optical",
            dampingRateHz: null,
            displayModeIndex: 2,
            frequencyHz: 2e9,
            imaginaryFrequencyHz: null,
            modeFieldId: "analysis:eigen:sample-0000:mode-0002",
            modeFieldResourceKey: null,
            modeId: null,
            rawModeIndex: 2,
            residualNorm: null,
            sampleIndex: 0,
            tangentLeakageMax: null,
          },
        ]}
      />,
    );

    expect(html).toContain("Selected");
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('data-selected="true"');
    expect(html).toContain("current");
  });

  it("marks and exposes selectable eigen branch rows", () => {
    const onSelectBranch = vi.fn();
    const html = renderToStaticMarkup(
      <FrequencyDomainBranchTable
        branches={[
          {
            branchId: "acoustic",
            frequencyMaxHz: 2e9,
            frequencyMinHz: 1e9,
            label: "Acoustic",
            overlapPrevMin: 0.91,
            points: [],
            sampleMax: 4,
            sampleMin: 0,
            trackingConfidenceMin: 0.97,
          },
          {
            branchId: "optical",
            frequencyMaxHz: 8e9,
            frequencyMinHz: 4e9,
            label: "Optical",
            overlapPrevMin: 0.82,
            points: [],
            sampleMax: 4,
            sampleMin: 0,
            trackingConfidenceMin: 0.89,
          },
        ]}
        selectedBranchId="acoustic"
        onSelectBranch={onSelectBranch}
      />,
    );

    expect(html).toContain("Selected");
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('data-selected="true"');
    expect(html).toContain("current");
    expect(html).toContain(
      'aria-label="Select branch acoustic for inspector controls"',
    );
    expect(html).toContain(
      'title="Select branch acoustic for inspector controls"',
    );
    expect(html).toContain("lucide lucide-eye");
    expect(html).toContain("<span>Select</span>");
  });

  it("keeps FMR peak selection available when its 3D field artifact is missing", () => {
    const html = renderToStaticMarkup(
      <FrequencyDomainFmrPeakTable
        onPlotPeak={vi.fn()}
        onSelectPeak={vi.fn()}
        peaks={[
          {
            absorbedPowerDensity: null,
            amplitude: 3,
            fieldId: null,
            frequencyHz: 2.4e9,
            frequencyPointIndex: 4,
            linewidthHz: null,
            modeRef: null,
            phaseRad: 0.25,
            source: "driven_response",
            validationStatus: "pass",
          },
        ]}
      />,
    );

    expect(html).toContain(
      'title="Select this FMR peak for inspector controls"',
    );
    expect(html).toContain(
      'title="The 3D field artifact for this FMR peak is missing"',
    );
    expect(html).toContain("disabled=\"\"");
  });
});
