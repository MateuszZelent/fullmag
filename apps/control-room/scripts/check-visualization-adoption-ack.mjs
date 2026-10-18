import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

let nextTimer = 0;
const timers = new Map();
const context = vm.createContext({
  setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
  clearTimeout(id) { timers.delete(id); },
});
const source = new URL("../src/", import.meta.url);
const identity = new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(new URL("kernel/resources/sessionResourceIdentity.ts", source), "utf8")), { context });
await identity.link(() => { throw new Error("Unexpected identity import"); }); await identity.evaluate();
const react = new vm.SyntheticModule(["useCallback", "useEffect"], function () {
  for (const name of ["useCallback", "useEffect"]) this.setExport(name, () => { throw new Error("Hooks are outside the coordinator diagnostic"); });
}, { context });
const coordinatorModule = new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(new URL("kernel/visualization/useVisualizationClientAck.ts", source), "utf8")), { context });
await coordinatorModule.link(name => { assert.ok(["react", "../resources/sessionResourceIdentity"].includes(name)); return name === "react" ? react : identity; });
await coordinatorModule.evaluate();
const create = coordinatorModule.namespace.createVisualizationAckCoordinator;
let checks = 0;
const check = (name, run) => { timers.clear(); run(); checks++; console.log(`PASS ${name}`); };
const setup = () => {
  const calls = [];
  const coordinator = create({ visualization: { ack: (request, options) => { calls.push({ request, options }); return Promise.resolve(); } } });
  return { calls, coordinator };
};
const input = { changeKind: "data", status: "applied", revision: 0, requestScopeEpoch: "api:1", sessionId: "session", sessionEpoch: "epoch", viewportId: "main", dataIdentity: null };
const data = { fieldBufferId: "buffer", fieldRevision: "7", resourceKey: "field:H", sessionId: "session", sessionEpoch: "epoch", visualizationRevision: 0 };
const fire = () => { for (const [id, timer] of [...timers]) { timers.delete(id); timer.callback(); } };
check("empty startup cannot time out adoption of a nonexistent buffer", () => {
  const { coordinator, calls } = setup(); coordinator.send(input);
  assert.equal(timers.size, 0); fire(); assert.equal(calls.length, 0); assert.equal(coordinator.pending.size, 0);
});
check("loading without identity never becomes a rendered success", () => {
  const { coordinator, calls } = setup(); coordinator.send(input); coordinator.send({ ...input, status: "rendered" }); assert.equal(calls.length, 0);
});
check("arrival of an identified buffer starts the bounded adoption timeout", () => {
  const { coordinator, calls } = setup(); coordinator.send(input); coordinator.send({ ...input, dataIdentity: data });
  assert.equal(timers.size, 1); assert.equal([...timers.values()][0].delay, 5000); fire(); assert.equal(calls.length, 1); assert.equal(calls[0].request.status, "failed");
});
check("matching frame clears timer and sends exactly one scoped rendered ACK", () => {
  const { coordinator, calls } = setup(); coordinator.send({ ...input, dataIdentity: data });
  const frame = { ...input, status: "rendered", dataIdentity: data, renderCommit: data };
  coordinator.send(frame); coordinator.send(frame); fire();
  assert.equal(timers.size, 0); assert.equal(calls.length, 1); assert.equal(calls[0].request.status, "rendered"); assert.ok(calls[0].options.sessionScopeKey.includes("request_scope_epoch=api%3A1"));
});
check("foreign buffer commit cannot complete an identified pending adoption", () => {
  const { coordinator, calls } = setup(); coordinator.send({ ...input, dataIdentity: data });
  coordinator.send({ ...input, status: "rendered", dataIdentity: data, renderCommit: { ...data, fieldBufferId: "other" } });
  assert.equal(calls.length, 0); assert.equal(timers.size, 1); fire(); assert.equal(calls[0].request.status, "failed");
});
check("explicit resource failure remains terminal even without a buffer", () => {
  const { coordinator, calls } = setup(); coordinator.send({ ...input, status: "failed", error: "Field unavailable" });
  assert.equal(calls.length, 1); assert.equal(calls[0].request.error, "Field unavailable"); assert.equal(timers.size, 0);
});
check("session replacement terminates an actual old adoption in its original scope", () => {
  const { coordinator, calls } = setup(); coordinator.send({ ...input, dataIdentity: data });
  coordinator.send({ ...input, sessionId: "next", sessionEpoch: "next-epoch", requestScopeEpoch: "api:2", revision: 1 });
  assert.equal(timers.size, 0); assert.equal(calls.length, 1); assert.equal(calls[0].request.status, "failed"); assert.ok(calls[0].options.sessionScopeKey.startsWith("session=session&"));
});
check("real identified adoption backlog remains bounded and reports every failure", () => {
  const { coordinator, calls } = setup();
  for (let revision = 1; revision <= 65; revision++) coordinator.send({ ...input, revision, dataIdentity: { ...data, visualizationRevision: revision, fieldBufferId: `buffer:${revision}` } });
  assert.equal(timers.size, 64); assert.equal(calls.length, 1); fire(); assert.equal(calls.length, 65); assert.ok(calls.every(call => call.request.status === "failed"));
});
check("style-only revisions keep their existing direct ACK contract", () => {
  const { coordinator, calls } = setup(); coordinator.send({ ...input, changeKind: "style", status: "rendered" }); assert.equal(timers.size, 0); assert.equal(calls.length, 1); assert.equal(calls[0].request.status, "rendered");
});
console.log(JSON.stringify({ state: "passed", checks, scope: "interpreted production coordinator and scope resolver; deterministic clock; no unit test compilation" }));
