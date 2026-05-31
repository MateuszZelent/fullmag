import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workflowScriptUrl = new URL(
  "../../../scripts/smoke-cross-section-workflow.mjs",
  import.meta.url,
);
const cdpWorkflowScriptUrl = new URL(
  "../../../scripts/smoke-cross-section-workflow-cdp.mjs",
  import.meta.url,
);

describe("cross-section workflow smoke script", () => {
  it("keeps the 2D cross-section draft out of canonical 3D clip state", () => {
    for (const scriptUrl of [workflowScriptUrl, cdpWorkflowScriptUrl]) {
      const source = readFileSync(scriptUrl, "utf8");

      expect(source).toContain(
        "2D Cross keeps canonical clip state disabled",
      );
      expect(source).toContain("!visualizationState.clip.enabled");
      expect(source).toContain("assertNoRequestsSince(");
      expect(source).toContain("canonical visualization PATCH requests");
      expect(source).toContain(
        "cross-section data-plane requests before image generation",
      );
      expect(source).not.toContain("clip state enabled");
    }
  });
});
