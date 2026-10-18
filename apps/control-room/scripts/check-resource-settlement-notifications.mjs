import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

// Interpret production modules only; no unit-test compilation or emitted files.
const modules = new Map();
function moduleAt(url) {
  const id = url.href;
  if (modules.has(id)) return modules.get(id);
  const sourceModule = new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(url, "utf8"), { mode: "transform" }), { identifier: id });
  modules.set(id, sourceModule);
  return sourceModule;
}
const sourceModule = moduleAt(new URL("../src/kernel/resources/ResourceRuntimeStore.ts", import.meta.url));
await sourceModule.link((specifier, owner) => moduleAt(new URL(`${specifier}.ts`, owner.identifier)));
await sourceModule.evaluate();
const { ResourceRuntimeStore } = sourceModule.namespace;
const store = new ResourceRuntimeStore();
const key = "confirmed-session|scene?__fm_client_scope=verified-client";
let loadCount = 0;
const load = async () => { loadCount++; return { revision: 7, binding: "new-projection" }; };
const request = { resourceKey: key, externalRevision: "realtime:7", load, resolveRevision: value => value.revision };
let notices = [];
const release = store.subscribe(key, () => notices.push(store.getSnapshot(key)));
await store.ensureLoad(request);
assert.equal(loadCount, 1);
assert.equal(store.getSnapshot(key).settledExternalRevision, "realtime:7");
notices = [];
await store.ensureLoad({ ...request, externalRevision: 7 });
assert.equal(loadCount, 1, "An already current scene must not be fetched again");
assert.equal(notices.length, 1, "Confirming a cached revision must notify a waiting observer exactly once");
assert.equal(notices[0].status, "ready");
assert.equal(notices[0].settledExternalRevision, 7);
assert.equal(notices[0].data.binding, "new-projection");
await store.ensureLoad({ ...request, externalRevision: 7 });
assert.equal(notices.length, 1, "Repeated settled reads must not cause notification loops");
assert.equal(loadCount, 1);
release();
console.log(JSON.stringify({ state: "passed", checks: 4, loads: loadCount, settlementNotifications: notices.length, unitTestsCompiled: false }));
