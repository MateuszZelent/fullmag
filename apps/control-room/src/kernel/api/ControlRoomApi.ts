import {
  ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DIAGNOSTICS_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_MODE_FIELD_META_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_DIAGNOSTICS_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FIELD_META_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FREQUENCY_POINT_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
  ANALYSIS_EIGEN_MODE_V2_PATH,
  ANALYSIS_FREQUENCY_RESPONSE_MAGNETIC_SWEEP_V1_PATH,
  ANALYSIS_DYNAMIC_STRUCTURE_FACTOR_V1_PATH,
  ANALYSIS_SPIN_WAVE_GAMMA_V1_PATH,
  ANALYSIS_OBJECT_TOPOLOGICAL_CHARGE_PATH,
  ANALYSIS_HYSTERESIS_POINTS_PATH,
  ANALYSIS_HYSTERESIS_METRICS_PATH,
  ANALYSIS_HYSTERESIS_SATURATION_PATH,
  ANALYSIS_HYSTERESIS_ADAPTIVE_REFINEMENT_PATH,
  ANALYSIS_HYSTERESIS_BRANCHES_PATH,
  ANALYSIS_HYSTERESIS_BOOKMARKS_PATH,
  ANALYSIS_HYSTERESIS_FAMILY_PATH,
  ANALYSIS_HYSTERESIS_FAMILY_VARIANT_POINTS_PATH,
  ANALYSIS_HYSTERESIS_MINOR_LOOPS_PATH,
  ANALYSIS_HYSTERESIS_REVERSAL_FIELDS_PATH,
  ANALYSIS_HYSTERESIS_POINT_PATH,
  ANALYSIS_HYSTERESIS_STAGE_SETTLE_TRACE_PATH,
  ANALYSIS_HYSTERESIS_SETTLE_TRACE_PATH,
  API_CONTRACT_VERSION_HEADER,
  DATA_FIELDS_PATH,
  DATA_ARTIFACT_PATH,
  DATA_ARTIFACTS_PATH,
  DATA_DOMAIN_META_PATH,
  DATA_DOMAIN_TOPOLOGY_PATH,
  DATA_FDM_REGION_MEMBERSHIP_BINARY_PATH,
  DATA_FDM_REGION_MEMBERSHIP_SCOPED_PATH,
  DATA_FDM_REGION_MEMBERSHIPS_PATH,
  DATA_FIELD_META_PATH,
  DATA_PLANAR_FIELD_EMPTY_MASK_PATH,
  DATA_PLANAR_FIELD_MESH_OVERLAY_PATH,
  DATA_PLANAR_FIELD_META_PATH,
  DATA_PLANAR_FIELD_PROBE_PATH,
  DATA_PLANAR_FIELD_RENDER_PNG_PATH,
  DATA_PLANAR_FIELD_SCALAR_PATH,
  DATA_PLANAR_FIELD_VECTORS_PATH,
  DATA_FIELD_VECTOR_PATH,
  DATA_MESH_REGION_MEMBERSHIP_PATH,
  DATA_MESH_REGION_MEMBERSHIPS_PATH,
  EXPECTED_API_CONTRACT_VERSION,
  DATA_SCALARS_PATH,
  DATA_TABLE_COLUMNS_PATH,
  DATA_TABLE_PATH,
  DATA_TABLE_ROWS_PATH,
  DATA_TABLE_ROWS_BINARY_PATH,
  DATA_TABLES_PATH,
  DIAGNOSTICS_CPU_PATH,
  DIAGNOSTICS_ENGINE_LOG_PATH,
  DIAGNOSTICS_GPU_PATH,
  DIAGNOSTICS_SOLVER_PROFILE_PATH,
  MESHING_CAPABILITIES_PATH,
  MESHING_BUILDS_PATH,
  MESHING_BUILDS_CURRENT_PATH,
  MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
  MESHING_HISTOGRAM_BIN_ELEMENTS_PATH,
  MESHING_PERIODIC_PAIRS_PATH,
  MESHING_PERIODIC_PAIRS_BINARY_PATH,
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
  MESHING_REGION_QUALITY_PATH,
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
  MODEL_COUPLINGS_PATH,
  MODEL_FIELD_DRIVE_PATH,
  MODEL_FIELD_DRIVES_PATH,
  MODEL_MAGNETIZATION_ASSET_PATH,
  MODEL_MATERIAL_FIELDS_PATH,
  MODEL_MATERIAL_PATH,
  MODEL_OBJECT_GEOMETRY_PATH,
  MODEL_OBJECT_INTERACTION_PATH,
  MODEL_OBJECT_PATH,
  MODEL_OBJECT_REGION_DUPLICATE_PATH,
  MODEL_OBJECT_REGION_PATH,
  MODEL_OBJECT_REGIONS_REORDER_PATH,
  MODEL_OBJECT_REGIONS_PATH,
  MODEL_OBJECTS_PATH,
  MODEL_PLANAR_MONITOR_DUPLICATE_PATH,
  MODEL_PLANAR_MONITOR_PATH,
  MODEL_PLANAR_MONITORS_PATH,
  MODEL_REGION_PATH,
  MODEL_REGION_DIAGNOSTICS_PATH,
  MODEL_REALIZED_REGIONS_PATH,
  MODEL_REGIONS_PATH,
  MODEL_SCENE_PATH,
  MODEL_SCRIPT_PATH,
  MODEL_STUDY_PATH,
  MODEL_TRANSACTIONS_PATH,
  MODEL_SYNCS_PATH,
  MODEL_UNIVERSE_PATH,
  PERSISTENCE_ASSET_IMPORT_PATH,
  PERSISTENCE_CHECKPOINT_PATH,
  PERSISTENCE_CHECKPOINT_RESTORE_PATH,
  PERSISTENCE_CHECKPOINTS_PATH,
  PERSISTENCE_EXPORTS_PATH,
  PERSISTENCE_FIELD_STATE_EXPORTS_PATH,
  PERSISTENCE_FIELD_STATE_IMPORT_INSPECTIONS_PATH,
  PERSISTENCE_FIELD_STATE_IMPORTS_PATH,
  PERSISTENCE_IMPORT_INSPECTIONS_PATH,
  PERSISTENCE_IMPORTS_PATH,
  SESSION_EVENTS_COMMUNICATION_POLICY_PATH,
  SESSION_STATUS_PATH,
  SIMULATION_COMMAND_DETAIL_PATH,
  SIMULATION_COMMANDS_PATH,
  SIMULATION_OBJECT_METRICS_PATH,
  SIMULATION_PREPARATION_PATH,
  SIMULATION_RUN_CURRENT_PATH,
  SIMULATION_RUN_PATH,
  SIMULATION_SOLVER_ENERGIES_CURRENT_PATH,
  SIMULATION_SOLVER_ENERGIES_HISTORY_PATH,
  SIMULATION_SOLVER_STATUS_PATH,
  SIMULATION_STAGE_HYSTERESIS_EXECUTION_TREE_PATH,
  SIMULATION_STAGE_HYSTERESIS_ORIENTATION_PATH,
  SIMULATION_STAGE_HYSTERESIS_PLAN_PATH,
  SIMULATION_STAGE_HYSTERESIS_PROGRESS_PATH,
  SIMULATION_STAGE_HYSTERESIS_PROTOCOL_PATH,
  SIMULATION_STAGE_HYSTERESIS_SATURATION_PATH,
  SIMULATION_STAGE_HYSTERESIS_SETTLE_PIPELINE_PATH,
  SIMULATION_STAGES_EXECUTION_PATH,
  VISUALIZATION_CLIENT_ACKS_PATH,
  VISUALIZATION_STATE_PATH,
} from "./apiPaths";
import {
  canonicalFieldVectorQuery,
  canonicalFieldVectorQueryParams,
} from "./fieldQueryIdentity";
import {
  fieldDisplayScale,
  resolveCanonicalQuantityId,
  storedFieldQuantityId,
} from "./quantityIds";
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
  CouplingListResource,
  DynamicStructureFactorResource,
  FieldDriveCreateRequest,
  FieldDriveDeleteRequest,
  FieldDriveListResource,
  FieldDriveReplaceRequest,
  SpinWaveGammaResource,
  CpuTelemetryResource,
  CrossSectionImageQuery,
  CrossSectionQuery,
  CrossSectionQualityQuery,
  CurrentRunResource,
  DomainMetaResource,
  EngineLogResource,
  FieldCatalogResource,
  FieldVectorIdentityIssue,
  FieldVectorResponseMetadata,
  FieldMetaResource,
  FieldMetaQuery,
  FieldStateExportRequest,
  FieldStateExportResponse,
  FieldStateImportRequest,
  FieldStateImportResponse,
  FieldStateInspectRequest,
  FieldStateInspectResponse,
  FieldVectorQuery,
  PlanarFieldMetaResource,
  PlanarFieldProbeQuery,
  PlanarFieldProbeResource,
  PlanarFieldQuery,
  PlanarMonitorCollectionResource,
  PlanarMonitorCreateRequest,
  PlanarMonitorDeleteRequest,
  PlanarMonitorDuplicateRequest,
  PlanarMonitorPatchRequest,
  PlanarMonitorResource,
  GeometryCapabilitiesResource,
  GeometryDiagnosticsResource,
  GeometryRealizationRequest,
  GeometryRealizationResource,
  GeometryValidationResource,
  GpuTelemetryResource,
  ImportSessionAssetRequest,
  LiveStatusResource,
  MagnetizationAssetPatchRequest,
  MagnetizationAssetResource,
  MagneticResponseSweepResource,
  FrequencyDomainManifestResource,
  FrequencyDomainJsonArtifactResource,
  FrequencyDomainTextArtifactResource,
  ArtifactResource,
  FrequencyDomainFieldResource,
  FrequencyDomainSweepProgressResource,
  JsonValue,
  HysteresisAdaptiveRefinementResource,
  HysteresisAngularFamilyResource,
  HysteresisBookmarkPointRequest,
  HysteresisBookmarksResource,
  HysteresisBranchesResource,
  HysteresisExecutionTreeResource,
  HysteresisMinorLoopsResource,
  HysteresisMetricsResource,
  HysteresisPointSchema,
  HysteresisPointsResource,
  HysteresisOrientationSchema,
  HysteresisProgressSchema,
  HysteresisProtocolSchema,
  HysteresisReversalFieldsResource,
  HysteresisSaturationResource,
  HysteresisSettlePipelineSchema,
  HysteresisSettleTraceEntrySchema,
  HysteresisSettleTraceResource,
  HysteresisStagePlanSchema,
  HysteresisStageSaturationSchema,
  MaterialParameterFieldListResource,
  MaterialPatchRequest,
  MaterialPropertiesResource,
  MaterialReferenceResource,
  MaterialResource,
  MeshActiveBuildResource,
  MeshBuildHistoryResource,
  MeshCapabilitiesResource,
  MeshHistogramBinElementsResource,
  MeshHistogramBinMetric,
  MeshLastSuccessfulBuildResource,
  MeshObjectConfigReplaceRequest,
  MeshObjectConfigResource,
  MeshObjectQualityResource,
  MeshObjectReportResource,
  MeshObjectSizeFieldResource,
  MeshPeriodicPairsResource,
  MeshQualityGatesResource,
  MeshRealizedSizeFieldsResource,
  MeshRegionMembershipListResource,
  MeshRegionMembershipResource,
  FdmRegionMembershipResource,
  MeshRegionQualityResource,
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
  ObjectRegionCreateRequest,
  ObjectRegionDuplicateRequest,
  ObjectRegionPatchRequest,
  ObjectRegionReorderRequest,
  RealtimeCommunicationPolicyPatch,
  RealtimeCommunicationPolicyResource,
  RegionDiagnosticsResource,
  RegionListResource,
  RegionPatchRequest,
  RequestOptions,
  ScalarWindowQuery,
  ScalarWindowResource,
  TableColumnMeta,
  TableListResource,
  TableResource,
  TableRowsQuery,
  TableRowsResource,
  SceneResource,
  ScriptSyncRequest,
  ScriptSyncResponse,
  ScriptSourceResponse,
  TopologicalChargeQuery,
  TopologicalChargeResource,
  SessionAssetImportResponse,
  SessionExportRequest,
  SessionExportResponse,
  SessionImportCommitRequest,
  SessionImportCommitResponse,
  SessionImportInspectRequest,
  SessionImportInspectResponse,
  SolverEnergyCurrentResource,
  SolverEnergyHistoryResource,
  SolverProfileResource,
  SimulationPreparationResource,
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

function optionalIntegerHeader(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function parseFieldVectorResponseMetadata(
  headers: Headers,
): FieldVectorResponseMetadata {
  return {
    component: headers.get("x-fullmag-component"),
    domainGenerationId: headers.get("x-fullmag-domain-generation-id"),
    encoding: headers.get("x-fullmag-encoding"),
    fieldIndexing: headers.get("x-fullmag-field-indexing"),
    fieldRevision: headers.get("x-fullmag-field-revision"),
    identityIssues: [],
    meshTopologyHash: headers.get("x-fullmag-mesh-topology-hash"),
    nComp: optionalIntegerHeader(headers, "x-fullmag-n-comp"),
    nodeIndexCount: optionalIntegerHeader(headers, "x-fullmag-node-index-count"),
    pointCount: optionalIntegerHeader(headers, "x-fullmag-point-count"),
    quantityId: headers.get("x-fullmag-quantity-id"),
    scopeId: headers.get("x-fullmag-scope-id"),
    scopeKind: headers.get("x-fullmag-scope-kind"),
    snapshotId: headers.get("x-fullmag-snapshot-id"),
    valueCount: optionalIntegerHeader(headers, "x-fullmag-value-count"),
  };
}

export function collectFieldVectorIdentityIssues(
  payload: DecodedFieldVector,
  metadata: FieldVectorResponseMetadata,
): FieldVectorIdentityIssue[] {
  const issues: FieldVectorIdentityIssue[] = [];
  const compare = (
    field: string,
    headerValue: number | string | null,
    payloadValue: number | string | null,
  ) => {
    if (headerValue !== null && String(headerValue) !== String(payloadValue)) {
      issues.push({ field, headerValue, payloadValue });
    }
  };
  compare("quantityId", metadata.quantityId, payload.quantityId);
  compare("pointCount", metadata.pointCount, payload.pointCount);
  compare("valueCount", metadata.valueCount, payload.valueCount);
  compare("nComp", metadata.nComp, payload.nComp);
  compare("scopeKind", metadata.scopeKind, payload.scopeKind ?? null);
  compare("scopeId", metadata.scopeId, payload.scopeId ?? null);
  compare(
    "meshTopologyHash",
    metadata.meshTopologyHash,
    payload.meshTopologyHash ?? null,
  );
  compare("fieldIndexing", metadata.fieldIndexing, payload.indexing ?? null);
  compare(
    "nodeIndexCount",
    metadata.nodeIndexCount,
    payload.nodeIndices?.length ?? 0,
  );
  compare(
    "domainGenerationId",
    metadata.domainGenerationId,
    payload.domainGenerationId ?? null,
  );
  return issues;
}

export function withDerivedDriveFluxDensity(
  catalog: FieldCatalogResource,
): FieldCatalogResource {
  if (catalog.quantities.some((quantity) => quantity.quantity_id === "B_drive")) {
    return catalog;
  }
  const source = catalog.quantities.find(
    (quantity) => quantity.quantity_id === "H_drive",
  );
  if (!source) return catalog;
  return {
    ...catalog,
    quantities: [
      ...catalog.quantities,
      {
        ...source,
        label: "Drive flux density",
        quantity_id: "B_drive",
        unit: "T",
      },
    ],
  };
}

export function transformFieldMetaForDisplay(
  requestedQuantityId: string,
  meta: FieldMetaResource,
): FieldMetaResource {
  const scale = fieldDisplayScale(requestedQuantityId);
  if (scale === 1) return meta;
  return {
    ...meta,
    label: "Drive flux density",
    quantity_id: requestedQuantityId,
    stats: meta.stats
      ? {
          max: meta.stats.max * scale,
          mean: meta.stats.mean * scale,
          min: meta.stats.min * scale,
        }
      : meta.stats,
    unit: "T",
  };
}

export function transformFieldVectorForDisplay(
  requestedQuantityId: string,
  result: BinaryResourceResult<DecodedFieldVector, FieldVectorResponseMetadata>,
): BinaryResourceResult<DecodedFieldVector, FieldVectorResponseMetadata> {
  const scale = fieldDisplayScale(requestedQuantityId);
  if (scale === 1 || result.status !== "ready") return result;
  const values = Float64Array.from(result.data.values, (value) => value * scale);
  return {
    ...result,
    data: {
      ...result.data,
      quantityId: requestedQuantityId,
      values,
    },
    responseMetadata: {
      ...result.responseMetadata,
      identityIssues: [],
      quantityId: requestedQuantityId,
    },
  };
}
import { decodeCrossSection } from "./codecs/crossSectionCodec";
import { decodeCrossSectionQuality } from "./codecs/crossSectionQualityCodec";
import { decodeFieldVector } from "./codecs/fieldVectorCodec";
import { decodeMeshQualityData } from "./codecs/meshQualityDataCodec";
import { decodePeriodicPairs } from "./codecs/periodicPairsCodec";
import { decodeTableRows } from "./codecs/tableRowsCodec";
import {
  decodeTopology,
  decodeTopologyHeader,
  decodeTopologySections,
  expectedTopologyByteLength,
  FMMT_HEADER_LEN,
  topologyByteLayout,
  type TopologyHeader,
  type TopologySections,
} from "./codecs/topologyCodec";
import type {
  DecodedCrossSection,
  DecodedCrossSectionQuality,
  DecodedFieldVector,
  DecodedMeshQualityData,
  DecodedTableRows,
  DecodedTopology,
} from "./codecs/types";
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
import type { components } from "./generated/openapi-v2-types";

type FetchLike = typeof fetch;
type PathParams = Record<string, string | number>;
type QueryParams = Record<string, unknown>;
type BinaryOpenApiTransportResult = {
  data?: unknown;
  error?: unknown;
  response: Response;
};

export interface AuthoringWriteOptions extends RequestOptions {
  baseRevision?: number;
}

export interface MeshHistogramBinElementsParams {
  binIndex: number;
  meshId: string;
  metric: MeshHistogramBinMetric;
  partId: string;
}

export interface HysteresisExecutionTreeQuery {
  window?: "active" | string;
  before?: number;
  after?: number;
  include_bookmarks?: boolean;
  include_warnings?: boolean;
  include_snapshots?: boolean;
}

const CHUNKED_TOPOLOGY_THRESHOLD_BYTES = 16 * 1024 * 1024;
const TOPOLOGY_RANGE_CHUNK_BYTES = 8 * 1024 * 1024;
const FIELD_MATERIALIZATION_TIMEOUT_MS = 5_000;
const FIELD_MATERIALIZATION_RETRY_MS = 250;
const FIELD_MATERIALIZATION_REQUEST_KEY = "current-field-cache";

function baseRevisionPayload(options?: AuthoringWriteOptions): { base_revision?: number } {
  return options?.baseRevision === undefined
    ? {}
    : { base_revision: options.baseRevision };
}

function shouldMaterializeFieldAfterJsonError(error: unknown): boolean {
  return (
    error instanceof ControlRoomApiError &&
    error.status === 404 &&
    error.message.toLowerCase().includes("not available")
  );
}

function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}

function delay(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    const timeout = globalThis.setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        globalThis.clearTimeout(timeout);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

interface ControlRoomApiOptions {
  baseUrl?: string;
  binaryDecodeScheduler?: BinaryDecodeScheduler;
  diagnostics?: RequestDiagnosticsController;
  fetchImpl?: FetchLike;
  maxGetRetries?: number;
  retryDelayMs?: number;
  requestIdFactory?: () => string;
}

export class ControlRoomApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly requestId: string | null = null,
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
  private readonly retryDelayMs: number;
  private readonly requestIdFactory: () => string;
  private readonly transport: OpenApiV2Transport;
  private readonly fieldMaterializationRequests = new Map<string, Promise<void>>();

  readonly sessions = {
    current: {
      status: (options?: RequestOptions) =>
        this.requestJson<LiveStatusResource>(SESSION_STATUS_PATH, options),
    },
  };

  readonly events = {
    communicationPolicy: (options?: RequestOptions) =>
      this.requestJson<RealtimeCommunicationPolicyResource>(
        SESSION_EVENTS_COMMUNICATION_POLICY_PATH,
        options,
      ),
    patchCommunicationPolicy: (
      patch: RealtimeCommunicationPolicyPatch,
      options?: RequestOptions,
    ) =>
      this.patchJson<
        RealtimeCommunicationPolicyResource,
        RealtimeCommunicationPolicyPatch
      >(SESSION_EVENTS_COMMUNICATION_POLICY_PATH, patch, options),
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
    spinWave: {
      gamma: (options?: RequestOptions) =>
        this.requestJson<SpinWaveGammaResource>(
          ANALYSIS_SPIN_WAVE_GAMMA_V1_PATH,
          options,
        ),
      dynamicStructureFactor: (options?: RequestOptions) =>
        this.requestJson<DynamicStructureFactorResource>(
          ANALYSIS_DYNAMIC_STRUCTURE_FACTOR_V1_PATH,
          options,
        ),
    },
    eigen: {
      eigenBranchesV2: (options?: RequestOptions) =>
        this.requestJson<FrequencyDomainJsonArtifactResource>(
          ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
          options,
        ),
      eigenDiagnosticsV2: (options?: RequestOptions) =>
        this.requestJson<FrequencyDomainJsonArtifactResource>(
          ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DIAGNOSTICS_V2_PATH,
          options,
        ),
      eigenDispersion: (options?: RequestOptions) =>
        this.requestJson<FrequencyDomainTextArtifactResource>(
          ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
          options,
        ),
      eigenModeFieldMeta: (
        sampleIndex: number,
        modeIndex: number,
        options?: RequestOptions,
      ) =>
        this.requestJson<FrequencyDomainFieldResource>(
          ANALYSIS_FREQUENCY_DOMAIN_EIGEN_MODE_FIELD_META_PATH,
          options,
          {
            path: {
              sample_index: sampleIndex,
              mode_index: modeIndex,
            },
          },
        ),
      modeV2: (
        sampleIndex: number,
        modeIndex: number,
        options?: RequestOptions,
      ) =>
        this.requestJson<JsonValue>(ANALYSIS_EIGEN_MODE_V2_PATH, options, {
          path: {
            sample_index: sampleIndex,
            mode_index: modeIndex,
          },
        }),
      eigenSpectrumV2: (options?: RequestOptions) =>
        this.requestJson<FrequencyDomainJsonArtifactResource>(
          ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
          options,
        ),
    },
    frequencyDomain: {
      eigenBranchesV2: (options?: RequestOptions) =>
        this.analysis.eigen.eigenBranchesV2(options),
      eigenDiagnosticsV2: (options?: RequestOptions) =>
        this.analysis.eigen.eigenDiagnosticsV2(options),
      eigenDispersion: (options?: RequestOptions) =>
        this.analysis.eigen.eigenDispersion(options),
      eigenModeFieldMeta: (
        sampleIndex: number,
        modeIndex: number,
        options?: RequestOptions,
      ) => this.analysis.eigen.eigenModeFieldMeta(sampleIndex, modeIndex, options),
      eigenSpectrumV2: (options?: RequestOptions) =>
        this.analysis.eigen.eigenSpectrumV2(options),
      manifestV1: (options?: RequestOptions) =>
        this.requestJson<FrequencyDomainManifestResource>(
          ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
          options,
        ),
      responseDiagnosticsV1: (options?: RequestOptions) =>
        this.requestJson<FrequencyDomainJsonArtifactResource>(
          ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_DIAGNOSTICS_V1_PATH,
          options,
        ),
      responseFieldMeta: (frequencyIndex: number, options?: RequestOptions) =>
        this.requestJson<FrequencyDomainFieldResource>(
          ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FIELD_META_PATH,
          options,
          { path: { frequency_index: frequencyIndex } },
        ),
      responseFrequencyPoint: (
        frequencyIndex: number,
        options?: RequestOptions,
      ) =>
        this.requestJson<FrequencyDomainJsonArtifactResource>(
          ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FREQUENCY_POINT_PATH,
          options,
          { path: { frequency_index: frequencyIndex } },
        ),
      responseMagneticSweep: (options?: RequestOptions) =>
        this.requestJson<FrequencyDomainJsonArtifactResource>(
          ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
          options,
        ),
      responseCancelRequestedV1: (options?: RequestOptions) =>
        this.requestJson<FrequencyDomainSweepProgressResource>(
          ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
          options,
        ),
      responseProgressV1: (options?: RequestOptions) =>
        this.requestJson<FrequencyDomainSweepProgressResource>(
          ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
          options,
        ),
    },
    frequencyResponse: {
      fieldMeta: (frequencyIndex: number, options?: RequestOptions) =>
        this.analysis.frequencyDomain.responseFieldMeta(frequencyIndex, options),
      frequencyPoint: (frequencyIndex: number, options?: RequestOptions) =>
        this.analysis.frequencyDomain.responseFrequencyPoint(
          frequencyIndex,
          options,
        ),
      magneticSweepV1: (options?: RequestOptions) =>
        this.requestJson<MagneticResponseSweepResource>(
          ANALYSIS_FREQUENCY_RESPONSE_MAGNETIC_SWEEP_V1_PATH,
          options,
        ),
      magneticSweepV2: (options?: RequestOptions) =>
        this.analysis.frequencyDomain.responseMagneticSweep(options),
    },
    extensions: {
      objects: {
        topologicalCharge: (
          objectId: string,
          query: TopologicalChargeQuery = {},
          options?: RequestOptions,
        ) =>
          this.requestJson<TopologicalChargeResource>(
            ANALYSIS_OBJECT_TOPOLOGICAL_CHARGE_PATH,
            options,
            {
              path: { object_id: objectId },
              query: topologicalChargeQueryParams(query),
            },
          ),
      },
    },
    hysteresis: {
      points: (stageId: string, options?: RequestOptions) =>
        this.requestJson<HysteresisPointsResource>(
          ANALYSIS_HYSTERESIS_POINTS_PATH,
          options,
          { path: { stage_id: stageId } },
        ),
      metrics: (stageId: string, options?: RequestOptions) =>
        this.requestJson<HysteresisMetricsResource>(
          ANALYSIS_HYSTERESIS_METRICS_PATH,
          options,
          { path: { stage_id: stageId } },
        ),
      saturation: (stageId: string, options?: RequestOptions) =>
        this.requestJson<HysteresisSaturationResource>(
          ANALYSIS_HYSTERESIS_SATURATION_PATH,
          options,
          { path: { stage_id: stageId } },
        ),
      adaptiveRefinement: (stageId: string, options?: RequestOptions) =>
        this.requestJson<HysteresisAdaptiveRefinementResource>(
          ANALYSIS_HYSTERESIS_ADAPTIVE_REFINEMENT_PATH,
          options,
          { path: { stage_id: stageId } },
        ),
      branches: (stageId: string, options?: RequestOptions) =>
        this.requestJson<HysteresisBranchesResource>(
          ANALYSIS_HYSTERESIS_BRANCHES_PATH,
          options,
          { path: { stage_id: stageId } },
        ),
      bookmarks: (stageId: string, options?: RequestOptions) =>
        this.requestJson<HysteresisBookmarksResource>(
          ANALYSIS_HYSTERESIS_BOOKMARKS_PATH,
          options,
          { path: { stage_id: stageId } },
        ),
      bookmarkPoint: (
        stageId: string,
        bookmark: HysteresisBookmarkPointRequest,
        options?: RequestOptions,
      ) =>
        this.postJson<HysteresisBookmarksResource, HysteresisBookmarkPointRequest>(
          ANALYSIS_HYSTERESIS_BOOKMARKS_PATH,
          bookmark,
          options,
          { path: { stage_id: stageId } },
        ),
      family: (stageId: string, options?: RequestOptions) =>
        this.requestJson<HysteresisAngularFamilyResource>(
          ANALYSIS_HYSTERESIS_FAMILY_PATH,
          options,
          { path: { stage_id: stageId } },
        ),
      familyVariantPoints: (
        stageId: string,
        variantId: string,
        options?: RequestOptions,
      ) =>
        this.requestJson<HysteresisPointSchema[]>(
          ANALYSIS_HYSTERESIS_FAMILY_VARIANT_POINTS_PATH,
          options,
          { path: { stage_id: stageId, variant_id: variantId } },
        ),
      minorLoops: (stageId: string, options?: RequestOptions) =>
        this.requestJson<HysteresisMinorLoopsResource>(
          ANALYSIS_HYSTERESIS_MINOR_LOOPS_PATH,
          options,
          { path: { stage_id: stageId } },
        ),
      reversalFields: (stageId: string, options?: RequestOptions) =>
        this.requestJson<HysteresisReversalFieldsResource>(
          ANALYSIS_HYSTERESIS_REVERSAL_FIELDS_PATH,
          options,
          { path: { stage_id: stageId } },
        ),
      point: (stageId: string, pointId: number, options?: RequestOptions) =>
        this.requestJson<HysteresisPointSchema>(
          ANALYSIS_HYSTERESIS_POINT_PATH,
          options,
          { path: { stage_id: stageId, point_id: pointId } },
        ),
      stageSettleTrace: (stageId: string, options?: RequestOptions) =>
        this.requestJson<HysteresisSettleTraceResource>(
          ANALYSIS_HYSTERESIS_STAGE_SETTLE_TRACE_PATH,
          options,
          { path: { stage_id: stageId } },
        ),
      settleTrace: (stageId: string, pointId: number, options?: RequestOptions) =>
        this.requestJson<HysteresisSettleTraceEntrySchema[]>(
          ANALYSIS_HYSTERESIS_SETTLE_TRACE_PATH,
          options,
          { path: { stage_id: stageId, point_id: pointId } },
        ),
    },
  };

  readonly data = {
    artifacts: {
      list: (options?: RequestOptions) =>
        this.requestJson<ArtifactResource[]>(DATA_ARTIFACTS_PATH, options),
      bytes: (artifactRef: string, options?: BinaryRequestOptions) =>
        this.requestBinaryBytes(
          DATA_ARTIFACT_PATH,
          options,
          { artifact_id: artifactRef },
        ),
    },
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
        this.requestJson<FieldCatalogResource>(DATA_FIELDS_PATH, options).then(
          withDerivedDriveFluxDensity,
        ),
      meta: (
        quantityId: string,
        query: FieldMetaQuery = {},
        options?: RequestOptions,
      ) => {
        const requestedQuantityId = resolveCanonicalQuantityId(quantityId);
        const storedQuantityId = storedFieldQuantityId(requestedQuantityId);
        return this.requestFieldMeta(
          storedQuantityId,
          DATA_FIELD_META_PATH,
          {
            path: { quantity_id: storedQuantityId },
            query: fieldMetaQueryParams(query),
          },
          options,
        ).then((meta) => transformFieldMetaForDisplay(requestedQuantityId, meta));
      },
      vector: (
        quantityId: string,
        query: FieldVectorQuery = {},
        options?: BinaryRequestOptions,
      ) => {
        const requestedQuantityId = resolveCanonicalQuantityId(quantityId);
        const storedQuantityId = storedFieldQuantityId(requestedQuantityId);
        return this.requestFieldVectorOnDemand(
          storedQuantityId,
          DATA_FIELD_VECTOR_PATH,
          { quantity_id: storedQuantityId },
          fieldVectorQueryParams(query),
          fieldMetaQueryParams(query),
          options,
        ).then((result) => transformFieldVectorForDisplay(requestedQuantityId, result));
      },
      planar: {
        meta: (
          quantityId: string,
          monitorId: string,
          query: PlanarFieldQuery = {},
          options?: RequestOptions,
        ) =>
          this.requestJson<PlanarFieldMetaResource>(
            DATA_PLANAR_FIELD_META_PATH,
            options,
            {
              path: { monitor_id: monitorId, quantity_id: quantityId },
              query,
            },
          ),
        scalar: (
          quantityId: string,
          monitorId: string,
          query: PlanarFieldQuery = {},
          options?: BinaryRequestOptions,
        ) =>
          this.requestBinaryBytes(
            DATA_PLANAR_FIELD_SCALAR_PATH,
            options,
            { monitor_id: monitorId, quantity_id: quantityId },
            query,
          ),
        vectors: (
          quantityId: string,
          monitorId: string,
          query: PlanarFieldQuery = {},
          options?: BinaryRequestOptions,
        ) =>
          this.requestBinaryBytes(
            DATA_PLANAR_FIELD_VECTORS_PATH,
            options,
            { monitor_id: monitorId, quantity_id: quantityId },
            query,
          ),
        emptyMask: (
          quantityId: string,
          monitorId: string,
          query: PlanarFieldQuery = {},
          options?: BinaryRequestOptions,
        ) =>
          this.requestBinaryBytes(
            DATA_PLANAR_FIELD_EMPTY_MASK_PATH,
            options,
            { monitor_id: monitorId, quantity_id: quantityId },
            query,
          ),
        meshOverlay: (
          quantityId: string,
          monitorId: string,
          query: PlanarFieldQuery = {},
          options?: BinaryRequestOptions,
        ) =>
          this.requestBinaryBytes(
            DATA_PLANAR_FIELD_MESH_OVERLAY_PATH,
            options,
            { monitor_id: monitorId, quantity_id: quantityId },
            query,
          ),
        probe: (
          quantityId: string,
          monitorId: string,
          query: PlanarFieldProbeQuery,
          options?: RequestOptions,
        ) =>
          this.requestJson<PlanarFieldProbeResource>(
            DATA_PLANAR_FIELD_PROBE_PATH,
            options,
            {
              path: { monitor_id: monitorId, quantity_id: quantityId },
              query,
            },
          ),
        renderPng: (
          quantityId: string,
          monitorId: string,
          query: PlanarFieldQuery = {},
          options?: BinaryRequestOptions,
        ) =>
          this.requestBinaryBytes(
            DATA_PLANAR_FIELD_RENDER_PNG_PATH,
            options,
            { monitor_id: monitorId, quantity_id: quantityId },
            query,
          ),
      },
    },
    meshRegionMembership: (regionId: string, options?: RequestOptions) =>
      this.requestJson<MeshRegionMembershipResource>(
        DATA_MESH_REGION_MEMBERSHIP_PATH,
        options,
        { path: { region_id: regionId } },
      ),
    meshRegionMemberships: (options?: RequestOptions) =>
      this.requestJson<MeshRegionMembershipListResource>(
        DATA_MESH_REGION_MEMBERSHIPS_PATH,
        options,
      ),
    fdmRegionMemberships: (options?: RequestOptions) =>
      this.requestOptionalJson<FdmRegionMembershipResource>(
        DATA_FDM_REGION_MEMBERSHIPS_PATH,
        options,
      ),
    fdmRegionMembershipBytes: (options?: BinaryRequestOptions) =>
      this.requestBinaryBytes(DATA_FDM_REGION_MEMBERSHIP_BINARY_PATH, options),
    fdmRegionMembershipRegionBytes: (
      regionId: string,
      options?: BinaryRequestOptions,
    ) =>
      this.requestBinaryBytes(
        DATA_FDM_REGION_MEMBERSHIP_SCOPED_PATH,
        options,
        { region_id: regionId },
      ),
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
    tables: {
      list: (options?: RequestOptions) =>
        this.requestJson<TableListResource>(DATA_TABLES_PATH, options),
      detail: (tableId: string, options?: RequestOptions) =>
        this.requestJson<TableResource>(
          DATA_TABLE_PATH,
          options,
          { path: { table_id: tableId } },
        ),
      columns: (tableId: string, options?: RequestOptions) =>
        this.requestJson<TableColumnMeta[]>(
          DATA_TABLE_COLUMNS_PATH,
          options,
          { path: { table_id: tableId } },
        ),
      rows: (
        tableId: string,
        query: TableRowsQuery = {},
        options?: RequestOptions,
      ) =>
        this.requestJson<TableRowsResource>(
          DATA_TABLE_ROWS_PATH,
          options,
          {
            path: { table_id: tableId },
            query: tableRowsQueryParams(query),
          },
        ),
      rowsBinary: (
        tableId: string,
        query: TableRowsQuery = {},
        options?: BinaryRequestOptions,
      ) =>
        this.requestTableRowsBinary(
          DATA_TABLE_ROWS_BINARY_PATH,
          { table_id: tableId },
          query,
          options,
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
    periodicPairs: (options?: RequestOptions) =>
      this.requestJson<MeshPeriodicPairsResource>(
        MESHING_PERIODIC_PAIRS_PATH,
        options,
      ),
    periodicPairsBinary: (options?: BinaryRequestOptions) =>
      this.requestBinaryResource(
        MESHING_PERIODIC_PAIRS_BINARY_PATH,
        "periodic-pairs",
        decodePeriodicPairs,
        options,
      ),
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
    regionQuality: (regionId: string, options?: RequestOptions) =>
      this.requestJson<MeshRegionQualityResource>(
        MESHING_REGION_QUALITY_PATH,
        options,
        {
          path: { region_id: regionId },
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
    histogramBinElements: (
      params: MeshHistogramBinElementsParams,
      options?: RequestOptions,
    ) =>
      this.requestJson<MeshHistogramBinElementsResource>(
        MESHING_HISTOGRAM_BIN_ELEMENTS_PATH,
        options,
        {
          path: {
            bin_index: params.binIndex,
            mesh_id: params.meshId,
            metric: params.metric,
            part_id: params.partId,
          },
        },
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
    planarMonitors: {
      list: (options?: RequestOptions) =>
        this.requestJson<PlanarMonitorCollectionResource>(
          MODEL_PLANAR_MONITORS_PATH,
          options,
        ),
      get: (monitorId: string, options?: RequestOptions) =>
        this.requestJson<PlanarMonitorResource>(
          MODEL_PLANAR_MONITOR_PATH,
          options,
          { path: { monitor_id: monitorId } },
        ),
      create: (
        request: PlanarMonitorCreateRequest,
        options?: RequestOptions,
      ) =>
        this.postJson<PlanarMonitorResource, PlanarMonitorCreateRequest>(
          MODEL_PLANAR_MONITORS_PATH,
          request,
          options,
        ),
      patch: (
        monitorId: string,
        request: PlanarMonitorPatchRequest,
        options?: RequestOptions,
      ) =>
        this.patchJson<PlanarMonitorResource, PlanarMonitorPatchRequest>(
          MODEL_PLANAR_MONITOR_PATH,
          request,
          options,
          { path: { monitor_id: monitorId } },
        ),
      remove: (
        monitorId: string,
        request: PlanarMonitorDeleteRequest,
        options?: RequestOptions,
      ) =>
        this.deleteJsonWithBody<
          PlanarMonitorCollectionResource,
          PlanarMonitorDeleteRequest
        >(MODEL_PLANAR_MONITOR_PATH, request, options, {
          path: { monitor_id: monitorId },
        }),
      duplicate: (
        monitorId: string,
        request: PlanarMonitorDuplicateRequest,
        options?: RequestOptions,
      ) =>
        this.postJson<PlanarMonitorResource, PlanarMonitorDuplicateRequest>(
          MODEL_PLANAR_MONITOR_DUPLICATE_PATH,
          request,
          options,
          { path: { monitor_id: monitorId } },
        ),
    },
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
    createRegion: (
      objectId: string,
      region: components["schemas"]["SceneObjectRegion"],
      options?: AuthoringWriteOptions,
    ) =>
      this.postJson<SceneResource, ObjectRegionCreateRequest>(
        MODEL_OBJECT_REGIONS_PATH,
        {
          ...baseRevisionPayload(options),
          region,
        },
        options,
        { path: { object_id: objectId } },
      ),
    patchObjectRegionResource: (
      objectId: string,
      regionId: string,
      patch: components["schemas"]["SceneObjectRegionPatch"],
      options?: AuthoringWriteOptions,
    ) =>
      this.patchJson<SceneResource, ObjectRegionPatchRequest>(
        MODEL_OBJECT_REGION_PATH,
        {
          ...baseRevisionPayload(options),
          patch,
        },
        options,
        { path: { object_id: objectId, region_id: regionId } },
      ),
    deleteRegion: (objectId: string, regionId: string, options?: RequestOptions) =>
      this.deleteJson<SceneResource>(MODEL_OBJECT_REGION_PATH, options, {
        path: { object_id: objectId, region_id: regionId },
      }),
    duplicateObjectRegion: (
      objectId: string,
      regionId: string,
      request: Omit<ObjectRegionDuplicateRequest, "base_revision"> = {},
      options?: AuthoringWriteOptions,
    ) =>
      this.postJson<SceneResource, ObjectRegionDuplicateRequest>(
        MODEL_OBJECT_REGION_DUPLICATE_PATH,
        {
          ...baseRevisionPayload(options),
          ...request,
        },
        options,
        { path: { object_id: objectId, region_id: regionId } },
      ),
    reorderObjectRegions: (
      objectId: string,
      regionIds: string[],
      options?: AuthoringWriteOptions,
    ) =>
      this.postJson<SceneResource, ObjectRegionReorderRequest>(
        MODEL_OBJECT_REGIONS_REORDER_PATH,
        {
          ...baseRevisionPayload(options),
          region_ids: regionIds,
        },
        options,
        { path: { object_id: objectId } },
      ),
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
    createMaterial: (
      materialId: string,
      name: string,
      properties: MaterialPropertiesResource,
      references: MaterialReferenceResource[] = [],
      options?: AuthoringWriteOptions,
    ) =>
      this.model.commitTransaction(
        {
          ...baseRevisionPayload(options),
          kind: "create_material",
          material_id: materialId,
          name,
          properties,
          references,
        },
        options,
      ),
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
    patchMaterialAsset: (
      materialId: string,
      patch: MaterialPatchRequest,
      options?: AuthoringWriteOptions,
    ) =>
      this.model.commitTransaction(
        {
          ...baseRevisionPayload(options),
          kind: "patch_material",
          material_id: materialId,
          patch,
        },
        options,
      ),
    deleteMaterial: (materialId: string, options?: AuthoringWriteOptions) =>
      this.model.commitTransaction(
        {
          ...baseRevisionPayload(options),
          kind: "delete_material",
          material_id: materialId,
        },
        options,
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
    realizedRegions: (options?: RequestOptions) =>
      this.requestJson<RegionListResource>(
        MODEL_REALIZED_REGIONS_PATH,
        options,
      ),
    regionDiagnostics: (options?: RequestOptions) =>
      this.requestJson<RegionDiagnosticsResource>(
        MODEL_REGION_DIAGNOSTICS_PATH,
        options,
      ),
    materialFields: (options?: RequestOptions) =>
      this.requestJson<MaterialParameterFieldListResource>(
        MODEL_MATERIAL_FIELDS_PATH,
        options,
      ),
    couplings: (options?: RequestOptions) =>
      this.requestJson<CouplingListResource>(MODEL_COUPLINGS_PATH, options),
    fieldDrives: (options?: RequestOptions) =>
      this.requestJson<FieldDriveListResource>(MODEL_FIELD_DRIVES_PATH, options),
    createFieldDrive: (
      request: FieldDriveCreateRequest,
      options?: RequestOptions,
    ) =>
      this.postJson<AuthoringTransactionResponse, FieldDriveCreateRequest>(
        MODEL_FIELD_DRIVES_PATH,
        request,
        options,
      ),
    replaceFieldDrive: (
      driveId: string,
      request: FieldDriveReplaceRequest,
      options?: RequestOptions,
    ) =>
      this.putJson<AuthoringTransactionResponse, FieldDriveReplaceRequest>(
        MODEL_FIELD_DRIVE_PATH,
        request,
        options,
        { path: { drive_id: driveId } },
      ),
    deleteFieldDrive: (
      driveId: string,
      request: FieldDriveDeleteRequest,
      options?: RequestOptions,
    ) =>
      this.deleteJsonWithBody<AuthoringTransactionResponse, FieldDriveDeleteRequest>(
        MODEL_FIELD_DRIVE_PATH,
        request,
        options,
        { path: { drive_id: driveId } },
      ),
    createObjectRegion: (
      objectId: string,
      region: components["schemas"]["SceneObjectRegion"],
      options?: AuthoringWriteOptions,
    ) =>
      this.model.commitTransaction(
        {
          ...baseRevisionPayload(options),
          kind: "create_object_region",
          object_id: objectId,
          region,
        },
        options,
      ),
    patchObjectRegion: (
      objectId: string,
      regionId: string,
      patch: components["schemas"]["SceneObjectRegionPatch"],
      options?: AuthoringWriteOptions,
    ) =>
      this.model.commitTransaction(
        {
          ...baseRevisionPayload(options),
          kind: "patch_object_region",
          object_id: objectId,
          patch,
          region_id: regionId,
        },
        options,
      ),
    patchObjectMaterialFields: (
      objectId: string,
      fields: components["schemas"]["SceneMaterialParameterAssignment"][],
      options?: AuthoringWriteOptions,
    ) =>
      this.model.commitTransaction(
        {
          ...baseRevisionPayload(options),
          fields,
          kind: "patch_object_material_fields",
          object_id: objectId,
        },
        options,
      ),
    deleteObjectRegion: (
      objectId: string,
      regionId: string,
      options?: AuthoringWriteOptions,
    ) =>
      this.model.commitTransaction(
        {
          ...baseRevisionPayload(options),
          kind: "delete_object_region",
          object_id: objectId,
          region_id: regionId,
        },
        options,
      ),
    createCoupling: (
      coupling: components["schemas"]["SceneCoupling"],
      options?: AuthoringWriteOptions,
    ) =>
      this.model.commitTransaction(
        {
          ...baseRevisionPayload(options),
          coupling,
          kind: "create_coupling",
        },
        options,
      ),
    patchCoupling: (
      couplingId: string,
      patch: components["schemas"]["SceneCouplingPatch"],
      options?: AuthoringWriteOptions,
    ) =>
      this.model.commitTransaction(
        {
          ...baseRevisionPayload(options),
          coupling_id: couplingId,
          kind: "patch_coupling",
          patch,
        },
        options,
      ),
    deleteCoupling: (couplingId: string, options?: AuthoringWriteOptions) =>
      this.model.commitTransaction(
        {
          ...baseRevisionPayload(options),
          coupling_id: couplingId,
          kind: "delete_coupling",
        },
        options,
      ),
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
    authoringScript: (options?: RequestOptions) =>
      this.requestJson<ScriptSourceResponse>(MODEL_SCRIPT_PATH, options),
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
    assets: {
      import: (
        request: ImportSessionAssetRequest,
        options?: RequestOptions,
      ) =>
        this.postJson<SessionAssetImportResponse, ImportSessionAssetRequest>(
          PERSISTENCE_ASSET_IMPORT_PATH,
          request,
          options,
        ),
    },
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
    fieldStates: {
      export: (
        request: FieldStateExportRequest,
        options?: RequestOptions,
      ) =>
        this.postJson<FieldStateExportResponse, FieldStateExportRequest>(
          PERSISTENCE_FIELD_STATE_EXPORTS_PATH,
          request,
          options,
        ),
      inspectImport: (
        request: FieldStateInspectRequest,
        options?: RequestOptions,
      ) =>
        this.postJson<FieldStateInspectResponse, FieldStateInspectRequest>(
          PERSISTENCE_FIELD_STATE_IMPORT_INSPECTIONS_PATH,
          request,
          options,
        ),
      import: (
        request: FieldStateImportRequest,
        options?: RequestOptions,
      ) =>
        this.postJson<FieldStateImportResponse, FieldStateImportRequest>(
          PERSISTENCE_FIELD_STATE_IMPORTS_PATH,
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
    preparation: (options?: RequestOptions) =>
      this.requestJson<SimulationPreparationResource>(
        SIMULATION_PREPARATION_PATH,
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
        this.requestOptionalJson<StageExecutionResource>(
          SIMULATION_STAGES_EXECUTION_PATH,
          options,
        ),
      hysteresis: {
        plan: (stageId: string, options?: RequestOptions) =>
          this.requestJson<HysteresisStagePlanSchema>(
            SIMULATION_STAGE_HYSTERESIS_PLAN_PATH,
            options,
            { path: { stage_id: stageId } },
          ),
        protocol: (stageId: string, options?: RequestOptions) =>
          this.requestJson<HysteresisProtocolSchema>(
            SIMULATION_STAGE_HYSTERESIS_PROTOCOL_PATH,
            options,
            { path: { stage_id: stageId } },
          ),
        saturation: (stageId: string, options?: RequestOptions) =>
          this.requestJson<HysteresisStageSaturationSchema>(
            SIMULATION_STAGE_HYSTERESIS_SATURATION_PATH,
            options,
            { path: { stage_id: stageId } },
          ),
        orientation: (stageId: string, options?: RequestOptions) =>
          this.requestJson<HysteresisOrientationSchema>(
            SIMULATION_STAGE_HYSTERESIS_ORIENTATION_PATH,
            options,
            { path: { stage_id: stageId } },
          ),
        settlePipeline: (stageId: string, options?: RequestOptions) =>
          this.requestJson<HysteresisSettlePipelineSchema>(
            SIMULATION_STAGE_HYSTERESIS_SETTLE_PIPELINE_PATH,
            options,
            { path: { stage_id: stageId } },
          ),
        executionTree: (
          stageId: string,
          query?: HysteresisExecutionTreeQuery,
          options?: RequestOptions,
        ) =>
          this.requestJson<HysteresisExecutionTreeResource>(
            SIMULATION_STAGE_HYSTERESIS_EXECUTION_TREE_PATH,
            options,
            { path: { stage_id: stageId }, query },
          ),
        progress: (stageId: string, options?: RequestOptions) =>
          this.requestJson<HysteresisProgressSchema>(
            SIMULATION_STAGE_HYSTERESIS_PROGRESS_PATH,
            options,
            { path: { stage_id: stageId } },
          ),
      },
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
    maxGetRetries = 2,
    retryDelayMs = 100,
    requestIdFactory = () => crypto.randomUUID(),
  }: ControlRoomApiOptions = {}) {
    this.baseUrl = resolveBaseUrl(baseUrl);
    this.binaryDecodeScheduler = binaryDecodeScheduler;
    this.requestDiagnostics = diagnostics ?? null;
    this.fetchImpl = fetchImpl ?? resolveDefaultFetch();
    this.maxGetRetries = maxGetRetries;
    this.retryDelayMs = retryDelayMs;
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

  private async requestFieldMeta(
    quantityId: string,
    path: OpenApiV2Path,
    params: Record<string, unknown>,
    options: RequestOptions = {},
  ): Promise<FieldMetaResource> {
    try {
      return await this.requestJson<FieldMetaResource>(path, options, params);
    } catch (error) {
      if (!shouldMaterializeFieldAfterJsonError(error)) {
        throw error;
      }
      await this.materializeFieldsForQuantity(quantityId, options);
      return this.retryFieldMetaUntilReady(quantityId, path, params, options);
    }
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

  private async deleteJsonWithBody<TResponse, TBody>(
    path: OpenApiV2Path,
    body: TBody,
    options: RequestOptions = {},
    params?: Record<string, unknown>,
  ): Promise<TResponse> {
    const result = await this.transport.DELETE(path as never, {
      body,
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

  private requestTableRowsBinary(
    path: OpenApiV2Path,
    pathParams: PathParams,
    query: TableRowsQuery = {},
    options: BinaryRequestOptions = {},
  ): Promise<BinaryResourceResult<DecodedTableRows>> {
    return this.requestBinaryResource(
      path,
      "table-rows",
      decodeTableRows,
      options,
      pathParams,
      tableRowsQueryParams(query),
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
      dpr: query.dpr,
      edge_width: query.edgeWidth,
      filter_expression: query.filterExpression,
      legend: query.legend,
      metric: query.metric,
      plane: query.plane,
      position_percent: query.positionPercent,
      resolution: query.resolution,
      rotation_degrees: query.rotationDegrees,
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
    query: QueryParams,
    options: BinaryRequestOptions = {},
  ): Promise<BinaryResourceResult<DecodedFieldVector, FieldVectorResponseMetadata>> {
    return this.requestBinaryResource(
      path,
      "field-vector",
      decodeFieldVector,
      options,
      pathParams,
      query,
      (response, data) => {
        const metadata = parseFieldVectorResponseMetadata(response.headers);
        return {
          ...metadata,
          identityIssues: collectFieldVectorIdentityIssues(data, metadata),
        };
      },
    );
  }

  private async requestFieldVectorOnDemand(
    quantityId: string,
    path: OpenApiV2Path,
    pathParams: PathParams,
    query: QueryParams,
    metaQuery: QueryParams,
    options: BinaryRequestOptions = {},
  ): Promise<BinaryResourceResult<DecodedFieldVector, FieldVectorResponseMetadata>> {
    const result = await this.requestFieldVector(path, pathParams, query, options);
    if (result.status !== "not-applicable") {
      return result;
    }
    if (await this.livePublisherOwnsFieldMaterialization(quantityId, metaQuery, options)) {
      return result;
    }
    await this.materializeFieldsForQuantity(quantityId, options);
    return this.retryFieldVectorUntilReady(
      quantityId,
      path,
      pathParams,
      query,
      options,
    );
  }

  private async livePublisherOwnsFieldMaterialization(
    quantityId: string,
    query: QueryParams,
    options: RequestOptions,
  ): Promise<boolean> {
    try {
      const meta = await this.requestJson<FieldMetaResource>(
        DATA_FIELD_META_PATH,
        options,
        {
          path: { quantity_id: quantityId },
          query,
        },
      );
      return ["complete", "pending", "stale_complete", "error"].includes(
        meta.state,
      );
    } catch (error) {
      if (shouldMaterializeFieldAfterJsonError(error)) {
        const solver = await this.requestOptionalJson<SolverStatusResource>(
          SIMULATION_SOLVER_STATUS_PATH,
          options,
        );
        return solver?.is_busy === true || solver?.runtime_state === "running";
      }
      throw error;
    }
  }

  private async materializeFieldsForQuantity(
    quantityId: string,
    options: RequestOptions = {},
  ): Promise<void> {
    if (quantityId.startsWith("analysis:")) {
      return;
    }
    throwIfAborted(options.signal);
    const key = FIELD_MATERIALIZATION_REQUEST_KEY;
    const existing = this.fieldMaterializationRequests.get(key);
    if (existing) {
      return existing;
    }
    const requestedQuantityId = resolveCanonicalQuantityId(quantityId);
    const request = this.commands
      .submit(
        {
          client_intent_id: `field-on-demand:${requestedQuantityId}:${Date.now()}`,
          kind: "compute_fields",
          reason: "field_on_demand",
          requested_at_unix_ms: Date.now(),
          target: { kind: "study" },
        },
        options,
      )
      .then(() => undefined)
      .finally(() => {
        this.fieldMaterializationRequests.delete(key);
      });
    this.fieldMaterializationRequests.set(key, request);
    return request;
  }

  private async retryFieldMetaUntilReady(
    quantityId: string,
    path: OpenApiV2Path,
    params: Record<string, unknown>,
    options: RequestOptions,
  ): Promise<FieldMetaResource> {
    const deadline = Date.now() + FIELD_MATERIALIZATION_TIMEOUT_MS;
    let lastError: unknown = null;
    while (Date.now() <= deadline) {
      throwIfAborted(options.signal);
      await delay(FIELD_MATERIALIZATION_RETRY_MS, options.signal);
      try {
        return await this.requestJson<FieldMetaResource>(path, options, params);
      } catch (error) {
        if (!shouldMaterializeFieldAfterJsonError(error)) {
          throw error;
        }
        lastError = error;
      }
    }
    throw lastError ?? new ControlRoomApiError(
      `Timed out waiting for field metadata materialization for quantity '${quantityId}'`,
      0,
    );
  }

  private async retryFieldVectorUntilReady(
    quantityId: string,
    path: OpenApiV2Path,
    pathParams: PathParams,
    query: QueryParams,
    options: BinaryRequestOptions,
  ): Promise<BinaryResourceResult<DecodedFieldVector, FieldVectorResponseMetadata>> {
    const deadline = Date.now() + FIELD_MATERIALIZATION_TIMEOUT_MS;
    let lastResult: BinaryResourceResult<DecodedFieldVector, FieldVectorResponseMetadata> | null = null;
    while (Date.now() <= deadline) {
      throwIfAborted(options.signal);
      await delay(FIELD_MATERIALIZATION_RETRY_MS, options.signal);
      const result = await this.requestFieldVector(path, pathParams, query, options);
      if (result.status !== "not-applicable") {
        return result;
      }
      lastResult = result;
    }
    if (lastResult) {
      return lastResult;
    }
    throw new ControlRoomApiError(
      `Timed out waiting for field vector materialization for quantity '${quantityId}'`,
      0,
    );
  }

  private async requestBinaryResource<TData, TMetadata = undefined>(
    path: OpenApiV2Path,
    decoderKind: BinaryDecoderKind,
    decode: (buffer: ArrayBuffer) => TData,
    options: BinaryRequestOptions = {},
    pathParams?: PathParams,
    query?: QueryParams,
    responseMetadata?: (response: Response, data: TData) => TMetadata,
  ): Promise<BinaryResourceResult<TData, TMetadata>> {
    const measureBase = `fullmag.api.requestBinaryResource.${decoderKind}`;
    return measureControlRoomApiPerformance(
      measureBase,
      async () => {
        const headers: Record<string, string> = {};
        if (options.etag) {
          headers["if-none-match"] = options.etag;
        }
        if (options.range) {
          headers.range = options.range;
        }

        const requestState: {
          lastRequestPath: string;
          lastResponse: Response | null;
        } = {
          lastRequestPath: path as string,
          lastResponse: null,
        };
        let result: BinaryOpenApiTransportResult | null = null;
        try {
          result = await measureControlRoomApiPerformance(
            `${measureBase}.transport`,
            async () =>
              this.transport.GET(path as never, {
                cache: "no-store",
                fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
                  requestState.lastRequestPath = pathFromUrl(
                    typeof input === "string"
                      ? input
                      : input instanceof Request
                        ? input.url
                        : String(input),
                  );
                  const resp = await this.executeBinaryOpenApiFetch(input, init);
                  requestState.lastResponse = resp;
                  return resp;
                },
                headers,
                params: { path: pathParams, query },
                parseAs: "arrayBuffer",
                signal: options.signal,
              } as never) as unknown as BinaryOpenApiTransportResult,
          );
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
        let data: TData;
        try {
          data = await measureControlRoomApiPerformance(
            `${measureBase}.decode`,
            async () =>
              decoderKind === "raw-bytes"
                ? decode(buffer)
                : await this.binaryDecodeScheduler({
                    buffer,
                    decodeInline: decode,
                    kind: decoderKind,
                    path: requestState.lastRequestPath,
                  }),
          );
        } catch (error) {
          this.requestDiagnostics?.record({
            byteLength,
            channel: "http",
            contentType: response.headers.get("content-type"),
            detail: "binary decode failed",
            direction: "rx",
            durationMs: Math.max(0, nowMs() - decodeStartedAt),
            etag,
            method: "GET",
            outcome: "error",
            path: requestState.lastRequestPath,
            requestId:
              response.headers.get("x-request-id") ?? "binary-payload",
            resourceKey: requestState.lastRequestPath,
            status: response.status,
          });
          throw error;
        }
        const decodeDurationMs = Math.max(0, nowMs() - decodeStartedAt);

        this.requestDiagnostics?.record({
          byteLength,
          channel: "http",
          contentType: response.headers.get("content-type"),
          detail: "decoded binary payload",
          direction: "rx",
          durationMs: decodeDurationMs,
          etag,
          method: "GET",
          outcome: "ok",
          path: requestState.lastRequestPath,
          requestId: response.headers.get("x-request-id") ?? "binary-payload",
          resourceKey: requestState.lastRequestPath,
          status: response.status,
        });

        return {
          byteLength,
          contentRange: response.headers.get("content-range"),
          data,
          etag,
          ...(responseMetadata
            ? { responseMetadata: responseMetadata(response, data) }
            : {}),
          status: "ready",
        } as BinaryResourceResult<TData, TMetadata>;
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
          etag: null,
          method,
          outcome: "sent",
          path,
          requestId,
          resourceKey: path,
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
          etag: response.headers.get("etag"),
          method,
          outcome: accepted ? "ok" : "error",
          path,
          requestId,
          resourceKey: path,
          status: response.status,
        });

        if (attempt < maxAttempts && retryableGetStatus(method, response.status)) {
          await delayRetry(this.retryDelayMs, init.signal);
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
          await delayRetry(this.retryDelayMs, init.signal);
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
      etag: null,
      method,
      outcome:
        lastError instanceof DOMException && lastError.name === "AbortError"
          ? "aborted"
          : "network-error",
      path,
      requestId,
      resourceKey: path,
      status: null,
    });

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

function retryableGetStatus(method: string, status: number): boolean {
  return (
    method === "GET" &&
    (status === 408 ||
      status === 429 ||
      status === 502 ||
      status === 503 ||
      status === 504)
  );
}

async function delayRetry(
  delayMs: number,
  signal: AbortSignal | null | undefined,
): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = globalThis.setTimeout(resolve, delayMs);
    signal?.addEventListener(
      "abort",
      () => {
        globalThis.clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
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
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
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

function fieldMetaQueryParams(query: FieldMetaQuery): QueryParams {
  return {
    component: query.component ?? undefined,
    scope_id: normalizeFieldMetaScopeId(
      query.scope_kind,
      query.scope_id,
    ) ?? undefined,
    scope_kind: query.scope_kind ?? undefined,
    snapshot_id: query.snapshot_id ?? undefined,
    stage_id: query.stage_id ?? undefined,
  };
}

function fieldVectorQueryParams(query: FieldVectorQuery): QueryParams {
  return canonicalFieldVectorQueryParams(canonicalFieldVectorQuery("m", query));
}

function topologicalChargeQueryParams(
  query: TopologicalChargeQuery,
): QueryParams {
  return {
    plane: query.plane,
    support: query.support,
    profile_samples:
      typeof query.profile_samples === "number"
        ? String(query.profile_samples)
        : query.profile_samples,
    snapshot_id: query.snapshot_id ?? undefined,
    stage_id: query.stage_id ?? undefined,
  };
}

function normalizeFieldMetaScopeId(
  scopeKind: FieldMetaQuery["scope_kind"],
  scopeId: FieldMetaQuery["scope_id"],
): string | null | undefined {
  if (
    scopeKind === "object" &&
    typeof scopeId === "string" &&
    scopeId.startsWith("object:")
  ) {
    return scopeId.slice("object:".length);
  }
  return scopeId;
}

function tableRowsQueryParams(query: TableRowsQuery): QueryParams {
  return {
    columns:
      query.columns && query.columns.length > 0
        ? query.columns.join(",")
        : undefined,
    cursor: query.cursor,
    decimation: query.decimation,
    from_row: query.fromRow,
    from_t: query.fromT,
    include_tail: query.includeTail,
    limit: query.limit,
    target_points: query.targetPoints,
    to_row: query.toRow,
    to_t: query.toT,
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
      response.headers.get("x-request-id"),
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
