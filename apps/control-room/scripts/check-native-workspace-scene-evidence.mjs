import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const scriptsRoot = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(scriptsRoot, "fixtures/native-workspace-restart-page.tsx");
const fixtureSource = await readFile(fixturePath, "utf8");
const helperStart = fixtureSource.indexOf("function summarizeScene(");
const helperEnd = fixtureSource.indexOf("\nasync function projectDocumentProof", helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart,
  "the fixture scene evidence helpers must remain extractable");

const executableHelpers = stripTypeScriptTypes(
  fixtureSource.slice(helperStart, helperEnd),
  { mode: "strip", sourceUrl: "native-workspace-restart-page.tsx#scene-evidence" },
);
const sandbox = {};
vm.runInNewContext(
  `${executableHelpers}\nglobalThis.assertUsefulScene = assertUsefulScene; globalThis.summarizeScene = summarizeScene;`,
  sandbox,
);

const validScene = {
  objects: [{
    id: "new-thin-film-muvx4aa5",
    name: "Thin film",
    geometry: { kind: "box" },
    material_ref: "mat:newthinfilm",
    regions: [{ region_id: "region:newthinfilm:r1", name: "Region 1", shape: { kind: "all" } }],
  }],
  materials: [{ id: "mat:newthinfilm", name: "Thin film material", properties: {} }],
};
const validSummary = sandbox.assertUsefulScene(validScene);
assert.equal(validSummary.objects[0].material_ref, "mat:newthinfilm");

const disconnectedScene = {
  objects: [
    {
      id: "geometry-only",
      name: "Geometry only",
      geometry: { kind: "box" },
      material_ref: null,
      regions: [],
    },
    {
      id: "region-only",
      name: "Unrelated region owner",
      geometry: null,
      material_ref: "mat:permalloy",
      regions: [{ region_id: "region:other", name: "Other", shape: { kind: "all" } }],
    },
  ],
  materials: [{ id: "mat:permalloy", name: "Permalloy", properties: {} }],
};
assert.throws(
  () => sandbox.assertUsefulScene(disconnectedScene),
  /same authored object|same object/i,
  "separate global geometry, region, and material counts must not prove a connected authored model",
);

const unknownMaterialScene = {
  objects: [{
    id: "unknown-material",
    name: "Unknown material reference",
    geometry: { kind: "box" },
    material_ref: "mat:missing",
    regions: [{ region_id: "region:core", name: "Core", shape: { kind: "all" } }],
  }],
  materials: [{ id: "mat:permalloy", name: "Permalloy", properties: {} }],
};
assert.throws(
  () => sandbox.assertUsefulScene(unknownMaterialScene),
  /same authored object|same object/i,
  "a dangling material reference must not satisfy scene evidence",
);

console.log(JSON.stringify({
  schema: "fullmag.control-room.check-result.v1",
  check: "native-workspace-scene-evidence",
  status: "passed",
  cases: [
    "same-object-geometry-region-and-existing-material-passes",
    "disconnected-global-counts-fail",
    "dangling-material-reference-fails",
  ],
}));
