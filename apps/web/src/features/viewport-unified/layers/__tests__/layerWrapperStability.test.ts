import { describe, expect, it } from "vitest";

import { BoundsLayer } from "../BoundsLayer";
import { MeshLayer } from "../MeshLayer";
import { WireframeLayer } from "../WireframeLayer";

describe("viewport layer wrapper stability", () => {
  it("keeps MeshLayer wrapper stable when visibility changes", () => {
    const hidden = MeshLayer({ visible: false, children: "mesh" });
    const visible = MeshLayer({ visible: true, children: "mesh" });

    expect(hidden.type).toBe("div");
    expect(visible.type).toBe("div");
    expect(hidden.props["data-viewport-layer"]).toBe("explicit-topology");
    expect(hidden.props["data-viewport-layer-visible"]).toBe("false");
    expect(visible.props["data-viewport-layer-visible"]).toBe("true");
  });

  it("keeps WireframeLayer wrapper stable when shaded mode toggles wireframe off", () => {
    const hidden = WireframeLayer({ visible: false, children: "viewport-canvas" });
    const visible = WireframeLayer({ visible: true, children: "viewport-canvas" });

    expect(hidden.type).toBe("div");
    expect(visible.type).toBe("div");
    expect(hidden.props["data-viewport-layer"]).toBe("wireframe");
    expect(hidden.props["data-viewport-layer-visible"]).toBe("false");
    expect(visible.props["data-viewport-layer-visible"]).toBe("true");
  });

  it("keeps BoundsLayer wrapper stable when bounds fallback toggles", () => {
    const hidden = BoundsLayer({ visible: false, children: "viewport-canvas" });
    const visible = BoundsLayer({ visible: true, children: "viewport-canvas" });

    expect(hidden.type).toBe("div");
    expect(visible.type).toBe("div");
    expect(hidden.props["data-viewport-layer"]).toBe("bounds");
    expect(hidden.props["data-viewport-layer-visible"]).toBe("false");
    expect(visible.props["data-viewport-layer-visible"]).toBe("true");
  });
});
