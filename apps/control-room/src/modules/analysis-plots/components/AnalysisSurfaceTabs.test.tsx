import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AnalysisSurfaceTabs } from "./AnalysisSurfaceTabs";

describe("AnalysisSurfaceTabs", () => {
  it("uses canonical contextual subview IDs in a compact shared control", () => {
    const html = renderToStaticMarkup(
      <AnalysisSurfaceTabs
        active="resonance-fmr"
        activeSubview="resonance.frequency-response"
        onChange={() => undefined}
        onSubviewChange={() => undefined}
        subviews={["resonance.eigenmodes", "resonance.frequency-response"]}
      />,
    );
    expect(html).toContain('aria-label="Analysis workbench surfaces"');
    expect(html).toContain('aria-label="Resonance &amp; FMR subview"');
    expect(html).toContain('data-analysis-subview="resonance.frequency-response"');
    expect(html).toContain("Frequency Response");
  });

  it("declares narrow-dock overflow and stacked subview behavior in the CSS contract", () => {
    const css = readFileSync(new URL("../../../design/styles/analysis-plots.css", import.meta.url), "utf8");

    expect(css).toMatch(/\.fm-analysis-plots__tabs-scroll\s*\{[^}]*overflow-x:\s*auto/);
    expect(css).toMatch(/@media \(max-width: 620px\)[\s\S]*?\.fm-analysis-plots__navigation\s*\{[^}]*flex-direction:\s*column/);
    expect(css).toMatch(/@media \(max-width: 620px\)[\s\S]*?\.fm-analysis-plots__subview\s*\{[^}]*width:\s*100%/);
  });
});
