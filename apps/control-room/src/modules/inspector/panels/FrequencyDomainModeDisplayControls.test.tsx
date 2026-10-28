import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FrequencyDomainModeDisplayControls, type FrequencyDomainModeDisplaySettings } from "./FrequencyDomainModeDisplayControls";

const base: FrequencyDomainModeDisplaySettings = {
  activeAnalysisFieldOverlay: null,
  appearanceCommandInput: vi.fn(),
  colorSource: "magnitude", colorRangeMax: 1, colorRangeMin: -1, colorRangeMode: "auto",
  colormap: "viridis", component: "magnitude", geometryScope: "surface", displayGain: 1,
  shaderVisible: true, solidColor: "var(--fm-surface-magnetic)", vectorBudget: 1200,
  vectorScale: 1, vectorsVisible: false, view: "real",
  setColorSource: vi.fn(),
  setColorRangeMax: vi.fn(),
  setColorRangeMin: vi.fn(),
  setColorRangeMode: vi.fn(),
  setDisplayGain: vi.fn(),
  setColormap: vi.fn(),
  setComponent: vi.fn(),
  setGeometryScope: vi.fn(),
  setShaderVisible: vi.fn(),
  setSolidColor: vi.fn(),
  setVectorBudget: vi.fn(),
  setVectorScale: vi.fn(),
  setVectorsVisible: vi.fn(),
  setView: vi.fn(),
};
function render(patch: Partial<FrequencyDomainModeDisplaySettings> = {}) {
  return renderToStaticMarkup(<FrequencyDomainModeDisplayControls disabled={false} labelPrefix="Eigen mode" settings={{...base,...patch}} viewDefaultValue="real" viewOptions={["real", "imag", "abs", "phase"]} />);
}
describe("contextual mode appearance", () => {
  it("has one color selector and hides irrelevant scalar/vector controls", () => {
    const html = render();
    expect(html).toContain("Color by");
    expect(html).not.toContain("Mode color source");
    expect(html).not.toContain("solid color picker");
    expect(html).not.toContain("Vector budget");
    expect(html).not.toContain("Color minimum");
    expect(html).not.toContain("Color maximum");
    expect(html).toContain("Mode colormap");
  });
  it("exposes manual limits and vector settings only when enabled", () => {
    const html = render({colorRangeMode: "manual", vectorsVisible: true});
    for(const label of ["Color minimum", "Color maximum", "Vector budget", "Vector scope", "Vector scale"]) expect(html).toContain(label);
    const symmetric = render({colorRangeMode: "symmetric"});
    expect(symmetric).not.toContain("Color minimum");
    expect(symmetric).toContain("Color maximum");
  });
  it("solid colors do not show scalar ranges or CSS variable values", () => {
    const html = render({colorSource: "solid"});
    expect(html).toContain("Theme default");
    expect(html).not.toContain("var(--fm-surface-magnetic)");
    expect(html).not.toContain("Mode colormap");
    expect(html).not.toContain("Color range");
  });
});
