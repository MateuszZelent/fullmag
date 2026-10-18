import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const path = new URL("../src/modules/inspector/panels/antenna/MicrostripGeometryEditorModel.ts", import.meta.url);
const geometryModule = new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(path, "utf8")));
await geometryModule.link(() => { throw new Error("Draft model must have no runtime dependencies"); });
await geometryModule.evaluate();
const { buildMicrostripCircuitPatch, antennaLayoutDimensionDraft, antennaLayoutDimensionFields, antennaLayoutDimensionsEqual, antennaLayoutGeometry, microstripGeometry, buildAntennaLayoutGeometry, buildMicrostripGeometry, widthStationDraft, widthStationsEqual, insertWidthStation, CPW_STATION_FIELDS } = geometryModule.namespace;
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
check("CPW dimension editing changes only authored length/thickness and preserves physical identity", () => {
  const before = JSON.stringify(cpw);
  const dimensions = antennaLayoutDimensionDraft(cpw);
  assert.deepEqual(Array.from(antennaLayoutDimensionFields(cpw), ({ parameter }) => parameter), ["length_m", "thickness_m"]);
  const built = buildAntennaLayoutGeometry(cpw, widthStationDraft(cpw), { ...dimensions, length_m: "2e-6", thickness_m: "20e-9", return_width_m: "999" });
  assert.equal(built.geometry_params.length_m, 2e-6);
  assert.equal(built.geometry_params.thickness_m, 20e-9);
  assert.equal("return_width_m" in built.geometry_params, false);
  assert.deepEqual({ ...built.geometry_params, length_m: params.length_m, thickness_m: params.thickness_m }, params);
  assert.equal(JSON.stringify(cpw), before);
  assert.equal(antennaLayoutDimensionsEqual(dimensions, { ...dimensions, length_m: "0.000001" }), true);
  assert.equal(antennaLayoutDimensionsEqual(dimensions, { ...dimensions, thickness_m: "20e-9" }), false);
});
check("microstrip dimensions preserve stations, conductor IDs and loop configuration; zero offset is authored", () => {
  const microstrip = { geometry_kind: "MicrostripAntennaLayout", geometry_params: {
    ...params, return_width_m: 500e-9, return_offset_m: 30e-9,
    stations: params.stations.map(({ s, signal_width_m }) => ({ s, signal_width_m })),
    loop: { enabled: false, inlet_connection_part_id: "inlet-stable" },
  } };
  const dimensions = antennaLayoutDimensionDraft(microstrip);
  assert.equal(Object.keys(dimensions).length, 4);
  const built = buildAntennaLayoutGeometry(microstrip, widthStationDraft(microstrip), {
    ...dimensions, length_m: "3e-6", thickness_m: "15e-9", return_width_m: "650e-9", return_offset_m: "0",
  });
  assert.equal(built.geometry_params.length_m, 3e-6);
  assert.equal(built.geometry_params.thickness_m, 15e-9);
  assert.equal(built.geometry_params.return_width_m, 650e-9);
  assert.equal(built.geometry_params.return_offset_m, 0);
  assert.deepEqual(built.geometry_params.loop, microstrip.geometry_params.loop);
  assert.deepEqual(built.geometry_params.conductors, microstrip.geometry_params.conductors);
  assert.deepEqual(built.geometry_params.stations, microstrip.geometry_params.stations);
  for (const { parameter } of antennaLayoutDimensionFields(microstrip)) {
    for (const value of [undefined, "", " ", "-1", "NaN", "Infinity"]) {
      assert.throws(() => buildAntennaLayoutGeometry(microstrip, widthStationDraft(microstrip), { ...dimensions, [parameter]: value }), /finite/);
    }
    if (parameter !== "return_offset_m") assert.throws(() => buildAntennaLayoutGeometry(microstrip, widthStationDraft(microstrip), { ...dimensions, [parameter]: "0" }), /positive/);
  }
});
check("closed-circuit dimension changes preserve the source-cut plane and reject moving its clearance away", () => {
  const geometry = { geometry_kind: "MicrostripAntennaLayout", geometry_params: {
    ...params, return_width_m: 500e-9, return_offset_m: 30e-9,
    conductors: [{ id: "signal", kind: "signal" }, { id: "return", kind: "return" }],
    stations: params.stations.map(({ s, signal_width_m }) => ({ s, signal_width_m })),
  } };
  const scene = { objects: [{ id: "owner", geometry }],
    current_transports: [{ name: "charge", kind: "current_transport", model: "ohmic_poisson", coupling: "one_way", domain: [{ object_id: "owner" }],
      materials: [{ region: { object_id: "owner" }, material: { sigma_Spm: params.conductivity_s_per_m } }] }],
    antenna_port_modes: [{ id: "port", source_object_id: "owner", current_transport_id: "charge", branches: [
      { id: "signal", inlet_terminal_ref: "signal-in", outlet_terminal_ref: "signal-out" }, { id: "return", inlet_terminal_ref: "return-in", outlet_terminal_ref: "return-out" },
    ] }],
  };
  const draft = { enabled: true, potentialJumpV: "1", parameters: Object.fromEntries(["inlet", "outlet"].flatMap((end) => [
    [`${end}_connection_length_m`, "10e-9"], [`${end}_connection_width_m`, "10e-9"], [`${end}_connection_offset_v_m`, "0"],
    [`${end}_connection_part_id`, end], [`${end}_connection_conductivity_s_per_m`, String(params.conductivity_s_per_m)],
  ])) };
  const closed = { ...scene, ...buildMicrostripCircuitPatch(scene, "owner", geometry, draft) };
  const closedGeometry = closed.objects[0].geometry;
  const originalCut = JSON.stringify(closed.current_transports[0].structured_current_closure.source_cuts[0]);
  const dimensions = antennaLayoutDimensionDraft(closedGeometry);
  const changed = buildAntennaLayoutGeometry(closedGeometry, widthStationDraft(closedGeometry), { ...dimensions, length_m: "2e-6" });
  const patch = buildMicrostripCircuitPatch(closed, "owner", changed, draft);
  assert.equal(JSON.stringify(patch.current_transports[0].structured_current_closure.source_cuts[0]), originalCut);
  const invalid = buildAntennaLayoutGeometry(closedGeometry, widthStationDraft(closedGeometry), { ...dimensions, thickness_m: "100e-9" });
  assert.throws(() => buildMicrostripCircuitPatch(closed, "owner", invalid, draft), /source cut must lie strictly inside/);
  assert.equal(JSON.stringify(closed.current_transports[0].structured_current_closure.source_cuts[0]), originalCut);
});
console.log(`Antenna station drafts: ${checks} interpreted checks PASS; no test bundle or backend solve.`);
