import { describe, expect, it } from "vitest";

import type { JsonObject } from "@/kernel/api/apiTypes";

import {
  buildMicrostripGeometry,
  insertWidthStation,
  widthStationDraft,
  widthStationsEqual,
} from "./MicrostripGeometryEditorModel";

const geometry = {
  geometry_kind: "MicrostripAntennaLayout",
  geometry_params: {
    length_m: 1e-6,
    thickness_m: 10e-9,
    conductivity_s_per_m: 5.8e7,
    return_width_m: 500e-9,
    return_offset_m: 30e-9,
    stations: [
      { s: 0, signal_width_m: 50e-9 },
      { s: 1, signal_width_m: 25e-9 },
    ],
    transform: { rotation_matrix: [[0, -1, 0], [1, 0, 0], [0, 0, 1]] },
    conductors: [{ id: "signal", kind: "signal" }, { id: "return", kind: "return" }],
  },
  bounds_min: [-250e-9, -0.5e-6, -45e-9],
  bounds_max: [250e-9, 0.5e-6, 5e-9],
} as JsonObject;

describe("microstrip width station authoring", () => {
  it("inserts an interior station and preserves authored physical parameters", () => {
    const draft = insertWidthStation(widthStationDraft(geometry), "draft:inserted");
    expect(draft).toHaveLength(3);
    expect(draft[1].s).toBe("0.5");
    const patched = buildMicrostripGeometry(geometry, [
      draft[0], { ...draft[1], signalWidthM: "10e-9" }, draft[2],
    ]);
    expect(patched.geometry_params).toMatchObject({
      length_m: 1e-6,
      return_width_m: 500e-9,
      transform: { rotation_matrix: [[0, -1, 0], [1, 0, 0], [0, 0, 1]] },
      conductors: [{ id: "signal" }, { id: "return" }],
      stations: [
        { s: 0, signal_width_m: 50e-9 },
        { s: 0.5, signal_width_m: 10e-9 },
        { s: 1, signal_width_m: 25e-9 },
      ],
    });
    expect(patched).not.toHaveProperty("bounds_min");
    expect(patched).not.toHaveProperty("bounds_max");
  });

  it("rejects blank, unordered, nonpositive and displaced endpoint stations", () => {
    const draft = widthStationDraft(geometry);
    expect(() => buildMicrostripGeometry(geometry, [{ ...draft[0], signalWidthM: " " }, draft[1]])).toThrow("requires");
    expect(() => buildMicrostripGeometry(geometry, [draft[0], { rowId: "draft:invalid", s: "0", signalWidthM: "5e-9" }, draft[1]])).toThrow("strictly increasing");
    expect(() => buildMicrostripGeometry(geometry, [draft[0], { ...draft[1], signalWidthM: "-1" }])).toThrow("positive");
    expect(() => buildMicrostripGeometry(geometry, [{ ...draft[0], s: "0.1" }, draft[1]])).toThrow("start at s=0");
  });

  it("keeps row identity UI-local and compares physical values, not formatting", () => {
    const original = widthStationDraft(geometry);
    const inserted = insertWidthStation(original, "draft:inserted");
    expect(inserted[0]).toBe(original[0]);
    expect(inserted[2]).toBe(original[1]);
    expect(inserted[1].rowId).toBe("draft:inserted");
    const formatted = original.map((station, index) => ({ ...station, rowId: `other:${station.rowId}`, signalWidthM: index === 0 ? "50e-9" : "25e-9" }));
    expect(widthStationsEqual(original, formatted)).toBe(true);
    expect(widthStationsEqual(original, [{ ...original[0], signalWidthM: " " }, original[1]])).toBe(false);
    const patched = buildMicrostripGeometry(geometry, inserted);
    expect((patched.geometry_params as JsonObject).stations).toEqual([
      { s: 0, signal_width_m: 50e-9 }, { s: 0.5, signal_width_m: 37.5e-9 }, { s: 1, signal_width_m: 25e-9 },
    ]);
    expect(widthStationDraft(patched, inserted).map((station) => station.rowId)).toEqual(inserted.map((station) => station.rowId));
  });

  it("does not reuse a moved row ID when a server station appears at its old position", () => {
    const previous = widthStationDraft({ geometry_params: { stations: [
      { s: 0, signal_width_m: 20e-9 }, { s: 0.25, signal_width_m: 20e-9 },
      { s: 0.75, signal_width_m: 20e-9 }, { s: 1, signal_width_m: 20e-9 },
    ] } });
    previous[2].s = "0.8";
    const refreshed = widthStationDraft({ geometry_params: { stations: [
      { s: 0, signal_width_m: 20e-9 }, { s: 0.25, signal_width_m: 20e-9 },
      { s: 0.75, signal_width_m: 19e-9 }, { s: 0.8, signal_width_m: 20e-9 }, { s: 1, signal_width_m: 20e-9 },
    ] } }, previous);
    expect(refreshed[3].rowId).toBe(previous[2].rowId);
    expect(new Set(refreshed.map((station) => station.rowId)).size).toBe(refreshed.length);
  });
});
