import { describe, expect, it } from "vitest";
import { defaultFmsRestoreMode, fmsFileSizeError, MAX_FMS_FILE_BYTES } from "./fmsFileTransport";

describe("FMS file import policy", () => {
  it.each([
    ["exact_resume", "resume"],
    ["logical_resume", "resume"],
    ["initial_condition_import", "visualization_only"],
    ["config_only", "replace_project"],
  ])("maps archive class %s to operation %s", (classification, mode) => {
    expect(defaultFmsRestoreMode(classification)).toBe(mode);
  });
  it("rejects an unknown class rather than replacing a project", () => {
    expect(() => defaultFmsRestoreMode("unknown")).toThrow("Unsupported archive restore class");
  });
  it("accepts exactly the compressed limit and rejects invalid sizes before upload", () => {
    expect(fmsFileSizeError(MAX_FMS_FILE_BYTES)).toBeNull();
    for (const size of [0, -1, NaN, Infinity, 0.5, MAX_FMS_FILE_BYTES + 1]) {
      expect(fmsFileSizeError(size)).not.toBeNull();
    }
  });
});
