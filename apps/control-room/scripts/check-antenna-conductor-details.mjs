import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
const sourceRoot = new URL("../src/", import.meta.url), modules = new Map();
function moduleAt(url) {
  if (!modules.has(url.href)) modules.set(url.href, new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(url, "utf8")), { identifier: url.href }));
  return modules.get(url.href);
}
const readoutModule = moduleAt(new URL("../src/modules/inspector/panels/antenna/AntennaReadoutModel.ts", import.meta.url));
await readoutModule.link((name, referrer) => moduleAt(name.startsWith("@/") ? new URL(`${name.slice(2)}.ts`, sourceRoot) : new URL(`${name}.ts`, referrer.identifier)));
await readoutModule.evaluate();
const { formatAntennaParameter } = readoutModule.namespace;


// Interpret the actual pure production functions; do not compile test sources or JSX.
const source = readFileSync(new URL("../src/modules/inspector/panels/antenna/AntennaCompositionPanels.tsx", import.meta.url), "utf8");
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Production section missing: ${start}`);
  return source.slice(first, last);
}
const code = section("function recordValue(", "function executionValue(")
  + section("function conductorDetails(", "export function AntennaConductorDetails(");
const details = new Function("numberValue", `${stripTypeScriptTypes(code)}; return conductorDetails;`)(formatAntennaParameter);
const object = { id: "source", name: "Renamed antenna", geometry: { geometry_kind: "MicrostripAntennaLayout", geometry_params: {
  conductivity_s_per_m: 5.8e7, conductors: [{ id: "signal" }, { id: "return" }],
  loop: { enabled: true, inlet_connection_part_id: "inlet", outlet_connection_part_id: "outlet" },
} } };
const current = { name: "charge", model: "ohmic_poisson", domain: [{ object_id: "source" }], materials: [
  { region: { object_id: "source", region_id: "signal" }, material: { sigma_Spm: 3.2e7 } },
  { region: { object_id: "source", region_id: "return" }, material: { sigma_Spm: 4.1e7 } },
  { region: { object_id: "foreign", region_id: "foreign" }, material: { sigma_Spm: 9e9 } },
] };
let checks = 0;
function check(name, run) { run(); checks++; console.log(`PASS ${name}`); }
const scene = { objects: [object], current_transports: [current] };
const rows = (model) => Object.fromEntries(model.rows.map(row => [row.label, row.value]));
check("layout conductivity is distinct from explicit per-part charge materials", () => {
  const model = details("source", scene), values = rows(model);
  assert.equal(values["Layout conductivity"], "58 MS/m");
  assert.equal(values["Charge conductivity · charge · signal"], "32 MS/m");
  assert.equal(values["Charge conductivity · charge · return"], "41 MS/m");
  assert.equal(model.rows.some(row => row.label.includes("foreign")), false);
  assert.equal(values["Part IDs"], "signal · return · inlet · outlet");
  assert.equal(values["Length"], undefined);
});
check("missing current module does not infer charge material from geometry", () => {
  const model = details("source", { objects: [object] });
  assert.equal(model.badge, "no current transport");
  assert.match(rows(model)["Charge transport"], /No explicit current module/);
  assert.equal(model.rows.some(row => row.label.startsWith("Charge conductivity")), false);
});
check("module without material assignment is explicit and does not fall back", () => {
  const model = details("source", { objects: [object], current_transports: [{ ...current, materials: [] }] });
  assert.match(rows(model)["Charge materials · charge"], /No explicit charge-material assignment/);
  assert.equal(model.rows.some(row => row.label.startsWith("Charge conductivity")), false);
});
check("renaming an object cannot change current-module membership", () => {
  const renamed = { ...scene, objects: [{ ...object, name: "Another label" }] };
  assert.deepEqual(details("source", scene).rows.filter(row => row.label !== "Name"), details("source", renamed).rows.filter(row => row.label !== "Name"));
  const model = details("source", { ...scene, current_transports: [{ ...current, domain: [{ object_id: object.name }] }] });
  assert.equal(model.badge, "no current transport");
});
check("missing object cannot report default mesh or resolved conductivity", () => {
  const values = rows(details("missing", scene));
  assert.equal(values["Authored mesh policy"], "unavailable");
  assert.equal(values["Layout conductivity"], "unavailable S/m");
});
check("summary is pure and never mutates authored resources", () => {
  const before = JSON.stringify(scene); details("source", scene); assert.equal(JSON.stringify(scene), before);
});
console.log(JSON.stringify({ checks, state: "passed", scope: "interpreted production summary; no browser/backend/solve qualification" }));
