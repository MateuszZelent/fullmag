import type { components } from "./generated/openapi-v2-types";

export type ResourceRevision = string | number;
type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type SessionListResource = components["schemas"]["SessionListResource"];
export type ModelReadinessResource =
  components["schemas"]["ModelReadinessResource"];
export type ModelReadinessCheck = components["schemas"]["ModelReadinessCheck"];

export type ObjectInteractionKind =
  | "exchange"
  | "demag"
  | "interfacial_dmi"
  | "uniaxial_anisotropy";

interface BaseAuthoringTransaction {
  base_revision?: number | null;
}

export type CommandDetailResource = components["schemas"]["CommandDetailResource"];
export type CommandQueueStatusResource =
  components["schemas"]["CommandQueueStatusResource"];
export type CommandResponse = components["schemas"]["CommandResponse"];
export type CommandFailureRequest = components["schemas"]["CommandFailureRequest"];
export type CheckpointCreateRequest =
  components["schemas"]["CheckpointCreateRequest"];
export type CheckpointCreateResponse =
  components["schemas"]["CheckpointCreateResponse"];
export type CheckpointEntry = components["schemas"]["CheckpointEntry"];
export type CheckpointListResource =
  components["schemas"]["CheckpointListResponse"];
export type CheckpointRestoreRequest =
  components["schemas"]["CheckpointRestoreRequest"];
export type CheckpointRestoreResponse =
  components["schemas"]["CheckpointRestoreResponse"];
export type CurrentRunResource = components["schemas"]["CurrentRunResource"];
export type DomainMetaResource = components["schemas"]["DomainMeta"];
export type FdmMultilayerLayoutResource =
  components["schemas"]["FdmMultilayerLayoutResource"];
export type FdmNativeLayerRegionMembershipResource =
  components["schemas"]["FdmNativeLayerRegionMembershipResource"];
export type EngineLogResource = components["schemas"]["EngineLogResource"];
export type FieldCatalogResource = components["schemas"]["FieldCatalog"];
export type FieldAvailabilityResource =
  components["schemas"]["FieldAvailabilityResource"];
export type FieldMetaResource = components["schemas"]["FieldMeta"];
export type QuantityCatalogResource =
  components["schemas"]["QuantityCatalogResponse"];
export interface FieldAvailabilityQuery {
  target_id?: string | null;
  scope_kind?: string | null;
  scope_id?: string | null;
  owner_object_id?: string | null;
}
export interface FieldMetaQuery {
  component?: string | null;
  owner_object_id?: string | null;
  scope_id?: string | null;
  scope_kind?: string | null;
  snapshot_id?: string | null;
  stage_id?: string | null;
}
export type FieldStateExportRequest =
  components["schemas"]["FieldStateExportRequest"];
export type FieldStateExportResponse =
  components["schemas"]["FieldStateExportResponse"];
export type FieldStateImportRequest =
  components["schemas"]["FieldStateImportRequest"];
export type FieldStateImportResponse =
  components["schemas"]["FieldStateImportResponse"];
export type FieldStateInspectRequest =
  components["schemas"]["FieldStateInspectRequest"];
export type FieldStateInspectResponse =
  components["schemas"]["FieldStateInspectResponse"];
export type FieldStateTargetRef =
  components["schemas"]["FieldStateTargetRef"];
export type FieldVectorQuery = components["schemas"]["FieldVectorQuery"];
export type FieldVectorPendingResponse =
  components["schemas"]["FieldVectorPendingResponse"];
type FdmFieldVectorQueryBase = Omit<
  FieldVectorQuery,
  "geometry_scope" | "scope_id" | "scope_kind"
> & {
  geometry_scope?: never;
};
type FdmIdentifiedFieldVectorQueryBase = FdmFieldVectorQueryBase & {
  scope_id: string;
};
export type FdmSingleGridFieldVectorQuery =
  | (FdmIdentifiedFieldVectorQueryBase & {
      scope_kind: "object" | "region";
    })
  | (FdmFieldVectorQueryBase & {
      scope_id?: string | null;
      scope_kind: "airbox";
    });
export type FdmMultilayerFieldVectorQuery = FdmIdentifiedFieldVectorQueryBase & {
  scope_kind: "airbox" | "layer" | "object";
};
export type FdmScopedFieldVectorQuery =
  | FdmSingleGridFieldVectorQuery
  | FdmMultilayerFieldVectorQuery;
export type PlanarFieldMetaResource =
  components["schemas"]["PlanarFieldMetaResource"];
export type PlanarSampleSourceResource =
  components["schemas"]["PlanarSampleSourceResource"];
export type PlanarFieldProbeResource =
  components["schemas"]["PlanarFieldProbeResource"];
export type PlanarMonitorCollectionResource =
  components["schemas"]["PlanarMonitorCollectionResource"];
export type PlanarMonitorCreateRequest =
  components["schemas"]["PlanarMonitorCreateRequest"];
export type PlanarMonitorDeleteRequest =
  components["schemas"]["PlanarMonitorDeleteRequest"];
export type PlanarMonitorDuplicateRequest =
  components["schemas"]["PlanarMonitorDuplicateRequest"];
export type PlanarMonitorPatchRequest =
  components["schemas"]["PlanarMonitorPatchRequest"];
export type PlanarMonitorResource =
  components["schemas"]["PlanarMonitorResource"];
export type PlanarViewScopeState =
  components["schemas"]["PlanarViewScopeState"];

export type PlanarFieldSource =
  | { kind: "default" }
  | { kind: "monitor"; monitorId: string };

export interface PlanarFieldQuery {
  [key: string]: boolean | number | string | undefined;
  sample_token?: string;
  component?: string;
  expected_carrier_revision?: string;
  expected_field_revision?: string;
  expected_mesh_revision?: string;
  expected_monitor_revision?: string;
  expected_source_revision?: string;
  expected_scene_revision?: string;
  include_mesh?: boolean;
  quality?: string;
  resolution_x?: number;
  resolution_y?: number;
  scope_id?: string;
  scope_kind?: string;
  snapshot_id?: string;
  stage_id?: string;
  vector_budget?: number;
}
export interface PlanarFieldProbeQuery
  extends Pick<
    PlanarFieldQuery,
    | "component"
    | "sample_token"
    | "expected_carrier_revision"
    | "expected_field_revision"
    | "expected_mesh_revision"
    | "expected_monitor_revision"
    | "expected_source_revision"
    | "expected_scene_revision"
    | "quality"
    | "resolution_x"
    | "resolution_y"
    | "scope_id"
    | "scope_kind"
    | "snapshot_id"
    | "stage_id"
  > {
  u_m: number;
  v_m: number;
}
export type CrossSectionPlane = "xy" | "xz" | "yz";
export type CrossSectionQualityMetric =
  components["schemas"]["CrossSectionQualityMetric"];
type CrossSectionImageColorScale =
  components["schemas"]["CrossSectionImageColorScale"];
export type SliceMeshColorScale = components["schemas"]["SliceMeshColorScale"];
export interface CrossSectionQuery {
  includePolygons?: boolean;
  includeWireframe?: boolean;
  plane: CrossSectionPlane;
  positionPercent: number;
}
export interface CrossSectionImageQuery {
  colorScale?: CrossSectionImageColorScale;
  dpr?: number;
  edgeWidth?: number;
  filterExpression?: string | null;
  legend?: boolean;
  metric: CrossSectionQualityMetric;
  plane: CrossSectionPlane;
  positionPercent: number;
  resolution?: number;
  rotationDegrees?: number;
  shrinkFactor?: number;
  wireframe?: boolean;
}
export interface CrossSectionQualityQuery {
  metric: CrossSectionQualityMetric;
  plane: CrossSectionPlane;
  positionPercent: number;
}
export type GeometryCapabilitiesResource =
  components["schemas"]["GeometryCapabilitiesResource"];
export type GeometryDiagnosticsResource =
  components["schemas"]["GeometryDiagnosticsResource"];
export type GeometryRealizationRequest =
  components["schemas"]["GeometryRealizationRequest"];
export type GeometryRealizationResource =
  components["schemas"]["GeometryRealizationSnapshot"];
export type GeometryValidationResource =
  components["schemas"]["GeometryValidationResource"];
export type HealthResource = components["schemas"]["HealthResponse"];
export type ImportSessionAssetRequest =
  components["schemas"]["ImportSessionAssetRequest"];
export type SessionAssetImportResponse =
  components["schemas"]["SessionAssetImportResponse"];
export type CpuTelemetryResource =
  components["schemas"]["CpuTelemetryResponse"];
export type GpuTelemetryResource =
  components["schemas"]["GpuTelemetryResponse"];
export type LiveStatusResource = components["schemas"]["LiveStatus"];
export type PlatformCapabilitiesResource =
  components["schemas"]["RuntimeCapabilityMatrix"];
export type MagneticResponseSweepResource = JsonObject & {
  schema_version: string;
};
export type TopologicalChargeResource =
  components["schemas"]["TopologicalChargeResourceV2"];
export interface TopologicalChargeQuery {
  plane?: "auto" | "xy" | "xz" | "yz";
  support?: "midplane" | "layer_profile";
  profile_samples?: "auto" | number;
  snapshot_id?: string | null;
  stage_id?: string | null;
}
export type FrequencyDomainManifestResource =
  components["schemas"]["FrequencyDomainManifestResource"];
export type FrequencyDomainJsonArtifactResource =
  components["schemas"]["FrequencyDomainJsonArtifactResource"];
export type FrequencyDomainJsonArtifactPayload =
  components["schemas"]["FrequencyDomainJsonArtifactPayload"];
export type FrequencyDomainSpectrumArtifactPayload =
  components["schemas"]["FrequencyDomainSpectrumArtifactPayload"];
export type FrequencyDomainBranchesArtifactPayload =
  components["schemas"]["FrequencyDomainBranchesArtifactPayload"];
export type FrequencyDomainResponseSweepArtifactPayload =
  components["schemas"]["FrequencyDomainResponseSweepArtifactPayload"];
export type FrequencyDomainFmrPeaksArtifactPayload =
  components["schemas"]["FrequencyDomainFmrPeaksArtifactPayload"];
export type FrequencyDomainTextArtifactResource =
  components["schemas"]["FrequencyDomainTextArtifactResource"];
export type ArtifactResource = components["schemas"]["ArtifactResource"];
export type FrequencyDomainKPathMetadataResource =
  components["schemas"]["FrequencyDomainKPathMetadataResource"];
export type FrequencyDomainKPathSamplingResource =
  components["schemas"]["FrequencyDomainKPathSamplingResource"];
export type FrequencyDomainKPathControlPointResource =
  components["schemas"]["FrequencyDomainKPathControlPointResource"];
export type FrequencyDomainFieldResource =
  components["schemas"]["FrequencyDomainFieldResource"];
export type FrequencyDomainSweepProgressResource =
  components["schemas"]["FrequencyDomainSweepProgressResource"];
export type RealtimeCommunicationPolicy =
  components["schemas"]["RealtimeCommunicationPolicy"];
export type RealtimeCommunicationPolicyPatch =
  components["schemas"]["RealtimeCommunicationPolicyPatch"];
export type RealtimeCommunicationPolicyResource =
  components["schemas"]["RealtimeCommunicationPolicyResource"];
export type SolverProfileResource =
  components["schemas"]["SolverProfileResource"];
export type MaterialPatchRequest =
  components["schemas"]["MaterialPatchRequest"];
export type MaterialPropertiesResource =
  components["schemas"]["MaterialPropertiesResource"];
export type MaterialReferenceResource =
  components["schemas"]["MaterialReferenceResource"];
export type MaterialResource = components["schemas"]["MaterialResource"];
export type MagnetizationAssetPatchRequest =
  components["schemas"]["MagnetizationAssetPatchRequest"];
export type MagnetizationAssetResource =
  components["schemas"]["MagnetizationAssetResource"];
export type MeshActiveBuildResource =
  components["schemas"]["MeshActiveBuildResource"];
export type MeshBuildHistoryResource =
  components["schemas"]["MeshBuildHistoryResource"];
export type MeshCapabilitiesResource =
  components["schemas"]["MeshCapabilitiesResource"];
export type MeshCapabilityMatrixResource =
  components["schemas"]["MeshCapabilityMatrixResource"];
export type MeshFeatureCapabilityResource =
  components["schemas"]["MeshFeatureCapabilityResource"];
export type MeshHistogramBinElementsResource =
  components["schemas"]["MeshHistogramBinElementsResource"];
export type MeshHistogramBinMetric =
  | "characteristic_size"
  | "edge_length"
  | "gamma"
  | "sicn"
  | "volume";
export type MeshLastSuccessfulBuildResource =
  components["schemas"]["MeshLastSuccessfulBuildResource"];
export type MeshObjectQualityResource =
  components["schemas"]["MeshObjectQualityResource"];
export type MeshObjectReportResource =
  components["schemas"]["MeshObjectReportResource"];
export type MeshObjectSizeFieldResource =
  components["schemas"]["MeshObjectSizeFieldResource"];
export type MeshPeriodicPairsResource =
  components["schemas"]["MeshPeriodicPairsResource"];
export type PeriodicValidationStatus =
  components["schemas"]["PeriodicValidationStatus"];
export type MeshQualityGatesResource =
  components["schemas"]["MeshQualityGatesResource"];
export type MeshRealizedSizeFieldsResource =
  components["schemas"]["MeshRealizedSizeFieldsResource"];
export type MeshRegionMembershipListResource =
  components["schemas"]["MeshRegionMembershipListResource"];
export type MeshRegionMembershipResource =
  components["schemas"]["MeshRegionMembershipResource"];
export type FdmRegionMembershipResource =
  components["schemas"]["FdmRegionMembershipResource"];
export type PendingJsonResourceResult<TData> =
  | { data: TData; status: "ready" }
  | { data: null; status: "pending" };
export type MeshRegionQualityResource =
  components["schemas"]["MeshRegionQualityResource"];
export type MeshSemanticsResource =
  components["schemas"]["MeshSemanticsResource"];
export type MeshSharedDomainConfigResource =
  components["schemas"]["MeshSharedDomainConfigResource"];
export type MeshSharedDomainQualityResource =
  components["schemas"]["MeshSharedDomainQualityResource"];
export type MeshSharedDomainReportResource =
  components["schemas"]["MeshSharedDomainReportResource"];
export type MeshSummaryResource =
  components["schemas"]["MeshSummaryResource"];
export type MeshUniverseQualityResource =
  components["schemas"]["MeshUniverseQualityResource"];
export type MeshUniverseReportResource =
  components["schemas"]["MeshUniverseReportResource"];
export interface MeshObjectConfigReplaceRequest {
  config?: JsonObject | null;
}
export interface MeshObjectConfigResource {
  config?: JsonObject | null;
  effective_config?: JsonObject | null;
  object_id: string;
  revision: number;
}
export interface MeshUniverseConfigReplaceRequest {
  config?: JsonObject | null;
}
export interface MeshUniverseConfigResource {
  config?: JsonObject | null;
  effective_config?: JsonObject | null;
  revision: number;
}
export interface MeshSharedDomainConfigReplaceRequest {
  config: JsonObject;
}
export type MeshSharedDomainManifestResource =
  components["schemas"]["MeshSharedDomainManifestResource"];
export type CouplingListResource =
  components["schemas"]["CouplingListResource"];
export type SpinWaveGammaResource =
  components["schemas"]["SpinWaveGammaResource"];
export type DynamicStructureFactorResource =
  components["schemas"]["DynamicStructureFactorResource"];
export type FieldDriveListResource =
  components["schemas"]["FieldDriveListResource"];
export type PhysicsGraphResource =
  components["schemas"]["PhysicsGraphResource"];
export type PhysicsGraphActivationResource =
  components["schemas"]["PhysicsGraphActivationResource"];
export type PhysicsGraphEdgeResource =
  components["schemas"]["PhysicsGraphEdgeResource"];
export type PhysicsGraphModuleResource =
  components["schemas"]["PhysicsGraphModuleResource"];
export type PhysicsGraphProvenanceResource =
  components["schemas"]["PhysicsGraphProvenanceResource"];
export type PhysicsGraphScopeResource =
  components["schemas"]["PhysicsGraphScopeResource"];
export type RegionalFieldDriveResource =
  components["schemas"]["RegionalFieldDriveResource"];
export type FieldDriveCreateRequest =
  components["schemas"]["FieldDriveCreateRequest"];
export type FieldDriveReplaceRequest =
  components["schemas"]["FieldDriveReplaceRequest"];
export type FieldDriveDeleteRequest =
  components["schemas"]["FieldDriveDeleteRequest"];
export type RegionListResource = components["schemas"]["RegionListResource"];
export type RegionDiagnosticsResource =
  components["schemas"]["RegionDiagnosticsResource"];
export type MaterialParameterFieldListResource =
  components["schemas"]["MaterialParameterFieldListResource"];
export type RegionPatchRequest = components["schemas"]["RegionPatchRequest"];
export type SolverEnergyCurrentResource =
  components["schemas"]["SolverEnergyCurrentResource"];
export type SolverEnergyHistoryResource =
  components["schemas"]["SolverEnergyHistoryResource"];
export type SimulationPreparationResource =
  components["schemas"]["SimulationPreparationResource"];
export type SolverStatusResource = components["schemas"]["SolverStatusResource"];
export type StageExecutionResource =
  components["schemas"]["StageExecutionResource"];
export type HysteresisStagePlanSchema =
  components["schemas"]["HysteresisStagePlanSchema"];
export type HysteresisStageSaturationSchema =
  components["schemas"]["HysteresisStageSaturationSchema"];
export type HysteresisProtocolSchema =
  components["schemas"]["HysteresisProtocolSchema"];
export type HysteresisOrientationSchema =
  components["schemas"]["HysteresisOrientationSchema"];
export type HysteresisSettlePipelineSchema =
  components["schemas"]["HysteresisSettlePipelineSchema"];
export type HysteresisExecutionTreeResource =
  components["schemas"]["HysteresisExecutionTreeResource"];
export type HysteresisExecutionTreeNode =
  components["schemas"]["HysteresisExecutionTreeNode"];
export type HysteresisBookmarkPointRequest =
  components["schemas"]["HysteresisBookmarkPointRequest"];
export type HysteresisBookmarkSchema =
  components["schemas"]["HysteresisBookmarkSchema"];
export type HysteresisBookmarksResource =
  components["schemas"]["HysteresisBookmarksResource"];
export type HysteresisAngularFamilyResource =
  components["schemas"]["HysteresisAngularFamilyResource"];
export type HysteresisAdaptiveRefinementResource =
  components["schemas"]["HysteresisAdaptiveRefinementResource"];
export type HysteresisBranchesResource =
  components["schemas"]["HysteresisBranchesResource"];
export type HysteresisMinorLoopsResource =
  components["schemas"]["HysteresisMinorLoopsResource"];
export type HysteresisPointsResource =
  components["schemas"]["HysteresisPointsResource"];
export type HysteresisMetricsResource =
  components["schemas"]["HysteresisMetricsResource"];
export type HysteresisReversalFieldsResource =
  components["schemas"]["HysteresisReversalFieldsResource"];
export type HysteresisSettleTraceResource =
  components["schemas"]["HysteresisSettleTraceResource"];
export type HysteresisProgressSchema =
  components["schemas"]["HysteresisProgressSchema"];
export type StudyRuntimePatchRequest =
  components["schemas"]["StudyRuntimePatchRequest"];
export type StudyRuntimeResource =
  components["schemas"]["StudyRuntimeResource"];
export type AuthoringTransactionRequest =
  | { kind: "replace_scene"; scene: JsonObject }
  | (BaseAuthoringTransaction & {
      kind: "merge_patch";
      merge_patch: JsonObject;
    })
  | (BaseAuthoringTransaction & {
      asset?: JsonObject | null;
      kind: "patch_magnetization";
      magnetization_ref?: string | null;
      object_id: string;
      region_id?: string | null;
    })
  | (BaseAuthoringTransaction & ObjectGeometryPatchRequest & {
      kind: "patch_object_geometry";
      object_id: string;
    })
  | (BaseAuthoringTransaction & ObjectCreateRequest & {
      kind: "create_object";
    })
  | (BaseAuthoringTransaction & {
      kind: "create_material";
      material_id: string;
      name: string;
      properties: MaterialPropertiesResource;
      references?: MaterialReferenceResource[];
    })
  | (BaseAuthoringTransaction & {
      kind: "patch_material";
      material_id: string;
      patch: MaterialPatchRequest;
    })
  | (BaseAuthoringTransaction & {
      kind: "delete_material";
      material_id: string;
    })
  | (BaseAuthoringTransaction & {
      kind: "delete_object";
      object_id: string;
    })
  | (BaseAuthoringTransaction & {
      kind: "rename_object";
      name: string;
      object_id: string;
    })
  | (BaseAuthoringTransaction & {
      kind: "commit_object_transform";
      object_id: string;
      transform: JsonObject;
    })
  | (BaseAuthoringTransaction & {
      kind: "patch_universe";
      sync_study_universe_mesh?: boolean;
      universe: JsonObject;
    })
  | (BaseAuthoringTransaction & {
      kind: "create_object_region";
      object_id: string;
      region: components["schemas"]["SceneObjectRegion"];
    })
  | (BaseAuthoringTransaction & {
      kind: "patch_object_region";
      object_id: string;
      patch: components["schemas"]["SceneObjectRegionPatch"];
      region_id: string;
    })
  | (BaseAuthoringTransaction & {
      fields: components["schemas"]["SceneMaterialParameterAssignment"][];
      kind: "patch_object_material_fields";
      object_id: string;
    })
  | (BaseAuthoringTransaction & {
      kind: "delete_object_region";
      object_id: string;
      region_id: string;
    })
  | (BaseAuthoringTransaction & {
      kind: "reorder_object_regions";
      object_id: string;
      region_ids: string[];
    })
  | (BaseAuthoringTransaction & {
      coupling: components["schemas"]["SceneCoupling"];
      kind: "create_coupling";
    })
  | (BaseAuthoringTransaction & {
      coupling_id: string;
      kind: "patch_coupling";
      patch: components["schemas"]["SceneCouplingPatch"];
    })
  | (BaseAuthoringTransaction & {
      coupling_id: string;
      kind: "delete_coupling";
    });
export interface AuthoringTransactionResponse {
  committed_scene: SceneResource;
  scene_revision: number;
  transaction_kind: string;
}
export interface ObjectCreateRequest extends BaseAuthoringTransaction {
  geometry: JsonObject;
  magnetization_asset?: JsonObject | null;
  magnetization_ref?: string | null;
  material_asset?: JsonObject | null;
  material_ref?: string | null;
  name: string;
  object_id: string;
  region_name?: string | null;
  study_universe_mesh?: JsonObject | null;
  transform?: JsonObject | null;
  universe?: JsonObject | null;
}
export interface ObjectGeometryPatchRequest extends BaseAuthoringTransaction {
  geometry: JsonObject;
  transform?: JsonObject | null;
}
export interface ObjectRegionCreateRequest extends BaseAuthoringTransaction {
  region: components["schemas"]["SceneObjectRegion"];
}
export type ObjectRegionDuplicateRequest =
  components["schemas"]["ObjectRegionDuplicateRequest"];
export interface ObjectRegionPatchRequest extends BaseAuthoringTransaction {
  patch: components["schemas"]["SceneObjectRegionPatch"];
}
export type ObjectRegionReorderRequest =
  components["schemas"]["ObjectRegionReorderRequest"];
export interface ObjectInteractionPatchRequest {
  base_revision?: number | null;
  enabled?: boolean | null;
  params?: JsonObject;
  present?: boolean | null;
}
export interface ObjectInteractionResource {
  enabled: boolean;
  interaction_kind: ObjectInteractionKind | string;
  object_id: string;
  params: JsonObject;
  present: boolean;
  scene_revision: number;
}
export interface ObjectPatchRequest extends BaseAuthoringTransaction {
  absorbing_boundary?: JsonObject | null;
  geometry?: JsonObject | null;
  magnetization_ref?: string | null;
  material_ref?: string | null;
  name?: string | null;
  notes?: string | null;
  region_name?: string | null;
  transform?: JsonObject | null;
  visible?: boolean | null;
}
export interface ObjectMetricsResource {
  energies: {
    anisotropy: number;
    demag: number;
    dmi: number;
    exchange: number;
    total: number;
    zeeman: number;
  };
  has_solver_sample: boolean;
  magnetization_average: {
    mx: number;
    my: number;
    mz: number;
  } | null;
  object_id: string;
  revision: number;
  source: string;
  step: number;
  time_seconds: number;
}
export type SceneResource = components["schemas"]["SceneResource"];
export type FrozenSpinsCollectionResource =
  components["schemas"]["FrozenSpinsCollectionResource"];
export type FrozenSpinsDefinitionResource =
  components["schemas"]["FrozenSpinsDefinitionResource"];
export type FrozenSpinsMutationRequest =
  components["schemas"]["FrozenSpinsMutationRequest"];
export type FrozenSpinsDeleteRequest =
  components["schemas"]["FrozenSpinsDeleteRequest"];
export type FrozenSpinsPreviewRequest =
  components["schemas"]["FrozenSpinsPreviewRequest"];
export type FrozenSpinsPreviewResponse =
  components["schemas"]["FrozenSpinsPreviewResponse"];
export type FrozenSpinsPreviewActivationRequest =
  components["schemas"]["FrozenSpinsPreviewActivationRequest"];
export type FrozenSpinsPreviewActivationResponse =
  components["schemas"]["FrozenSpinsPreviewActivationResponse"];
export type FrozenSpinsRuntimeApplication =
  components["schemas"]["FrozenSpinsRuntimeApplication"];
export type FrozenSpinsSolverRuntimeStatus =
  components["schemas"]["FrozenSpinsSolverRuntimeStatus"];
export type FrozenSpinsDefinition = components["schemas"]["FrozenSpinsSchema"];
export type FrozenSpinsSelectionExpression =
  components["schemas"]["SelectionExprSchema"];
export type FrozenSpinsReferencePolicy =
  components["schemas"]["FrozenReferencePolicySchema"];
export type FrozenSpinsMembershipPolicy =
  components["schemas"]["SelectionMembershipPolicySchema"];
export type FrozenSpinsActivation =
  components["schemas"]["ConstraintActivationSchema"];
export type SelectionScalarExpression =
  components["schemas"]["SelectionScalarExprSchema"];
export type SelectionGeometryPredicate =
  components["schemas"]["SelectionGeometryPredicateSchema"];
export type SceneCurrentTransport = components["schemas"]["SceneCurrentTransport"];
export type SceneSpinTransport = components["schemas"]["SceneSpinTransport"];
export type KnownSceneCurrentTransport = components["schemas"]["KnownSceneCurrentTransport"];
export type KnownSceneSpinTransport = components["schemas"]["KnownSceneSpinTransport"];
export type SceneImpressedPotentialJump = components["schemas"]["SceneImpressedPotentialJump"];
export type SceneStructuredCurrentClosure = components["schemas"]["SceneStructuredCurrentClosure"];
export type SceneStructuredCurrentDrive = components["schemas"]["SceneStructuredCurrentDrive"];
export type SceneStructuredCurrentSourceCut = components["schemas"]["SceneStructuredCurrentSourceCut"];
export type SceneStructuredCutPlane = components["schemas"]["SceneStructuredCutPlane"];
export type SceneSpinTorque = components["schemas"]["SceneSpinTorque"];
export type SceneOerstedField = components["schemas"]["SceneOerstedField"];
export type CurrentTransportListResource = components["schemas"]["CurrentTransportListResource"];
export type CurrentTransportMutationRequest = components["schemas"]["CurrentTransportMutationRequest"];
export type CurrentTransportCommitResource = components["schemas"]["CurrentTransportCommitResource"];
export type SpinTransportListResource = components["schemas"]["SpinTransportListResource"];
export type SpinTransportMutationRequest = components["schemas"]["SpinTransportMutationRequest"];
export type SpinTransportCommitResource = components["schemas"]["SpinTransportCommitResource"];
export type SpinInterfaceListResource = components["schemas"]["SpinInterfaceListResource"];
export type TransportValidationRequest = components["schemas"]["TransportValidationRequest"];
export type TransportValidationResponse = components["schemas"]["TransportValidationResponse"];
export type TransportAuthoringCapabilityMap = components["schemas"]["TransportAuthoringCapabilityMap"];
export type SpinTorqueListResource = components["schemas"]["SpinTorqueListResource"];
export type SpinTorqueMutationRequest = components["schemas"]["SpinTorqueMutationRequest"];
export type SpinTorqueCommitResource = components["schemas"]["SpinTorqueCommitResource"];
export type OerstedFieldListResource = components["schemas"]["OerstedFieldListResource"];
export type OerstedFieldMutationRequest = components["schemas"]["OerstedFieldMutationRequest"];
export type OerstedFieldCommitResource = components["schemas"]["OerstedFieldCommitResource"];
export type SpinAuthoringDeleteRequest = components["schemas"]["SpinAuthoringDeleteRequest"];
export type RuntimeCommandPrecondition =
  components["schemas"]["RuntimeCommandPrecondition"];
export type RuntimeCommandTarget =
  components["schemas"]["RuntimeCommandTarget"];
export type ScalarWindowResource = components["schemas"]["ScalarWindow"];
export interface ScalarWindowQuery {
  columns?: readonly string[];
  limit?: number;
  sinceRevision?: number;
  tail?: boolean;
}
export type TableRowsResource = components["schemas"]["TableRowsResource"];
export type TableColumnMeta = components["schemas"]["TableColumnMeta"];
export type TableListResource = components["schemas"]["TableListResource"];
export type TableResource = components["schemas"]["TableResource"];
export interface TableRowsQuery {
  columns?: readonly string[];
  cursor?: number;
  decimation?: "minmax_lttb" | "none";
  fromRow?: number;
  fromT?: number;
  includeTail?: boolean;
  limit?: number;
  targetPoints?: number;
  toRow?: number;
  toT?: number;
}
export type SessionExportRequest =
  components["schemas"]["SessionExportRequest"];
export type ScriptSyncRequest = components["schemas"]["ScriptSyncRequest"];
export type ScriptSyncResponse = components["schemas"]["ScriptSyncResponse"];
export type ScriptSourceResponse = components["schemas"]["ScriptSourceResponse"];
export type SessionExportResponse =
  components["schemas"]["SessionExportResponse"];
export type SessionImportCommitRequest =
  components["schemas"]["SessionImportCommitRequest"];
export type SessionImportCommitResponse =
  components["schemas"]["SessionImportCommitResponse"];
export type SessionImportInspectRequest =
  components["schemas"]["SessionImportInspectRequest"];
export type SessionImportInspectResponse =
  components["schemas"]["SessionImportInspectResponse"];
type GeneratedStructuredCommandRequest =
  components["schemas"]["StructuredCommandRequest"];
type RuntimeCommandIntent = components["schemas"]["RuntimeCommandIntent"];
type MeshBuildCommandRequest = RuntimeCommandIntent & {
  kind: "mesh_build";
  mesh_options?: JsonObject | null;
  mesh_reason?: string | null;
  mesh_target?: components["schemas"]["MeshCommandTarget"] | null;
};
export type StructuredCommandRequest =
  | Exclude<GeneratedStructuredCommandRequest, { kind: "mesh_build" }>
  | MeshBuildCommandRequest;
export type UniversePatchRequest = components["schemas"]["UniversePatchRequest"];
export type UniverseResource = components["schemas"]["UniverseResource"];
export type VisualizationStatePatch =
  components["schemas"]["VisualizationStatePatch"];
export type VisualizationStateResource =
  components["schemas"]["VisualizationStateResource"];
export type ModeCompositionDatasetPatch =
  components["schemas"]["ModeCompositionDatasetPatch"];
export type EigenModeResourceRef =
  components["schemas"]["EigenModeResourceRef"];
export type ModeCompositionLayer =
  components["schemas"]["ModeCompositionLayer"];
export type ModeCompositionLifecycle =
  components["schemas"]["ModeCompositionLifecycle"];
export type ModeCompositionOperation =
  components["schemas"]["ModeCompositionOperation"];
export type ModeCompositionPatch =
  components["schemas"]["ModeCompositionPatch"];
export type ModeCompositionPhaseClock =
  components["schemas"]["ModeCompositionPhaseClock"];
export type ModeCompositionResource =
  components["schemas"]["ModeCompositionResource"];
export type ModeFieldComponent = components["schemas"]["ModeFieldComponent"];
export type ModeFieldNormalization =
  components["schemas"]["ModeFieldNormalization"];
export type ModeFieldRepresentation =
  components["schemas"]["ModeFieldRepresentation"];
export type ModeLayerAnimation = components["schemas"]["ModeLayerAnimation"];
export type ModeLayerAppearance = components["schemas"]["ModeLayerAppearance"];
export type VisualizationClientAckEntry =
  components["schemas"]["VisualizationClientAckEntry"];
export type VisualizationClientAckRequest =
  components["schemas"]["VisualizationClientAckRequest"];
export type VisualizationClientAckResource =
  components["schemas"]["VisualizationClientAckResource"];

export type HysteresisPointSchema = components["schemas"]["HysteresisPointSchema"];
export type HysteresisAdaptiveRefinementCandidateSchema =
  components["schemas"]["HysteresisAdaptiveRefinementCandidateSchema"];
export type HysteresisAdaptiveRefinementSchema =
  components["schemas"]["HysteresisAdaptiveRefinementSchema"];
export type HysteresisBranchSchema = components["schemas"]["HysteresisBranchSchema"];
export type HysteresisMinorLoopSchema =
  components["schemas"]["HysteresisMinorLoopSchema"];
export type HysteresisMetricsSchema = components["schemas"]["HysteresisMetricsSchema"];
export type HysteresisSaturationResultSchema =
  components["schemas"]["HysteresisSaturationResultSchema"];
export type HysteresisSaturationResource =
  components["schemas"]["HysteresisSaturationResource"];
export type HysteresisSettleTraceEntrySchema =
  components["schemas"]["HysteresisSettleTraceEntrySchema"];

export interface FieldVectorIdentityIssue {
  field: string;
  headerValue: number | string | null;
  payloadValue: number | string | null;
}

export interface FieldVectorResponseMetadata {
  component: string | null;
  domainGenerationId: string | null;
  encoding: string | null;
  fieldIndexing: string | null;
  fieldRevision: string | null;
  identityIssues: FieldVectorIdentityIssue[];
  meshTopologyHash: string | null;
  nComp: number | null;
  nodeIndexCount: number | null;
  pointCount: number | null;
  quantityId: string | null;
  scopeId: string | null;
  scopeKind: string | null;
  snapshotId: string | null;
  valueCount: number | null;
}

export type PendingBinaryResourceResult = FieldVectorPendingResponse & {
  etag: string | null;
  status: "pending";
};

type PendingBinaryResourceFor<TMetadata> =
  Extract<TMetadata, FieldVectorResponseMetadata> extends never
    ? never
    : PendingBinaryResourceResult;

type ReadyBinaryResourceResult<TData, TMetadata> = {
      byteLength: number;
      contentRange?: string | null;
      data: TData;
      etag: string | null;
      status: "ready";
    } & (unknown extends TMetadata
      ? { responseMetadata?: TMetadata }
      : { responseMetadata: TMetadata });

export type BinaryResourceResult<TData, TMetadata = unknown> =
  | ReadyBinaryResourceResult<TData, TMetadata>
  | PendingBinaryResourceFor<TMetadata>
  | {
      etag: string | null;
      status: "not-applicable";
    }
  | {
      etag: string | null;
      status: "not-modified";
    };

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface BinaryRequestOptions extends RequestOptions {
  etag?: string | null;
  range?: string | null;
}

export function isOptionalObjectInteractionKind(
  kind: ObjectInteractionKind,
): boolean {
  return kind === "interfacial_dmi" || kind === "uniaxial_anisotropy";
}
