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

const PLANAR_MONITOR_RESOURCE_KEY = DATA_PLANAR_FIELD_META_PATH
  .replace("{quantity_id}", "m")
  .replace("{monitor_id}", "monitor-1");

interface PauseLease {
  isViewport3D: boolean;
  isPlanar: boolean;
  release: () => void;
}

function createPauseRuntimeMock() {
  const leases: PauseLease[] = [];
  const runtimeStore = {
    beginPauseMatching: vi.fn((predicate: (resourceKey: string) => boolean) => {
      const release = vi.fn();
      leases.push({
        isViewport3D: predicate(DATA_DOMAIN_TOPOLOGY_PATH),
        isPlanar: predicate(PLANAR_MONITOR_RESOURCE_KEY),
        release,
      });
      return release;
    }),
  };
  return { runtimeStore, leases };
}

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

  it("keeps 3D resources live for an initial chart with a 3D companion", () => {
    const layout = new LayoutController(new EventBus<KernelEventMap>());
    layout.replace({
      ...layout.get(),
      activeViewportMainModuleId: "analysis-plots",
      viewportCompanion: {
        moduleId: "viewport-3d",
        placement: "beside",
      },
    });
    const { runtimeStore, leases } = createPauseRuntimeMock();

    const dispose = createViewport3DInactiveResourcePauseController({
      layout,
      runtimeStore,
    });

    expect(runtimeStore.beginPauseMatching).toHaveBeenCalledTimes(1);
    expect(leases).toHaveLength(1);
    expect(leases[0]?.isViewport3D).toBe(false);
    expect(leases[0]?.isPlanar).toBe(true);
    dispose();
  });

  it("releases and reacquires only the 3D pause when its companion appears", () => {
    const layout = new LayoutController(new EventBus<KernelEventMap>());
    layout.setActiveViewportMainModule("analysis-plots");
    const { runtimeStore, leases } = createPauseRuntimeMock();

    const dispose = createViewport3DInactiveResourcePauseController({
      layout,
      runtimeStore,
    });
    const initial3DLease = leases.find((lease) => lease.isViewport3D);
    const planarLease = leases.find((lease) => lease.isPlanar);
    expect(initial3DLease).toBeDefined();
    expect(planarLease).toBeDefined();
    expect(runtimeStore.beginPauseMatching).toHaveBeenCalledTimes(2);

    layout.setViewportCompanion({
      moduleId: "viewport-3d",
      placement: "beside",
    });

    expect(initial3DLease?.release).toHaveBeenCalledTimes(1);
    expect(planarLease?.release).not.toHaveBeenCalled();
    expect(runtimeStore.beginPauseMatching).toHaveBeenCalledTimes(2);

    layout.setViewportCompanion(null);

    const threeDLeases = leases.filter((lease) => lease.isViewport3D);
    const replacement3DLease = threeDLeases[threeDLeases.length - 1];
    expect(runtimeStore.beginPauseMatching).toHaveBeenCalledTimes(3);
    expect(replacement3DLease).toBeDefined();
    expect(planarLease?.release).not.toHaveBeenCalled();

    dispose();
    expect(initial3DLease?.release).toHaveBeenCalledTimes(1);
    expect(replacement3DLease?.release).toHaveBeenCalledTimes(1);
    expect(planarLease?.release).toHaveBeenCalledTimes(1);
  });

  it("keeps planar resources live for a field-map companion and for both visible modules", () => {
    const layout = new LayoutController(new EventBus<KernelEventMap>());
    layout.setActiveViewportMainModule("analysis-plots");
    const { runtimeStore, leases } = createPauseRuntimeMock();

    const dispose = createViewport3DInactiveResourcePauseController({
      layout,
      runtimeStore,
    });
    const initial3DLease = leases.find((lease) => lease.isViewport3D);
    const initialPlanarLease = leases.find((lease) => lease.isPlanar);
    expect(initial3DLease).toBeDefined();
    expect(initialPlanarLease).toBeDefined();

    layout.setViewportCompanion({
      moduleId: "field-map",
      placement: "beside",
    });

    expect(initial3DLease?.release).not.toHaveBeenCalled();
    expect(initialPlanarLease?.release).toHaveBeenCalledTimes(1);
    expect(runtimeStore.beginPauseMatching).toHaveBeenCalledTimes(2);

    layout.setViewportCompanion(null);

    const planarLeases = leases.filter((lease) => lease.isPlanar);
    const replacementPlanarLease = planarLeases[planarLeases.length - 1];
    expect(runtimeStore.beginPauseMatching).toHaveBeenCalledTimes(3);
    expect(replacementPlanarLease).toBeDefined();
    expect(initial3DLease?.release).not.toHaveBeenCalled();

    layout.replace({
      ...layout.get(),
      activeViewportMainModuleId: "viewport-3d",
      viewportCompanion: {
        moduleId: "field-map",
        placement: "beside",
      },
    });

    expect(runtimeStore.beginPauseMatching).toHaveBeenCalledTimes(3);
    expect(initial3DLease?.release).toHaveBeenCalledTimes(1);
    expect(replacementPlanarLease?.release).toHaveBeenCalledTimes(1);

    dispose();
  });

  it("does not react to layout changes after disposal", () => {
    const layout = new LayoutController(new EventBus<KernelEventMap>());
    layout.setActiveViewportMainModule("analysis-plots");
    const { runtimeStore, leases } = createPauseRuntimeMock();

    const dispose = createViewport3DInactiveResourcePauseController({
      layout,
      runtimeStore,
    });
    const initialLeases = [...leases];
    expect(runtimeStore.beginPauseMatching).toHaveBeenCalledTimes(2);

    dispose();

    layout.setViewportCompanion({
      moduleId: "viewport-3d",
      placement: "beside",
    });
    layout.setViewportCompanion(null);
    layout.setActiveViewportMainModule("field-map");

    expect(runtimeStore.beginPauseMatching).toHaveBeenCalledTimes(2);
    expect(initialLeases).toHaveLength(2);
    expect(initialLeases[0]?.release).toHaveBeenCalledTimes(1);
    expect(initialLeases[1]?.release).toHaveBeenCalledTimes(1);

    dispose();
    expect(initialLeases[0]?.release).toHaveBeenCalledTimes(1);
    expect(initialLeases[1]?.release).toHaveBeenCalledTimes(1);
  });
});
