import { describe, expect, it } from "vitest";

import { fieldCatalogResourceKey, fieldCatalogRevisionKey } from "./fieldCatalogScope";

describe("field catalog resource identity", () => {
  it("separates a run catalog from the pre-run catalog", () => {
    const path = "/v2/sessions/current/data/quantities";
    const revisionKey = fieldCatalogRevisionKey(path, "stage/one");

    expect(fieldCatalogResourceKey(path)).toBe(path);
    expect(revisionKey).toBe(`${path}?stage_id=stage%2Fone`);
    expect(fieldCatalogResourceKey(path, null, "run/current?1")).toBe(
      `${path}:run=run%2Fcurrent%3F1`,
    );
    expect(fieldCatalogResourceKey(path, "stage/one", "run/current?1")).toBe(
      `${revisionKey}:run=run%2Fcurrent%3F1`,
    );
  });
});
