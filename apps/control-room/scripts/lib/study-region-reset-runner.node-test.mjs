import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { regionResetExpectedComputePrecondition, regionResetWriteAllowed, regionResetCommandBindingMatches, regionResetValidateImportAck, regionResetAssertExecutionIdentity, regionResetValidateSync, regionResetGridIsReady, regionResetPinnedWorkspaceUrl, regionResetValidateImportedSource } from "../check-study-region-reset-browser.mjs";

const session = { session_id: "owned", session_epoch: "owned@1", request_scope_epoch: "api:1" };
const scope = "session=owned&epoch=owned%401&request_scope_epoch=api%3A1";
function gate(phase) {
  return { phase, apiInstance: "api", session, sourceName: "fixture.py", sourceText: "import fullmag\n",
    importAttempts: 0, createAttempts: 0, replaceAttempts: 0, editAttempts: 0, syncAttempts: 0,
    solverAttempts: 0, gridAttempts: 0, sceneRevision: 41 };
}
function request(path, body) {
  return { method: "POST", path, body, headers: { "x-fullmag-api-instance": "api", "x-fullmag-session-scope": scope } };
}
const transactionPath = "/v2/sessions/current/model/transactions";
const commandsPath = "/v2/sessions/current/simulation/commands";
function precondition() {
  return { scene_revision: 41, mesh_revision: 2, domain_generation_id: "domain",
    region_topology_revision: 1, region_membership_revision: 2, region_coefficients_revision: 3,
    region_initial_state_revision: 4, current_run: { kind: "run", run_id: "previous" },
    runtime_state: "awaiting_command", command_revision: 7 };
}
test("fixed script import admits exactly the reviewed bytes with consent once", () => {
  const g = gate("import");
  const r = request("/v2/persistence/projects/from-script", { source: { name: "fixture.py", text: g.sourceText },
    project_name: "fixture", origin: "python:fixture.py", consent: { executed_by_user: true } });
  assert.equal(regionResetWriteAllowed(r, g), true);
  for (const mutate of [
    (q) => { q.body.source.text += "changed"; },
    (q) => { q.body.consent.executed_by_user = false; },
    (q) => { q.headers["x-fullmag-api-instance"] = "foreign"; },
    (q) => { q.body.other = true; },
  ]) {
    const bad = structuredClone(r); mutate(bad); assert.equal(regionResetWriteAllowed(bad, g), false);
  }
  g.importAttempts = 1; assert.equal(regionResetWriteAllowed(r,g),false);
});
test("session activation never permits replacement and binds selected storage defaults", () => {
  const g = gate("import");
  g.project = { name: "fixture", scene_document: { study: {} } };
  g.storageDefaults = { output_parent: "/results", temp_parent: "/scratch",
    supported_formats: ["zarr"], data_format: "zarr", cleanup: "on_success", existing_output: "timestamp" };
  const r = request("/v2/sessions", { name: "fixture", backend: "fdm", device: "cpu", precision: "double",
    replace_current: false, output_storage: { output_dir: "/results/fixture_123/results.zarr",
      temp_dir: "/scratch", data_format: "zarr", cleanup: "on_success", existing_output: "timestamp" } });
  assert.equal(regionResetWriteAllowed(r,g),true);
  for (const mutate of [
    (q) => { q.body.replace_current = true; },
    (q) => { q.body.device = "gpu"; },
    (q) => { q.body.output_storage.output_dir = "/results/../foreign"; },
    (q) => { q.body.output_storage.temp_dir = "/foreign"; },
    (q) => { q.body.output_storage.cleanup = "always"; },
  ]) {
    const bad = structuredClone(r); mutate(bad); assert.equal(regionResetWriteAllowed(bad,g),false);
  }
});
test("regional save requires exact predicted transaction, session and phase", () => {
  const g=gate("region-reset");
  g.expectedEdit = { kind:"merge_patch",base_revision:41,merge_patch:{study:{scoped:"left-half"}} };
  const r=request(transactionPath, structuredClone(g.expectedEdit));
  assert.equal(regionResetWriteAllowed(r,g),true);
  const bad=structuredClone(r);bad.body.merge_patch.study.scoped="whole-object";
  assert.equal(regionResetWriteAllowed(bad,g),false);
  g.editAttempts=1;assert.equal(regionResetWriteAllowed(r,g),false);
  g.editAttempts=0;g.phase="observe";assert.equal(regionResetWriteAllowed(r,g),false);
});
test("B-only dispatch cannot change target, source, revision or repeat an intent", () => {
  const g=gate("stage-b");g.expectedComputePrecondition=precondition();
  const r=request(commandsPath,{kind:"relax",target:{kind:"stage_id",stage_id:"relax-b"},
    initial_state:{kind:"default_for_target"},precondition:precondition(),client_intent_id:"study:relax:fixed",
    reason:"user_requested",requested_at_unix_ms:12345});
  assert.equal(regionResetWriteAllowed(r,g),true);
  for(const mutate of [
    q=>{q.body.target.stage_id="relax-c";},q=>{q.body.initial_state={kind:"authored_initial_state"};},
    q=>{q.body.precondition.scene_revision=40;},q=>{q.body.kind="solve";},
    q=>{delete q.headers["x-fullmag-session-scope"];},
  ]) { const bad=structuredClone(r);mutate(bad);assert.equal(regionResetWriteAllowed(bad,g),false); }
  g.solverAttempts=1;assert.equal(regionResetWriteAllowed(r,g),false);
});
test("Build plus Study permits only one exact revision-fenced grid request", () => {
  const g=gate("build-study");g.expectedGridPrecondition={scene_revision:41,mesh_revision:2,current_run:{kind:"none"}};
  const r=request(commandsPath,{kind:"fdm_grid_refresh",precondition:structuredClone(g.expectedGridPrecondition),
    reason:"explicit_build_grid",client_intent_id:"mesh-confirm-123-1"});
  assert.equal(regionResetWriteAllowed(r,g),true);
  const bad=structuredClone(r);bad.body.precondition.scene_revision=42;
  assert.equal(regionResetWriteAllowed(bad,g),false);
  g.gridAttempts=1;assert.equal(regionResetWriteAllowed(r,g),false);
});
test("canonical copy uses the acknowledged revision once", () => {
  const g=gate("export"),r=request("/v2/sessions/current/model/syncs",{expected_scene_revision:41});
  assert.equal(regionResetWriteAllowed(r,g),true);
  r.body.expected_scene_revision=40;assert.equal(regionResetWriteAllowed(r,g),false);
  r.body.expected_scene_revision=41;g.syncAttempts=1;assert.equal(regionResetWriteAllowed(r,g),false);
});
test("compute precondition covers absence of a run and all current revisions", () => {
  const resources={scene_revision:41,mesh_revision:2,region_topology_revision:1,region_membership_revision:2,
    region_coefficients_revision:3,region_initial_state_revision:4};
  const actual=regionResetExpectedComputePrecondition({resources},{runtime_state:"awaiting_command"},{commands:[]});
  assert.deepEqual(actual.current_run,{kind:"none"});
  assert.equal(actual.scene_revision,41);
  assert.equal(actual.command_revision,0);
  assert.throws(()=>regionResetExpectedComputePrecondition({resources:{...resources,mesh_revision:undefined}},
    {runtime_state:"awaiting_command"},{commands:[]}),/Missing revision/);
});

test("terminal run evidence must belong to the acknowledged command target and a new run", () => {
  const target={kind:"stage_id",stage_id:"relax-b"};
  const binding={run_id:"new",requested_target:target,step_id:"relax-b"};
  assert.equal(regionResetCommandBindingMatches(binding,target,"new","old"),true);
  assert.equal(regionResetCommandBindingMatches(binding,target,"new","new"),false);
  assert.equal(regionResetCommandBindingMatches({...binding,run_id:"foreign"},target,"new","old"),false);
  assert.equal(regionResetCommandBindingMatches({...binding,step_id:"relax-c"},target,"new","old"),false);
  assert.equal(regionResetCommandBindingMatches({...binding,requested_target:{kind:"study"}},target,"new","old"),false);
});

test("Study solve cannot pass before acknowledged and completed grid preparation", () => {
  const g=gate("build-study");g.expectedComputePrecondition=precondition();
  const r=request(commandsPath,{kind:"solve",target:{kind:"study"},precondition:precondition(),
    client_intent_id:"study:solve:fixed",reason:"user_requested",requested_at_unix_ms:12345});
  assert.equal(regionResetWriteAllowed(r,g),false);
  g.gridAcknowledged=true;assert.equal(regionResetWriteAllowed(r,g),false);
  g.gridReady=true;assert.equal(regionResetWriteAllowed(r,g),true);
});
test("import acknowledgement must preserve the full authored scene and revision", () => {
  const expected={base_revision:0,scene:{version:"scene.v2",revision:7,objects:[{id:"film",alpha:0.5}],study:{keep:true}}};
  const ack={transaction_kind:"replace_scene",scene_revision:1,
    committed_scene:{...structuredClone(expected.scene),revision:1}};
  assert.deepEqual(regionResetValidateImportAck(ack,expected),ack.committed_scene);
  const changed=structuredClone(ack);changed.committed_scene.objects[0].alpha=0.1;
  assert.throws(()=>regionResetValidateImportAck(changed,expected),/authored data/);
  assert.throws(()=>regionResetValidateImportAck({...ack,scene_revision:2},expected),/revision/);
});
test("stage execution must retain session epoch and request scope, not only run ID", () => {
  const execution={run_id:"new",...session};
  regionResetAssertExecutionIdentity(execution,session,"new");
  for(const key of ["session_epoch","request_scope_epoch","session_id"]) {
    assert.throws(()=>regionResetAssertExecutionIdentity({...execution,[key]:"foreign"},session,"new"),/Stage execution/);
  }
});
test("canonical source acknowledgement must pin the exact exported revision", () => {
  regionResetValidateSync({source:"source",scene_revision:41},"source",41);
  assert.throws(()=>regionResetValidateSync({source:"source",scene_revision:40},"source",41),/revision/);
  assert.throws(()=>regionResetValidateSync({source:"foreign",scene_revision:41},"source",41),/Downloaded source/);
});

test("grid readiness binds the completed command, held run, preparation and domain", () => {
  const x={
    session,sceneRevision:41,gridCommandId:"grid-1",
    status:{resources:{scene_revision:41,commands_revision:2,domain_generation_id:"domain",
      simulation_preparation_revision:3},domain:{discretization:"fdm",cell_count:8,generation_id:"domain"},
      run:{run_id:"held"},solver:{state:"awaiting_command"}},
    queue:{pending_count:0,running_count:0,revision:2,
      commands:[{command_id:"grid-1",kind:"fdm_grid_refresh",status:"completed"}]},
    solver:{runtime_state:"awaiting_command"},
    execution:{run_id:"held",...session,runtime_state:"awaiting_command",
      stage_statuses:["pending","pending","pending"],completed_stage_indexes:[]},
    run:{run_id:"held",session_id:session.session_id,status:"waiting_for_solve"},
    preparation:{status:"ready",revision:3,preparation_id:"prep-1",
      receipt:{schema_version:"preparation_receipt.v1",preparation_id:"prep-1",run_id:"held",
        plan_fingerprint:"sha256:"+"1".repeat(64),payload_sha256:"2".repeat(64)}},
  };
  assert.equal(regionResetGridIsReady(x),true);
  for(const mutate of [
    q=>{q.queue.commands[0].status="failed";},q=>{q.queue.commands[0].command_id="foreign";},
    q=>{q.preparation.receipt.run_id="foreign";},q=>{q.execution.session_epoch="foreign";},
    q=>{q.status.resources.scene_revision=40;},
  ]) {const bad=structuredClone(x);mutate(bad);assert.throws(()=>regionResetGridIsReady(bad));}
});

test("workspace bootstrap uses the product API-incarnation pin before any mutation", () => {
  const api="12345678-1234-4321-8765-123456789abc";
  assert.equal(regionResetPinnedWorkspaceUrl("http://127.0.0.1:3243",api),
    "http://127.0.0.1:3243/workspace?fullmag_api_instance="+api);
  assert.throws(()=>regionResetPinnedWorkspaceUrl("http://127.0.0.1:3243","foreign"),/API incarnation/);
});

test("import evidence checks stored bytes and verified scene fidelity before activation", () => {
  const text="import fullmag as fm\\n";
  const payload={project_id:"p",scene_document:{version:"scene.v2"},
    script_import:{name:"fixture.py",origin:"python:fixture.py",
      sha256:createHash("sha256").update(text).digest("hex"),
      fidelity:{scene_exported:true,round_trip:"verified"}}};
  regionResetValidateImportedSource(payload,"fixture.py",text);
  for(const mutate of [
    q=>{q.script_import.sha256="0".repeat(64);},q=>{q.script_import.name="foreign.py";},
    q=>{q.script_import.fidelity.round_trip="not_checked";},q=>{q.script_import.fidelity.round_trip="failed";},
  ]) {const bad=structuredClone(payload);mutate(bad);assert.throws(()=>regionResetValidateImportedSource(bad,"fixture.py",text));}
});

test("auxiliary renderer writes stay scoped and bounded; failed renderer ACK never passes", () => {
  const g=gate("observe"),r=request("/v2/sessions/current/visualization/client-acks",
    {client_id:"renderer",revision:1,status:"rendered"});
  assert.equal(regionResetWriteAllowed(r,g),true);
  const bad=structuredClone(r);bad.body.status="failed";assert.equal(regionResetWriteAllowed(bad,g),false);
  g.clientAckAttempts=16;assert.equal(regionResetWriteAllowed(r,g),false);
  g.clientAckAttempts=0;r.body.extra="not permitted";assert.equal(regionResetWriteAllowed(r,g),false);
});
