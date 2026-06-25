import { describe, expect, it, vi } from "vitest";

import {
  DATA_FIELD_SLICE_RENDER_PNG_PATH,
  DATA_FIELD_VECTOR_PATH,
  DATA_FIELDS_PATH,
  DATA_DOMAIN_TOPOLOGY_PATH,
  MESHING_SHARED_DOMAIN_CROSS_SECTION_IMAGE_PATH,
  MESHING_SHARED_DOMAIN_QUALITY_DATA_PATH,
} from "@/kernel/api/apiPaths";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { LayoutController } from "@/kernel/layout/LayoutController";

import {
  createViewport3DInactiveResourcePauseController,
  isViewport3DExclusiveResourceKey,
} from "./inactiveViewportResourcePolicy";

describe("inactiveViewportResourcePolicy", () => {
  it("classifies only viewport-3d exclusive resources for inactive-tab pause", () => {
    expect(
      isViewport3DExclusiveResourceKey(
        `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?component=full&scope_kind=full`,
      ),
    ).toBe(true);
    expect(
      isViewport3DExclusiveResourceKey(
        `${DATA_FIELDS_PATH}#viewport-3d:quantity-field-vectors:${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}`,
      ),
    ).toBe(true);
    expect(isViewport3DExclusiveResourceKey(DATA_DOMAIN_TOPOLOGY_PATH)).toBe(
      true,
    );
    expect(
      isViewport3DExclusiveResourceKey(
        MESHING_SHARED_DOMAIN_QUALITY_DATA_PATH,
      ),
    ).toBe(true);

    expect(
      isViewport3DExclusiveResourceKey(
        DATA_FIELD_SLICE_RENDER_PNG_PATH.replace("{quantity_id}", "m"),
      ),
    ).toBe(false);
    expect(
      isViewport3DExclusiveResourceKey(
        MESHING_SHARED_DOMAIN_CROSS_SECTION_IMAGE_PATH,
      ),
    ).toBe(false);
  });

  it("pauses 3D-only resource hooks while a non-3D center tab is active", () => {
    const layout = new LayoutController(new EventBus<KernelEventMap>());
    const releasePause = vi.fn();
    let capturedPredicate: ((resourceKey: string) => boolean) | null = null;
    const runtimeStore = {
      beginPauseMatching: vi.fn((predicate: (resourceKey: string) => boolean) => {
        capturedPredicate = predicate;
        return releasePause;
      }),
    };

    const dispose = createViewport3DInactiveResourcePauseController({
      layout,
      runtimeStore,
    });

    expect(runtimeStore.beginPauseMatching).not.toHaveBeenCalled();

    layout.setActiveViewportMainModule("analysis-plots");

    expect(runtimeStore.beginPauseMatching).toHaveBeenCalledTimes(1);
    expect(capturedPredicate).toBe(isViewport3DExclusiveResourceKey);

    layout.setActiveViewportMainModule("cross-section-image");
    expect(runtimeStore.beginPauseMatching).toHaveBeenCalledTimes(1);

    layout.setActiveViewportMainModule("viewport-3d");
    expect(releasePause).toHaveBeenCalledTimes(1);

    dispose();
    expect(releasePause).toHaveBeenCalledTimes(1);
  });

  it("starts paused when the initial active center tab is non-3D and releases on dispose", () => {
    const layout = new LayoutController(new EventBus<KernelEventMap>());
    layout.setActiveViewportMainModule("cross-section-image");
    const releasePause = vi.fn();
    const runtimeStore = {
      beginPauseMatching: vi.fn(() => releasePause),
    };

    const dispose = createViewport3DInactiveResourcePauseController({
      layout,
      runtimeStore,
    });

    expect(runtimeStore.beginPauseMatching).toHaveBeenCalledTimes(1);

    dispose();

    expect(releasePause).toHaveBeenCalledTimes(1);
  });
});
