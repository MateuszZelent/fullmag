import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AnalysisSurfaceHeader } from "./AnalysisSurfaceHeader";

describe("AnalysisSurfaceHeader", () => {
  it("uses canonical contextual subview IDs in a compact shared control", () => {
    const html = renderToStaticMarkup(
      <AnalysisSurfaceHeader
        active="resonance-fmr"
        activeSubview="resonance.frequency-response"
        onSubviewChange={() => undefined}
        subviews={["resonance.eigenmodes", "resonance.frequency-response"]}
      />,
    );
    expect(html).not.toContain("Analysis workbench surfaces");
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain("fm-analysis-plots__tab");
    expect(html).toContain('data-analysis-surface-title="resonance-fmr"');
    expect(html).toMatch(/<h2 class="fm-analysis-plots__surface-title"[^>]*>Resonance &amp; FMR<\/h2>/);
    expect(html).toContain('aria-label="Resonance &amp; FMR subview"');
    expect(html).toContain('data-analysis-subview="resonance.frequency-response"');
    expect(html).toContain("Frequency Response");
  });

  it("declares the surface title and narrow-dock and stacked subview behavior in the CSS contract", () => {
    const css = readFileSync(new URL("../../../design/styles/analysis-plots.css", import.meta.url), "utf8");

    expect(css).not.toMatch(/\.fm-analysis-plots__tab(s|s-scroll)?\s*[{,]/);
    expect(css).toMatch(/\.fm-analysis-plots__surface-title\s*\{[^}]*text-overflow:\s*ellipsis/);
    expect(css).toMatch(/@media \(max-width: 620px\)[\s\S]*?\.fm-analysis-plots__navigation\s*\{[^}]*flex-direction:\s*column/);
    expect(css).toMatch(/@media \(max-width: 620px\)[\s\S]*?\.fm-analysis-plots__subview\s*\{[^}]*width:\s*100%/);
  });
});
