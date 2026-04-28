import { describe, expect, it } from "vitest";

import { resolveRuntimeRenderMode } from "../useFemVectorDomain";

describe("resolveRuntimeRenderMode", () => {
  it("preserves points mode during interaction", () => {
    expect(resolveRuntimeRenderMode("points", true)).toBe("points");
  });

  it("still simplifies surface+edges during interaction", () => {
    expect(resolveRuntimeRenderMode("surface+edges", true)).toBe("surface");
  });

  it("keeps the requested mode when interaction is idle", () => {
    expect(resolveRuntimeRenderMode("points", false)).toBe("points");
    expect(resolveRuntimeRenderMode("wireframe", false)).toBe("wireframe");
  });
});
