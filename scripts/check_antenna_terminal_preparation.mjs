// Interpreted source-contract check: Node's built-in type stripping, no unit-test build.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";

const root = resolve(import.meta.dirname, "..");
const model = await import(pathToFileURL(resolve(root, "apps/control-room/src/modules/inspector/panels/antenna/AntennaTerminalPreparationModel.ts")));
const readiness = await import(pathToFileURL(resolve(root, "apps/control-room/src/shared/domain/physics/antennaStageValidation.ts")));
let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; }
const scene = {
  revision: 7, scene: { id: "session" },
  objects: [{ id: "antenna", locked: false, geometry: { geometry_kind: "MicrostripAntennaLayout", geometry_params: { conductors: [{ id: "signal" }, { id: "return" }] } }, transform: { rotation: [0, 0, 0] } }],
  current_transports: [{ name: "charge", kind: "current_transport", model: "ohmic_poisson", coupling: "one_way", domain: [{ object_id: "antenna" }],
    boundaries: [{ id: "legacy" }], gauge: "terminal_reference", solver: { engine: "cg", operator_version: "fem_charge_conforming_h1_p1.transparent.v1" } }],
  antenna_port_modes: [{ id: "port", source_object_id: "antenna", current_transport_id: "charge", normalization_current_a: 1, branches: [
    { id: "signal", inlet_terminal_ref: "signal_in", outlet_terminal_ref: "signal_out", signed_weight: 1 },
    { id: "return", inlet_terminal_ref: "return_in", outlet_terminal_ref: "return_out", signed_weight: -1 },
  ] }],
  antenna_field_solve_stages: [{ id: "solve", source_object_id: "antenna", current_transport_id: "charge", port_mode_ids: ["port"], conservative_current_view_ref: "phantom", target_refs: [{ kind: "global" }], outputs: [{ quantity: "H_ant_basis" }] }],
};
const pristine = JSON.stringify(scene);
const draft = model.createAntennaTerminalPreparationDraft(scene, "antenna", "port", "owner");
check(draft.rows.every((row) => row.currentA === "" && row.direction.every((value) => value === "")), "No inferred actuation or transformed orientation");
check(model.antennaTerminalPreparationErrors(scene, "antenna", draft).length > 0, "Incomplete form rejected");
check(await model.antennaTerminalBoundaryMarker("antenna", "signal", "local_u_min") === 117762299, "Pinned Python/Rust marker identity");
Object.assign(draft, { revision: "explicit-r1", dirty: true });
const authored = [-0.2, 0.2, 0.7, -0.7];
draft.rows.forEach((row, index) => Object.assign(row, { lengthM: "1e-6", conductivitySpm: "5.8e7", direction: [index % 2 ? "1" : "-1", "0", "0"], currentA: String(authored[index]) }));
check(model.antennaTerminalPreparationErrors(scene, "antenna", draft).length === 0, "Explicit bounded preparation accepted structurally");
const explicitZero = structuredClone(draft); explicitZero.rows.forEach((row) => { row.currentA = "0"; });
check(model.antennaTerminalPreparationErrors(scene, "antenna", explicitZero).length === 0, "Explicit zero controls remain valid authoring, not qualified basis");
const request = await model.buildAntennaTerminalPreparationTransaction(scene, "antenna", draft);
const transport = request.merge_patch.current_transports[0];
const stage = request.merge_patch.antenna_field_solve_stages[0];
check(transport.boundaries.length === 0 && transport.conservative_current_view === null && stage.conservative_current_view_ref === null, "Legacy conflicts removed only in transaction");
check(!("objects" in request.merge_patch) && !("antenna_port_modes" in request.merge_patch), "Geometry and port physics preserved");
check(JSON.stringify(Object.values(transport.external_lead_preparation.drives[0].outer_terminal_currents_a)) === JSON.stringify(authored), "Actuation not derived from branch weights");
check(new Set(transport.external_lead_preparation.extensions.map((item) => item.boundary_markers[0])).size === 4, "Disjoint semantic cap markers");
check(transport.external_lead_preparation.extensions.map((item) => item.observation_id).join() === "signal_in,signal_out,return_in,return_out", "Actuators remain distinct from observations");
check(JSON.stringify(scene) === pristine, "Input snapshot unchanged");
const committed = { ...scene, revision: 8, current_transports: [transport], antenna_field_solve_stages: [stage] };
const reopened = model.createAntennaTerminalPreparationDraft(committed, "antenna", "port", "owner");
check(reopened.rows.map((row) => row.currentA).join() === authored.map(String).join(), "Existing controls reopen without inference");
const foreignCap = structuredClone(reopened); foreignCap.rows[0].loadedBoundaryMarkers = [123];
await assert.rejects(model.buildAntennaTerminalPreparationTransaction(committed, "antenna", foreignCap), /surface rebinding/); checks++;
check(model.antennaPreparationIdentity({ b: 1, a: { d: 2, c: 3 } }) === model.antennaPreparationIdentity({ a: { c: 3, d: 2 }, b: 1 }), "Order-independent ACK identity");
check(readiness.antennaStageValidationMessages(stage, committed).some((reason) => reason.includes("inspection-only")), "Qualified basis remains blocked");
check(!readiness.antennaInspectionValidationMessages(stage, committed).some((reason) => reason.includes("legacy")), "Inspection has distinct readiness");
const geometryChanged = structuredClone(scene); geometryChanged.objects[0].transform.rotation[0] = 1;
check(model.antennaTerminalPreparationErrors(geometryChanged, "antenna", draft)[0].includes("Geometry changed"), "Changed geometry invalidates draft cap binding");
check(model.antennaTerminalPreparationErrors({ ...scene, revision: 9 }, "antenna", draft)[0].includes("Scene changed"), "Stale scene rejected");
const edited = { ...draft, revision: "edit-during-ACK" };
const ack = model.acknowledgeAntennaTerminalPreparationDraft(edited, draft, 8);
check(ack.dirty && ack.revision === "edit-during-ACK", "ACK preserves new edits");
check(!model.acknowledgeAntennaTerminalPreparationDraft(draft, draft, 8).dirty, "Exact submitted ACK clears dirty state");
const duplicate = structuredClone(draft); duplicate.rows[1].actuatorId = duplicate.rows[0].actuatorId;
check(model.antennaTerminalPreparationErrors(scene, "antenna", duplicate)[0].includes("distinct"), "Overlapping actuator identity rejected");
const badNormal = structuredClone(draft); badNormal.rows[0].direction = ["2", "0", "0"];
check(model.antennaTerminalPreparationErrors(scene, "antenna", badNormal)[0].includes("unit vector"), "Invalid orientation rejected");
assert.throws(() => model.createAntennaTerminalPreparationDraft({ ...scene, current_transports: [{ ...scene.current_transports[0], conservative_current_source: { kind: "expert" } }] }, "antenna", "port", "owner")); checks++;
const shared = { ...scene, antenna_field_solve_stages: [...scene.antenna_field_solve_stages, { ...stage, id: "foreign", source_object_id: "other" }] };
await assert.rejects(model.buildAntennaTerminalPreparationTransaction(shared, "antenna", draft), /shared/); checks++;
const report = { status: "passed", checks, scope: "interpreted frontend source contracts; no production/browser/runtime qualification", node: process.version };
if (process.argv[2]) await writeFile(resolve(process.argv[2]), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
