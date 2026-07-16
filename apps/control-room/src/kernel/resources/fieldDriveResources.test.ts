import { describe, expect, it } from "vitest";

import { MODEL_FIELD_DRIVES_PATH } from "../api/apiPaths";
import { MODEL_FIELD_DRIVES_RESOURCE_KEY } from "./fieldDriveResources";

describe("field drive resources", () => {
  it("uses the canonical OpenAPI resource identity", () => {
    expect(MODEL_FIELD_DRIVES_RESOURCE_KEY).toBe(MODEL_FIELD_DRIVES_PATH);
  });
});
