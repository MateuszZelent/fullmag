import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("PhysicsInteractionPanel lane contract", () => {
  it("uses the resolved interaction catalog and blocks unresolved writes", () => {
    const source = readFileSync(
      new URL("./PhysicsInteractionPanel.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("useActiveLaneCapabilities(");
    expect(source).toContain("resolveActiveLaneOperation(");
    expect(source).toContain("interactionSpecsForDiscretization(");
    expect(source).toContain("validateInteractionDraftForDiscretization(");
    expect(source).toContain('if (interactionDiscretization === "unknown")');
    expect(source).not.toContain("interactionSelectOptions()");
    expect(source).not.toContain("AIRBOX_VISUALIZATION_TARGET");
  });

  it("guards the write path with the authoritative active-lane operation", () => {
    const source = readFileSync(
      new URL("./PhysicsInteractionPanel.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("if (!activeLaneOperation.enabled)");
    expect(source).toContain("activeLaneOperation.reason");
  });
});
