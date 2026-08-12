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
});
