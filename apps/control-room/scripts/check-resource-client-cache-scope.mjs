import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

// Exercise the production cache store and key helper after native type erasure.
// This is an interpreted source check, not a transpiled unit-test bundle.
const context = vm.createContext({
  AbortController,
  DOMException,
  clearTimeout,
  setTimeout,
  structuredClone,
});
const productionModule = (path) =>
  new vm.SourceTextModule(
    stripTypeScriptTypes(readFileSync(path, "utf8")),
    { context },
  );

const resourceState = productionModule("src/kernel/resources/resourceState.ts");
await resourceState.link(() => {
  throw new Error("Unexpected resource-state dependency");
});
await resourceState.evaluate();

const resourceRuntimeStore = productionModule(
  "src/kernel/resources/ResourceRuntimeStore.ts",
);
await resourceRuntimeStore.link((specifier) => {
  assert.equal(specifier, "./resourceState");
  return resourceState;
});
await resourceRuntimeStore.evaluate();

const resourceClientScope = productionModule(
  "src/kernel/resources/resourceClientScope.ts",
);
await resourceClientScope.link(() => {
  throw new Error("Unexpected client-scope dependency");
});
await resourceClientScope.evaluate();

const apiPaths = new vm.SourceTextModule(`
  export const SESSIONS_PATH = "/v2/platform/sessions";
  export const DATA_DOMAIN_META_PATH = "/v2/sessions/current/data/domain/meta";
  export const DATA_DOMAIN_TOPOLOGY_PATH = "/v2/sessions/current/data/domain/topology";
  export const DATA_FIELDS_PATH = "/v2/sessions/current/data/fields";
  export const DATA_FIELD_VECTOR_PATH = "/v2/sessions/current/data/fields/{quantity_id}/samples/vector";
  export const DATA_PLANAR_FIELD_META_PATH = "/v2/sessions/current/data/fields/{quantity_id}/planar-monitors/{monitor_id}/meta";
`, { context });
await apiPaths.link(() => {
  throw new Error("Unexpected API-path dependency");
});
await apiPaths.evaluate();

const inactiveViewportPolicy = productionModule(
  "src/kernel/resources/inactiveViewportResourcePolicy.ts",
);
await inactiveViewportPolicy.link((specifier) => {
  if (specifier === "@/kernel/api/apiPaths") return apiPaths;
  if (specifier === "@/kernel/resources/ResourceRuntimeStore") return resourceRuntimeStore;
  throw new Error(`Unexpected viewport-pause dependency: ${specifier}`);
});
await inactiveViewportPolicy.evaluate();

const {
  ResourceRuntimeStore,
  sharedResourceRuntimeStore,
} = resourceRuntimeStore.namespace;
const { resourceRuntimeKeyForClientScope } = resourceClientScope.namespace;
const oldScope = "client-old";
const newScope = "client-new";
const canonicalKey = "/v2/sessions/current/data/domain/meta?detail=full";
const oldRuntimeKey = resourceRuntimeKeyForClientScope(canonicalKey, oldScope);
const newRuntimeKey = resourceRuntimeKeyForClientScope(canonicalKey, newScope);
assert.notEqual(oldRuntimeKey, newRuntimeKey);
assert.equal(oldRuntimeKey, `${canonicalKey}&__fm_client_scope=${oldScope}`);
assert.equal(
  resourceRuntimeKeyForClientScope(oldRuntimeKey, oldScope),
  oldRuntimeKey,
);
assert.equal(
  resourceRuntimeKeyForClientScope(oldRuntimeKey, newScope),
  newRuntimeKey,
);

const store = new ResourceRuntimeStore();
store.updateData(oldRuntimeKey, { owner: oldScope }, 1);
assert.equal(store.getSnapshot(newRuntimeKey).data, null);
store.updateData(newRuntimeKey, { owner: newScope }, 1);

let resolveOldLoad;
const oldLoad = store.ensureLoad({
  externalRevision: 2,
  load: () => new Promise((resolve) => { resolveOldLoad = resolve; }),
  resourceKey: oldRuntimeKey,
});
resolveOldLoad({ owner: oldScope, source: "late-load" });
await oldLoad;
assert.deepEqual(store.getSnapshot(oldRuntimeKey).data, {
  owner: oldScope,
  source: "late-load",
});
assert.deepEqual(store.getSnapshot(newRuntimeKey).data, { owner: newScope });

const fieldKey = resourceRuntimeKeyForClientScope(
  apiPaths.namespace.DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "magnetization"),
  newScope,
);
const isViewport3DExclusiveResourceKey =
  inactiveViewportPolicy.namespace.isViewport3DExclusiveResourceKey;
assert.equal(isViewport3DExclusiveResourceKey(fieldKey), true);
let fieldLoadCount = 0;
const releaseFieldPause = store.beginPauseMatching(isViewport3DExclusiveResourceKey);
const pausedLoad = store.ensureLoad({
  externalRevision: 3,
  load: async () => {
    fieldLoadCount += 1;
    return { source: "resumed" };
  },
  resourceKey: fieldKey,
});
await pausedLoad;
assert.equal(fieldLoadCount, 0);
releaseFieldPause();
assert.equal(fieldLoadCount, 1);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(store.getSnapshot(fieldKey).data, { source: "resumed" });

const viewportFieldHold = productionModule(
  "src/modules/viewport-3d/viewport3dFieldUpdateHold.ts",
);
await viewportFieldHold.link((specifier) => {
  assert.equal(specifier, "@/kernel/resources/ResourceRuntimeStore");
  return resourceRuntimeStore;
});
await viewportFieldHold.evaluate();
const sharedStore = sharedResourceRuntimeStore;
const vectorKey = resourceRuntimeKeyForClientScope(
  apiPaths.namespace.DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "field"),
  newScope,
);
let heldLoadCount = 0;
viewportFieldHold.namespace.beginViewport3DFieldUpdateHold();
await sharedStore.ensureLoad({
  externalRevision: 4,
  load: async () => {
    heldLoadCount += 1;
    return { source: "held" };
  },
  resourceKey: vectorKey,
});
assert.equal(heldLoadCount, 0);
viewportFieldHold.namespace.endViewport3DFieldUpdateHold();
assert.equal(heldLoadCount, 1);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(sharedStore.getSnapshot(vectorKey).data, { source: "held" });

// Link the production command-scope adapter to the same store/helper and small
// deterministic collaborators. This checks that lookup/subscription keys use
// the API instance scope without duplicating the session identity algorithm.
const sessionIdentity = new vm.SourceTextModule(`
  export function sessionResourceIdentityFromStatus(status) {
    return status ? { sessionId: status.session_id, epoch: status.session_epoch } : null;
  }
  export function confirmedSessionResourceIdentity(identity, collection) {
    return identity && collection.sessions.some((item) => item.session_id === identity.sessionId)
      ? identity : null;
  }
  export function sessionRequestScopeKey(identity) {
    return identity ? "session=" + identity.sessionId + "&epoch=" + identity.epoch : null;
  }
`, { context });
await sessionIdentity.link(() => {
  throw new Error("Unexpected session-identity dependency");
});
await sessionIdentity.evaluate();

const useSessionStatus = new vm.SourceTextModule(
  'export const SESSION_STATUS_RESOURCE_KEY = "session:status";',
  { context },
);
await useSessionStatus.link(() => {
  throw new Error("Unexpected session-status dependency");
});
await useSessionStatus.evaluate();

const commandScopeSource = productionModule(
  "src/kernel/commands/commandSessionScopeSource.ts",
);
await commandScopeSource.link((specifier) => {
  if (specifier === "../api/apiPaths") return apiPaths;
  if (specifier === "../resources/ResourceRuntimeStore") return resourceRuntimeStore;
  if (specifier === "../resources/sessionResourceIdentity") return sessionIdentity;
  if (specifier === "../resources/resourceClientScope") return resourceClientScope;
  if (specifier === "../resources/useSessionStatus") return useSessionStatus;
  throw new Error(`Unexpected command-scope dependency: ${specifier}`);
});
await commandScopeSource.evaluate();
const commandScopeStore = new ResourceRuntimeStore();
const collectionKey = resourceRuntimeKeyForClientScope(
  apiPaths.namespace.SESSIONS_PATH,
  newScope,
);
const statusKey = resourceRuntimeKeyForClientScope(
  useSessionStatus.namespace.SESSION_STATUS_RESOURCE_KEY,
  newScope,
);
commandScopeStore.updateData(
  resourceRuntimeKeyForClientScope(apiPaths.namespace.SESSIONS_PATH, oldScope),
  { sessions: [{ session_id: "old-session" }] },
  1,
);
commandScopeStore.updateData(
  resourceRuntimeKeyForClientScope(
    useSessionStatus.namespace.SESSION_STATUS_RESOURCE_KEY,
    oldScope,
  ),
  { session_id: "old-session", session_epoch: 1 },
  1,
);
const commandScope = commandScopeSource.namespace.createCommandSessionScopeSource(
  commandScopeStore,
  newScope,
);
assert.equal(commandScope.getScopeKey(), null);
commandScopeStore.updateData(
  collectionKey,
  { sessions: [{ session_id: "new-session" }] },
  2,
);
commandScopeStore.updateData(
  statusKey,
  { session_id: "new-session", session_epoch: 9 },
  2,
);
assert.equal(commandScope.getScopeKey(), "session=new-session&epoch=9");
let commandScopeNotifications = 0;
const unsubscribe = commandScope.subscribe(() => { commandScopeNotifications += 1; });
commandScopeStore.updateData(
  statusKey,
  { session_id: "new-session", session_epoch: 10 },
  3,
);
assert.equal(commandScopeNotifications, 1);
unsubscribe();

// Verify the React hook transports stay canonical outside the local cache and
// all production imperative scene/visualization publishers use the same key.
const useResourceSource = readFileSync("src/kernel/resources/useResource.ts", "utf8");
assert.equal((useResourceSource.match(/runtimeResourceKey/g) ?? []).length >= 15, true);
assert.match(useResourceSource, /resources\.subscribe\(resourceKey/);
assert.match(useResourceSource, /resources\.getRevision\(resourceKey\)/);
assert.match(useResourceSource, /load: \(context\) => load\(\{ \.\.\.context, resourceKey \}\)/);
assert.doesNotMatch(
  useResourceSource,
  /runtimeStore\.(?:subscribe|getSnapshot|pauseLoad|cancelRetry)\(resourceKey/,
);
const scenePublisher = readFileSync("src/kernel/resources/geometryLifecycleResources.ts", "utf8");
assert.match(scenePublisher, /resourceRuntimeKeyForClientScope\(SCENE_RESOURCE_KEY, resourceCacheScope\)/);
const publisherSource = scenePublisher.slice(
  scenePublisher.indexOf("export function publishCommittedSceneResource("),
  scenePublisher.indexOf("export function useSceneResource("),
);
const scenePublication = new vm.SourceTextModule(stripTypeScriptTypes(`
  import { ResourceRuntimeStore, sharedResourceRuntimeStore } from "store";
  import { resourceRuntimeKeyForClientScope } from "scope";
  const SCENE_RESOURCE_KEY = "/v2/sessions/current/scene";
  ${publisherSource}
`), { context });
await scenePublication.link((specifier) => {
  if (specifier === "store") return resourceRuntimeStore;
  if (specifier === "scope") return resourceClientScope;
  throw new Error(`Unexpected scene-publication dependency: ${specifier}`);
});
await scenePublication.evaluate();
const publicationStore = new ResourceRuntimeStore();
const invalidations = [];
const resources = { invalidate: (...args) => invalidations.push(args) };
for (let index = 0; index < 20; index += 1) {
  const scope = `retired-client-${index}`;
  const session = `session=owned-${index}&epoch=1`;
  const canonical = "/v2/sessions/current/scene";
  const observedKey = resourceRuntimeKeyForClientScope(`${session}|${canonical}`, scope);
  const aliasKey = resourceRuntimeKeyForClientScope(canonical, scope);
  const scene = { objects: [{ object_id: `object-${index}` }] };
  const stop = publicationStore.subscribe(observedKey, () => {});
  scenePublication.namespace.publishCommittedSceneResource(
    resources, scene, index, publicationStore, true, session, scope,
  );
  assert.equal(publicationStore.getSnapshot(observedKey).data, scene);
  assert.equal(publicationStore.getSnapshot(aliasKey).data, null);
  stop();
  scenePublication.namespace.publishCommittedSceneResource(
    resources, scene, index + 1, publicationStore, true, session, scope,
  );
  scenePublication.namespace.publishCommittedSceneResource(
    resources, scene, index + 2, publicationStore, true, null, scope,
  );
  assert.equal(publicationStore.getSnapshot(observedKey).data, null);
  assert.equal(publicationStore.getSnapshot(aliasKey).data, null);
}
assert.equal(invalidations.length, 60);
const visualizationPublisher = readFileSync("src/kernel/visualization/VisualizationRegistrySyncController.ts", "utf8");
assert.match(visualizationPublisher, /updateObservedData\([\s\S]*?resourceRuntimeKeyForClientScope\(/);
assert.match(
  readFileSync("src/kernel/KernelProvider.tsx", "utf8"),
  /createCommandSessionScopeSource\([\s\S]*?api\.resourceCacheScope,?\s*\)/,
);
for (const path of [
  "src/kernel/authoring/AuthoringHistoryController.ts",
  "src/kernel/authoring/objectTranslationMutation.ts",
  "src/modules/inspector/panels/GeometryObjectPanel.tsx",
  "src/modules/inspector/panels/ObjectGeneralPanel.tsx",
  "src/modules/inspector/panels/ObjectMaterialPanel.tsx",
  "src/modules/inspector/panels/CouplingInspectorPanel.tsx",
  "src/modules/inspector/panels/ObjectRegionsPanel.tsx",
  "src/modules/inspector/panels/RegionsListPanel.tsx",
  "src/modules/inspector/panels/region/ObjectRegionMagneticParametersPanel.tsx",
]) {
  assert.match(readFileSync(path, "utf8"), /resourceCacheScope/);
}
const viewportPausePolicy = readFileSync(
  "src/kernel/resources/inactiveViewportResourcePolicy.ts",
  "utf8",
);
assert.match(viewportPausePolicy, /resourceKey\.split\("\?"\)\[0\]/);
const fieldPausePolicy = readFileSync(
  "src/modules/viewport-3d/viewport3dFieldUpdateHold.ts",
  "utf8",
);
assert.match(fieldPausePolicy, /resourceKey\.includes\("\/data\/fields\/"\)/);

const simulationAvailability = productionModule(
  "src/kernel/resources/simulationResourceAvailability.ts",
);
await simulationAvailability.link(() => {
  throw new Error("Unexpected simulation-availability dependency");
});
await simulationAvailability.evaluate();
const { hasCurrentSimulationRun, hasSimulationPreparation } = simulationAvailability.namespace;
const emptySimulation = {
  session: { session_id: "new-session" },
  run: null,
  resources: { simulation_preparation_revision: 0 },
};
assert.equal(hasCurrentSimulationRun(null), false);
assert.equal(hasSimulationPreparation(null, 7), false);
assert.equal(hasCurrentSimulationRun(emptySimulation), false);
assert.equal(hasSimulationPreparation(emptySimulation), false);
assert.equal(hasSimulationPreparation(emptySimulation, 0), false);
assert.equal(hasSimulationPreparation(emptySimulation, 7), true);
assert.equal(hasSimulationPreparation({
  ...emptySimulation, resources: { simulation_preparation_revision: 8 },
}), true);
for (const status of ["running", "completed", "failed"]) {
  assert.equal(hasCurrentSimulationRun({
    ...emptySimulation, run: { run_id: "run-1", status },
  }), true);
}
assert.equal(hasCurrentSimulationRun({
  ...emptySimulation, session: null, run: { run_id: "old-run" },
}), false);
assert.equal(hasSimulationPreparation({
  ...emptySimulation, session: null, resources: { simulation_preparation_revision: 8 },
}, 8), false);

const navigationDependencies = new vm.SyntheticModule(
  ["useSyncExternalStore", "requestThemeToggle", "applyAuthoringHistoryWorkspaceTransition", "pickProjectArchive"],
  function () {
    for (const name of ["useSyncExternalStore", "requestThemeToggle", "applyAuthoringHistoryWorkspaceTransition", "pickProjectArchive"]) {
      this.setExport(name, () => { throw new Error(`Unexpected navigation dependency call: ${name}`); });
    }
  },
  { context },
);
await navigationDependencies.link(() => { throw new Error("Unexpected navigation dependency"); });
await navigationDependencies.evaluate();
const homeViewModule = productionModule("src/kernel/layout/homeView.ts");
await homeViewModule.link((specifier) => {
  assert.equal(specifier, "react");
  return navigationDependencies;
});
await homeViewModule.evaluate();
const shellCommandsModule = productionModule("src/kernel/layout/shellCommands.ts");
await shellCommandsModule.link((specifier) => {
  if (specifier === "./homeView") return homeViewModule;
  assert.ok([
    "@/design/theme/themeEvents",
    "../authoring/authoringHistoryWorkspaceRestore",
    "../persistence/ProjectDocumentController",
  ].includes(specifier), `Unexpected shell command dependency: ${specifier}`);
  return navigationDependencies;
});
await shellCommandsModule.evaluate();
const navigationState = homeViewModule.namespace.homeView;
const openStart = shellCommandsModule.namespace.SHELL_COMMANDS.find(command => command.id === "workspace.home");
const returnToWorkspace = shellCommandsModule.namespace.SHELL_COMMANDS.find(command => command.id === "workspace.return-to-workspace");
let navigationNotifications = 0;
const unsubscribeNavigation = navigationState.subscribe(() => { navigationNotifications += 1; });
assert.equal(returnToWorkspace.isEnabled(), false);
assert.equal(openStart.run({}).status, "completed");
assert.equal(openStart.run({}).status, "completed");
assert.equal(navigationState.isOpen(), true);
assert.equal(navigationNotifications, 1);
assert.equal(returnToWorkspace.isEnabled(), true);
assert.equal(returnToWorkspace.run({}).status, "completed");
assert.equal(navigationState.isOpen(), false);
assert.equal(returnToWorkspace.isEnabled(), false);
assert.equal(navigationNotifications, 2);
unsubscribeNavigation();
navigationState.resetForTests();

sharedResourceRuntimeStore.resetForTests();
console.log(JSON.stringify({
  check: "resource-client-cache-scope",
  groups: 11,
  passed: true,
  emitted_code: false,
}));
