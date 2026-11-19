import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript"), React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const root = fileURLToPath(new URL("../src/", import.meta.url));
const cache = new Map();
function synthetic(key, values) {
  if (!cache.has(key)) cache.set(key, new vm.SyntheticModule(Object.keys(values), function () {
    for (const [name, value] of Object.entries(values)) this.setExport(name, value);
  }));
  return cache.get(key);
}
let selectedStatus = null, selectedStages = null;
const calls = [];
const noResource = () => ({ data: null, status: "idle" });
const trackedResource = name => options => {
  calls.push({ name, options });
  return name === "useStageExecutionResource" ? { data: selectedStages, status: "ready" } : noResource();
};
const stubs = new Map([
  ["@/kernel/resources/geometryLifecycleResources", { useSceneResource: noResource }],
  ["@/kernel/resources/studyRuntimeResources", Object.fromEntries([
    "useCurrentRunResource", "useFrequencyDomainResponseProgressResource", "useFrequencyDomainResponseSweepResource",
    "useObjectMetricsResource", "useScalarWindowResource", "useSolverStatusResource", "useStageExecutionResource",
  ].map(name => [name, trackedResource(name)]))],
  ["@/kernel/resources/useSessionStatus", { useSessionStatusSelector: () => selectedStatus }],
  ["@/kernel/selection/useSelection", { useSelectionSelector: () => null }],
  ["@/kernel/runtime/useAwaitingComputeCommand", { useAwaitingComputeCommand: () => ({ disabledReason: null, pending: false, run() {} }) }],
  ["@/shared/ui/Button", { Button: props => React.createElement("button", null, props.children) }],
]);
async function moduleAt(file) {
  if (cache.has(file)) return cache.get(file);
  const code = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const mod = new vm.SourceTextModule(code, { identifier: file }); cache.set(file, mod);
  await mod.link(async spec => {
    if (stubs.has(spec)) return synthetic(spec, stubs.get(spec));
    if (!spec.startsWith(".") && !spec.startsWith("@/")) return synthetic(spec, require(spec));
    const base = spec.startsWith("@/") ? path.join(root, spec.slice(2)) : path.resolve(path.dirname(file), spec);
    const target = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")].find(existsSync);
    assert.ok(target, `Unresolved ${spec}`); return moduleAt(target);
  });
  return mod;
}
// The optional stdin is the preserved actual HTTP observation, never a new request.
const fixture = process.argv.includes("--fixture-stdin") ? JSON.parse(readFileSync(0, "utf8")) : {
  status: {
    session: { session_id: "session", session_epoch: "session@1", request_scope_epoch: "scope:1" },
    run: { run_id: "run", solver_steps: 0, solver_time: 0, started_at: "1793044967691", requested_device: "cpu", resolved_device: "cpu", selection_reason: "explicit_device_request" },
    solver: { state: "running", dt: null, converged: false }, energies: null,
    metrics: { total_steps: 0, steps_per_second: null }, resources: { scalars_revision: 0 },
  },
  stages_execution: {
    session_id: "session", session_epoch: "session@1", request_scope_epoch: "scope:1", run_id: "run",
    revision: 4, runtime_state: "running", total_stages: 1, completed_stage_indexes: [], stage_statuses: ["running"], active_stage_index: 0,
    stages: [{ stage_id: "authored-step", antenna_solve_stage_id: "inspect_loop", index: 0, label: "Stage 1", status: "running", converged: false }],
  },
};
const file = path.join(root, "modules/footer/FooterTelemetry.tsx");
const mod = await moduleAt(file); await mod.evaluate();
const { buildFooterTelemetryModel: build, selectFooterTelemetryStatus: select, footerTelemetryStatusEquals: equal } = mod.namespace;
const status = select({ status: "ready", data: fixture.status });
const stages = fixture.stages_execution;
const model = (stageResource = stages, selectedStatus = status, nowMs = null) =>
  build(selectedStatus, null, null, null, stageResource, null, null, null, { magneticModelPresent: false, nowMs });
const renderFooter = (view = "antenna") => renderToStaticMarkup(React.createElement(
  mod.namespace.FooterTelemetry, {
    bus: { subscribe: () => () => {} }, status: selectedStatus,
    stageExecution: { data: selectedStages, status: "ready" }, view,
  },
));
const first = model();
assert.deepEqual(first.metrics.map(metric => metric.label), ["Solve state", "Phase", "Field samples", "Source cells", "Stage elapsed", "Publication"],
  "An explicit nonmagnetic antenna solve must replace LLG time/STEP/rate/dt/M/energy counters");
assert.equal(first.metrics.find(metric => metric.label === "Solve state").value, "Running");
assert.equal(first.metrics.find(metric => metric.label === "Stage elapsed").value, "Not reported");
assert.equal(first.metrics.find(metric => metric.label === "Field samples").value, "Progress not reported");
assert.equal(first.metrics.find(metric => metric.label === "Publication").value, "Awaiting result");
assert.match(first.statusTitle, /Antenna solve/);
console.log("PASS actual retained running antenna projection has honest status and no LLG zero counters");

const value = (result, label) => result.metrics.find(metric => metric.label === label)?.value;
const missing = build(null, null, null, {
  sessionId: "previous-session", runId: "previous-run", revision: 99,
  row: { step: 42, time: 2, mx: 1, my: 0, mz: 0 },
}, stages);
assert.deepEqual(missing.metrics, [], "Absent session telemetry must not publish zero or stale LLG counters");
assert.equal(missing.statusTitle, "System Status: No live telemetry");
assert.equal(missing.awaitingCompute, false);
selectedStatus = null; selectedStages = stages; calls.length = 0;
const missingMarkup = renderFooter("overview");
assert.ok(missingMarkup.includes("No live telemetry"));
assert.ok(!missingMarkup.includes(">Step<") && !missingMarkup.includes("Sim time"));
for (const name of ["useScalarWindowResource", "useFrequencyDomainResponseProgressResource", "useFrequencyDomainResponseSweepResource", "useSolverStatusResource"]) {
  assert.equal(calls.find(call => call.name === name).options.enabled, false, name);
}
console.log("PASS absent telemetry rejects stale samples and renders no fabricated zero counters");
for (const state of ["pending", "running", "completed", "failed", "cancelled"]) {
  const record = { ...stages.stages[0], status: state, state_transition_reason: state === "failed" ? "Native solve time limit" : null };
  const resource = { ...stages, runtime_state: state, active_stage_index: state === "running" ? 0 : null, stages: [record] };
  const result = model(resource);
  assert.equal(value(result, "Solve state"), state.charAt(0).toUpperCase() + state.slice(1));
  assert.equal(value(result, "Stage elapsed"), "Not reported");
  assert.equal(value(result, "Field samples"), "Progress not reported");
  if (state === "completed") assert.equal(value(result, "Publication"), "Check saved results", "Completion must not assert verified result availability");
  if (state === "failed") assert.match(result.metrics[0].detail, /Native solve time limit/);
}
console.log("PASS lifecycle states and terminal single-stage records preserve honest result/reason semantics");
for (const key of ["session_id", "session_epoch", "request_scope_epoch", "run_id"]) {
  assert.ok(!model({ ...stages, [key]: "foreign" }).statusTitle.includes("Antenna solve"), key);
}
for (const key of ["sessionId", "sessionEpoch", "requestScopeEpoch"]) {
  const foreign = { ...status, [key]: "foreign" };
  assert.equal(equal(status, foreign), false, `${key} must invalidate the selected status`);
  assert.ok(!model(stages, foreign).statusTitle.includes("Antenna solve"));
}
for (const patch of [
  { antenna_solve_stage_id: undefined, label: "antenna closed_loop_inspection", kind: "antenna_field_solve" },
  { antenna_solve_stage_id: " " }, { index: 1 }, { stage_id: "" }, { status: "unknown" },
]) assert.ok(!model({ ...stages, stages: [{ ...stages.stages[0], ...patch }] }).statusTitle.includes("Antenna solve"));
assert.ok(!model({ ...stages, active_stage_index: null, stages: [stages.stages[0], { ...stages.stages[0], index: 1 }] }).statusTitle.includes("Antenna solve"));
assert.ok(!model({ ...stages, active_stage_index: -1 }).statusTitle.includes("Antenna solve"));
assert.ok(!model({ ...stages, active_stage_index: 0.5 }).statusTitle.includes("Antenna solve"));
assert.ok(!model(stages, null).statusTitle.includes("Antenna solve"));
console.log("PASS exact session/run/epoch/scope and explicit authored solve identity reject stale or inferred physics");
const timed = (state, start, end, percent) => ({ ...stages, runtime_state: state,
  stages: [{ ...stages.stages[0], status: state, started_at_unix_ms: start, completed_at_unix_ms: end, progress_percent: percent }] });
assert.equal(value(model(timed("running", 1_000, null, 0), status, 4_000), "Stage elapsed"), "3.000 s");
assert.equal(value(model(timed("running", 1_000, null, 0), status, 4_000), "Field samples"), "Progress not reported");
assert.equal(value(model(timed("completed", 1_000, 6_000, 100), status, 90_000), "Stage elapsed"), "5.000 s");
for (const invalid of [null, undefined, -1, 0, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  assert.equal(value(model(timed("running", invalid, null, 17), status, 90_000), "Stage elapsed"), "Not reported");
}
for (const invalid of [null, undefined, -1, 101, NaN, Infinity]) {
  assert.equal(value(model(timed("running", 1_000, null, invalid), status, 90_000), "Field samples"), "Progress not reported");
}
assert.equal(value(model(timed("running", 10_000, null, 17), status, 1_000), "Stage elapsed"), "Not reported");
console.log("PASS only published finite stage times drive elapsed; legacy percentages never become field counts");
const llg = build(status, null, { runtime_state: "running", stage_kind: "relaxation", step_index: 42, sim_time_seconds: 2, dt_seconds: 1e-12 }, null, null, null, null, null, { magneticModelPresent: true });
assert.equal(value(llg, "Step"), "42");
assert.ok(llg.metrics.some(metric => metric.label === "Sim time"));
assert.ok(llg.metrics.some(metric => metric.id === "avg-m"));
assert.ok(llg.metrics.some(metric => metric.id === "energy-total"));
console.log("PASS magnetic LLG telemetry remains unchanged");
selectedStatus = status; selectedStages = stages; calls.length = 0;
const markup = renderFooter();
assert.ok(markup.includes("Antenna solve"));
assert.ok(markup.includes("Not reported"));
assert.ok(!markup.includes(">Step<") && !markup.includes("Sim time") && !markup.includes("Average magnetization"));
for (const name of ["useScalarWindowResource", "useFrequencyDomainResponseProgressResource", "useFrequencyDomainResponseSweepResource"]) {
  assert.equal(calls.filter(call => call.name === name).length, 1);
  assert.equal(calls.find(call => call.name === name).options.enabled, false, name);
}
assert.equal(calls.find(call => call.name === "useObjectMetricsResource").options, null);
assert.equal(calls.filter(call => call.name === "useStageExecutionResource").length, 0, "FooterModule exclusively owns the stage resource");
assert.equal(calls.filter(call => call.name === "useSolverStatusResource").length, 1);
selectedStages = { ...stages, request_scope_epoch: "other" }; calls.length = 0;
renderFooter();
for (const name of ["useScalarWindowResource", "useFrequencyDomainResponseProgressResource", "useFrequencyDomainResponseSweepResource"]) {
  assert.equal(calls.find(call => call.name === name).options.enabled, false, name);
}
assert.match(renderFooter(), /No antenna stage in the current execution/);
console.log("PASS real footer SSR consumes the parent stage snapshot and rejects stale antenna data without LLG requests");
const numericalProgress = {
  phase: "evaluating_field", completed_targets: 1_000, total_targets: 2_000,
  source_cells: 1_856, elapsed_seconds: 61,
};
const withProgress = (progress, state = "running") => ({
  ...stages, runtime_state: state,
  stages: [{ ...stages.stages[0], status: state, antenna_progress: progress }],
});
selectedStatus = status;
selectedStages = withProgress(numericalProgress);
const half = model(selectedStages);
assert.equal(half.antennaProgress.percent, 50);
assert.equal(value(half, "Field samples"), "1,000 / 2,000");
assert.equal(value(half, "Source cells"), "1,856");
assert.equal(value(half, "Operation elapsed"), "1m 01.000s");
const journalBeforeOperation = withProgress(numericalProgress);
journalBeforeOperation.stages[0].started_at_unix_ms = 1_000;
assert.equal(value(model(journalBeforeOperation, status, 121_000), "Operation elapsed"), "1m 01.000s");
journalBeforeOperation.stages[0].antenna_progress = undefined;
assert.equal(value(model(journalBeforeOperation, status, 121_000), "Stage elapsed"), "2m 00.000s");
const halfMarkup = renderFooter();
assert.match(halfMarkup, /role="progressbar"/);
assert.match(halfMarkup, /aria-valuenow="50"/);
assert.match(halfMarkup, /aria-label="Antenna field sampling"/);
assert.match(halfMarkup, /Estimating field time/);
assert.ok(!halfMarkup.includes("Estimated field time left"), "SSR has no observed field-completion window");
for (const progress of [
  null, { ...numericalProgress, phase: "future_phase" },
  ...["completed_targets", "total_targets", "source_cells", "elapsed_seconds"].flatMap(key =>
    [-1, NaN, Infinity].map(invalid => ({ ...numericalProgress, [key]: invalid }))),
  { ...numericalProgress, total_targets: 0 },
  { ...numericalProgress, source_cells: 0 },
  { ...numericalProgress, phase: "preparing_source" },
  { ...numericalProgress, phase: "publishing_result" },
  { ...numericalProgress, completed_targets: 2_001 },
  { ...numericalProgress, completed_targets: 0.5 },
  { ...numericalProgress, source_cells: Number.MAX_SAFE_INTEGER + 1 },
]) {
  selectedStages = withProgress(progress);
  const invalidModel = model(selectedStages);
  assert.equal(invalidModel.antennaProgress.percent, null);
  assert.equal(value(invalidModel, "Phase"), "Progress not reported");
  const invalidMarkup = renderFooter();
  assert.ok(!invalidMarkup.includes("aria-valuenow="), "Unknown/malformed progress must be indeterminate");
}
const beforeSampling = model(withProgress({ ...numericalProgress, phase: "solving_potential", completed_targets: 0 }));
assert.equal(beforeSampling.antennaProgress.percent, null);
assert.equal(value(beforeSampling, "Phase"), "Solving electric potential");
assert.equal(model({ ...withProgress(numericalProgress), runtime_state: "failed" }).antennaProgress.active, false);
selectedStages = withProgress({ ...numericalProgress, completed_targets: 2_000, phase: "publishing_result" }, "failed");
selectedStages.stages[0].state_transition_reason = "Result store is locked";
const failedPublication = model(selectedStages);
assert.equal(failedPublication.antennaProgress.percent, 100);
assert.equal(failedPublication.antennaProgress.active, false);
assert.equal(value(failedPublication, "Publication"), "Not completed");
assert.match(failedPublication.statusTitle, /Failed/);
const failedMarkup = renderFooter();
assert.match(failedMarkup, /aria-valuenow="100"/);
assert.match(failedMarkup, /data-active="false"/);
assert.match(failedMarkup, /Failed/);
assert.match(failedMarkup, /Field sampling complete/);
assert.ok(!failedMarkup.includes("Estimated field time left") && !failedMarkup.includes("Estimating field time"),
  "N/N and failed publication must not claim an active or zero overall-stage ETA");
for (const state of ["failed", "cancelled", "completed", "pending"]) {
  assert.equal(model(withProgress(null, state)).antennaProgress.active, false);
}
for (const key of ["session_id", "session_epoch", "request_scope_epoch", "run_id"]) {
  assert.equal(model({ ...withProgress(numericalProgress), [key]: "foreign" }).antennaProgress, null);
}
console.log("PASS typed field counters, accessible real Radix progress, malformed/unknown fallback and failed publication at 100%");
// Execute the actual clock hook with deterministic React lifecycle primitives.
const ast = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const clockDeclaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "useAntennaStageClock");
assert.ok(clockDeclaration);
const eligibilityCode = ["validStageTimestamp", "resolveFooterAntennaStage"].map(name =>
  ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(ast).replace(/^export /, "")).join("\n");
const eligibilityContext = vm.createContext({});
vm.runInContext(ts.transpileModule(eligibilityCode, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, eligibilityContext);
assert.equal(eligibilityContext.resolveFooterAntennaStage(status, stages).clockKey, null,
  "Actual retained running payload without start time must never enable the clock");
assert.ok(eligibilityContext.resolveFooterAntennaStage(status, timed("running", 1_000, null, null)).clockKey);
assert.equal(eligibilityContext.resolveFooterAntennaStage(status, timed("completed", 1_000, 2_000, null)).clockKey, null);
assert.equal(eligibilityContext.resolveFooterAntennaStage(status, { ...timed("running", 1_000, null, null), request_scope_epoch: "foreign" }), null);
let hookState, previousDeps, pendingEffect, cleanup, rendering = false, currentTime = 4_000, nextTimer = 0;
const timers = new Map();
const clockContext = vm.createContext({
  useState: () => [hookState ?? null, next => { hookState = typeof next === "function" ? next(hookState) : next; }],
  useEffect: (effect, deps) => {
    if (!previousDeps || deps.some((dep, index) => dep !== previousDeps[index])) pendingEffect = { effect, deps };
  },
  Date: { now: () => { assert.equal(rendering, false, "Clock must never read Date.now during render"); return currentTime; } },
  globalThis: { setInterval: (callback, delay) => { assert.equal(delay, 1_000); const id = ++nextTimer; timers.set(id, callback); return id; }, clearInterval: id => timers.delete(id) },
});
vm.runInContext(ts.transpileModule(clockDeclaration.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, clockContext);
function renderClock(identity, commit = true) {
  rendering = true; const result = clockContext.useAntennaStageClock(identity); rendering = false;
  if (commit && pendingEffect) {
    cleanup?.(); previousDeps = pendingEffect.deps; cleanup = pendingEffect.effect(); pendingEffect = null;
  }
  return result;
}
assert.equal(renderClock(null), null); assert.equal(timers.size, 0, "Current actual payload must create zero timers");
assert.equal(renderClock("scopeA/stageA/start1000", false), null, "Initial client render matches SSR");
renderClock("scopeA/stageA/start1000"); assert.equal(timers.size, 1);
for (const callback of timers.values()) callback();
assert.equal(renderClock("scopeA/stageA/start1000"), 4_000);
assert.equal(timers.size, 1, "Unrelated render must not create another timer");
assert.equal(renderClock("scopeB/stageA/start1000"), null, "New identity must not reuse another stage clock");
assert.equal(timers.size, 1);
currentTime = 5_000; for (const callback of timers.values()) callback();
assert.equal(renderClock("scopeB/stageA/start1000"), 5_000);
assert.equal(renderClock(null), null); assert.equal(timers.size, 0, "Terminal/missing identity must stop the clock");
renderClock("scopeC/stageA/start1000"); assert.equal(timers.size, 1); cleanup?.();
assert.equal(timers.size, 0, "Unmount must dispose the timer");
console.log("PASS actual clock hook hydration, identity fencing, terminal/idle and unmount cleanup without API polling");
console.log(JSON.stringify({ status: "passed", groups: 9, scope: "interpreted production telemetry model, SSR and clock lifecycle", browser_verified: false, unit_test_compilation: false }));
