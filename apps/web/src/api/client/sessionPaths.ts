import { openApiV2Path } from "../generated/openapi-v2-paths";

export const V2_CURRENT_SESSION = "/v2/sessions/current" as const;

export const sessionApiPaths = {
  platform: {
    health: openApiV2Path("/v2/platform/health"),
    capabilities: openApiV2Path("/v2/platform/capabilities"),
    openapi: openApiV2Path("/v2/platform/openapi.json"),
    asyncapi: openApiV2Path("/v2/platform/asyncapi.json"),
  },
  status: openApiV2Path("/v2/sessions/current/status"),
  events: {
    ws: openApiV2Path("/v2/sessions/current/events/ws"),
  },
  model: {
    scene: openApiV2Path("/v2/sessions/current/model/scene"),
    geometryCapabilities: openApiV2Path("/v2/sessions/current/model/geometry/capabilities"),
    geometryValidation: openApiV2Path("/v2/sessions/current/model/geometry/validation"),
    geometryRealizations: openApiV2Path("/v2/sessions/current/model/geometry/realizations"),
    geometryRealizationCurrent: openApiV2Path("/v2/sessions/current/model/geometry/realizations/current"),
    geometryDiagnostics: openApiV2Path("/v2/sessions/current/model/geometry/diagnostics"),
    geometryDiagnostic: (diagnosticId: string) =>
      openApiV2Path("/v2/sessions/current/model/geometry/diagnostics/{diagnostic_id}").replace("{diagnostic_id}", encodeURIComponent(diagnosticId)),
    regions: openApiV2Path("/v2/sessions/current/model/regions"),
    region: (regionId: string) =>
      openApiV2Path("/v2/sessions/current/model/regions/{region_id}").replace("{region_id}", encodeURIComponent(regionId)),
    objects: openApiV2Path("/v2/sessions/current/model/objects"),
    object: (objectId: string) =>
      openApiV2Path("/v2/sessions/current/model/objects/{object_id}").replace("{object_id}", encodeURIComponent(objectId)),
    objectGeometry: (objectId: string) =>
      openApiV2Path("/v2/sessions/current/model/objects/{object_id}/geometry").replace("{object_id}", encodeURIComponent(objectId)),
    material: (materialId: string) =>
      openApiV2Path("/v2/sessions/current/model/materials/{material_id}").replace("{material_id}", encodeURIComponent(materialId)),
    objectInteraction: (objectId: string, interactionKind: string) =>
      openApiV2Path("/v2/sessions/current/model/objects/{object_id}/interactions/{interaction_kind}")
        .replace("{object_id}", encodeURIComponent(objectId))
        .replace("{interaction_kind}", encodeURIComponent(interactionKind)),
    study: openApiV2Path("/v2/sessions/current/model/study"),
    script: openApiV2Path("/v2/sessions/current/model/script"),
    syncs: openApiV2Path("/v2/sessions/current/model/syncs"),
    transactions: openApiV2Path("/v2/sessions/current/model/transactions"),
    universe: openApiV2Path("/v2/sessions/current/model/universe"),
    universeFit: openApiV2Path("/v2/sessions/current/model/universe/fit"),
  },
  simulation: {
    commands: openApiV2Path("/v2/sessions/current/simulation/commands"),
    command: (commandId: string) =>
      openApiV2Path("/v2/sessions/current/simulation/commands/{command_id}").replace("{command_id}", encodeURIComponent(commandId)),
    runsCurrent: openApiV2Path("/v2/sessions/current/simulation/runs/current"),
    run: (runId: string) =>
      openApiV2Path("/v2/sessions/current/simulation/runs/{run_id}").replace("{run_id}", encodeURIComponent(runId)),
    stagesExecution: openApiV2Path("/v2/sessions/current/simulation/stages/execution"),
    solverStatus: openApiV2Path("/v2/sessions/current/simulation/solver/status"),
    solverEnergiesCurrent: openApiV2Path("/v2/sessions/current/simulation/solver/energies/current"),
    solverEnergiesHistory: openApiV2Path("/v2/sessions/current/simulation/solver/energies/history"),
  },
  data: {
    quantities: openApiV2Path("/v2/sessions/current/data/quantities"),
    fields: openApiV2Path("/v2/sessions/current/data/fields"),
    domainMeta: openApiV2Path("/v2/sessions/current/data/domain/meta"),
    domainTopology: openApiV2Path("/v2/sessions/current/data/domain/topology"),
    fieldMeta: (quantityId: string) =>
      openApiV2Path("/v2/sessions/current/data/fields/{quantity_id}/meta").replace("{quantity_id}", encodeURIComponent(quantityId)),
    fieldVector: (quantityId: string) =>
      openApiV2Path("/v2/sessions/current/data/fields/{quantity_id}/samples/vector").replace("{quantity_id}", encodeURIComponent(quantityId)),
    fieldSliceMeta: (quantityId: string) =>
      openApiV2Path("/v2/sessions/current/data/fields/{quantity_id}/samples/slice/meta").replace("{quantity_id}", encodeURIComponent(quantityId)),
    fieldSliceScalar: (quantityId: string) =>
      openApiV2Path("/v2/sessions/current/data/fields/{quantity_id}/samples/slice/scalar").replace("{quantity_id}", encodeURIComponent(quantityId)),
    fieldSliceArrows: (quantityId: string) =>
      openApiV2Path("/v2/sessions/current/data/fields/{quantity_id}/samples/slice/arrows").replace("{quantity_id}", encodeURIComponent(quantityId)),
    scalars: openApiV2Path("/v2/sessions/current/data/scalars"),
    artifacts: openApiV2Path("/v2/sessions/current/data/artifacts"),
    artifact: (artifactId: string) =>
      openApiV2Path("/v2/sessions/current/data/artifacts/{artifact_id}").replace("{artifact_id}", encodeURIComponent(artifactId)),
  },
  visualization: {
    display: openApiV2Path("/v2/sessions/current/visualization/display"),
  },
  workspace: {
    layout: openApiV2Path("/v2/sessions/current/workspace/layout"),
    ribbon: openApiV2Path("/v2/sessions/current/workspace/ribbon"),
    selection: openApiV2Path("/v2/sessions/current/workspace/selection"),
    activeNode: openApiV2Path("/v2/sessions/current/workspace/tree/active-node"),
  },
  meshing: {
    summary: openApiV2Path("/v2/sessions/current/meshing/summary"),
    capabilities: openApiV2Path("/v2/sessions/current/meshing/capabilities"),
    semantics: openApiV2Path("/v2/sessions/current/meshing/semantics"),
    policyUniverse: openApiV2Path("/v2/sessions/current/meshing/policies/universe"),
    universeQuality: openApiV2Path("/v2/sessions/current/meshing/meshes/universe/quality"),
    universeReport: openApiV2Path("/v2/sessions/current/meshing/meshes/universe/report"),
    policySharedDomain: openApiV2Path("/v2/sessions/current/meshing/policies/shared-domain"),
    policyObject: (objectId: string) =>
      openApiV2Path("/v2/sessions/current/meshing/policies/objects/{object_id}").replace("{object_id}", encodeURIComponent(objectId)),
    policyInterface: (interfaceId: string) =>
      openApiV2Path("/v2/sessions/current/meshing/policies/interfaces/{interface_id}").replace("{interface_id}", encodeURIComponent(interfaceId)),
    builds: openApiV2Path("/v2/sessions/current/meshing/builds"),
    currentBuild: openApiV2Path("/v2/sessions/current/meshing/builds/current"),
    latestSuccessfulBuild: openApiV2Path("/v2/sessions/current/meshing/builds/latest-successful"),
    sharedDomainManifest: openApiV2Path("/v2/sessions/current/meshing/meshes/shared-domain/manifest"),
    sharedDomainTopology: openApiV2Path("/v2/sessions/current/meshing/meshes/shared-domain/topology"),
    sharedDomainQuality: openApiV2Path("/v2/sessions/current/meshing/meshes/shared-domain/quality"),
    sharedDomainReport: openApiV2Path("/v2/sessions/current/meshing/meshes/shared-domain/report"),
    objectTopology: (objectId: string) =>
      openApiV2Path("/v2/sessions/current/meshing/meshes/objects/{object_id}/topology").replace("{object_id}", encodeURIComponent(objectId)),
    partTopology: (partId: string) =>
      openApiV2Path("/v2/sessions/current/meshing/meshes/parts/{part_id}/topology").replace("{part_id}", encodeURIComponent(partId)),
    objectSizeField: (objectId: string) =>
      openApiV2Path("/v2/sessions/current/meshing/meshes/objects/{object_id}/size-field").replace("{object_id}", encodeURIComponent(objectId)),
    objectQuality: (objectId: string) =>
      openApiV2Path("/v2/sessions/current/meshing/meshes/objects/{object_id}/quality").replace("{object_id}", encodeURIComponent(objectId)),
    objectReport: (objectId: string) =>
      openApiV2Path("/v2/sessions/current/meshing/meshes/objects/{object_id}/report").replace("{object_id}", encodeURIComponent(objectId)),
    interfaceQuality: (interfaceId: string) =>
      openApiV2Path("/v2/sessions/current/meshing/meshes/interfaces/{interface_id}/quality").replace("{interface_id}", encodeURIComponent(interfaceId)),
    interfaceReport: (interfaceId: string) =>
      openApiV2Path("/v2/sessions/current/meshing/meshes/interfaces/{interface_id}/report").replace("{interface_id}", encodeURIComponent(interfaceId)),
  },
  analysis: {
    eigenSpectrum: openApiV2Path("/v2/sessions/current/analysis/eigenmodes/spectrum"),
    eigenMode: (modeId: string) =>
      openApiV2Path("/v2/sessions/current/analysis/eigenmodes/modes/{mode_id}").replace("{mode_id}", encodeURIComponent(modeId)),
    eigenDispersion: openApiV2Path("/v2/sessions/current/analysis/eigenmodes/dispersion"),
    eigenBranches: openApiV2Path("/v2/sessions/current/analysis/eigenmodes/branches"),
  },
  persistence: {
    checkpoints: openApiV2Path("/v2/sessions/current/persistence/checkpoints"),
    exports: openApiV2Path("/v2/sessions/current/persistence/exports"),
    importInspections: openApiV2Path("/v2/sessions/current/persistence/imports/inspections"),
    imports: openApiV2Path("/v2/sessions/current/persistence/imports"),
    assetImport: openApiV2Path("/v2/sessions/current/persistence/assets/import"),
    recovery: openApiV2Path("/v2/sessions/current/persistence/recovery"),
  },
  diagnostics: {
    gpu: openApiV2Path("/v2/sessions/current/diagnostics/gpu"),
    engineLog: openApiV2Path("/v2/sessions/current/diagnostics/engine-log"),
  },
} as const;
