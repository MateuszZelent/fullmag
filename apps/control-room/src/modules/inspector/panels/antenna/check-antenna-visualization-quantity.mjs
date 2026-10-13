import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

// Interpret the production selector without building a unit-test bundle.
const source = readFileSync(new URL("./AntennaVisualizationQuantity.ts", import.meta.url), "utf8");
const interpreted = stripTypeScriptTypes(source).replace(/^export /gm, "");
const { antennaInspectionHasCurrent, antennaVisualizationQuantity } = vm.runInNewContext(`${interpreted}\n({ antennaInspectionHasCurrent, antennaVisualizationQuantity });`);

let count = 0;
const check = (actual, expected) => { assert.equal(actual, expected); count += 1; };
const display = { schema_version: "antenna_inspection_display.v2", capabilities: { current_density: true }, device_current: {} };
check(antennaInspectionHasCurrent(display), true);
check(antennaInspectionHasCurrent(null), false);
check(antennaInspectionHasCurrent({ ...display, schema_version: "antenna_inspection_display.v1" }), false);
check(antennaInspectionHasCurrent({ ...display, capabilities: { current_density: false } }), false);
check(antennaInspectionHasCurrent({ ...display, device_current: null }), false);
check(antennaInspectionHasCurrent({ ...display, device_current: undefined }), false);

for (const [raw, basis] of [
  ["device_potential", "electric_potential_per_ampere"],
  ["current_density", "current_density_per_ampere"],
  ["magnetic_field", "magnetic_field_per_ampere"],
]) {
  check(antennaVisualizationQuantity(raw, true, true), raw);
  check(antennaVisualizationQuantity(basis, true, true), raw);
  check(antennaVisualizationQuantity(raw, false, true), basis);
  check(antennaVisualizationQuantity(basis, false, true), basis);
  check(antennaVisualizationQuantity(antennaVisualizationQuantity(basis, true, true), false, true), basis);
  check(antennaVisualizationQuantity(antennaVisualizationQuantity(raw, false, true), true, true), raw);
}
check(antennaVisualizationQuantity("current_density", true, false), "magnetic_field");
check(antennaVisualizationQuantity("current_density_per_ampere", true, false), "magnetic_field");
check(antennaVisualizationQuantity("current_density", false, false), "current_density_per_ampere");
check(antennaVisualizationQuantity("device_potential", true, false), "device_potential");
check(antennaVisualizationQuantity("magnetic_field_per_ampere", true, false), "magnetic_field");
console.log(`Antenna visualization quantity: ${count}/${count} passed (interpreted production source).`);
