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

// Execute the actual antenna hooks, identity/key helpers and antenna facade.
// Only React/resource scheduling and the transport boundary are controlled.
const syntheticModule = async (exports) => {
  const stubModule = new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
  }, { context });
  await stubModule.link(() => { throw new Error("Unexpected stub dependency"); });
  await stubModule.evaluate();
  return stubModule;
};
const antennaIdentity = productionModule("src/kernel/resources/sessionResourceIdentity.ts");
await antennaIdentity.link(() => { throw new Error("Unexpected identity dependency"); });
await antennaIdentity.evaluate();
const generatedPaths = productionModule("src/kernel/api/generated/openapi-v2-paths.ts");
await generatedPaths.link(() => { throw new Error("Unexpected generated-path dependency"); });
await generatedPaths.evaluate();
const antennaPaths = productionModule("src/kernel/api/apiPaths.ts");
await antennaPaths.link((specifier) => {
  assert.equal(specifier, "./generated/openapi-v2-paths");
  return generatedPaths;
});
await antennaPaths.evaluate();
const antennaPathNames = [
  "DATA_ANTENNA_FIELD_SOLUTION_PATH",
  "DATA_ANTENNA_STAGE_OUTPUT_CATALOG_PATH",
  "DATA_ANTENNA_FIELD_SOLUTION_PAYLOAD_PATH",
  "DATA_ANTENNA_SOURCE_SPECTRUM_PATH",
  "DATA_ANTENNA_SOURCE_SPECTRUM_PAYLOAD_PATH",
  "DATA_ANTENNA_EXTERNAL_LEAD_INSPECTION_PATH",
  "DATA_ANTENNA_EXTERNAL_LEAD_INSPECTION_PAYLOAD_PATH",
];
const openApi = JSON.parse(readFileSync("src/kernel/api/generated/openapi-v2.json", "utf8"));
for (const name of antennaPathNames) {
  const path = antennaPaths.namespace[name];
  generatedPaths.namespace.assertOpenApiV2Path(path);
  assert.ok(openApi.paths[path]?.get, `${name} must have a generated GET contract`);
}

const confirmedOwner = {
  session_id: "antenna/session",
  session_epoch: "antenna/session@17:tombstone:0",
  request_scope_epoch: "api-instance:7",
};
let antennaStatus = { session: confirmedOwner };
let antennaCollection = { sessions: [{ session_id: confirmedOwner.session_id, current: true }] };
const confirmedAntennaIdentity = () => antennaIdentity.namespace.confirmedSessionResourceIdentity(
  antennaIdentity.namespace.sessionResourceIdentityFromStatus(antennaStatus),
  antennaCollection,
);
const antennaStatusModule = await syntheticModule({
  useSessionResourceIdentity: confirmedAntennaIdentity,
});
const antennaScopedKey = productionModule("src/kernel/resources/useSessionScopedResourceKey.ts");
await antennaScopedKey.link((specifier) => {
  if (specifier === "./sessionResourceIdentity") return antennaIdentity;
  if (specifier === "./useSessionStatus") return antennaStatusModule;
  throw new Error(`Unexpected scoped-key dependency: ${specifier}`);
});
await antennaScopedKey.evaluate();

class AntennaApiError extends Error {
  constructor(status, code) {
    super(code ?? "antenna API error");
    this.status = status;
    this.code = code;
  }
}
const antennaCalls = [];
let antennaError = null;
let antennaResponse = null;
context.antennaRequestProbe = {
  requestJson(path, options, params) {
    antennaCalls.push({ path, options, params: params?.path, query: params?.query });
    return antennaError ? Promise.reject(antennaError) : Promise.resolve(antennaResponse);
  },
  requestBinaryBytes(path, options, params, query) {
    antennaCalls.push({ path, options, params, query });
    return antennaError ? Promise.reject(antennaError) : Promise.resolve(antennaResponse);
  },
};
const facadeSource = readFileSync("src/kernel/api/ControlRoomApi.ts", "utf8");
const dataMarker = "  readonly data = {";
const dataStart = facadeSource.indexOf(dataMarker);
const antennaEnd = facadeSource.indexOf("    artifacts: {", dataStart);
const capStart = facadeSource.indexOf("export const MAX_ANTENNA_INSPECTION_BYTES =");
assert.ok(dataStart >= 0 && antennaEnd > dataStart && capStart >= 0);
const antennaFacade = new vm.SourceTextModule(stripTypeScriptTypes(`
  import { ${antennaPathNames.join(", ")} } from "paths";
  ${facadeSource.slice(capStart, facadeSource.indexOf(";", capStart) + 1)}
  export const antenna = (function () {
    return { ${facadeSource.slice(dataStart + dataMarker.length, antennaEnd)} };
  }).call(globalThis.antennaRequestProbe).antenna;
`), { context });
await antennaFacade.link((specifier) => {
  assert.equal(specifier, "paths");
  return antennaPaths;
});
await antennaFacade.evaluate();
const antennaKernel = await syntheticModule({
  useKernel: () => ({ api: { data: { antenna: antennaFacade.namespace.antenna } } }),
});
let antennaDefinition = null;
const antennaResource = await syntheticModule({
  useResource: (definition) => {
    assert.equal(antennaDefinition, null, "one owning resource definition per hook");
    antennaDefinition = definition;
    return definition;
  },
});
const antennaReact = await syntheticModule({ useCallback: (callback) => callback });
const antennaApiErrors = await syntheticModule({ ControlRoomApiError: AntennaApiError });
const antennaHooks = productionModule("src/kernel/resources/antennaResources.ts");
await antennaHooks.link((specifier) => {
  if (specifier === "react") return antennaReact;
  if (specifier === "../api/apiPaths") return antennaPaths;
  if (specifier === "../api/ControlRoomApi") return antennaApiErrors;
  if (specifier === "../KernelContext") return antennaKernel;
  if (specifier === "./useResource") return antennaResource;
  if (specifier === "./sessionResourceIdentity") return antennaIdentity;
  if (specifier === "./useSessionScopedResourceKey") return antennaScopedKey;
  throw new Error(`Unexpected antenna-hook dependency: ${specifier}`);
});
await antennaHooks.evaluate();
const renderAntenna = (name, args) => {
  antennaDefinition = null;
  antennaCalls.length = 0;
  const definition = antennaHooks.namespace[name](...args);
  assert.equal(definition, antennaDefinition);
  return definition;
};
const samplePayload = (kind, unit) => ({
  path: `antenna/external_lead_solutions/output/${kind}.bin`,
  sha256: `sha256:${"b".repeat(64)}`,
  byte_count: 24, value_count: 3, scalar_type: "float64_le", layout: kind, unit,
});
const inspectionDigest = `sha256:${"a".repeat(64)}`;
// Minimal resource-boundary fixture, not a native/numerically verified bundle.
const inspection = {
  ...confirmedOwner,
  resource_id: "antenna/external-lead-inspection/runtime-stage",
  run_id: "antenna-run", runtime_stage_id: "runtime/stage 007", stage_revision: 31,
  record_content_digest: `sha256:${"c".repeat(64)}`,
  schema_version: "antenna_external_lead_stage_output.v1",
  stage_kind: "antenna_field_solve", resolved_action: "external_lead_inspection",
  stage_id: "authored-stage", port_mode_id: "port", output_id: "inspection-output",
  status: "inspection_only", qualification: "NOT VERIFIED", field_scope: "external_electrode_truncation",
  outputs: [{
    kind: "antenna_external_lead_inspection",
    inspection_ref: { stage_id: "authored-stage", output_id: "inspection-output", content_digest: inspectionDigest },
    manifest_ref: "antenna/external_lead_solutions/output/manifest.v1.json",
    payload_units: { V: "V", RT0_coefficients: "A", H: "A/m", positions: "m" }, reused_existing: false,
  }],
  manifest: {
    schema_version: "antenna_external_lead_solution.v1", content_digest: inspectionDigest,
    source_object_id: "conductor", current_transport_id: "transport", drive_id: "drive",
    closure_revision: "closure", validation_scope: "manifest_only",
    charge_content_sha256: "charge", field_content_sha256: "field", source_content_sha256: "source",
    input_pins: {}, requested_execution: {}, resolved_execution: {}, solver_policy: {},
    sampling_carrier: { carrier_kind: "point_cloud", domain: { kind: "global" }, location: "node", sample_count: 1, topology_digest: "topology" },
    bundle: samplePayload("bundle", "1"), sample_positions: samplePayload("sample_positions", "m"),
    magnetic_field: samplePayload("magnetic_field", "A/m"),
    device_vertex_ids: samplePayload("device_vertex_ids", "1"), device_potential: samplePayload("device_potential", "V"),
  },
};
const antennaHookCases = [
  ["useAntennaFieldSolutionResource", ["solution 1"], "DATA_ANTENNA_FIELD_SOLUTION_PATH"],
  ["useAntennaStageOutputCatalogResource", ["runtime/stage 007"], "DATA_ANTENNA_STAGE_OUTPUT_CATALOG_PATH"],
  ["useAntennaFieldSolutionPayloadResource", ["solution 1", "magnetic_field_per_ampere", "port"], "DATA_ANTENNA_FIELD_SOLUTION_PAYLOAD_PATH"],
  ["useAntennaSourceSpectrumResource", ["spectrum 1"], "DATA_ANTENNA_SOURCE_SPECTRUM_PATH"],
  ["useAntennaSourceSpectrumPayloadResource", ["spectrum 1", "power"], "DATA_ANTENNA_SOURCE_SPECTRUM_PAYLOAD_PATH"],
  ["useAntennaExternalLeadInspectionResource", [inspection.runtime_stage_id], "DATA_ANTENNA_EXTERNAL_LEAD_INSPECTION_PATH"],
  ["useAntennaExternalLeadInspectionPayloadResource", [inspection, "magnetic_field"], "DATA_ANTENNA_EXTERNAL_LEAD_INSPECTION_PAYLOAD_PATH"],
];
const identity = confirmedAntennaIdentity();
const identityScope = antennaIdentity.namespace.sessionRequestScopeKey(identity);
// Deliberately differ from render identity to prove forwarding from load context.
const loadScope = antennaIdentity.namespace.sessionRequestScopeKey({ ...identity, requestScopeEpoch: "load-context:99" });
const signal = new AbortController().signal;
const loadAntenna = (definition) => definition.load({ signal, sessionScopeKey: loadScope });
antennaResponse = { status: "ready", etag: '"server-owned-etag"', data: new ArrayBuffer(24) };
for (const [name, args, pathName] of antennaHookCases) {
  const definition = renderAntenna(name, args);
  assert.equal(definition.enabled, true, name);
  assert.ok(definition.resourceKey.startsWith(`${identityScope}|`), name);
  await loadAntenna(definition);
  assert.equal(antennaCalls.length, 1, name);
  assert.equal(antennaCalls[0].path, antennaPaths.namespace[pathName], name);
  assert.equal(antennaCalls[0].options.sessionScopeKey, loadScope, name);
  assert.equal(antennaCalls[0].options.signal, signal, name);
  assert.equal(renderAntenna(name, [...args, { enabled: false }]).enabled, false, name);
}
for (const unconfirmed of [null, { session: { ...confirmedOwner, request_scope_epoch: "" } }]) {
  antennaStatus = unconfirmed;
  for (const [name, args] of antennaHookCases) assert.equal(renderAntenna(name, args).enabled, false, name);
}
antennaStatus = { session: confirmedOwner };
antennaCollection = { sessions: [{ session_id: "another-session", current: true }] };
for (const [name, args] of antennaHookCases) assert.equal(renderAntenna(name, args).enabled, false, name);
antennaCollection = { sessions: [{ session_id: confirmedOwner.session_id, current: true }] };

const binaryRef = { sha256: "sha256:payload" };
const fieldManifest = { ...confirmedOwner, solution_id: "solution", content_digest: "sha256:manifest", bases: [], sample_positions: binaryRef };
const spectrumManifest = { ...confirmedOwner, output_id: "spectrum", content_digest: "sha256:manifest", payloads: { power: binaryRef } };
for (const [helper, manifest, kind, id] of [
  ["antennaFieldPayloadEtag", fieldManifest, "sample_positions", "solution"],
  ["antennaSpectrumPayloadEtag", spectrumManifest, "power", "spectrum"],
]) {
  const oldEtag = antennaHooks.namespace[helper](manifest, kind);
  const reopenedEtag = antennaHooks.namespace[helper]({ ...manifest, request_scope_epoch: "api-instance:8" }, kind);
  assert.notEqual(oldEtag, reopenedEtag);
  assert.ok(oldEtag.includes(`:${manifest.session_epoch}:${manifest.request_scope_epoch}:${id}:`));
}

const metadataDefinition = renderAntenna("useAntennaExternalLeadInspectionResource", [inspection.runtime_stage_id]);
antennaResponse = inspection;
assert.equal(await loadAntenna(metadataDefinition), inspection);
assert.equal(antennaCalls[0].params.stage_id, inspection.runtime_stage_id);
assert.equal(metadataDefinition.resolveRevision(inspection), `${inspection.stage_revision}:${inspection.record_content_digest}`);
assert.notEqual(metadataDefinition.resolveRevision({ ...inspection, stage_revision: 32 }), metadataDefinition.resolveRevision(inspection));
for (const status of ["failed", "cancelled"]) {
  const definition = renderAntenna("useAntennaExternalLeadInspectionResource", [inspection.runtime_stage_id]);
  assert.equal(definition.enabled, true, `${status} metadata remains inspectable`);
  antennaResponse = { ...inspection, status, manifest: null, outputs: [] };
  assert.equal(await loadAntenna(definition), antennaResponse);
  assert.equal(antennaResponse.qualification, "NOT VERIFIED");
}

const payloadHook = "useAntennaExternalLeadInspectionPayloadResource";
const payloadKinds = ["bundle", "sample_positions", "magnetic_field", "device_vertex_ids", "device_potential"];
const range = "bytes=0-7";
antennaResponse = { status: "ready", etag: '"server-owned-etag"', data: new ArrayBuffer(8) };
const initialPayloadKey = renderAntenna(payloadHook, [inspection, "magnetic_field"]).resourceKey;
for (const payloadKind of payloadKinds) {
  const definition = renderAntenna(payloadHook, [inspection, payloadKind, { range }]);
  assert.equal(definition.enabled, true);
  assert.ok(definition.resourceKey.includes(`content_digest=${encodeURIComponent(inspectionDigest)}`));
  assert.ok(definition.resourceKey.includes(`${inspection.stage_revision}:${inspection.record_content_digest}`));
  assert.ok(definition.resourceKey.includes(range));
  const result = await loadAntenna(definition);
  const request = antennaCalls[0];
  assert.equal(request.params.stage_id, inspection.runtime_stage_id);
  assert.equal(request.params.payload_kind, payloadKind);
  assert.equal(request.query.content_digest, inspectionDigest);
  assert.equal(request.options.range, range);
  assert.equal(request.options.maxResponseBytes, 128 * 1024 * 1024);
  assert.equal(request.options.etag, undefined, "inspection SHA must not become a predicted HTTP ETag");
  assert.equal(result, antennaResponse);
  assert.equal(definition.resolveRevision(result), result.etag);
  assert.notEqual(definition.resourceKey, initialPayloadKey);
}
assert.equal(inspection.manifest.magnetic_field.unit, "A/m");
assert.equal(inspection.outputs[0].payload_units.H, "A/m");
for (const changed of [
  { ...inspection, stage_revision: 32 },
  { ...inspection, record_content_digest: `sha256:${"d".repeat(64)}` },
]) assert.notEqual(renderAntenna(payloadHook, [changed, "magnetic_field"]).resourceKey, initialPayloadKey);
const changedDigest = `sha256:${"e".repeat(64)}`;
const changedOutput = { ...inspection.outputs[0], inspection_ref: { ...inspection.outputs[0].inspection_ref, content_digest: changedDigest } };
const changedInspection = { ...inspection, outputs: [changedOutput], manifest: { ...inspection.manifest, content_digest: changedDigest } };
assert.notEqual(renderAntenna(payloadHook, [changedInspection, "magnetic_field"]).resourceKey, initialPayloadKey);
antennaStatus = { session: { ...confirmedOwner, request_scope_epoch: "api-instance:8" } };
const reopenedInspection = { ...inspection, request_scope_epoch: "api-instance:8" };
const reopenedPayload = renderAntenna(payloadHook, [reopenedInspection, "magnetic_field"]);
assert.equal(reopenedPayload.enabled, true);
assert.notEqual(reopenedPayload.resourceKey, initialPayloadKey);
antennaStatus = { session: confirmedOwner };

const disabledInspections = [
  null, { ...inspection, status: "failed" }, { ...inspection, status: "cancelled" },
  { ...inspection, manifest: null }, { ...inspection, outputs: [] },
  { ...inspection, outputs: [inspection.outputs[0], inspection.outputs[0]] },
  { ...inspection, session_id: "another-session" }, { ...inspection, session_epoch: "another-epoch" },
  { ...inspection, request_scope_epoch: "api-instance:6" },
  { ...inspection, manifest: { ...inspection.manifest, content_digest: changedDigest } },
  { ...inspection, outputs: [{ ...changedOutput, inspection_ref: { ...changedOutput.inspection_ref, content_digest: "" } }] },
];
for (const invalid of disabledInspections) {
  const definition = renderAntenna(payloadHook, [invalid, "magnetic_field"]);
  assert.equal(definition.enabled, false);
  assert.equal(await loadAntenna(definition), null);
  assert.equal(antennaCalls.length, 0);
}
assert.equal(renderAntenna(payloadHook, [inspection, null]).enabled, false);
for (const cap of [256 * 1024 * 1024, 1024]) {
  antennaCalls.length = 0;
  const options = { maxResponseBytes: cap, sessionScopeKey: loadScope, range, etag: '"cached-server-etag"', signal };
  await antennaFacade.namespace.antenna.externalLeadInspectionPayload(inspection.runtime_stage_id, "bundle", inspectionDigest, options);
  assert.equal(antennaCalls[0].options.maxResponseBytes, Math.min(cap, 128 * 1024 * 1024));
  for (const key of ["sessionScopeKey", "range", "etag", "signal"]) assert.equal(antennaCalls[0].options[key], options[key]);
}

let antennaErrorCases = 0;
for (const [name, args] of antennaHookCases) {
  for (const [status, code] of [[409, "inspection_owner_changed"], [404, "missing_payload"], [422, "invalid_antenna_inspection"]]) {
    const definition = renderAntenna(name, args);
    antennaError = new AntennaApiError(status, code);
    await assert.rejects(loadAntenna(definition), (error) => error === antennaError, name);
    antennaErrorCases += 1;
  }
}
for (const index of [0, 1, 3, 5]) {
  const [name, args] = antennaHookCases[index];
  const definition = renderAntenna(name, args);
  antennaError = new AntennaApiError(404, "resource_not_found");
  assert.equal(await loadAntenna(definition), null, name);
  antennaErrorCases += 1;
}
antennaError = null;
delete context.antennaRequestProbe;

const composition = productionModule("src/modules/inspector/panels/antenna/AntennaCompositionRuntime.ts");
await composition.link(() => { throw new Error("Unexpected composition dependency"); });
await composition.evaluate();
const runtimeIds = { solutionId: "solution", stageId: "solve", spectrumOutputId: "spectrum", spectrumRequestId: "request", publishedRef: null };
const catalog = {
  ...confirmedOwner, status: "ready", stage_id: "solve",
  outputs: [{ output_id: "solution", solution_ref: { stage_id: "solve", asset_id: "asset", content_digest: "sha256:solution" } }],
};
const field = { ...confirmedOwner, status: "ready", solution_id: "solution", quantity: "H_ant_basis", asset_id: "asset", content_digest: "sha256:solution" };
const spectrum = { ...confirmedOwner, output_id: "spectrum", request_id: "request", solution_id: "solution", sampling: { solution_id: "solution" }, solution_content_digest: "sha256:solution" };
for (const [helper, data] of [["antennaFieldSolutionIdentityStatus", field], ["antennaSpectrumIdentityStatus", spectrum]]) {
  assert.equal(composition.namespace[helper](runtimeIds, { data, status: "ready" }, { data: catalog, status: "ready" }), "ready");
  assert.equal(composition.namespace[helper](runtimeIds, { data: { ...data, request_scope_epoch: "api-instance:8" }, status: "ready" }, { data: catalog, status: "ready" }), "identity mismatch");
}

// Interpret the exact private lifecycle method and actual prefix predicate;
// constructor parameter properties require transforms, so do not compile them.
const bridgeSource = readFileSync("src/kernel/realtime/RealtimeInvalidationBridge.ts", "utf8");
const controllerSource = readFileSync("src/kernel/resources/ResourceInvalidationController.ts", "utf8");
const sliceBetween = (source, start, end) => {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `Missing production slice: ${start}`);
  return source.slice(first, last);
};
const prefixPredicate = sliceBetween(controllerSource, "function resourceKeyMatchesPrefix(", "function isSessionScopedExactResourceKey(");
const lifecycleMethod = sliceBetween(bridgeSource, "  private invalidateRuntimeLifecycleDependents(", "  private invalidateHysteresisAnalysisDependents(");
const apiImports = sliceBetween(bridgeSource, "import {", '} from "../api/apiPaths";') + '} from "paths";';
const stagePrefix = sliceBetween(bridgeSource, "const ANTENNA_STAGE_OUTPUT_CATALOG_PREFIX =", "const ANTENNA_SOURCE_SPECTRUM_PREFIX =");
const dependentRevision = sliceBetween(bridgeSource, "function dependentResourceRevision(", "function defaultScheduleFlush(");
const lifecycleProbe = new vm.SourceTextModule(stripTypeScriptTypes(`
  ${apiImports}
  ${stagePrefix}
  ${dependentRevision}
  export ${prefixPredicate}
  export class LifecycleProbe { ${lifecycleMethod} }
`), { context });
await lifecycleProbe.link((specifier) => {
  assert.equal(specifier, "paths");
  return antennaPaths;
});
await lifecycleProbe.evaluate();
const stageKeys = [1, 5, 6].map((index) => renderAntenna(antennaHookCases[index][0], antennaHookCases[index][1]).resourceKey);
const unrelatedFieldKey = renderAntenna(antennaHookCases[0][0], antennaHookCases[0][1]).resourceKey;
const stageInvalidations = new Map();
const lifecycle = new lifecycleProbe.namespace.LifecycleProbe();
lifecycle.resources = {
  invalidate: () => {},
  invalidateMatching: () => {}, // Hysteresis matchers are outside this source probe.
  invalidatePrefix: (prefix, revision) => {
    for (const key of [...stageKeys, unrelatedFieldKey]) {
      if (lifecycleProbe.namespace.resourceKeyMatchesPrefix(key, prefix)) stageInvalidations.set(key, revision);
    }
  },
};
lifecycle.invalidateRuntimeLifecycleDependents(antennaPaths.namespace.SIMULATION_STAGES_EXECUTION_PATH, 44);
assert.equal(stageInvalidations.size, stageKeys.length);
for (const key of stageKeys) assert.ok(stageInvalidations.has(key));
assert.equal(stageInvalidations.has(unrelatedFieldKey), false);

// Interpret the actual external-lead Inspector model with synthetic metadata.
// This proves identity/codec guards, never native execution or field physics.
const inspectionModel = productionModule("src/modules/inspector/panels/antenna/AntennaExternalLeadInspectionModel.ts");
await inspectionModel.link((specifier) => {
  assert.equal(specifier, "@/kernel/resources/sessionResourceIdentity");
  return antennaIdentity;
});
await inspectionModel.evaluate();
const {
  MAX_INSPECTION_PREVIEW_SAMPLES,
  resolveInspectionRuntimeStage,
  inspectionSelectionMatchesContext,
  inspectionMatchesRuntimeStage,
  inspectionPreviewCount,
  decodeInspectionPreview,
} = inspectionModel.namespace;
assert.equal(MAX_INSPECTION_PREVIEW_SAMPLES, 8);
const execution = {
  ...confirmedOwner, run_id: inspection.run_id,
  stages: [
    { stage_id: inspection.stage_id, stage_index: 0, label: inspection.stage_id,
      study_node_id: inspection.stage_id, antenna_solve_stage_id: "other-definition" },
    { stage_id: inspection.runtime_stage_id, stage_index: 19, label: "Not the authored ID",
      study_node_id: "another-study-node", antenna_solve_stage_id: inspection.stage_id },
  ],
};
const mapped = resolveInspectionRuntimeStage(inspection.stage_id, execution, identity);
assert.equal(mapped.state, "mapped");
assert.equal(mapped.runtimeStageId, inspection.runtime_stage_id);
assert.equal(mapped.runId, inspection.run_id);
let inspectionMappingCases = 1;
for (const [candidate, owner, expected] of [
  [null, identity, "unavailable"],
  [execution, null, "unavailable"],
  [{ ...execution, stages: [execution.stages[0]] }, identity, "unavailable"],
  [{ ...execution, stages: [] }, identity, "unavailable"],
  [{ ...execution, stages: [execution.stages[1], { ...execution.stages[1], stage_id: "second-runtime" }] }, identity, "ambiguous"],
  [{ ...execution, stages: [{ ...execution.stages[1], stage_id: "" }] }, identity, "identity_mismatch"],
  [{ ...execution, run_id: "" }, identity, "identity_mismatch"],
]) {
  assert.equal(resolveInspectionRuntimeStage(inspection.stage_id, candidate, owner).state, expected);
  inspectionMappingCases += 1;
}
assert.equal(resolveInspectionRuntimeStage("study-node-only", {
  ...execution, stages: [{ stage_id: "study-node-only", stage_index: 0,
    label: "study-node-only", study_node_id: "study-node-only" }],
}, identity).state, "unavailable");
inspectionMappingCases += 1;
// Selection is a small view preference, not an alternate resource owner.
// Several equally labelled executions need an exact, context-pinned choice.
const repeatedExecution = {
  ...execution,
  stages: [execution.stages[0], execution.stages[1], {
    ...execution.stages[1], stage_id: "second-runtime", label: execution.stages[1].label,
  }],
};
const explicitSelection = {
  authoredStageId: inspection.stage_id, runtimeStageId: "second-runtime",
  runId: execution.run_id, identity,
};
assert.deepEqual(Array.from(resolveInspectionRuntimeStage(inspection.stage_id, repeatedExecution, identity).candidates,
  (candidate) => candidate.runtimeStageId), [inspection.runtime_stage_id, "second-runtime"]);
const explicitlyMapped = resolveInspectionRuntimeStage(inspection.stage_id, repeatedExecution, identity, explicitSelection);
assert.equal(explicitlyMapped.state, "mapped");
assert.equal(explicitlyMapped.runtimeStageId, "second-runtime");
assert.equal(inspectionMatchesRuntimeStage(inspection, inspection.stage_id, explicitlyMapped, identity), false);
assert.equal(inspectionMatchesRuntimeStage({ ...inspection, runtime_stage_id: "second-runtime" }, inspection.stage_id, explicitlyMapped, identity), true);
let inspectionSelectionCases = 4;
const pausedInspectionHook = renderAntenna("useAntennaExternalLeadInspectionResource", [inspection.runtime_stage_id, { pauseLoad: true }]);
assert.equal(pausedInspectionHook.enabled, true, "Paused metadata must retain its scoped cache subscription");
assert.equal(pausedInspectionHook.pauseLoad, true);
inspectionSelectionCases += 2;
for (const change of [
  { authoredStageId: "different-definition" }, { runId: "different-run" },
  ...["sessionId", "sessionEpoch", "requestScopeEpoch"].map((key) => ({ identity: { ...identity, [key]: `${identity[key]}:next` } })),
]) {
  const invalidSelection = { ...explicitSelection, ...change };
  assert.equal(inspectionSelectionMatchesContext(invalidSelection, inspection.stage_id, repeatedExecution, identity), false);
  assert.equal(resolveInspectionRuntimeStage(inspection.stage_id, repeatedExecution, identity, invalidSelection).state, "ambiguous");
  inspectionSelectionCases += 2;
}
for (const candidate of [repeatedExecution, { ...repeatedExecution, revision: 900 }]) {
  assert.equal(inspectionSelectionMatchesContext(explicitSelection, inspection.stage_id, candidate, identity), true);
  assert.equal(resolveInspectionRuntimeStage(inspection.stage_id, candidate, identity, explicitSelection).runtimeStageId, "second-runtime");
  inspectionSelectionCases += 2;
}
for (const runtimeStageId of ["foreign-runtime", execution.stages[0].stage_id]) {
  const disappeared = resolveInspectionRuntimeStage(inspection.stage_id, repeatedExecution, identity,
    { ...explicitSelection, runtimeStageId });
  assert.equal(disappeared.state, "unavailable");
  assert.equal(disappeared.candidates.length, 2);
  inspectionSelectionCases += 2;
}
assert.equal(resolveInspectionRuntimeStage(inspection.stage_id, execution, identity, explicitSelection).state, "unavailable",
  "A disappeared chosen execution silently fell back to the sole remaining result");
inspectionSelectionCases += 1;
for (const stages of [
  [execution.stages[1], execution.stages[1]],
  [execution.stages[1], { ...execution.stages[1], stage_id: " " }],
]) {
  const rejected = resolveInspectionRuntimeStage(inspection.stage_id, { ...execution, stages }, identity, explicitSelection);
  assert.equal(rejected.state, "identity_mismatch");
  assert.equal(rejected.candidates.length, 0);
  inspectionSelectionCases += 2;
}
for (const candidate of [null, { ...repeatedExecution, run_id: "new-run" }, { ...repeatedExecution, run_id: " " }]) {
  assert.equal(inspectionSelectionMatchesContext(explicitSelection, inspection.stage_id, candidate, identity), false);
  inspectionSelectionCases += 1;
}
for (const run_id of [undefined, null, 17]) {
  const invalidRun = { ...repeatedExecution, run_id };
  assert.equal(inspectionSelectionMatchesContext(explicitSelection, inspection.stage_id, invalidRun, identity), false);
  assert.equal(resolveInspectionRuntimeStage(inspection.stage_id, invalidRun, identity, explicitSelection).state, "identity_mismatch");
  inspectionSelectionCases += 2;
}
assert.equal(inspectionSelectionMatchesContext(explicitSelection, inspection.stage_id, repeatedExecution, null), false);
inspectionSelectionCases += 1;
for (const key of ["session_id", "session_epoch", "request_scope_epoch"]) {
  const rejected = resolveInspectionRuntimeStage(inspection.stage_id,
    { ...repeatedExecution, [key]: "different-owner" }, identity, explicitSelection);
  assert.equal(rejected.state, "identity_mismatch");
  assert.equal(rejected.candidates.length, 0);
  assert.equal(inspectionSelectionMatchesContext(explicitSelection, inspection.stage_id,
    { ...repeatedExecution, [key]: "different-owner" }, identity), false);
  inspectionSelectionCases += 3;
}
assert.equal(inspectionMatchesRuntimeStage(inspection, inspection.stage_id, mapped, identity), true);
let inspectionOwnerCases = 1;
for (const key of ["session_id", "session_epoch", "request_scope_epoch"]) {
  const changedOwner = { ...confirmedOwner, [key]: `${confirmedOwner[key]}:different-incarnation` };
  assert.equal(resolveInspectionRuntimeStage(inspection.stage_id, { ...execution, ...changedOwner }, identity).state, "identity_mismatch");
  assert.equal(inspectionMatchesRuntimeStage({ ...inspection, ...changedOwner }, inspection.stage_id, mapped, identity), false);
  const nextIdentity = antennaIdentity.namespace.sessionResourceIdentityFromStatus({ session: changedOwner });
  const nextMapping = resolveInspectionRuntimeStage(inspection.stage_id, { ...execution, ...changedOwner }, nextIdentity);
  assert.equal(nextMapping.state, "mapped");
  assert.equal(inspectionMatchesRuntimeStage(inspection, inspection.stage_id, nextMapping, nextIdentity), false);
  assert.equal(inspectionMatchesRuntimeStage({ ...inspection, ...changedOwner }, inspection.stage_id, nextMapping, nextIdentity), true);
  // Back at owner A, the former B payload must remain stale, not become A data.
  assert.equal(inspectionMatchesRuntimeStage({ ...inspection, ...changedOwner }, inspection.stage_id, mapped, identity), false);
  assert.equal(inspectionMatchesRuntimeStage(inspection, inspection.stage_id, mapped, identity), true);
  inspectionOwnerCases += 7;
}
for (const changed of [
  { ...inspection, run_id: "another-run" },
  { ...inspection, runtime_stage_id: inspection.stage_id },
  { ...inspection, stage_id: inspection.runtime_stage_id },
]) {
  assert.equal(inspectionMatchesRuntimeStage(changed, inspection.stage_id, mapped, identity), false);
  inspectionOwnerCases += 1;
}
for (const unavailable of [
  { state: "unavailable", message: "synthetic" },
  { state: "ambiguous", message: "synthetic" },
  { state: "identity_mismatch", message: "synthetic" },
]) {
  assert.equal(inspectionMatchesRuntimeStage(inspection, inspection.stage_id, unavailable, identity), false);
  inspectionOwnerCases += 1;
}
assert.equal(inspectionMatchesRuntimeStage(inspection, inspection.stage_id, mapped, null), false);
inspectionOwnerCases += 1;

const previewInspection = (sampleCount) => ({
  ...inspection,
  manifest: {
    ...inspection.manifest,
    sampling_carrier: { ...inspection.manifest.sampling_carrier, sample_count: sampleCount },
    sample_positions: { ...inspection.manifest.sample_positions, layout: "sample_xyz_interleaved",
      value_count: sampleCount * 3, byte_count: sampleCount * 3 * 8 },
    magnetic_field: { ...inspection.manifest.magnetic_field, layout: "sample_xyz_interleaved",
      value_count: sampleCount * 3, byte_count: sampleCount * 3 * 8 },
  },
});
for (const count of [1, 7, 8, 11, 1_000_000]) {
  assert.equal(inspectionPreviewCount(previewInspection(count)), Math.min(8, count));
}
const modelInspection = previewInspection(11);
const incompatibleMetadata = [
  { ...modelInspection, status: "ready" },
  { ...modelInspection, qualification: "VERIFIED" },
  { ...modelInspection, field_scope: "closed_circuit" },
  { ...modelInspection, manifest: null },
  { ...modelInspection, manifest: { ...modelInspection.manifest, validation_scope: "physics_validated" } },
  { ...modelInspection, outputs: [] },
  { ...modelInspection, outputs: [modelInspection.outputs[0], modelInspection.outputs[0]] },
];
for (const [key, value] of [["stage_id", "other-definition"], ["output_id", "other-output"], ["content_digest", changedDigest]]) {
  incompatibleMetadata.push({ ...modelInspection, outputs: [{ ...modelInspection.outputs[0],
    inspection_ref: { ...modelInspection.outputs[0].inspection_ref, [key]: value } }] });
}
for (const count of [0, -1, 1.5, NaN, Infinity, 1_000_001, Number.MAX_SAFE_INTEGER + 1]) {
  incompatibleMetadata.push(previewInspection(count));
}
for (const carrier of ["sample_positions", "magnetic_field"]) {
  for (const [key, value] of [
    ["scalar_type", "float64_be"], ["scalar_type", "float32_le"],
    ["layout", "component_major"], ["unit", carrier === "magnetic_field" ? "A/m/A" : "nm"],
    ["value_count", 32], ["byte_count", 263],
  ]) {
    incompatibleMetadata.push({ ...modelInspection, manifest: { ...modelInspection.manifest,
      [carrier]: { ...modelInspection.manifest[carrier], [key]: value } } });
  }
}
for (const candidate of incompatibleMetadata) assert.throws(() => inspectionPreviewCount(candidate));

const previewSamples = 8;
const previewBytes = previewSamples * 3 * 8;
const carrierBytes = modelInspection.manifest.magnetic_field.byte_count;
const previewBuffer = (field) => {
  const buffer = new ArrayBuffer(previewBytes);
  const view = new DataView(buffer);
  for (let index = 0; index < previewSamples; index += 1) {
    for (let component = 0; component < 3; component += 1) {
      // Distinct signed fractional values detect byte order and any /A scaling.
      const value = field ? (index + 1) * 101.25 + component : -(index + 1) * 0.125 - component * 0.25;
      view.setFloat64((index * 3 + component) * 8, value, true);
    }
  }
  return buffer;
};
const previewPayload = (field) => ({
  status: "ready", etag: '"synthetic-server-etag"', data: previewBuffer(field),
  byteLength: previewBytes, contentRange: `bytes 0-${previewBytes - 1}/${carrierBytes}`,
});
const positionPreview = previewPayload(false);
const fieldPreview = previewPayload(true);
const decodedPreview = decodeInspectionPreview(positionPreview, fieldPreview, previewSamples, carrierBytes);
assert.equal(decodedPreview.length, 8);
for (let index = 0; index < previewSamples; index += 1) {
  for (let component = 0; component < 3; component += 1) {
    assert.equal(decodedPreview[index].positionM[component], -(index + 1) * 0.125 - component * 0.25);
    assert.equal(decodedPreview[index].fieldApm[component], (index + 1) * 101.25 + component);
  }
}
const singlePreview = (payload) => ({ ...payload, data: payload.data.slice(0, 24),
  byteLength: 24, contentRange: "bytes 0-23/24" });
const decodedSingle = decodeInspectionPreview(singlePreview(positionPreview), singlePreview(fieldPreview), 1, 24);
assert.equal(decodedSingle.length, 1);
assert.equal(decodedSingle[0].fieldApm[0], 101.25);
let inspectionDecodeRejections = 0;
for (const key of ["positions", "field"]) {
  for (const change of [
    { status: "not_modified" }, { etag: null }, { etag: "" }, { etag: undefined },
    { byteLength: previewBytes - 8 }, { data: new ArrayBuffer(previewBytes - 8) },
    { byteLength: carrierBytes, data: new ArrayBuffer(carrierBytes) },
    { contentRange: `bytes 8-${previewBytes + 7}/${carrierBytes}` },
    { contentRange: `bytes 0-${previewBytes - 1}/${carrierBytes + 8}` },
    { contentRange: `bytes 0-${carrierBytes - 1}/${carrierBytes}` },
    { contentRange: null },
  ]) {
    const positions = key === "positions" ? { ...positionPreview, ...change } : positionPreview;
    const field = key === "field" ? { ...fieldPreview, ...change } : fieldPreview;
    assert.throws(() => decodeInspectionPreview(positions, field, previewSamples, carrierBytes));
    inspectionDecodeRejections += 1;
  }
  for (const value of [NaN, Infinity, -Infinity]) {
    const invalid = previewPayload(key === "field");
    new DataView(invalid.data).setFloat64(previewBytes - 8, value, true);
    assert.throws(() => decodeInspectionPreview(
      key === "positions" ? invalid : positionPreview,
      key === "field" ? invalid : fieldPreview,
      previewSamples, carrierBytes,
    ));
    inspectionDecodeRejections += 1;
  }
}
for (const [count, bytes] of [
  [0, carrierBytes], [-1, carrierBytes], [1.5, carrierBytes], [9, carrierBytes],
  [NaN, carrierBytes], [Infinity, carrierBytes], [8, previewBytes - 1],
  [8, Number.MAX_SAFE_INTEGER + 1], [8, Infinity],
]) {
  assert.throws(() => decodeInspectionPreview(positionPreview, fieldPreview, count, bytes));
  inspectionDecodeRejections += 1;
}
sharedResourceRuntimeStore.resetForTests();
console.log(JSON.stringify({
  check: "resource-client-cache-scope",
  groups: 28,
  preserved_prior_groups: 19,
  antenna_hooks: antennaHookCases.length,
  antenna_payload_kinds: payloadKinds.length,
  antenna_disabled_payload_cases: disabledInspections.length + 1,
  antenna_error_cases: antennaErrorCases,
  antenna_composition_aba_cases: 2,
  antenna_scoped_stage_invalidations: stageInvalidations.size,
  antenna_inspection_mapping_cases: inspectionMappingCases,
  antenna_inspection_selection_cases: inspectionSelectionCases,
  antenna_inspection_owner_cases: inspectionOwnerCases,
  antenna_inspection_metadata_rejections: incompatibleMetadata.length,
  antenna_inspection_preview_samples: decodedPreview.length,
  antenna_inspection_decode_rejections: inspectionDecodeRejections,
  passed: true,
  emitted_code: false,
}));
