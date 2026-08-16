import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "src/modules/inspector/panels/VisualizationVectorAccountingRows.tsx"),
  "utf8",
);

describe("VisualizationVectorAccountingRows performance contract", () => {
  it("does not request or scan debug statistics when the ordinary inspector mounts", () => {
    expect(source).not.toContain("controller.request(");
    expect(source).not.toContain("scanFieldVectorDebugStatistics");
    expect(source).toContain("useVisualizationDebugSnapshots");
  });

  it("renders distinct available, requested, effective, decoded and adopted accounting rows", () => {
    expect(source).toContain("Available vector anchors");
    expect(source).toContain("Requested budget");
    expect(source).toContain("Effective scene allocation");
    expect(source).toContain("Decoded field samples");
    expect(source).toContain("Adopted arrows");
  });

  it("passes the expected visualization revision into identity matching", () => {
    expect(source).toContain("expectedVisualizationRevision?:");
    expect(source).toContain("expectedVisualizationRevision: props.expectedVisualizationRevision");
  });
});
