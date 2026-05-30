import {
  ANALYSIS_FREQUENCY_RESPONSE_MAGNETIC_SWEEP_V1_PATH,
  API_CONTRACT_VERSION_HEADER,
  DATA_FIELDS_PATH,
  DATA_DOMAIN_META_PATH,
  DATA_DOMAIN_TOPOLOGY_PATH,
  DATA_FIELD_VECTOR_PATH,
  EXPECTED_API_CONTRACT_VERSION,
  DATA_SCALARS_PATH,
  DIAGNOSTICS_CPU_PATH,
  DIAGNOSTICS_ENGINE_LOG_PATH,
  DIAGNOSTICS_GPU_PATH,
  DIAGNOSTICS_SOLVER_PROFILE_PATH,
  MESHING_CAPABILITIES_PATH,
  MESHING_BUILDS_PATH,
  MESHING_BUILDS_CURRENT_PATH,
  MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
  MESHING_SHARED_DOMAIN_CROSS_SECTION_IMAGE_PATH,
  MESHING_SHARED_DOMAIN_CROSS_SECTION_PATH,
  MESHING_SHARED_DOMAIN_CROSS_SECTION_QUALITY_PATH,
  MESHING_SEMANTICS_PATH,
  MESHING_SHARED_DOMAIN_POLICY_PATH,
  MESHING_SHARED_DOMAIN_QUALITY_DATA_PATH,
  MESHING_SHARED_DOMAIN_QUALITY_GATES_PATH,
  MESHING_SHARED_DOMAIN_QUALITY_PATH,
  MESHING_SHARED_DOMAIN_REALIZED_SIZE_FIELDS_PATH,
  MESHING_SHARED_DOMAIN_REPORT_PATH,
  MESHING_OBJECT_POLICY_PATH,
  MESHING_OBJECT_TOPOLOGY_PATH,
  MESHING_OBJECT_QUALITY_PATH,
  MESHING_OBJECT_REPORT_PATH,
  MESHING_OBJECT_SIZE_FIELD_PATH,
  MESHING_PART_TOPOLOGY_PATH,
  MESHING_SHARED_DOMAIN_MANIFEST_PATH,
  MESHING_SHARED_DOMAIN_TOPOLOGY_PATH,
  MESHING_SUMMARY_PATH,
  MESHING_UNIVERSE_POLICY_PATH,
  MESHING_UNIVERSE_QUALITY_PATH,
  MESHING_UNIVERSE_REPORT_PATH,
  MODEL_GEOMETRY_CAPABILITIES_PATH,
  MODEL_GEOMETRY_DIAGNOSTIC_PATH,
  MODEL_GEOMETRY_DIAGNOSTICS_PATH,
  MODEL_GEOMETRY_REALIZATION_CURRENT_PATH,
  MODEL_GEOMETRY_REALIZATIONS_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
  MODEL_MAGNETIZATION_ASSET_PATH,
  MODEL_MATERIAL_PATH,
  MODEL_OBJECT_GEOMETRY_PATH,
  MODEL_OBJECT_INTERACTION_PATH,
  MODEL_OBJECT_PATH,
  MODEL_OBJECTS_PATH,
  MODEL_REGION_PATH,
  MODEL_REGIONS_PATH,
  MODEL_SCENE_PATH,
  MODEL_STUDY_PATH,
  MODEL_TRANSACTIONS_PATH,
  MODEL_SYNCS_PATH,
  MODEL_UNIVERSE_PATH,
  PERSISTENCE_CHECKPOINT_PATH,
  PERSISTENCE_CHECKPOINT_RESTORE_PATH,
  PERSISTENCE_CHECKPOINTS_PATH,
  PERSISTENCE_EXPORTS_PATH,
  PERSISTENCE_IMPORT_INSPECTIONS_PATH,
  PERSISTENCE_IMPORTS_PATH,
  SESSION_STATUS_PATH,
  SIMULATION_COMMAND_DETAIL_PATH,
  SIMULATION_COMMANDS_PATH,
  SIMULATION_OBJECT_METRICS_PATH,
  SIMULATION_RUN_CURRENT_PATH,
  SIMULATION_RUN_PATH,
  SIMULATION_SOLVER_ENERGIES_CURRENT_PATH,
  SIMULATION_SOLVER_ENERGIES_HISTORY_PATH,
  SIMULATION_SOLVER_STATUS_PATH,
  SIMULATION_STAGES_EXECUTION_PATH,
  VISUALIZATION_CLIENT_ACKS_PATH,
  VISUALIZATION_STATE_PATH,
} from "./apiPaths";
import { resolveCanonicalQuantityId } from "./quantityIds";
import type {
  BinaryRequestOptions,
  BinaryResourceResult,
  AuthoringTransactionRequest,
  AuthoringTransactionResponse,
  CheckpointCreateRequest,
  CheckpointCreateResponse,
  CheckpointEntry,
  CheckpointListResource,
  CheckpointRestoreRequest,
  CheckpointRestoreResponse,
  CommandDetailResource,
  CommandQueueStatusResource,
  CommandResponse,
  CpuTelemetryResource,
  CrossSectionImageQuery,
  CrossSectionQuery,
  CrossSectionQualityQuery,
  CurrentRunResource,
  DomainMetaResource,
  EngineLogResource,
  FieldCatalogResource,
  FieldVectorQuery,
  GeometryCapabilitiesResource,
  GeometryDiagnosticsResource,
  GeometryRealizationRequest,
  GeometryRealizationResource,
  GeometryValidationResource,
  GpuTelemetryResource,
  LiveStatusResource,
  MagnetizationAssetPatchRequest,
  MagnetizationAssetResource,
  MagneticResponseSweepResource,
  MaterialPatchRequest,
  MaterialResource,
  MeshActiveBuildResource,
  MeshBuildHistoryResource,
  MeshCapabilitiesResource,
  MeshLastSuccessfulBuildResource,
  MeshObjectConfigReplaceRequest,
  MeshObjectConfigResource,
  MeshObjectQualityResource,
  MeshObjectReportResource,
  MeshObjectSizeFieldResource,
  MeshQualityGatesResource,
  MeshRealizedSizeFieldsResource,
  MeshSemanticsResource,
  MeshSharedDomainConfigReplaceRequest,
  MeshSharedDomainConfigResource,
  MeshSharedDomainQualityResource,
  MeshSharedDomainReportResource,
  MeshSharedDomainManifestResource,
  MeshSummaryResource,
  MeshUniverseConfigReplaceRequest,
  MeshUniverseConfigResource,
  MeshUniverseQualityResource,
  MeshUniverseReportResource,
  ObjectCreateRequest,
  ObjectGeometryPatchRequest,
  ObjectMetricsResource,
  ObjectInteractionKind,
  ObjectInteractionPatchRequest,
  ObjectInteractionResource,
  ObjectPatchRequest,
  RegionListResource,
  RegionPatchRequest,
  RequestOptions,
  ScalarWindowQuery,
  ScalarWindowResource,
  SceneResource,
  ScriptSyncRequest,
  ScriptSyncResponse,
  SessionExportRequest,
  SessionExportResponse,
  SessionImportCommitRequest,
  SessionImportCommitResponse,
  SessionImportInspectRequest,
  SessionImportInspectResponse,
  SolverEnergyCurrentResource,
  SolverEnergyHistoryResource,
  SolverProfileResource,
  SolverStatusResource,
  StageExecutionResource,
  StructuredCommandRequest,
  StudyRuntimePatchRequest,
  StudyRuntimeResource,
  UniversePatchRequest,
  UniverseResource,
  VisualizationClientAckEntry,
  VisualizationClientAckRequest,
  VisualizationClientAckResource,
  VisualizationStatePatch,
  VisualizationStateResource,
} from "./apiTypes";
import {
  decodeCrossSection,
  decodeCrossSectionQuality,
  decodeFieldVector,
  decodeMeshQualityData,
  decodeTopology,
  decodeTopologyHeader,
  decodeTopologySections,
  expectedTopologyByteLength,
  FMMT_HEADER_LEN,
  topologyByteLayout,
  type DecodedCrossSection,
  type DecodedCrossSectionQuality,
  type DecodedFieldVector,
  type DecodedMeshQualityData,
  type DecodedTopology,
  type TopologyHeader,
  type TopologySections,
} from "./codecs";
import {
  createBinaryDecodeScheduler,
  type BinaryDecoderKind,
  type BinaryDecodeScheduler,
} from "./binaryDecodeScheduler";
import {
  createOpenApiV2Transport,
  type OpenApiV2Transport,
} from "./generated/openapi-v2-client";
import type { OpenApiV2Path } from "./generated/openapi-v2-paths";
import type { RequestDiagnosticsController } from "./RequestDiagnosticsController";

type FetchLike = typeof fetch;
type PathParams = Record<string, string | number>;
type QueryParams = Record<string, unknown>;
type BinaryOpenApiTransportResult = {
  data?: unknown;
  error?: unknown;
  response: Response;
};

const CHUNKED_TOPOLOGY_THRESHOLD_BYTES = 16 * 1024 * 1024;
const TOPOLOGY_RANGE_CHUNK_BYTES = 8 * 1024 * 1024;

interface ControlRoomApiOptions {
  baseUrl?: string;
  binaryDecodeScheduler?: BinaryDecodeScheduler;
  diagnostics?: RequestDiagnosticsController;
  fetchImpl?: FetchLike;
  maxGetRetries?: number;
  requestIdFactory?: () => string;
}

export class ControlRoomApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ControlRoomApiError";
  }
}

export class ControlRoomApi {
  private readonly baseUrl: string;
  private readonly binaryDecodeScheduler: BinaryDecodeScheduler;
  private readonly requestDiagnostics: RequestDiagnosticsController | null;
  private readonly fetchImpl: FetchLike;
  private readonly maxGetRetries: number;
  private readonly requestIdFactory: () => string;
  private readonly transport: OpenApiV2Transport;

  readonly sessions = {
    current: {
      status: (options?: RequestOptions) =>
        this.requestJson<LiveStatusResource>(SESSION_STATUS_PATH, options),
    },
  };

  readonly commands = {
    detail: (commandId: string, options?: RequestOptions) =>
      this.requestJson<CommandDetailResource>(
        SIMULATION_COMMAND_DETAIL_PATH,
        options,
        { path: { command_id: commandId } },
      ),
    list: (options?: RequestOptions) =>
      this.requestJson<CommandQueueStatusResource>(
        SIMULATION_COMMANDS_PATH,
        options,
      ),
    submit: (command: StructuredCommandRequest, options?: RequestOptions) =>
      this.postJson<CommandResponse, StructuredCommandRequest>(
        SIMULATION_COMMANDS_PATH,
        command,
        options,
      ),
  };

  readonly analysis = {
    frequencyResponse: {
      magneticSweepV1: (options?: RequestOptions) =>
        this.requestJson<MagneticResponseSweepResource>(
          ANALYSIS_FREQUENCY_RESPONSE_MAGNETIC_SWEEP_V1_PATH,
          options,
        ),
    },
  };

  readonly data = {
    domain: {
      meta: (options?: RequestOptions) =>
        this.requestJson<DomainMetaResource>(DATA_DOMAIN_META_PATH, options),
      topology: (options?: BinaryRequestOptions) =>
        this.requestTopology(DATA_DOMAIN_TOPOLOGY_PATH, options),
      topologyBytes: (options?: BinaryRequestOptions) =>
        this.requestBinaryBytes(DATA_DOMAIN_TOPOLOGY_PATH, options),
      topologyChunked: (options?: BinaryRequestOptions) =>
        this.requestTopologyChunked(DATA_DOMAIN_TOPOLOGY_PATH, options),
    },
    fields: {
      catalog: (options?: RequestOptions) =>
        this.requestJson<FieldCatalogResource>(DATA_FIELDS_PATH, options),
      vector: (
        quantityId: string,
        query: FieldVectorQuery = {},
        options?: BinaryRequestOptions,
      ) =>
        this.requestFieldVector(
          DATA_FIELD_VECTOR_PATH,
          { quantity_id: resolveCanonicalQuantityId(quantityId) },
          query,
          options,
        ),
    },
    scalars: {
      window: (
        query: ScalarWindowQuery = {},
        options?: RequestOptions,
      ) =>
        this.requestJson<ScalarWindowResource>(
          DATA_SCALARS_PATH,
          options,
          { query: scalarWindowQueryParams(query) },
        ),
    },
  };

  readonly diagnostics = {
    engineLog: (options?: RequestOptions) =>
      this.requestJson<EngineLogResource>(
        DIAGNOSTICS_ENGINE_LOG_PATH,
        options,
      ),
    cpuTelemetry: (options?: RequestOptions) =>
      this.requestJson<CpuTelemetryResource>(DIAGNOSTICS_CPU_PATH, options),
    gpuTelemetry: (options?: RequestOptions) =>
      this.requestJson<GpuTelemetryResource>(DIAGNOSTICS_GPU_PATH, options),
    solverProfile: (options?: RequestOptions) =>
      this.requestJson<SolverProfileResource>(
        DIAGNOSTICS_SOLVER_PROFILE_PATH,
        options,
      ),
  };

  readonly meshing = {
    capabilities: (options?: RequestOptions) =>
      this.requestJson<MeshCapabilitiesResource>(
        MESHING_CAPABILITIES_PATH,
        options,
      ),
    semantics: (options?: RequestOptions) =>
      this.requestJson<MeshSemanticsResource>(MESHING_SEMANTICS_PATH, options),
    summary: (options?: RequestOptions) =>
      this.requestJson<MeshSummaryResource>(MESHING_SUMMARY_PATH, options),
    builds: {
      history: (options?: RequestOptions) =>
        this.requestJson<MeshBuildHistoryResource>(MESHING_BUILDS_PATH, options),
      current: (options?: RequestOptions) =>
        this.requestJson<MeshActiveBuildResource>(
          MESHING_BUILDS_CURRENT_PATH,
          options,
        ),
      latestSuccessful: (options?: RequestOptions) =>
        this.requestJson<MeshLastSuccessfulBuildResource>(
          MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
          options,
        ),
    },
    objectPolicy: (objectId: string, options?: RequestOptions) =>
      this.requestJson<MeshObjectConfigResource>(
        MESHING_OBJECT_POLICY_PATH,
        options,
        {
          path: { object_id: objectId },
        },
      ),
    objectQuality: (objectId: string, options?: RequestOptions) =>
      this.requestJson<MeshObjectQualityResource>(
        MESHING_OBJECT_QUALITY_PATH,
        options,
        {
          path: { object_id: objectId },
        },
      ),
    objectReport: (objectId: string, options?: RequestOptions) =>
      this.requestJson<MeshObjectReportResource>(
        MESHING_OBJECT_REPORT_PATH,
        options,
        {
          path: { object_id: objectId },
        },
      ),
    objectSizeField: (objectId: string, options?: RequestOptions) =>
      this.requestJson<MeshObjectSizeFieldResource>(
        MESHING_OBJECT_SIZE_FIELD_PATH,
        options,
        {
          path: { object_id: objectId },
        },
      ),
    objectTopology: (objectId: string, options?: BinaryRequestOptions) =>
      this.requestTopology(
        MESHING_OBJECT_TOPOLOGY_PATH,
        options,
        { object_id: objectId },
      ),
    partTopology: (partId: string, options?: BinaryRequestOptions) =>
      this.requestTopology(
        MESHING_PART_TOPOLOGY_PATH,
        options,
        { part_id: partId },
      ),
    replaceObjectPolicy: (
      objectId: string,
      request: MeshObjectConfigReplaceRequest,
      options?: RequestOptions,
    ) =>
      this.putJson<MeshObjectConfigResource, MeshObjectConfigReplaceRequest>(
        MESHING_OBJECT_POLICY_PATH,
        request,
        options,
        {
          path: { object_id: objectId },
        },
      ),
    sharedDomain: {
      manifest: (options?: RequestOptions) =>
        this.requestOptionalJson<MeshSharedDomainManifestResource>(
          MESHING_SHARED_DOMAIN_MANIFEST_PATH,
          options,
        ),
      policy: (options?: RequestOptions) =>
        this.requestJson<MeshSharedDomainConfigResource>(
          MESHING_SHARED_DOMAIN_POLICY_PATH,
          options,
        ),
      quality: (options?: RequestOptions) =>
        this.requestJson<MeshSharedDomainQualityResource>(
          MESHING_SHARED_DOMAIN_QUALITY_PATH,
          options,
        ),
      crossSection: (
        query: CrossSectionQuery,
        options?: BinaryRequestOptions,
      ) =>
        this.requestCrossSection(
          MESHING_SHARED_DOMAIN_CROSS_SECTION_PATH,
          query,
          options,
        ),
      crossSectionImage: (
        query: CrossSectionImageQuery,
        options?: BinaryRequestOptions,
      ) =>
        this.requestCrossSectionImage(
          MESHING_SHARED_DOMAIN_CROSS_SECTION_IMAGE_PATH,
          query,
          options,
        ),
      crossSectionQuality: (
        query: CrossSectionQualityQuery,
        options?: BinaryRequestOptions,
      ) =>
        this.requestCrossSectionQuality(
          MESHING_SHARED_DOMAIN_CROSS_SECTION_QUALITY_PATH,
          query,
          options,
        ),
      qualityData: (options?: BinaryRequestOptions) =>
        this.requestMeshQualityData(
          MESHING_SHARED_DOMAIN_QUALITY_DATA_PATH,
          options,
        ),
      qualityGates: (options?: RequestOptions) =>
        this.requestJson<MeshQualityGatesResource>(
          MESHING_SHARED_DOMAIN_QUALITY_GATES_PATH,
          options,
        ),
      realizedSizeFields: (options?: RequestOptions) =>
        this.requestJson<MeshRealizedSizeFieldsResource>(
          MESHING_SHARED_DOMAIN_REALIZED_SIZE_FIELDS_PATH,
          options,
        ),
      report: (options?: RequestOptions) =>
        this.requestJson<MeshSharedDomainReportResource>(
          MESHING_SHARED_DOMAIN_REPORT_PATH,
          options,
        ),
      replacePolicy: (
        request: MeshSharedDomainConfigReplaceRequest,
        options?: RequestOptions,
      ) =>
        this.putJson<
          MeshSharedDomainConfigResource,
          MeshSharedDomainConfigReplaceRequest
        >(MESHING_SHARED_DOMAIN_POLICY_PATH, request, options),
      topology: (options?: BinaryRequestOptions) =>
        this.requestTopology(MESHING_SHARED_DOMAIN_TOPOLOGY_PATH, options),
    },
    sharedDomainManifest: (options?: RequestOptions) =>
      this.requestOptionalJson<MeshSharedDomainManifestResource>(
        MESHING_SHARED_DOMAIN_MANIFEST_PATH,
        options,
      ),
    sharedDomainTopology: (options?: BinaryRequestOptions) =>
      this.requestTopology(MESHING_SHARED_DOMAIN_TOPOLOGY_PATH, options),
    universePolicy: (options?: RequestOptions) =>
      this.requestJson<MeshUniverseConfigResource>(
        MESHING_UNIVERSE_POLICY_PATH,
        options,
      ),
    universeQuality: (options?: RequestOptions) =>
      this.requestJson<MeshUniverseQualityResource>(
        MESHING_UNIVERSE_QUALITY_PATH,
        options,
      ),
    universeReport: (options?: RequestOptions) =>
      this.requestJson<MeshUniverseReportResource>(
        MESHING_UNIVERSE_REPORT_PATH,
        options,
      ),
    replaceUniversePolicy: (
      request: MeshUniverseConfigReplaceRequest,
      options?: RequestOptions,
    ) =>
      this.putJson<MeshUniverseConfigResource, MeshUniverseConfigReplaceRequest>(
        MESHING_UNIVERSE_POLICY_PATH,
        request,
        options,
      ),
  };

  readonly model = {
    commitTransaction: (
      transaction: AuthoringTransactionRequest,
      options?: RequestOptions,
    ) =>
      this.postJson<AuthoringTransactionResponse, AuthoringTransactionRequest>(
        MODEL_TRANSACTIONS_PATH,
        transaction,
        options,
      ),
    createObject: (request: ObjectCreateRequest, options?: RequestOptions) =>
      this.postJson<SceneResource, ObjectCreateRequest>(
        MODEL_OBJECTS_PATH,
        request,
        options,
      ),
    deleteObject: (objectId: string, options?: RequestOptions) =>
      this.deleteJson<SceneResource>(MODEL_OBJECT_PATH, options, {
        path: { object_id: objectId },
      }),
    geometry: {
      capabilities: (options?: RequestOptions) =>
        this.requestJson<GeometryCapabilitiesResource>(
          MODEL_GEOMETRY_CAPABILITIES_PATH,
          options,
        ),
      diagnostic: (diagnosticId: string, options?: RequestOptions) =>
        this.requestJson<GeometryDiagnosticsResource>(
          MODEL_GEOMETRY_DIAGNOSTIC_PATH,
          options,
          { path: { diagnostic_id: diagnosticId } },
        ),
      diagnostics: (options?: RequestOptions) =>
        this.requestJson<GeometryDiagnosticsResource>(
          MODEL_GEOMETRY_DIAGNOSTICS_PATH,
          options,
        ),
      realization: (options?: RequestOptions) =>
        this.requestJson<GeometryRealizationResource>(
          MODEL_GEOMETRY_REALIZATION_CURRENT_PATH,
          options,
        ),
      realize: (request: GeometryRealizationRequest, options?: RequestOptions) =>
        this.postJson<GeometryRealizationResource, GeometryRealizationRequest>(
          MODEL_GEOMETRY_REALIZATIONS_PATH,
          request,
          options,
        ),
      validation: (options?: RequestOptions) =>
        this.requestJson<GeometryValidationResource>(
          MODEL_GEOMETRY_VALIDATION_PATH,
          options,
        ),
    },
    patchObject: (
      objectId: string,
      patch: ObjectPatchRequest,
      options?: RequestOptions,
    ) =>
      this.patchJson<SceneResource, ObjectPatchRequest>(
        MODEL_OBJECT_PATH,
        patch,
        options,
        { path: { object_id: objectId } },
      ),
    patchObjectGeometry: (
      objectId: string,
      patch: ObjectGeometryPatchRequest,
      options?: RequestOptions,
    ) =>
      this.patchJson<SceneResource, ObjectGeometryPatchRequest>(
        MODEL_OBJECT_GEOMETRY_PATH,
        patch,
        options,
        { path: { object_id: objectId } },
      ),
    objectInteraction: (
      objectId: string,
      interactionKind: ObjectInteractionKind,
      options?: RequestOptions,
    ) =>
      this.requestJson<ObjectInteractionResource>(
        MODEL_OBJECT_INTERACTION_PATH,
        options,
        { path: { object_id: objectId, interaction_kind: interactionKind } },
      ),
    patchObjectInteraction: (
      objectId: string,
      interactionKind: ObjectInteractionKind,
      patch: ObjectInteractionPatchRequest,
      options?: RequestOptions,
    ) =>
      this.patchJson<ObjectInteractionResource, ObjectInteractionPatchRequest>(
        MODEL_OBJECT_INTERACTION_PATH,
        patch,
        options,
        { path: { object_id: objectId, interaction_kind: interactionKind } },
      ),
    material: (materialId: string, options?: RequestOptions) =>
      this.requestJson<MaterialResource>(MODEL_MATERIAL_PATH, options, {
        path: { material_id: materialId },
      }),
    magnetizationAsset: (assetId: string, options?: RequestOptions) =>
      this.requestJson<MagnetizationAssetResource>(
        MODEL_MAGNETIZATION_ASSET_PATH,
        options,
        { path: { asset_id: assetId } },
      ),
    patchMaterial: (
      materialId: string,
      patch: MaterialPatchRequest,
      options?: RequestOptions,
    ) =>
      this.patchJson<MaterialResource, MaterialPatchRequest>(
        MODEL_MATERIAL_PATH,
        patch,
        options,
        { path: { material_id: materialId } },
      ),
    patchMagnetizationAsset: (
      assetId: string,
      patch: MagnetizationAssetPatchRequest,
      options?: RequestOptions,
    ) =>
      this.patchJson<MagnetizationAssetResource, MagnetizationAssetPatchRequest>(
        MODEL_MAGNETIZATION_ASSET_PATH,
        patch,
        options,
        { path: { asset_id: assetId } },
      ),
    regions: (options?: RequestOptions) =>
      this.requestJson<RegionListResource>(MODEL_REGIONS_PATH, options),
    patchRegion: (
      regionId: string,
      patch: RegionPatchRequest,
      options?: RequestOptions,
    ) =>
      this.patchJson<SceneResource, RegionPatchRequest>(
        MODEL_REGION_PATH,
        patch,
        options,
        { path: { region_id: regionId } },
      ),
    scene: (options?: RequestOptions) =>
      this.requestJson<SceneResource>(MODEL_SCENE_PATH, options),
    syncAuthoringScript: (
      request: ScriptSyncRequest,
      options?: RequestOptions,
    ) =>
      this.postJson<ScriptSyncResponse, ScriptSyncRequest>(
        MODEL_SYNCS_PATH,
        request,
        options,
      ),
    study: (options?: RequestOptions) =>
      this.requestJson<StudyRuntimeResource>(MODEL_STUDY_PATH, options),
    patchStudy: (
      patch: StudyRuntimePatchRequest,
      options?: RequestOptions,
    ) =>
      this.patchJson<StudyRuntimeResource, StudyRuntimePatchRequest>(
        MODEL_STUDY_PATH,
        patch,
        options,
      ),
    universe: (options?: RequestOptions) =>
      this.requestJson<UniverseResource>(MODEL_UNIVERSE_PATH, options),
    updateUniverse: (patch: UniversePatchRequest, options?: RequestOptions) =>
      this.patchJson<UniverseResource, UniversePatchRequest>(
        MODEL_UNIVERSE_PATH,
        patch,
        options,
      ),
  };

  readonly persistence = {
    checkpoints: {
      create: (request: CheckpointCreateRequest, options?: RequestOptions) =>
        this.postJson<CheckpointCreateResponse, CheckpointCreateRequest>(
          PERSISTENCE_CHECKPOINTS_PATH,
          request,
          options,
        ),
      detail: (checkpointId: string, options?: RequestOptions) =>
        this.requestJson<CheckpointEntry>(
          PERSISTENCE_CHECKPOINT_PATH,
          options,
          { path: { checkpoint_id: checkpointId } },
        ),
      list: (options?: RequestOptions) =>
        this.requestJson<CheckpointListResource>(
          PERSISTENCE_CHECKPOINTS_PATH,
          options,
        ),
      restore: (
        checkpointId: string,
        request: CheckpointRestoreRequest,
        options?: RequestOptions,
      ) =>
        this.postJson<CheckpointRestoreResponse, CheckpointRestoreRequest>(
          PERSISTENCE_CHECKPOINT_RESTORE_PATH,
          request,
          options,
          { path: { checkpoint_id: checkpointId } },
        ),
    },
    exports: {
      create: (request: SessionExportRequest, options?: RequestOptions) =>
        this.postJson<SessionExportResponse, SessionExportRequest>(
          PERSISTENCE_EXPORTS_PATH,
          request,
          options,
        ),
    },
    imports: {
      commit: (request: SessionImportCommitRequest, options?: RequestOptions) =>
        this.postJson<SessionImportCommitResponse, SessionImportCommitRequest>(
          PERSISTENCE_IMPORTS_PATH,
          request,
          options,
        ),
      inspect: (
        request: SessionImportInspectRequest,
        options?: RequestOptions,
      ) =>
        this.postJson<
          SessionImportInspectResponse,
          SessionImportInspectRequest
        >(PERSISTENCE_IMPORT_INSPECTIONS_PATH, request, options),
    },
  };

  readonly simulation = {
    currentRun: (options?: RequestOptions) =>
      this.requestJson<CurrentRunResource>(
        SIMULATION_RUN_CURRENT_PATH,
        options,
      ),
    objects: {
      metrics: (objectId: string, options?: RequestOptions) =>
        this.requestJson<ObjectMetricsResource>(
          SIMULATION_OBJECT_METRICS_PATH,
          options,
          { path: { object_id: objectId } },
        ),
    },
    run: (runId: string, options?: RequestOptions) =>
      this.requestJson<CurrentRunResource>(
        SIMULATION_RUN_PATH,
        options,
        { path: { run_id: runId } },
      ),
    stages: {
      execution: (options?: RequestOptions) =>
        this.requestJson<StageExecutionResource>(
          SIMULATION_STAGES_EXECUTION_PATH,
          options,
        ),
    },
    solver: {
      energies: {
        current: (options?: RequestOptions) =>
          this.requestJson<SolverEnergyCurrentResource>(
            SIMULATION_SOLVER_ENERGIES_CURRENT_PATH,
            options,
          ),
        history: (limit?: number, options?: RequestOptions) =>
          this.requestJson<SolverEnergyHistoryResource>(
            SIMULATION_SOLVER_ENERGIES_HISTORY_PATH,
            options,
            limit === undefined ? undefined : { query: { limit } },
          ),
      },
      status: (options?: RequestOptions) =>
        this.requestJson<SolverStatusResource>(
          SIMULATION_SOLVER_STATUS_PATH,
          options,
        ),
    },
  };

  readonly visualization = {
    ack: (ack: VisualizationClientAckRequest, options?: RequestOptions) =>
      this.postJson<VisualizationClientAckEntry, VisualizationClientAckRequest>(
        VISUALIZATION_CLIENT_ACKS_PATH,
        ack,
        options,
      ),
    acks: (options?: RequestOptions) =>
      this.requestJson<VisualizationClientAckResource>(
        VISUALIZATION_CLIENT_ACKS_PATH,
        options,
      ),
    patch: (patch: VisualizationStatePatch, options?: RequestOptions) =>
      this.patchJson<VisualizationStateResource, VisualizationStatePatch>(
        VISUALIZATION_STATE_PATH,
        patch,
        options,
      ),
    state: (options?: RequestOptions) =>
      this.requestJson<VisualizationStateResource>(
        VISUALIZATION_STATE_PATH,
        options,
      ),
  };

  constructor({
    baseUrl,
    binaryDecodeScheduler = createBinaryDecodeScheduler(),
    diagnostics,
    fetchImpl,
    maxGetRetries = 1,
    requestIdFactory = () => crypto.randomUUID(),
  }: ControlRoomApiOptions = {}) {
    this.baseUrl = resolveBaseUrl(baseUrl);
    this.binaryDecodeScheduler = binaryDecodeScheduler;
    this.requestDiagnostics = diagnostics ?? null;
    this.fetchImpl = fetchImpl ?? resolveDefaultFetch();
    this.maxGetRetries = maxGetRetries;
    this.requestIdFactory = requestIdFactory;
    this.transport = createOpenApiV2Transport({
      baseUrl: this.baseUrl,
      fetch: (input) => this.executeOpenApiFetch(input, undefined),
    });
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  private async requestJson<T>(
    path: OpenApiV2Path,
    options: RequestOptions = {},
    params?: Record<string, unknown>,
  ): Promise<T> {
    const result = await this.transport.GET(path as never, {
      cache: "no-store",
      params,
      signal: options.signal,
    } as never);
    return readOpenApiResult<T>(result);
  }

  private async requestOptionalJson<T>(
    path: OpenApiV2Path,
    options: RequestOptions = {},
    params?: Record<string, unknown>,
  ): Promise<T | null> {
    const result = await this.transport.GET(path as never, {
      cache: "no-store",
      params,
      signal: options.signal,
    } as never);

    if (result.response?.status === 204 || result.response?.status === 304) {
      return null;
    }

    return readOpenApiResult<T>(result);
  }

  private async postJson<TResponse, TBody>(
    path: OpenApiV2Path,
    body: TBody,
    options: RequestOptions = {},
    params?: Record<string, unknown>,
  ): Promise<TResponse> {
    const result = await this.transport.POST(path as never, {
      body,
      cache: "no-store",
      params,
      signal: options.signal,
    } as never);
    return readOpenApiResult<TResponse>(result);
  }

  private async patchJson<TResponse, TBody>(
    path: OpenApiV2Path,
    body: TBody,
    options: RequestOptions = {},
    params?: Record<string, unknown>,
  ): Promise<TResponse> {
    const result = await this.transport.PATCH(path as never, {
      body,
      cache: "no-store",
      params,
      signal: options.signal,
    } as never);
    return readOpenApiResult<TResponse>(result);
  }

  private async putJson<TResponse, TBody>(
    path: OpenApiV2Path,
    body: TBody,
    options: RequestOptions = {},
    params?: Record<string, unknown>,
  ): Promise<TResponse> {
    const result = await this.transport.PUT(path as never, {
      body,
      cache: "no-store",
      params,
      signal: options.signal,
    } as never);
    return readOpenApiResult<TResponse>(result);
  }

  private async deleteJson<TResponse>(
    path: OpenApiV2Path,
    options: RequestOptions = {},
    params?: Record<string, unknown>,
  ): Promise<TResponse> {
    const result = await this.transport.DELETE(path as never, {
      cache: "no-store",
      params,
      signal: options.signal,
    } as never);
    return readOpenApiResult<TResponse>(result);
  }

  private requestTopology(
    path: OpenApiV2Path,
    options: BinaryRequestOptions = {},
    pathParams?: PathParams,
  ): Promise<BinaryResourceResult<DecodedTopology>> {
    return this.requestBinaryResource(
      path,
      "topology",
      decodeTopology,
      options,
      pathParams,
    );
  }

  private async requestTopologyChunked(
    path: OpenApiV2Path,
    options: BinaryRequestOptions = {},
    pathParams?: PathParams,
  ): Promise<BinaryResourceResult<DecodedTopology>> {
    const headerResult = await this.requestBinaryBytes(
      path,
      {
        ...options,
        range: `bytes=0-${FMMT_HEADER_LEN - 1}`,
      },
      pathParams,
    );
    if (headerResult.status !== "ready") {
      return headerResult;
    }

    const header = decodeTopologyHeader(headerResult.data);
    const expectedByteLength = expectedTopologyByteLength(header);
    if (expectedByteLength <= CHUNKED_TOPOLOGY_THRESHOLD_BYTES) {
      return this.requestBinaryResource(
        path,
        "topology",
        decodeTopology,
        options,
        pathParams,
      );
    }

    const contentLength =
      parseContentRangeTotal(headerResult.contentRange) ?? expectedByteLength;
    if (contentLength !== expectedByteLength) {
      throw new ControlRoomApiError(
        `FMMT content length mismatch: expected ${expectedByteLength}, got ${contentLength}`,
        0,
      );
    }

    const data = await this.loadTopologySectionsByRange(
      path,
      header,
      options,
      pathParams,
    );
    return {
      byteLength: expectedByteLength,
      data,
      etag: headerResult.etag,
      status: "ready",
    };
  }

  private async loadTopologySectionsByRange(
    path: OpenApiV2Path,
    header: TopologyHeader,
    options: BinaryRequestOptions,
    pathParams?: PathParams,
  ): Promise<DecodedTopology> {
    const layout = topologyByteLayout(header);
    const sections: TopologySections = {
      boundaryFaces: new Uint32Array(header.boundaryFaceCount * 3),
      boundaryMarkers: new Uint32Array(header.boundaryMarkerCount),
      elementMarkers: new Uint32Array(header.elementMarkerCount),
      indices: new Uint32Array(header.elementCount * 4),
      positions: new Float64Array(header.nodeCount * 3),
    };

    await Promise.all([
      this.loadTopologySectionByRange(
        path,
        options,
        pathParams,
        layout.positions,
        new Uint8Array(sections.positions.buffer),
      ),
      this.loadTopologySectionByRange(
        path,
        options,
        pathParams,
        layout.indices,
        new Uint8Array(sections.indices.buffer),
      ),
      this.loadTopologySectionByRange(
        path,
        options,
        pathParams,
        layout.boundaryFaces,
        new Uint8Array(sections.boundaryFaces.buffer),
      ),
      this.loadTopologySectionByRange(
        path,
        options,
        pathParams,
        layout.elementMarkers,
        new Uint8Array(sections.elementMarkers.buffer),
      ),
      this.loadTopologySectionByRange(
        path,
        options,
        pathParams,
        layout.boundaryMarkers,
        new Uint8Array(sections.boundaryMarkers.buffer),
      ),
    ]);

    return decodeTopologySections(header, sections);
  }

  private async loadTopologySectionByRange(
    path: OpenApiV2Path,
    options: BinaryRequestOptions,
    pathParams: PathParams | undefined,
    range: { end: number; start: number },
    target: Uint8Array,
  ): Promise<void> {
    if (target.byteLength === 0 || range.end < range.start) return;

    let written = 0;
    for (
      let start = range.start;
      start <= range.end;
      start += TOPOLOGY_RANGE_CHUNK_BYTES
    ) {
      const end = Math.min(start + TOPOLOGY_RANGE_CHUNK_BYTES - 1, range.end);
      const result = await this.requestBinaryBytes(
        path,
        {
          ...options,
          etag: null,
          range: `bytes=${start}-${end}`,
        },
        pathParams,
      );
      if (result.status !== "ready") {
        throw new ControlRoomApiError(
          `Expected topology byte range ${start}-${end}, got ${result.status}`,
          0,
        );
      }

      const bytes = new Uint8Array(result.data);
      target.set(bytes, written);
      written += bytes.byteLength;
    }
  }

  private requestBinaryBytes(
    path: OpenApiV2Path,
    options: BinaryRequestOptions = {},
    pathParams?: PathParams,
    query?: QueryParams,
  ): Promise<BinaryResourceResult<ArrayBuffer>> {
    return this.requestBinaryResource(
      path,
      "raw-bytes",
      (buffer) => buffer,
      options,
      pathParams,
      query,
    );
  }

  private requestMeshQualityData(
    path: OpenApiV2Path,
    options: BinaryRequestOptions = {},
  ): Promise<BinaryResourceResult<DecodedMeshQualityData>> {
    return this.requestBinaryResource(
      path,
      "mesh-quality-data",
      decodeMeshQualityData,
      options,
    );
  }

  private requestCrossSection(
    path: OpenApiV2Path,
    query: CrossSectionQuery,
    options: BinaryRequestOptions = {},
  ): Promise<BinaryResourceResult<DecodedCrossSection>> {
    return this.requestBinaryResource(
      path,
      "cross-section",
      decodeCrossSection,
      options,
      undefined,
      {
        include_polygons: query.includePolygons,
        include_wireframe: query.includeWireframe,
        plane: query.plane,
        position_percent: query.positionPercent,
      },
    );
  }

  private requestCrossSectionImage(
    path: OpenApiV2Path,
    query: CrossSectionImageQuery,
    options: BinaryRequestOptions = {},
  ): Promise<BinaryResourceResult<ArrayBuffer>> {
    return this.requestBinaryBytes(path, options, undefined, {
      color_scale: query.colorScale,
      filter_expression: query.filterExpression,
      legend: query.legend,
      metric: query.metric,
      plane: query.plane,
      position_percent: query.positionPercent,
      resolution: query.resolution,
      shrink_factor: query.shrinkFactor,
      wireframe: query.wireframe,
    });
  }

  private requestCrossSectionQuality(
    path: OpenApiV2Path,
    query: CrossSectionQualityQuery,
    options: BinaryRequestOptions = {},
  ): Promise<BinaryResourceResult<DecodedCrossSectionQuality>> {
    return this.requestBinaryResource(
      path,
      "cross-section-quality",
      decodeCrossSectionQuality,
      options,
      undefined,
      {
        metric: query.metric,
        plane: query.plane,
        position_percent: query.positionPercent,
      },
    );
  }

  private requestFieldVector(
    path: OpenApiV2Path,
    pathParams: PathParams,
    query: FieldVectorQuery,
    options: BinaryRequestOptions = {},
  ): Promise<BinaryResourceResult<DecodedFieldVector>> {
    return this.requestBinaryResource(
      path,
      "field-vector",
      decodeFieldVector,
      options,
      pathParams,
      query,
    );
  }

  private async requestBinaryResource<TData>(
    path: OpenApiV2Path,
    decoderKind: BinaryDecoderKind,
    decode: (buffer: ArrayBuffer) => TData,
    options: BinaryRequestOptions = {},
    pathParams?: PathParams,
    query?: QueryParams,
  ): Promise<BinaryResourceResult<TData>> {
    return measureControlRoomApiPerformance(
      `fullmag.api.requestBinaryResource.${decoderKind}`,
      async () => {
        const headers: Record<string, string> = {};
        if (options.etag) {
          headers["if-none-match"] = options.etag;
        }
        if (options.range) {
          headers.range = options.range;
        }

        const requestState: { lastResponse: Response | null } = {
          lastResponse: null,
        };
        let result: BinaryOpenApiTransportResult | null = null;
        try {
          result = await this.transport.GET(path as never, {
            cache: "no-store",
            fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
              const resp = await this.executeBinaryOpenApiFetch(input, init);
              requestState.lastResponse = resp;
              return resp;
            },
            headers,
            params: { path: pathParams, query },
            parseAs: "arrayBuffer",
            signal: options.signal,
          } as never) as unknown as BinaryOpenApiTransportResult;
        } catch (error) {
          const lastResponse = requestState.lastResponse;
          if (lastResponse && !lastResponse.ok) {
            throw new ControlRoomApiError(
              `Request failed with status ${lastResponse.status}`,
              lastResponse.status,
            );
          }
          throw error;
        }
        if (!result) {
          throw new ControlRoomApiError("Binary resource request did not return a response", 0);
        }
        const response = result.response;
        const etag = response.headers.get("etag");

        if (response.status === 304) {
          return { etag, status: "not-modified" };
        }

        if (response.status === 204) {
          return { etag, status: "not-applicable" };
        }

        if (!response.ok || result.error) {
          throw new ControlRoomApiError(
            await formatResponseError(response),
            response.status,
          );
        }

        const buffer = result.data as unknown;
        if (!(buffer instanceof ArrayBuffer)) {
          throw new ControlRoomApiError("Expected binary response body", 0);
        }
        const byteLength = buffer.byteLength;

        const decodeStartedAt = nowMs();
        const data =
          decoderKind === "raw-bytes"
            ? decode(buffer)
            : await this.binaryDecodeScheduler({
                buffer,
                decodeInline: decode,
                kind: decoderKind,
                path: path as string,
              });
        const decodeDurationMs = Math.max(0, nowMs() - decodeStartedAt);

        this.requestDiagnostics?.record({
          byteLength,
          channel: "http",
          contentType: response.headers.get("content-type"),
          detail: "decoded binary payload",
          direction: "rx",
          durationMs: decodeDurationMs,
          method: "GET",
          outcome: "ok",
          path: path as string,
          requestId: response.headers.get("x-request-id") ?? "binary-payload",
          status: response.status,
        });

        return {
          byteLength,
          contentRange: response.headers.get("content-range"),
          data,
          etag,
          status: "ready",
        };
      },
    );
  }

  private async executeBinaryOpenApiFetch(
    input: RequestInfo | URL,
    init: RequestInit | undefined,
  ): Promise<Response> {
    const request = await normalizeFetchInput(input, init);
    return this.executeFetchRequest(
      request.url,
      request.method,
      request.init,
      new Set([204, 304]),
      true,
    );
  }

  private async executeOpenApiFetch(
    input: RequestInfo | URL,
    init: RequestInit | undefined,
  ): Promise<Response> {
    const request = await normalizeFetchInput(input, init);
    return this.executeFetchRequest(request.url, request.method, request.init);
  }

  private async executeFetchRequest(
    url: string,
    method: string,
    init: RequestInit,
    acceptedStatuses = new Set<number>(),
    allowMissingContractVersion = false,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    const requestId = this.requestIdFactory();
    headers.set("x-request-id", requestId);

    const started = Date.now();
    const path = pathFromUrl(url);
    const maxAttempts = method === "GET" ? this.maxGetRetries + 1 : 1;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        this.requestDiagnostics?.record({
          byteLength: byteLengthFromBody(init.body),
          channel: "http",
          contentType: headers.get("content-type"),
          detail: `attempt ${attempt}`,
          direction: "tx",
          durationMs: null,
          method,
          outcome: "sent",
          path,
          requestId,
          status: null,
        });

        const fetchImpl = this.fetchImpl;
        const response = await fetchImpl(url, {
          ...init,
          cache: init.cache ?? "no-store",
          headers,
          method,
        });

        const contractVersionError = resolveContractVersionError(response, {
          allowMissing: allowMissingContractVersion,
        });
        const accepted =
          (response.ok || acceptedStatuses.has(response.status)) &&
          !contractVersionError;
        const responseDetail = await resolveResponseDiagnosticDetail({
          attempt,
          method,
          path,
          response,
        });
        this.requestDiagnostics?.record({
          byteLength: byteLengthFromHeaders(response.headers),
          channel: "http",
          contentType: response.headers.get("content-type"),
          detail: responseDetail,
          direction: "rx",
          durationMs: Date.now() - started,
          method,
          outcome: accepted ? "ok" : "error",
          path,
          requestId,
          status: response.status,
        });

        if (attempt < maxAttempts && response.status >= 500) {
          continue;
        }

        if (contractVersionError) {
          throw contractVersionError;
        }

        return response;
      } catch (error) {
        if (error instanceof ControlRoomApiError) {
          throw error;
        }

        lastError = error;
        if (
          attempt < maxAttempts &&
          !(error instanceof DOMException && error.name === "AbortError")
        ) {
          continue;
        }
      }
    }

    this.requestDiagnostics?.record({
      byteLength: null,
      channel: "http",
      contentType: null,
      detail: null,
      direction: "rx",
      durationMs: Date.now() - started,
      method,
      outcome:
        lastError instanceof DOMException && lastError.name === "AbortError"
          ? "aborted"
          : "network-error",
      path,
      requestId,
      status: null,
    });

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

function resolveBaseUrl(baseUrl: string | undefined): string {
  if (baseUrl !== undefined) {
    return baseUrl.replace(/\/$/, "");
  }

  if (typeof window !== "undefined") {
    return window.location.origin;
  }

  return "http://localhost";
}

function resolveDefaultFetch(): FetchLike {
  if (typeof globalThis.fetch !== "function") {
    throw new ControlRoomApiError("Fetch API is not available", 0);
  }

  return globalThis.fetch.bind(globalThis);
}

async function normalizeFetchInput(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<{ init: RequestInit; method: string; url: string }> {
  if (typeof Request !== "undefined" && input instanceof Request) {
    const method = init?.method ?? input.method;
    let body = init?.body;

    if (
      body === undefined &&
      method !== "GET" &&
      method !== "HEAD" &&
      input.body != null
    ) {
      body = await input.clone().arrayBuffer();
    }

    return {
      init: {
        ...init,
        body,
        cache: init?.cache ?? input.cache,
        headers: init?.headers ?? input.headers,
        signal: init?.signal ?? input.signal,
      },
      method,
      url: input.url,
    };
  }

  return {
    init: init ?? {},
    method: init?.method ?? "GET",
    url: String(input),
  };
}

function pathFromUrl(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function parseContentRangeTotal(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^bytes\s+\d+-\d+\/(\d+)$/i.exec(value.trim());
  if (!match) return null;
  const total = Number(match[1]);
  return Number.isFinite(total) ? total : null;
}

function scalarWindowQueryParams(query: ScalarWindowQuery): QueryParams {
  return {
    columns:
      query.columns && query.columns.length > 0
        ? query.columns.join(",")
        : undefined,
    limit: query.limit,
    since_revision: query.sinceRevision,
  };
}

function byteLengthFromHeaders(headers: Headers): number | null {
  const contentLength = headers.get("content-length");
  if (!contentLength) {
    return null;
  }

  const parsed = Number.parseInt(contentLength, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

async function measureControlRoomApiPerformance<T>(
  name: string,
  task: () => Promise<T>,
): Promise<T> {
  const performanceTarget =
    typeof performance !== "undefined" ? performance : null;
  if (
    !performanceTarget ||
    typeof performanceTarget.mark !== "function" ||
    typeof performanceTarget.measure !== "function"
  ) {
    return task();
  }

  const startMark = `${name}:start`;
  const endMark = `${name}:end`;
  performanceTarget.mark(startMark);
  try {
    return await task();
  } finally {
    performanceTarget.mark(endMark);
    try {
      performanceTarget.measure(name, startMark, endMark);
    } catch {
      // Gracefully ignore measurement errors to prevent crashing the API
    }
    performanceTarget.clearMarks?.(startMark);
    performanceTarget.clearMarks?.(endMark);
  }
}

function nowMs(): number {
  return typeof performance !== "undefined" &&
    typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function byteLengthFromBody(body: BodyInit | null | undefined): number | null {
  if (body == null) {
    return 0;
  }

  if (typeof body === "string") {
    return new TextEncoder().encode(body).byteLength;
  }

  if (body instanceof ArrayBuffer) {
    return body.byteLength;
  }

  if (ArrayBuffer.isView(body)) {
    return body.byteLength;
  }

  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
    return new TextEncoder().encode(body.toString()).byteLength;
  }

  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return body.size;
  }

  return null;
}

async function resolveResponseDiagnosticDetail({
  attempt,
  method,
  path,
  response,
}: {
  attempt: number;
  method: string;
  path: string;
  response: Response;
}): Promise<string> {
  const base = `attempt ${attempt}`;
  if (method !== "POST" || path !== SIMULATION_COMMANDS_PATH) {
    return base;
  }

  try {
    const payload = (await response.clone().json()) as Record<string, unknown>;
    const details = [base];
    const commandId = stringField(payload.command_id);
    if (commandId) {
      details.push(`command_id=${commandId}`);
    }
    if (typeof payload.accepted === "boolean") {
      details.push(`accepted=${payload.accepted}`);
    }
    const error = stringField(payload.error);
    if (error) {
      details.push(`error=${error}`);
    }
    return details.join("; ");
  } catch {
    return base;
  }
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function resolveContractVersionError(
  response: Response,
  options: { allowMissing?: boolean } = {},
): ControlRoomApiError | null {
  const actual = response.headers.get(API_CONTRACT_VERSION_HEADER);
  if (actual == null && options.allowMissing) {
    return null;
  }
  if (actual === EXPECTED_API_CONTRACT_VERSION) {
    return null;
  }

  return new ControlRoomApiError(
    `API contract version mismatch: expected ${EXPECTED_API_CONTRACT_VERSION}, got ${actual ?? "missing"}`,
    0,
  );
}

function readOpenApiResult<T>(result: {
  data?: unknown;
  error?: unknown;
  response?: Response;
}): T {
  const response = result.response;

  if (!response) {
    throw new ControlRoomApiError("OpenAPI transport returned no response", 0);
  }

  if (response.status === 304) {
    return undefined as T;
  }

  if (!response.ok) {
    throw new ControlRoomApiError(
      formatOpenApiError(result.error),
      response.status,
    );
  }

  return result.data as T;
}

function formatOpenApiError(error: unknown): string {
  if (error == null) {
    return "Request failed";
  }

  if (typeof error === "string") {
    return error;
  }

  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string") {
      return record.message;
    }
    if (typeof record.error === "string") {
      return record.error;
    }
  }

  return "Request failed";
}

async function formatResponseError(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) {
      return `Request failed with status ${response.status}`;
    }

    try {
      return formatOpenApiError(JSON.parse(text));
    } catch {
      return text;
    }
  } catch {
    return `Request failed with status ${response.status}`;
  }
}
