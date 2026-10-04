import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

// Interpret actual host/store/command sources; adapter protocol remains covered
// separately by the real document-owner browser fixture.
const context = vm.createContext({ AbortController, DOMException, URL, URLSearchParams, clearTimeout, setTimeout, structuredClone });
const modules = new Map();
const source = (path) => new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(path, "utf8")), { context });
const state = source("src/kernel/resources/resourceState.ts");
const storeModule = source("src/kernel/resources/ResourceRuntimeStore.ts");
const scope = source("src/kernel/resources/resourceClientScope.ts");
const pin = source("src/kernel/api/apiInstancePin.ts");
const commandScope = source("src/kernel/commands/commandSessionScope.ts");
const commandsModule = source("src/kernel/commands/CommandRegistry.ts");
const ownerAdapter = new vm.SourceTextModule("export function createDevelopmentKernelOwners(_kernel, options) { return options; }", { context });
const paths = new vm.SourceTextModule('export const PLATFORM_DEVELOPMENT_BACKEND_PATH = "/v2/platform/development-backend";', { context });
for (const leafModule of [state, scope, pin, commandScope, ownerAdapter, paths]) {
  await leafModule.link(() => { throw new Error("Unexpected leaf dependency"); });
  await leafModule.evaluate();
}
await storeModule.link((specifier) => { assert.equal(specifier, "./resourceState"); return state; });
await storeModule.evaluate();
await commandsModule.link((specifier) => { assert.equal(specifier, "./commandSessionScope"); return commandScope; });
await commandsModule.evaluate();
modules.set("../api/apiInstancePin", pin);
modules.set("../api/apiPaths", paths);
modules.set("../resources/ResourceRuntimeStore", storeModule);
modules.set("../resources/resourceClientScope", scope);
modules.set("./DevelopmentKernelOwners", ownerAdapter);
const hostModule = source("src/kernel/development/DevelopmentKernelHost.ts");
await hostModule.link((specifier) => { assert.ok(modules.has(specifier)); return modules.get(specifier); });
await hostModule.evaluate();
const { DevelopmentKernelHost } = hostModule.namespace;
const { CommandRegistry } = commandsModule.namespace;
const { sharedResourceRuntimeStore: store } = storeModule.namespace;
const { resourceRuntimeKeyForClientScope: keyFor } = scope.namespace;
const oldPin = "11111111-1111-4111-8111-111111111111";
const newPin = "22222222-2222-4222-8222-222222222222";
const commandContext = { source: "button" };
let groups = 0;

const commands = new CommandRegistry();
let settle;
let invocations = 0;
commands.register({ id: "check", run: async () => { invocations += 1; return await new Promise((resolve) => { settle = resolve; }); } });
const running = commands.execute("check", commandContext);
assert.throws(() => commands.beginDevelopmentHandoffPause(), /active workspace commands/);
settle({ status: "succeeded" });
await running;
const releaseOne = commands.beginDevelopmentHandoffPause();
const releaseTwo = commands.beginDevelopmentHandoffPause();
assert.equal(commands.isEnabled("check", commandContext), false);
assert.equal((await commands.execute("check", commandContext)).status, "failed");
releaseOne(); releaseOne();
assert.equal(commands.isEnabled("check", commandContext), false);
releaseTwo();
assert.equal(commands.isEnabled("check", commandContext), true);
assert.equal(invocations, 1);
groups += 1;

let created = 0;
const factory = (options) => {
  const apiPin = options.expectedApiInstance ?? oldPin;
  const kernel = {
    commands: new CommandRegistry(),
    api: {
      resourceCacheScope: `host-client-${++created}`,
      retired: false,
      paused: false,
      rejectPause: false,
      getExpectedApiInstance: () => apiPin,
      getBaseUrl: () => "http://localhost:3197",
      beginDevelopmentHandoffTransportPause() {
        if (this.rejectPause) throw new Error("ordinary operation is active");
        this.paused = true;
        return () => { if (!this.retired) this.paused = false; };
      },
      retireDevelopmentHandoffTransport() { this.retired = true; this.paused = true; },
    },
    cameraRegistry: { dirty: false, getSnapshot() { return { dirty: this.dirty, syncInFlight: false, error: null }; }, stop() {} },
    visualizationSync: { getSnapshot: () => ({ pendingPatch: null, inflightPatch: null, error: null }), stop() {} },
    resources: { invalidations: 0, invalidateMatching() { this.invalidations += 1; } },
  };
  kernel.commands.register({ id: "check", run: async () => ({ status: "succeeded" }) });
  return kernel;
};
const host = new DevelopmentKernelHost(factory);
const old = host.getSnapshot().kernel;
const owners = host.createOwners({ applyPendingChanges: false, carryUnsavedDocument: false });
old.cameraRegistry.dirty = true;
assert.throws(() => owners.pauseOldKernel(), /camera and visualization/);
old.cameraRegistry.dirty = false;
old.api.rejectPause = true;
assert.throws(() => owners.pauseOldKernel(), /ordinary operation/);
assert.equal(host.getSnapshot().paused, false);
assert.equal(store.stats().activePauseCount, 0);
assert.equal(old.commands.isEnabled("check", commandContext), true);
assert.equal(old.resources.invalidations, 1);
old.api.rejectPause = false;
groups += 1;

const key = keyFor("/v2/sessions/current/model/scene", old.api.resourceCacheScope);
const otherKey = keyFor("/v2/sessions/current/model/scene", "another-client");
const unsubscribe = store.subscribe(key, () => {});
const oldData = { owner: "old" };
store.updateData(key, oldData, 1);
const release = owners.pauseOldKernel();
let fetches = 0;
await store.ensureLoad({ resourceKey: key, externalRevision: 2, load: async () => { fetches += 1; return { owner: "late" }; } });
assert.equal(fetches, 0);
assert.equal(store.getSnapshot(key).data, oldData);
await store.ensureLoad({ resourceKey: otherKey, externalRevision: 2, load: async () => { fetches += 1; return { owner: "other" }; } });
assert.equal(fetches, 1);
assert.equal(old.api.paused, true);
assert.equal((await old.commands.execute("check", commandContext)).status, "failed");
groups += 1;

await assert.rejects(owners.prepareReplacement(oldPin), /pin is invalid/);
const next = await owners.prepareReplacement(newPin);
assert.notEqual(next.api.resourceCacheScope, old.api.resourceCacheScope);
assert.equal(next.api.getExpectedApiInstance(), newPin);
await assert.rejects(owners.prepareReplacement(newPin), /custody/);
let published = false;
const publication = owners.publishReplacement(next).then(() => { published = true; });
await Promise.resolve();
assert.equal(published, false);
assert.equal(host.getSnapshot().generation, 1);
assert.equal(host.getSnapshot().kernel, next);
assert.equal(host.getSnapshot().paused, true);
assert.equal(next.commands.isEnabled("check", commandContext), false);
assert.equal((await next.commands.execute("check", commandContext)).status, "failed");
assert.equal(next.api.paused, true);
host.confirmMounted(old);
await Promise.resolve();
assert.equal(published, false);
unsubscribe(); // React old-subtree cleanup precedes the provider acknowledgement.
host.confirmMounted(next, (previous, replacement) => { assert.equal(previous, old); assert.equal(replacement, next); });
await publication;
assert.equal(host.getSnapshot().paused, false);
assert.equal(next.commands.isEnabled("check", commandContext), true);
assert.equal(next.api.paused, false);
assert.equal(old.api.retired, true);
release(); release();
assert.equal(old.api.paused, true);
assert.equal(store.getSnapshot(key).data, null);
groups += 1;

const failedHost = new DevelopmentKernelHost(factory);
const failedOwners = failedHost.createOwners({ applyPendingChanges: false, carryUnsavedDocument: false });
failedOwners.pauseOldKernel();
const failedNext = await failedOwners.prepareReplacement(newPin);
const failedPublication = failedOwners.publishReplacement(failedNext);
const rejection = assert.rejects(failedPublication, /history unavailable/);
failedHost.confirmMounted(failedNext, () => { throw new Error("history unavailable"); });
await rejection;
assert.equal(failedHost.getSnapshot().paused, true);
assert.equal(failedNext.commands.isEnabled("check", commandContext), false);
assert.equal((await failedNext.commands.execute("check", commandContext)).status, "failed");
assert.equal(failedNext.api.paused, true);
assert.match(failedHost.getSnapshot().publicationError, /protected/);
failedHost.confirmMounted(failedNext);
assert.equal(failedHost.getSnapshot().paused, true);
groups += 1;

const url = `http://localhost:3197/workspace?layout=wide&fullmag_api_instance=${oldPin}#view`;
const replacementUrl = pin.namespace.developmentReplacementUrl(url, oldPin, newPin);
assert.equal(new URL(replacementUrl).searchParams.get("layout"), "wide");
assert.equal(new URL(replacementUrl).hash, "#view");
assert.equal(pin.namespace.resolveApiInstancePin(new URL(replacementUrl).search), newPin);
assert.equal(pin.namespace.developmentReplacementUrl(replacementUrl, oldPin, newPin), replacementUrl);
for (const invalidUrl of ["http://localhost:3197/workspace", url.replace("#view", `&fullmag_api_instance=${newPin}#view`), `http://localhost:3197/?fullmag_api_instance=33333333-3333-4333-8333-333333333333`]) {
  assert.throws(() => pin.namespace.developmentReplacementUrl(invalidUrl, oldPin, newPin));
}
groups += 1;

store.resetForTests();
console.log(JSON.stringify({ check: "development-kernel-host", groups, passed: true, emitted_code: false, adapter: "protocol_stub_actual_adapter_covered_separately" }));
