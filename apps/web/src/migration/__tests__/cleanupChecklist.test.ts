import { describe, it, expect } from "vitest";
import {
  getCleanupChecklist,
  getActiveDeprecations,
} from "../cleanupChecklist";

describe("cleanupChecklist", () => {
  it("getCleanupChecklist returns a non-empty list", () => {
    const items = getCleanupChecklist();
    expect(items.length).toBeGreaterThan(0);
  });

  it("every item has required fields", () => {
    for (const item of getCleanupChecklist()) {
      expect(item.id).toBeTruthy();
      expect(item.description).toBeTruthy();
      expect(item.module).toBeTruthy();
      expect(["active", "migrated", "deprecated"]).toContain(item.status);
    }
  });

  it("getActiveDeprecations returns only deprecated items", () => {
    const deprecated = getActiveDeprecations();
    expect(deprecated.length).toBeGreaterThan(0);
    for (const item of deprecated) {
      expect(item.status).toBe("deprecated");
    }
  });

  it("getActiveDeprecations is a subset of getCleanupChecklist", () => {
    const all = getCleanupChecklist();
    const deprecated = getActiveDeprecations();
    const allIds = new Set(all.map((i) => i.id));
    for (const item of deprecated) {
      expect(allIds.has(item.id)).toBe(true);
    }
  });

  it("contains known deprecation items", () => {
    const ids = getActiveDeprecations().map((i) => i.id);
    expect(ids).toContain("bootstrap-endpoint");
    expect(ids).toContain("poll-endpoint");
    expect(ids).not.toContain("preview-component");
    expect(ids).toContain("normalize-ts");
    expect(ids).toContain("binary-preview-codec");
  });
});
