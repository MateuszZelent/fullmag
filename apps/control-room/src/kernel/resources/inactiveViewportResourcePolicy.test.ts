import { describe, expect, it, vi } from "vitest";

import {
  DATA_FIELD_SLICE_RENDER_PNG_PATH,
  DATA_FIELD_VECTOR_PATH,
  DATA_FIELDS_PATH,
  DATA_PLANAR_FIELD_META_PATH,
  DATA_DOMAIN_TOPOLOGY_PATH,
  MESHING_SHARED_DOMAIN_CROSS_SECTION_IMAGE_PATH,
  MESHING_SHARED_DOMAIN_MANIFEST_PATH,
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
      isViewport3DExclusiveResourceKey(MESHING_SHARED_DOMAIN_MANIFEST_PATH),
    ).toBe(false);
    expect(
      isViewport3DExclusiveResourceKey(
        MESHING_SHARED_DOMAIN_QUALITY_DATA_PATH,
      ),
    ).toBe(false);

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
    const runtimeStore = {
      beginPauseMatching: vi.fn(
        (predicate: (resourceKey: string) => boolean) => {
          void predicate;
          return releasePause;
        },
      ),
    };

    const dispose = createViewport3DInactiveResourcePauseController({
      layout,
      runtimeStore,
    });

    expect(runtimeStore.beginPauseMatching).toHaveBeenCalledTimes(1);
    const planarPausePredicate = runtimeStore.beginPauseMatching.mock.calls[0]![0];
    expect(
      planarPausePredicate(DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")),
    ).toBe(false);
    expect(
      planarPausePredicate(
        DATA_PLANAR_FIELD_META_PATH
          .replace("{quantity_id}", "m")
          .replace("{monitor_id}", "monitor-1"),
      ),
    ).toBe(true);

    layout.setActiveViewportMainModule("analysis-plots");

    expect(runtimeStore.beginPauseMatching).toHaveBeenCalledTimes(2);
    expect(runtimeStore.beginPauseMatching.mock.calls[1]?.[0]).toBe(
      isViewport3DExclusiveResourceKey,
    );

    layout.setActiveViewportMainModule("cross-section-image");
    expect(runtimeStore.beginPauseMatching).toHaveBeenCalledTimes(2);

    layout.setActiveViewportMainModule("viewport-3d");
    expect(releasePause).toHaveBeenCalledTimes(1);

    dispose();
    expect(releasePause).toHaveBeenCalledTimes(2);
  });

  it("does not classify ordinary field vectors as planar-monitor resources", () => {
    const layout = new LayoutController(new EventBus<KernelEventMap>());
    const predicates: Array<(resourceKey: string) => boolean> = [];
    const runtimeStore = {
      beginPauseMatching: vi.fn((predicate: (resourceKey: string) => boolean) => {
        predicates.push(predicate);
        return vi.fn();
      }),
    };

    const dispose = createViewport3DInactiveResourcePauseController({
      layout,
      runtimeStore,
    });

    const eigenFieldKey =
      `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "analysis%3Aeigen%3Asample-0000%3Amode-0002")}?component=full&scope_kind=full`;
    expect(predicates[0]?.(eigenFieldKey)).toBe(false);
    expect(
      predicates[0]?.(
        DATA_PLANAR_FIELD_META_PATH.replace("{quantity_id}", "m").replace(
          "{monitor_id}",
          "monitor-1",
        ),
      ),
    ).toBe(true);

    dispose();
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

    expect(runtimeStore.beginPauseMatching).toHaveBeenCalledTimes(2);

    dispose();

    expect(releasePause).toHaveBeenCalledTimes(2);
  });
});
