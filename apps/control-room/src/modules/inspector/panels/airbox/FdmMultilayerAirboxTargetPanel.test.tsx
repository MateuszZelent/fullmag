import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FdmMultilayerAirboxTargetPanelView } from "./FdmMultilayerAirboxTargetPanel";

describe("FdmMultilayerAirboxTargetPanelView", () => {
  it("renders the target-only grid, H_demag-only capability, and provenance", () => {
    const html = renderToStaticMarkup(
      <FdmMultilayerAirboxTargetPanelView
        model={{
          fieldCapabilityRows: [
            { label: "H_demag", value: "available" },
            { label: "H_eff", value: "unavailable (airbox_heff_not_available_v1)" },
          ],
          provenanceRows: [
            { label: "Carrier fingerprint", mono: true, value: "sha256:carrier" },
            { label: "Runtime", mono: true, value: '{"backend":"fdm_cpu_reference"}' },
          ],
          status: "ready",
          targetGridRows: [
            { label: "Target-only", value: "yes" },
            { label: "Cells", value: "[5, 4, 3]" },
            { label: "Origin", unit: "m", value: "[-4e-9, -6e-9, -8e-9]" },
            { label: "Cell size", unit: "m", value: "[2e-9, 3e-9, 4e-9]" },
            { label: "Samples", value: "60" },
            { label: "Values", value: "180" },
          ],
        }}
      />,
    );

    expect(html).toContain("Certified target-only observation grid");
    expect(html).toContain("[5, 4, 3]");
    expect(html).toContain("H_demag");
    expect(html).toContain("H_eff");
    expect(html).toContain("sha256:carrier");
    expect(html).not.toContain("Common Convolution Grid");
  });

  it("renders only an unavailable state when the carrier is not published", () => {
    const html = renderToStaticMarkup(
      <FdmMultilayerAirboxTargetPanelView
        model={{
          notice: "Target-only Airbox carrier is not published or failed validation.",
          status: "unavailable",
        }}
      />,
    );

    expect(html).toContain("not published or failed validation");
    expect(html).toContain("unavailable");
    expect(html).not.toContain("Carrier provenance");
  });
});
