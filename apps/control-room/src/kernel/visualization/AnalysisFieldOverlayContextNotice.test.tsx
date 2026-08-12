import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AnalysisFieldOverlayContextNotice } from "./AnalysisFieldOverlayContextNotice";

describe("AnalysisFieldOverlayContextNotice", () => {
  it("offers keyboard-native Clear and Rebind actions for a foreign overlay", () => {
    const html = renderToStaticMarkup(
      <AnalysisFieldOverlayContextNotice
        context={{
          overlay: {
            fieldId: "field-old",
            label: "Old mode",
            query: { phase_rad: 0, view: "phase_rotated_real" },
            source: "eigen-mode",
          },
          reason: "Overlay belongs to run-old, not run-new.",
          resultRunId: "run-new",
          status: "foreign",
        }}
        onClear={() => undefined}
        onRebind={() => undefined}
        rebindDisabledReason={null}
      />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("Active Analysis Overlay is not rendered");
    expect(html).toContain(">Clear<");
    expect(html).toContain(">Rebind<");
    expect(html).not.toContain('disabled=""');
  });

  it("disables Rebind and exposes the reason without hiding Clear", () => {
    const html = renderToStaticMarkup(
      <AnalysisFieldOverlayContextNotice
        context={{
          overlay: {
            fieldId: "field-unowned",
            label: "Unowned mode",
            query: { phase_rad: 0, view: "phase_rotated_real" },
            source: "eigen-mode",
          },
          reason: "Owner identity is incomplete.",
          resultRunId: "run-new",
          status: "unverified",
        }}
        onClear={() => undefined}
        onRebind={() => undefined}
        rebindDisabledReason="Select a typed analysis field in run-new."
      />,
    );

    expect(html).toContain("Select a typed analysis field in run-new.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Rebind<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Clear<\/button>/);
  });
});
