import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const path = new URL("../src/modules/inspector/panels/antenna/MicrostripGeometryEditorModel.ts", import.meta.url);
const geometryModule = new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(path, "utf8")));
await geometryModule.link(() => { throw new Error("Draft model must have no runtime dependencies"); });
await geometryModule.evaluate();
const { antennaLayoutGeometry, microstripGeometry, buildAntennaLayoutGeometry, buildMicrostripGeometry, widthStationDraft, widthStationsEqual, insertWidthStation, CPW_STATION_FIELDS } = geometryModule.namespace;
let checks = 0;
const check = (label, run) => { run(); checks++; console.log(`PASS ${label}`); };
const params = {
  length_m: 1e-6, thickness_m: 10e-9, conductivity_s_per_m: 5.8e7,
  transform: { translation_m: [1e-6, 2e-6, 3e-6] },
  conductors: [{ id: "trace", kind: "signal" }, { id: "left", kind: "ground_left" }, { id: "right", kind: "ground_right" }],
  stations: [
    { s: 0, signal_width_m: 40e-9, left_gap_m: 10e-9, right_gap_m: 30e-9, left_ground_width_m: 80e-9, right_ground_width_m: 150e-9 },
    { s: 1, signal_width_m: 20e-9, left_gap_m: 20e-9, right_gap_m: 10e-9, left_ground_width_m: 120e-9, right_ground_width_m: 90e-9 },
  ],
};
const cpw = { geometry_kind: "CPWAntennaLayout", geometry_params: params, bounds_min: [0, 0, 0] };
check("CPW inserts all five interpolated dimensions with stable UI-local IDs", () => {
  const baseline = widthStationDraft(cpw);
  const inserted = insertWidthStation(baseline, "draft:new");
  assert.equal(inserted[0], baseline[0]);
  assert.equal(inserted[2], baseline[1]);
  assert.equal(inserted[1].rowId, "draft:new");
  const built = buildAntennaLayoutGeometry(cpw, inserted);
  assert.equal(built.geometry_kind, cpw.geometry_kind);
  for (const key of ["signal_width_m", ...Array.from(CPW_STATION_FIELDS, (field) => field.parameter)]) {
    assert.equal(built.geometry_params.stations[1][key], (params.stations[0][key] + params.stations[1][key]) / 2);
  }
  assert.deepEqual({ ...built.geometry_params, stations: [] }, { ...params, stations: [] });
  assert.equal("bounds_min" in built, false);
  assert.equal("rowId" in built.geometry_params.stations[1], false);
  assert.deepEqual(Array.from(widthStationDraft(built, inserted), (row) => row.rowId), Array.from(inserted, (row) => row.rowId));
});
check("every CPW dimension participates in numeric equality and validation", () => {
  const draft = widthStationDraft(cpw);
  for (const { key } of CPW_STATION_FIELDS) {
    assert.equal(widthStationsEqual(draft, draft.map((row) => ({ ...row, [key]: Number(row[key]).toExponential() }))), true);
    assert.equal(widthStationsEqual(draft, [{ ...draft[0], [key]: "9e-9" }, draft[1]]), false);
    for (const value of [undefined, "", " ", "0", "-1", "NaN", "Infinity"]) {
      assert.throws(() => buildAntennaLayoutGeometry(cpw, [{ ...draft[0], [key]: value }, draft[1]]), /positive/);
    }
  }
  assert.throws(() => buildAntennaLayoutGeometry(cpw, [{ ...draft[0], s: "0.1" }, draft[1]]), /start at/);
  assert.throws(() => buildAntennaLayoutGeometry(cpw, [draft[0], { ...draft[1], s: "0" }]), /strictly/);
  assert.equal(insertWidthStation([{ ...draft[0], leftGapM: "" }, draft[1]], "new")[1].leftGapM, "");
});
check("old microstrip guards stay narrow; generic selector uses immutable object ID", () => {
  const scene = { objects: [{ id: "owner", name: "renamed", geometry: cpw }] };
  assert.equal(antennaLayoutGeometry(scene, "owner"), cpw);
  assert.equal(antennaLayoutGeometry(scene, "renamed"), null);
  assert.equal(microstripGeometry(scene, "owner"), null);
  assert.throws(() => buildMicrostripGeometry(cpw, widthStationDraft(cpw)), /MicrostripAntennaLayout/);
  const microstrip = { geometry_kind: "MicrostripAntennaLayout", geometry_params: { ...params, stations: params.stations.map(({ s, signal_width_m }) => ({ s, signal_width_m })), return_width_m: 500e-9, return_offset_m: 30e-9 } };
  const draft = widthStationDraft(microstrip);
  assert.equal(Object.keys(draft[0]).length, 3);
  assert.equal(buildMicrostripGeometry(microstrip, draft).geometry_params.return_offset_m, 30e-9);
  assert.equal(widthStationsEqual(draft, widthStationDraft(cpw)), false);
});
check("CPW moved station IDs cannot collide with server insertion at its former position", () => {
  const previous = insertWidthStation(widthStationDraft(cpw), "draft:middle");
  previous[1].s = "0.6";
  const built = buildAntennaLayoutGeometry(cpw, previous);
  const refreshed = { ...built, geometry_params: { ...built.geometry_params, stations: [params.stations[0], { ...params.stations[0], s: 0.5 }, built.geometry_params.stations[1], params.stations[1]] } };
  const next = widthStationDraft(refreshed, previous);
  assert.equal(next[2].rowId, previous[1].rowId);
  assert.equal(new Set(next.map((row) => row.rowId)).size, 4);
});
console.log(`Antenna station drafts: ${checks} interpreted checks PASS; no test bundle or backend solve.`);
