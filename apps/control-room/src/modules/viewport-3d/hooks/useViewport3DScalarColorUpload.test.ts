import { BufferAttribute, BufferGeometry, DynamicDrawUsage, StaticDrawUsage } from "three";
import { describe, expect, it } from "vitest";

import type { ScalarColorBuffer } from "../viewport3dFieldMapping";
import {
  canReuseViewport3DScalarShaderAttributes,
  canRetainViewport3DScalarUploadBuffer,
  createViewport3DScalarColorUploadPlan,
  createViewport3DScalarColorUploadStore,
  createViewport3DScalarShaderColorUploadPlan,
  createViewport3DScalarShaderUploadStore,
} from "./useViewport3DScalarColorUpload";
import { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import {
  VIEWPORT_3D_COMPLEX_IMAG_VALUE_ATTRIBUTE,
  VIEWPORT_3D_COMPLEX_REAL_VALUE_ATTRIBUTE,
  VIEWPORT_3D_SCALAR_VALUE_ATTRIBUTE,
  VIEWPORT_3D_VECTOR_VALUE_ATTRIBUTE,
} from "../viewport3dScalarSurfaceShader";

describe("canReuseViewport3DScalarShaderAttributes", () => {
  it("keeps immutable complex attributes when only uniforms change", () => {
    const real = new Float32Array([1, 2, 3, 4, 5, 6]);
    const imag = new Float32Array([7, 8, 9, 10, 11, 12]);
    const previous: ScalarColorBuffer = {
      buildKey: "mode:raw-a",
      colors: new Float32Array(),
      colorMode: "x",
      complexImagValues: imag,
      complexRealValues: real,
      complexRepresentation: "real",
      range: { max: 1, min: -1 },
    };
    const next: ScalarColorBuffer = {
      ...previous,
      colorMode: "z",
      complexPhaseRad: Math.PI / 2,
      complexRepresentation: "imag",
    };

    expect(canReuseViewport3DScalarShaderAttributes(previous, next)).toBe(true);
    expect(canReuseViewport3DScalarShaderAttributes(previous, {
      ...next,
      buildKey: "mode:raw-b",
    })).toBe(false);
    expect(canReuseViewport3DScalarShaderAttributes(previous, {
      ...next,
      complexImagValues: imag.slice(),
    })).toBe(false);
  });
});

function scalarColorBuffer(vertexCount: number): ScalarColorBuffer {
  const colors = new Float32Array(vertexCount * 3);
  for (let index = 0; index < colors.length; index += 1) {
    colors[index] = index + 1;
  }
  return {
    colors,
    range: { max: colors.length, min: 1 },
  };
}

describe("canRetainViewport3DScalarUploadBuffer", () => {
  it("keeps a visible scalar upload only for the same semantic layer", () => {
    const geometry = new BufferGeometry();
    const buffer = scalarColorBuffer(2);

    expect(
      canRetainViewport3DScalarUploadBuffer({
        allowRetention: true,
        buffer,
        geometry,
        requestedGeometry: geometry,
        requestedRetentionKey: "part=a|mode=x|quantity=m|palette=viridis",
        retentionKey: "part=a|mode=x|quantity=m|palette=viridis",
      }),
    ).toBe(true);

    expect(
      canRetainViewport3DScalarUploadBuffer({
        allowRetention: true,
        buffer,
        geometry,
        requestedGeometry: geometry,
        requestedRetentionKey: "part=a|mode=y|quantity=m|palette=viridis",
        retentionKey: "part=a|mode=x|quantity=m|palette=viridis",
      }),
    ).toBe(false);

    expect(
      canRetainViewport3DScalarUploadBuffer({
        allowRetention: false,
        buffer,
        geometry,
        requestedGeometry: geometry,
        requestedRetentionKey: "part=a|mode=x|quantity=m|palette=viridis",
        retentionKey: "part=a|mode=x|quantity=m|palette=viridis",
      }),
    ).toBe(false);
  });
});

describe("createViewport3DScalarColorUploadPlan", () => {
  it("splits scalar color buffers into upload chunks before visible adoption", () => {
    const geometry = new BufferGeometry();
    const colorBuffer = scalarColorBuffer(5);
    const uploadPlan = createViewport3DScalarColorUploadPlan(
      geometry,
      colorBuffer,
      5,
      2,
    );

    expect(uploadPlan).not.toBeNull();
    expect(uploadPlan?.chunks.map((chunk) => chunk.itemCount)).toEqual([
      2, 2, 1,
    ]);
    expect(uploadPlan?.estimatedBytes).toBe(colorBuffer.colors.byteLength);
    expect(geometry.hasAttribute("color")).toBe(false);

    for (const chunk of uploadPlan?.chunks ?? []) {
      chunk.upload();
    }
    expect(geometry.hasAttribute("color")).toBe(false);

    uploadPlan?.onVisible();
    const attribute = geometry.getAttribute("color") as BufferAttribute;
    expect(attribute).toBeInstanceOf(BufferAttribute);
    expect(Array.from(attribute.array as Float32Array)).toEqual(
      Array.from(colorBuffer.colors),
    );
    expect(attribute.version).toBeGreaterThan(0);
    expect(attribute.usage).toBe(DynamicDrawUsage);
  });

  it("reuses an existing compatible scalar color attribute", () => {
    const geometry = new BufferGeometry();
    const existing = new BufferAttribute(new Float32Array(6), 3);
    geometry.setAttribute("color", existing);
    const colorBuffer = scalarColorBuffer(2);

    const uploadPlan = createViewport3DScalarColorUploadPlan(
      geometry,
      colorBuffer,
      2,
      1,
    );

    for (const chunk of uploadPlan?.chunks ?? []) {
      chunk.upload();
    }
    uploadPlan?.onVisible();

    expect(geometry.getAttribute("color")).toBe(existing);
    expect(existing.usage).toBe(StaticDrawUsage);
    expect(Array.from(existing.array as Float32Array)).toEqual(
      Array.from(colorBuffer.colors),
    );
  });
});

describe("createViewport3DScalarShaderColorUploadPlan", () => {
  it("splits scalar shader attributes into upload chunks before visible adoption", () => {
    const geometry = new BufferGeometry();
    const scalarValues = new Float32Array([1, 2, 3, 4, 5]);
    const colorBuffer: ScalarColorBuffer = {
      colors: new Float32Array(),
      colorMode: "x",
      range: { max: 5, min: 1 },
      scalarValues,
    };

    const uploadPlan = createViewport3DScalarShaderColorUploadPlan(
      geometry,
      colorBuffer,
      5,
      2,
    );

    expect(uploadPlan).not.toBeNull();
    expect(uploadPlan?.chunks.map((chunk) => chunk.itemCount)).toEqual([
      2, 2, 1,
    ]);
    expect(uploadPlan?.estimatedBytes).toBe(scalarValues.byteLength);
    expect(geometry.hasAttribute(VIEWPORT_3D_SCALAR_VALUE_ATTRIBUTE)).toBe(false);

    for (const chunk of uploadPlan?.chunks ?? []) {
      chunk.upload();
    }
    expect(geometry.hasAttribute(VIEWPORT_3D_SCALAR_VALUE_ATTRIBUTE)).toBe(false);

    uploadPlan?.onVisible();
    const attribute = geometry.getAttribute(
      VIEWPORT_3D_SCALAR_VALUE_ATTRIBUTE,
    ) as BufferAttribute;
    expect(attribute).toBeInstanceOf(BufferAttribute);
    expect(Array.from(attribute.array as Float32Array)).toEqual(
      Array.from(scalarValues),
    );
    expect(attribute.version).toBeGreaterThan(0);
    expect(attribute.usage).toBe(DynamicDrawUsage);
  });

  it("reuses compatible shader attributes while retaining inactive slots", () => {
    const geometry = new BufferGeometry();
    const scalarAttribute = new BufferAttribute(new Float32Array(2), 1);
    geometry.setAttribute(VIEWPORT_3D_SCALAR_VALUE_ATTRIBUTE, scalarAttribute);
    geometry.setAttribute(
      VIEWPORT_3D_VECTOR_VALUE_ATTRIBUTE,
      new BufferAttribute(new Float32Array(6).fill(1), 3),
    );
    const scalarValues = new Float32Array([7, 9]);
    const colorBuffer: ScalarColorBuffer = {
      colors: new Float32Array(),
      colorMode: "x",
      range: { max: 9, min: 7 },
      scalarValues,
    };

    const uploadPlan = createViewport3DScalarShaderColorUploadPlan(
      geometry,
      colorBuffer,
      2,
      1,
    );

    for (const chunk of uploadPlan?.chunks ?? []) {
      chunk.upload();
    }
    uploadPlan?.onVisible();

    expect(geometry.getAttribute(VIEWPORT_3D_SCALAR_VALUE_ATTRIBUTE)).toBe(
      scalarAttribute,
    );
    expect(scalarAttribute.usage).toBe(StaticDrawUsage);
    expect(Array.from(scalarAttribute.array as Float32Array)).toEqual([7, 9]);
    expect(geometry.hasAttribute(VIEWPORT_3D_VECTOR_VALUE_ATTRIBUTE)).toBe(true);
  });

  it("retains inactive shader slots so mode switches reuse their GPU attribute identities", () => {
    const geometry = new BufferGeometry();
    const scalarValues = new Float32Array([1, 2]);
    const vectorValues = new Float32Array([1, 2, 3, 4, 5, 6]);

    for (const buffer of [
      {
        colors: new Float32Array(),
        colorMode: "scalar",
        range: { max: 2, min: 1 },
        scalarValues,
      },
      {
        colors: new Float32Array(),
        colorMode: "orientation",
        range: { max: 1, min: 0 },
        vectorValues,
      },
      {
        colors: new Float32Array(),
        colorMode: "scalar",
        range: { max: 2, min: 1 },
        scalarValues,
      },
    ] satisfies ScalarColorBuffer[]) {
      const plan = createViewport3DScalarShaderColorUploadPlan(
        geometry,
        buffer,
        2,
        2,
      );
      for (const chunk of plan?.chunks ?? []) chunk.upload();
      plan?.onVisible();
    }

    expect(geometry.getAttribute(VIEWPORT_3D_SCALAR_VALUE_ATTRIBUTE)).toBeInstanceOf(
      BufferAttribute,
    );
    expect(geometry.getAttribute(VIEWPORT_3D_VECTOR_VALUE_ATTRIBUTE)).toBeInstanceOf(
      BufferAttribute,
    );
  });

  it("uploads complex real/imag attributes for shader-side phase projection (S-18)", () => {
    const geometry = new BufferGeometry();
    const colorBuffer: ScalarColorBuffer = {
      colors: new Float32Array(),
      colorMode: "x",
      complexImagValues: new Float32Array([0, 1, 0, 0, 0, 1]),
      complexPhaseRad: Math.PI / 2,
      complexRealValues: new Float32Array([1, 0, 0, 0, 1, 0]),
      range: { max: 1, min: -1 },
      scalarValues: new Float32Array([1, 0]),
    };

    const uploadPlan = createViewport3DScalarShaderColorUploadPlan(
      geometry,
      colorBuffer,
      2,
    );

    expect(uploadPlan).not.toBeNull();
    for (const chunk of uploadPlan?.chunks ?? []) chunk.upload();
    uploadPlan?.onVisible();

    expect(
      Array.from(
        geometry.getAttribute(VIEWPORT_3D_COMPLEX_REAL_VALUE_ATTRIBUTE)
          .array as Float32Array,
      ),
    ).toEqual([1, 0, 0, 0, 1, 0]);
    expect(
      Array.from(
        geometry.getAttribute(VIEWPORT_3D_COMPLEX_IMAG_VALUE_ATTRIBUTE)
          .array as Float32Array,
      ),
    ).toEqual([0, 1, 0, 0, 0, 1]);
  });
});

describe("createViewport3DScalarColorUploadStore and retention transition sequences (LR-02)", () => {
  it("tracks transition from fresh upload to retained stale upload across missing buffer frames", () => {
    const tracker = new Viewport3DResourceTracker();
    const store = createViewport3DScalarColorUploadStore();
    const geometryA = new BufferGeometry();
    const bufferA = scalarColorBuffer(3);
    const retentionKeyA = "part=part1|mode=magnitude|quantity=m|palette=viridis";

    // Initial state
    expect(store.getSnapshot()).toEqual({
      buffer: null,
      fresh: false,
      geometry: null,
      retentionKey: null,
      version: 0,
    });

    // Frame 1: fresh buffer available
    store.publish(bufferA, geometryA, retentionKeyA, true);
    expect(store.getSnapshot()).toEqual({
      buffer: bufferA,
      fresh: true,
      geometry: geometryA,
      retentionKey: retentionKeyA,
      version: 1,
    });

    // Frame 2: buffer temporarily missing, same geometry and retentionKey -> retain
    const current = store.getSnapshot();
    const canRetain = canRetainViewport3DScalarUploadBuffer({
      allowRetention: true,
      buffer: current.buffer,
      geometry: current.geometry,
      requestedGeometry: geometryA,
      requestedRetentionKey: retentionKeyA,
      retentionKey: current.retentionKey,
    });
    expect(canRetain).toBe(true);
    store.publish(current.buffer, geometryA, current.retentionKey, false);

    expect(store.getSnapshot()).toEqual({
      buffer: bufferA,
      fresh: false,
      geometry: geometryA,
      retentionKey: retentionKeyA,
      version: 2,
    });

    // Frame 3: geometry changed -> retention rejected, buffer blanked
    const geometryB = new BufferGeometry();
    const stateBeforeGeoChange = store.getSnapshot();
    const canRetainOnNewGeo = canRetainViewport3DScalarUploadBuffer({
      allowRetention: true,
      buffer: stateBeforeGeoChange.buffer,
      geometry: stateBeforeGeoChange.geometry,
      requestedGeometry: geometryB,
      requestedRetentionKey: retentionKeyA,
      retentionKey: stateBeforeGeoChange.retentionKey,
    });
    expect(canRetainOnNewGeo).toBe(false);
    if (stateBeforeGeoChange.buffer) {
      tracker.recordRetentionRejection(
        stateBeforeGeoChange.geometry !== geometryB ? "geometry" : "retention-key",
      );
    }
    store.publish(null, geometryB, null, false);

    expect(store.getSnapshot()).toEqual({
      buffer: null,
      fresh: false,
      geometry: geometryB,
      retentionKey: null,
      version: 3,
    });
    expect(tracker.getRetentionRejectionCounts()).toEqual({ geometry: 1 });
  });

  it("rejects retention and blanks buffer when retentionKey changes", () => {
    const tracker = new Viewport3DResourceTracker();
    const store = createViewport3DScalarColorUploadStore();
    const geometry = new BufferGeometry();
    const buffer = scalarColorBuffer(3);
    const retentionKeyA = "part=part1|mode=magnitude|quantity=m";
    const retentionKeyB = "part=part1|mode=x|quantity=m";

    store.publish(buffer, geometry, retentionKeyA, true);

    const current = store.getSnapshot();
    const canRetain = canRetainViewport3DScalarUploadBuffer({
      allowRetention: true,
      buffer: current.buffer,
      geometry: current.geometry,
      requestedGeometry: geometry,
      requestedRetentionKey: retentionKeyB,
      retentionKey: current.retentionKey,
    });
    expect(canRetain).toBe(false);
    if (current.buffer) {
      tracker.recordRetentionRejection(
        current.geometry !== geometry ? "geometry" : "retention-key",
      );
    }
    store.publish(null, geometry, null, false);

    expect(store.getSnapshot()).toEqual({
      buffer: null,
      fresh: false,
      geometry,
      retentionKey: null,
      version: 2,
    });
    expect(tracker.getRetentionRejectionCounts()).toEqual({ "retention-key": 1 });
  });

  it("notifies subscribers only when published snapshot changes", () => {
    const store = createViewport3DScalarShaderUploadStore();
    const geometry = new BufferGeometry();
    const buffer = scalarColorBuffer(2);
    let notifyCount = 0;
    const unsubscribe = store.subscribe(() => {
      notifyCount += 1;
    });

    store.publish(buffer, geometry, "key-1", true);
    expect(notifyCount).toBe(1);

    // Publishing identical state is a no-op
    store.publish(buffer, geometry, "key-1", true);
    expect(notifyCount).toBe(1);

    // Publishing with fresh: false notifies
    store.publish(buffer, geometry, "key-1", false);
    expect(notifyCount).toBe(2);

    unsubscribe();
    store.publish(null, null, null, false);
    expect(notifyCount).toBe(2);
  });
});
