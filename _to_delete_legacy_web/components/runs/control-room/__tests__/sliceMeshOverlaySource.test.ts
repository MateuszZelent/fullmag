import { describe, expect, it } from "vitest";

import { resolveSliceMeshOverlaySource } from "../UnifiedViewport2DPresenter";
import type { SliceMeshOverlay2D } from "@/components/preview/fem/sliceMeshOverlay2D";
import type { LiveApiError } from "@/src/api/client/errors/LiveApiError";

const overlay: SliceMeshOverlay2D = {
  topologyKey: "mesh:1",
  segments: [{ a: [0, 0], b: [1, 1] }],
};

describe("resolveSliceMeshOverlaySource", () => {
  it("prefers backend mesh overlay when it is available", () => {
    expect(
      resolveSliceMeshOverlaySource({
        backend: overlay,
        local: { ...overlay, topologyKey: "local:1" },
        loading: false,
        error: null,
        enabled: true,
      }),
    ).toMatchObject({
      overlay,
      source: "backend",
      status: "ready",
      message: "mesh: backend",
    });
  });

  it("uses local fallback when backend is empty or failed", () => {
    expect(
      resolveSliceMeshOverlaySource({
        backend: null,
        local: overlay,
        loading: false,
        error: { message: "backend failed" } as LiveApiError,
        enabled: true,
      }),
    ).toMatchObject({
      overlay,
      source: "local",
      status: "ready",
      message: "mesh: local fallback after backend error",
    });
  });

  it("reports loading, error, and disabled states without inventing an overlay", () => {
    expect(
      resolveSliceMeshOverlaySource({
        backend: null,
        local: null,
        loading: true,
        error: null,
        enabled: true,
      }),
    ).toMatchObject({ overlay: null, source: "none", status: "loading" });

    expect(
      resolveSliceMeshOverlaySource({
        backend: null,
        local: null,
        loading: false,
        error: { message: "backend failed" } as LiveApiError,
        enabled: true,
      }),
    ).toMatchObject({ overlay: null, source: "none", status: "error", message: "backend failed" });

    expect(
      resolveSliceMeshOverlaySource({
        backend: overlay,
        local: overlay,
        loading: false,
        error: null,
        enabled: false,
      }),
    ).toMatchObject({ overlay: null, source: "none", status: "unavailable" });
  });
});
