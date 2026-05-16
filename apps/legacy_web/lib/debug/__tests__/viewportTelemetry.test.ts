import { afterEach, describe, expect, it } from "vitest";

import {
  getViewportTelemetrySnapshot,
  recordViewportLifecycleEvent,
  recordViewportLifecycleEventForLabel,
  registerViewportTelemetry,
  unregisterViewportTelemetry,
  type ViewportTelemetryEntry,
} from "../viewportTelemetry";

function entry(id: string, label = id): ViewportTelemetryEntry {
  return {
    id,
    label,
    renderer: "webgl",
    drawCalls: 0,
    triangles: 0,
    lines: 0,
    points: 0,
    geometries: 0,
    textures: 0,
    frameloop: "demand",
    hidden: false,
    width: 0,
    height: 0,
    dpr: 1,
    lastFrameAt: 0,
    lastFrameAtUnixMs: 0,
    mountedAt: 0,
    lifecycle: {
      canvasMounts: 0,
      canvasUnmounts: 0,
      contextLost: 0,
      contextRestored: 0,
      cameraFits: 0,
      cameraRestores: 0,
      cameraPersists: 0,
      topologyRebuilds: 0,
      fieldBufferUpdates: 0,
    },
  };
}

describe("viewport lifecycle telemetry", () => {
  afterEach(() => {
    unregisterViewportTelemetry("viewport:a");
    unregisterViewportTelemetry("viewport:b");
  });

  it("increments lifecycle counters on registered viewport entries only", () => {
    registerViewportTelemetry(entry("viewport:a", "fem-m"));

    recordViewportLifecycleEvent("viewport:a", "canvas_mount");
    recordViewportLifecycleEvent("viewport:a", "camera_restore");
    recordViewportLifecycleEvent("viewport:a", "topology_rebuild");
    recordViewportLifecycleEvent("viewport:a", "field_buffer_update");
    recordViewportLifecycleEvent("missing", "camera_persist");

    const current = getViewportTelemetrySnapshot();
    const viewport = current.find((item) => item.id === "viewport:a");
    expect(viewport?.lifecycle).toMatchObject({
      canvasMounts: 1,
      cameraRestores: 1,
      cameraPersists: 0,
      topologyRebuilds: 1,
      fieldBufferUpdates: 1,
    });
  });

  it("can record by telemetry label for nested renderers", () => {
    registerViewportTelemetry(entry("viewport:a", "fem-m"));
    registerViewportTelemetry(entry("viewport:b", "fem-m"));

    recordViewportLifecycleEventForLabel("fem-m", "camera_persist");

    const current = getViewportTelemetrySnapshot().filter((item) => item.label === "fem-m");
    expect(current).toHaveLength(2);
    expect(current.every((item) => item.lifecycle.cameraPersists === 1)).toBe(true);
  });
});
