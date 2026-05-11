import { describe, expect, it } from "vitest";

import { ALL_MODULES } from "@/modules";

describe("status-bar module", () => {
  it("is registered for the status-bar slot", () => {
    const manifest = ALL_MODULES.find((module) => module.id === "status-bar");

    expect(manifest?.slots).toContain("status-bar");
  });
});
