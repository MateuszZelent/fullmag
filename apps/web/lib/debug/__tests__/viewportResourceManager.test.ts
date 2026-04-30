import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";

import {
  estimateThreeBufferGeometryBytes,
  getViewportResourceManagerStats,
  getViewportResourceRecords,
  releaseViewportResource,
  resetViewportResourceManagerForTests,
  trackViewportResource,
} from "../viewportResourceManager";

describe("viewportResourceManager", () => {
  afterEach(() => {
    resetViewportResourceManagerForTests();
  });

  it("tracks key, owner, estimated bytes, and lifecycle stats", () => {
    const dispose = vi.fn();

    trackViewportResource({
      key: "resource:surface",
      owner: "FemGeometry:1",
      label: "Surface",
      resource: { id: 1 },
      estimatedBytes: 128.9,
      dispose,
    });

    expect(getViewportResourceRecords()).toMatchObject([
      {
        key: "resource:surface",
        owner: "FemGeometry:1",
        label: "Surface",
        estimatedBytes: 128,
      },
    ]);
    expect(getViewportResourceManagerStats()).toMatchObject({
      entries: 1,
      estimatedBytes: 128,
      created: 1,
      disposed: 0,
      replaced: 0,
    });

    releaseViewportResource("resource:surface");

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(getViewportResourceManagerStats()).toMatchObject({
      entries: 0,
      estimatedBytes: 0,
      created: 1,
      disposed: 1,
    });
  });

  it("disposes the previous resource when a key is replaced", () => {
    const disposePrevious = vi.fn();
    const disposeNext = vi.fn();

    trackViewportResource({
      key: "resource:points",
      owner: "FemGeometry:1",
      label: "Points",
      resource: { id: 1 },
      estimatedBytes: 64,
      dispose: disposePrevious,
    });
    trackViewportResource({
      key: "resource:points",
      owner: "FemGeometry:1",
      label: "Points",
      resource: { id: 2 },
      estimatedBytes: 96,
      dispose: disposeNext,
    });

    expect(disposePrevious).toHaveBeenCalledTimes(1);
    expect(disposeNext).not.toHaveBeenCalled();
    expect(getViewportResourceManagerStats()).toMatchObject({
      entries: 1,
      estimatedBytes: 96,
      created: 2,
      disposed: 1,
      replaced: 1,
    });
  });

  it("estimates BufferGeometry bytes from attributes and index buffers", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(9), 3));
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(3), 1));

    expect(estimateThreeBufferGeometryBytes(geometry)).toBe(84);

    geometry.dispose();
  });
});
