import { describe, expect, it } from "vitest";

import { inspectorFitCommandId } from "./inspectorFitCommand";

describe("Inspector Fit view", () => {
  it("fits the 2D view when it is the active main module and the 3D view otherwise", () => {
    expect(inspectorFitCommandId("field-map")).toBe("field-map.fit");
    expect(inspectorFitCommandId("viewport-3d")).toBe("viewport-3d.fit");
    expect(inspectorFitCommandId("analysis-plots")).toBe("viewport-3d.fit");
    expect(inspectorFitCommandId(null)).toBe("viewport-3d.fit");
  });
});
