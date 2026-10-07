import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// Interpret the production formatter before JSX without compiling any test target.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const relativePath = "apps/control-room/src/modules/overlay/mesh-build/MeshBuildParameterDiff.tsx";
const ref = process.argv.indexOf("--git-ref");
const source = ref < 0
  ? readFileSync(resolve(root, "src/modules/overlay/mesh-build/MeshBuildParameterDiff.tsx"), "utf8")
  : execFileSync("git", ["show", `${process.argv[ref + 1]}:${relativePath}`], { cwd: root, encoding: "utf8" });
const pureSource = source.slice(0, source.indexOf("export function MeshBuildParameterDiff("));
assert.ok(pureSource.includes("function formatPolicyValue("), "Production formatter boundary missing");
const context = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(pureSource.replace(/^import type .*;\r?\n/gm, "").replace(/export interface /g, "interface ")), context);
const format = vm.runInContext("formatPolicyValue", context);
const cases = [
  ["size_factor", "0.8", "0.8"],
  ["object.mesh.size_factor", "1", "1"],
  ["size_from_curvature", "16", "16"],
  ["mesh.through_thickness_element_ratio", "1.2", "1.2"],
  ["through_thickness_elements", "1", "1 layer / 2 node planes"],
  ["objects.waveguide.through_thickness_elements", "3", "3 layers / 4 node planes"],
  ["mesh.through_thickness_elements", "0", "0"],
  ["mesh.maximum_element_size", "2e-8", "20.00 nm"],
  ["airbox_hmax", "1e-6", "1.000 um"],
  ["shared_domain.adaptive_h_min", "1e-8", "10.00 nm"],
  ["shared_domain.adaptive_h_max", "1e-6", "1.000 um"],
  ["mesh.corner_extent", "-2e-8", "-20.00 nm"],
  ["mesh.transition_distance", "airbox_boundary", "airbox_boundary"],
  ["mesh.maximum_element_size", "20 nm", "20 nm"],
  ["mesh.maximum_element_size", "2e-8 invalid", "2e-8 invalid"],
  ["mesh.maximum_element_size", "Infinity", "Infinity"],
  ["mesh.maximum_element_size", "NaN", "NaN"],
  ["mesh.maximum_element_size", "   ", "unset"],
  ["mesh.maximum_element_size", "null", "unset"],
  ["unknown_size_hint", "2e-8", "2e-8"],
  ["mesh.maximum_element_growth_rate", "1.3", "1.30x"],
  ["mesh.boundary_layer_stretching", "1.2", "1.20x"],
  ["mesh.algorithm_2d", "6", "Frontal-Delaunay (6)"],
  ["mesh.algorithm_3d", "9", "HXT (9)"],
  ["mesh.algorithm_3d", "9 unknown", "9 unknown"],
];
let failures = 0;
for (const [path, value, expected] of cases) {
  try {
    assert.equal(format(path, value), expected);
    console.log(`PASS ${path}: ${JSON.stringify(value)}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${path}: ${JSON.stringify(value)} — ${error.message}`);
  }
}
assert.equal(failures, 0, `${failures}/${cases.length} production formatter checks failed`);
assert.equal(vm.runInContext('PARAM_LABELS["size_factor"]', context), "Size factor");
assert.ok(source.includes('PARAM_LABELS[row.path.split(".").at(-1) ?? row.path] ?? row.label'), "Nested paths must use existing leaf labels with row-label fallback");
console.log(`Mesh parameter units: ${cases.length} interpreted checks passed; no UI qualification.`);
