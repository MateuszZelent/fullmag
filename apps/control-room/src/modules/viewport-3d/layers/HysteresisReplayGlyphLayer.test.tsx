import { describe, expect, it } from "vitest";

import {
  buildHysteresisReplayGlyphLayerModel,
} from "./HysteresisReplayGlyphLayer";

describe("buildHysteresisReplayGlyphLayerModel", () => {
  it("builds field and measurement-axis glyph segments from the domain-neutral replay model", () => {
    const model = buildHysteresisReplayGlyphLayerModel({
      bounds: {
        center: [1, 2, 3],
        radius: 10,
        size: [20, 10, 4],
      },
      glyphModel: {
        fieldDirection: {
          label: "H field",
          source: "oop",
          vector: [0, 0, 1],
        },
        measurementAxis: {
          label: "Measurement axis",
          source: "in_plane_x",
          vector: [1, 0, 0],
        },
        pointId: 4,
        sampleNormal: {
          label: "Sample normal",
          source: "derived_oop",
          vector: [0, 0, 1],
        },
        stageId: "hysteresis-1",
        targetId: "hysteresis-step:hysteresis-1:4",
      },
    });

    expect(model).toEqual({
      axes: [
        {
          color: "var(--fm-warning)",
          key: "fieldDirection",
          label: "H field",
          positions: [1, 2, 3, 1, 2, 6],
        },
        {
          color: "var(--fm-info)",
          key: "measurementAxis",
          label: "Measurement axis",
          positions: [1, 2, 3, 4, 2, 3],
        },
        {
          color: "var(--fm-stale)",
          key: "sampleNormal",
          label: "Sample normal",
          positions: [1, 2, 3, 1, 2, 6],
        },
      ],
      labels: [
        {
          key: "fieldDirection",
          label: "H field",
          position: [1, 2, 6],
        },
        {
          key: "measurementAxis",
          label: "Measurement axis",
          position: [4, 2, 3],
        },
        {
          key: "sampleNormal",
          label: "Sample normal",
          position: [1, 2, 6],
        },
      ],
      signature: "hysteresis-step:hysteresis-1:4:fieldDirection:1,2,6:measurementAxis:4,2,3:sampleNormal:1,2,6",
    });
  });

  it("returns null without bounds or replay axes", () => {
    expect(buildHysteresisReplayGlyphLayerModel({
      bounds: null,
      glyphModel: null,
    })).toBeNull();
    expect(buildHysteresisReplayGlyphLayerModel({
      bounds: { center: [0, 0, 0], radius: 1, size: [1, 1, 1] },
      glyphModel: {
        fieldDirection: null,
        measurementAxis: null,
        pointId: 4,
        sampleNormal: null,
        stageId: "hysteresis-1",
        targetId: "hysteresis-step:hysteresis-1:4",
      },
    })).toBeNull();
  });
});
