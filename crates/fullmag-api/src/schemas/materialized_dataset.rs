//! Typed, bounded projection of one durable materialized dataset manifest.
//!
//! The route exposes the manifest's scientific identity and provenance while
//! deliberately omitting tensor chunks and numerical samples. The CAS root
//! remains addressable through the pinned source and artifact identities.

use crate::schemas::solutions::{
    SolutionAcceptedStateIdResource, SolutionExecutionStatusResource,
    SolutionScientificAssessmentResource,
};
use fullmag_quantities::{
    ActiveSupportDescriptor, ApproximationPolicy, ComplexEncoding, DatasetAvailability,
    DatasetAxisKind, DatasetAxisSelection, DatasetDefinition, DatasetEvaluationPolicy,
    DatasetFieldDescriptor, DatasetStatus, DatasetTransform, EvaluationPrecision, FieldFrameKind,
    FieldNormalization, FieldResolution, FieldSampleLocation, FieldValueRepresentation,
    FunctionSpaceDescriptor, FunctionSpaceOrdering, HarmonicConvention, ModalAmplitudeSemantics,
    ModalFieldSemantics, ModalNormalizationDescriptor, ModalNormalizationKind,
    ModalReconstructionRule, QuantityId, SelectionReference, SolutionArtifactRef,
    UnavailableAction,
};
use serde::Serialize;
use utoipa::ToSchema;

pub const MATERIALIZED_DATASET_RESOURCE_SCHEMA: &str = "fullmag.analysis.materialized_dataset.v1";

#[derive(Debug, Clone, Copy, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MaterializedDatasetIntegrityResource {
    Verified,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MaterializedDatasetQuantityResource {
    #[serde(rename = "m")]
    M,
    #[serde(rename = "frozen_spins")]
    FrozenSpins,
    #[serde(rename = "H_ex")]
    HEx,
    #[serde(rename = "H_demag")]
    HDemag,
    #[serde(rename = "H_ext")]
    HExt,
    #[serde(rename = "H_ant")]
    HAnt,
    #[serde(rename = "H_drive")]
    HDrive,
    #[serde(rename = "H_eff")]
    HEff,
    #[serde(rename = "torque")]
    Torque,
    #[serde(rename = "H_ani")]
    HAni,
    #[serde(rename = "H_dmi")]
    HDmi,
    #[serde(rename = "H_rotated_dmi")]
    HDmiRotated,
    #[serde(rename = "H_mel")]
    HMel,
    #[serde(rename = "u")]
    U,
    #[serde(rename = "eps")]
    Eps,
    #[serde(rename = "sigma")]
    Sigma,
    #[serde(rename = "H_ani_cubic")]
    HAniCubic,
    #[serde(rename = "H_dmi_bulk")]
    HDmiBulk,
    #[serde(rename = "H_oe")]
    HOe,
    #[serde(rename = "H_therm")]
    HTherm,
    #[serde(rename = "E_ex")]
    EEx,
    #[serde(rename = "E_demag")]
    EDemag,
    #[serde(rename = "E_ext")]
    EExt,
    #[serde(rename = "E_drive")]
    EDrive,
    #[serde(rename = "E_ani")]
    EAni,
    #[serde(rename = "E_dmi")]
    EDmi,
    #[serde(rename = "E_rotated_dmi")]
    ERotatedDmi,
    #[serde(rename = "E_el")]
    EEl,
    #[serde(rename = "E_kin_el")]
    EKinEl,
    #[serde(rename = "elastic_residual_norm")]
    ElasticResidualNorm,
    #[serde(rename = "E_total")]
    ETotal,
    #[serde(rename = "mode_amplitude")]
    ModeAmplitude,
    #[serde(rename = "mode_real")]
    ModeReal,
    #[serde(rename = "mode_imag")]
    ModeImag,
    #[serde(rename = "mode_phase")]
    ModePhase,
    #[serde(rename = "eden_ex")]
    EdenEx,
    #[serde(rename = "eden_demag")]
    EdenDemag,
    #[serde(rename = "demag_phi")]
    DemagPhi,
    #[serde(rename = "eden_ext")]
    EdenExt,
    #[serde(rename = "eden_drive")]
    EdenDrive,
    #[serde(rename = "eden_ani")]
    EdenAni,
    #[serde(rename = "eden_dmi")]
    EdenDmi,
    #[serde(rename = "eden_rotated_dmi")]
    EdenRotatedDmi,
    #[serde(rename = "eden_total")]
    EdenTotal,
    #[serde(rename = "mat_ms")]
    MatMs,
    #[serde(rename = "mat_aex")]
    MatAex,
    #[serde(rename = "mat_alpha")]
    MatAlpha,
    #[serde(rename = "mat_dind")]
    MatDind,
    #[serde(rename = "mat_dbulk")]
    MatDbulk,
    #[serde(rename = "dm_dt")]
    DmDt,
    #[serde(rename = "V_electric")]
    VElectric,
    #[serde(rename = "J_charge")]
    JCharge,
    #[serde(rename = "spin_potential")]
    SpinPotential,
    #[serde(rename = "spin_current_tensor")]
    SpinCurrentTensor,
    #[serde(rename = "torque_stt")]
    TorqueStt,
    #[serde(rename = "torque_sot")]
    TorqueSot,
}

impl From<QuantityId> for MaterializedDatasetQuantityResource {
    fn from(value: QuantityId) -> Self {
        match value {
            QuantityId::M => Self::M,
            QuantityId::FrozenSpins => Self::FrozenSpins,
            QuantityId::HEx => Self::HEx,
            QuantityId::HDemag => Self::HDemag,
            QuantityId::HExt => Self::HExt,
            QuantityId::HAnt => Self::HAnt,
            QuantityId::HDrive => Self::HDrive,
            QuantityId::HEff => Self::HEff,
            QuantityId::Torque => Self::Torque,
            QuantityId::HAni => Self::HAni,
            QuantityId::HDmi => Self::HDmi,
            QuantityId::HDmiRotated => Self::HDmiRotated,
            QuantityId::HMel => Self::HMel,
            QuantityId::U => Self::U,
            QuantityId::Eps => Self::Eps,
            QuantityId::Sigma => Self::Sigma,
            QuantityId::HAniCubic => Self::HAniCubic,
            QuantityId::HDmiBulk => Self::HDmiBulk,
            QuantityId::HOe => Self::HOe,
            QuantityId::HTherm => Self::HTherm,
            QuantityId::EEx => Self::EEx,
            QuantityId::EDemag => Self::EDemag,
            QuantityId::EExt => Self::EExt,
            QuantityId::EDrive => Self::EDrive,
            QuantityId::EAni => Self::EAni,
            QuantityId::EDmi => Self::EDmi,
            QuantityId::ERotatedDmi => Self::ERotatedDmi,
            QuantityId::EEl => Self::EEl,
            QuantityId::EKinEl => Self::EKinEl,
            QuantityId::ElasticResidualNorm => Self::ElasticResidualNorm,
            QuantityId::ETotal => Self::ETotal,
            QuantityId::ModeAmplitude => Self::ModeAmplitude,
            QuantityId::ModeReal => Self::ModeReal,
            QuantityId::ModeImag => Self::ModeImag,
            QuantityId::ModePhase => Self::ModePhase,
            QuantityId::EdenEx => Self::EdenEx,
            QuantityId::EdenDemag => Self::EdenDemag,
            QuantityId::DemagPhi => Self::DemagPhi,
            QuantityId::EdenExt => Self::EdenExt,
            QuantityId::EdenDrive => Self::EdenDrive,
            QuantityId::EdenAni => Self::EdenAni,
            QuantityId::EdenDmi => Self::EdenDmi,
            QuantityId::EdenRotatedDmi => Self::EdenRotatedDmi,
            QuantityId::EdenTotal => Self::EdenTotal,
            QuantityId::MatMs => Self::MatMs,
            QuantityId::MatAex => Self::MatAex,
            QuantityId::MatAlpha => Self::MatAlpha,
            QuantityId::MatDind => Self::MatDind,
            QuantityId::MatDbulk => Self::MatDbulk,
            QuantityId::DmDt => Self::DmDt,
            QuantityId::VElectric => Self::VElectric,
            QuantityId::JCharge => Self::JCharge,
            QuantityId::SpinPotential => Self::SpinPotential,
            QuantityId::SpinCurrentTensor => Self::SpinCurrentTensor,
            QuantityId::TorqueStt => Self::TorqueStt,
            QuantityId::TorqueSot => Self::TorqueSot,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MaterializedDatasetFrameKindResource {
    Laboratory,
    Object,
    Material,
    LocalBasis,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MaterializedDatasetSampleLocationResource {
    Node,
    Cell,
    DegreeOfFreedom,
    IntegrationPoint,
    Global,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MaterializedDatasetFunctionSpaceOrderingResource {
    ByNode,
    ByComponent,
    Lexicographic,
    NativeWithMapping,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MaterializedDatasetNormalizationResource {
    None,
    UnitVector,
    MaxAbs,
    L2,
    Modal,
    PhysicalAmplitude,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MaterializedDatasetValueRepresentationResource {
    PhysicalField,
    ModalPhysicalComponents,
    ModalFunctionSpaceCoefficients,
    ModalLocalTangentCoefficients,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MaterializedDatasetResolutionResource {
    Quantitative,
    PreviewOnly,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MaterializedDatasetComplexEncodingResource {
    Real,
    RealImagPair,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MaterializedDatasetHarmonicConventionResource {
    ExpPositiveIOmegaT,
    ExpNegativeIOmegaT,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MaterializedDatasetAvailabilityResource {
    Ready,
    NotRecorded,
    NotApplicable,
    NotYetComputed,
    Unsupported,
    Missing,
    Corrupt,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MaterializedDatasetUnavailableActionResource {
    SelectAvailableQuantity,
    RecomputeFromRecordedState,
    CreateNewRun,
    RepairOrRestoreArtifact,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MaterializedDatasetEvaluationPrecisionResource {
    F32,
    F64,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MaterializedDatasetApproximationResource {
    ExactOnly,
    AllowDeclaredApproximation,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MaterializedDatasetUnavailableDataResource {
    Fail,
    PreserveUnavailable,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MaterializedDatasetAxisKindResource {
    Time,
    Frequency,
    WaveVector,
    Mode,
    Parameter,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MaterializedDatasetProjectionMethodResource {
    Nearest,
    Linear,
    Conservative,
    L2,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MaterializedDatasetPlaneResource {
    Values,
    Real,
    Imaginary,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MaterializedDatasetDtypeResource {
    U8,
    I32,
    U32,
    F32,
    F64,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MaterializedDatasetModalReconstructionResource {
    PhysicalComponents,
    FunctionSpaceBasisExpansion,
    LocalTangentBasisToCartesian,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MaterializedDatasetModalAmplitudeResource {
    RelativeEigenvector,
    PhysicalDrivenResponse,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MaterializedDatasetModalNormalizationKindResource {
    L2,
    MaxAbs,
    Energy,
    Biorthogonal,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MaterializedDatasetPinnedSourceResource {
    pub run_id: String,
    pub solution_set_id: String,
    pub solution_revision: String,
    pub member_id: String,
    pub artifact_id: String,
    pub tensor_object_ref: String,
    pub run_spec_digest: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MaterializedDatasetSelectionResource {
    pub selection_id: String,
    pub selection_revision: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MaterializedDatasetStatusResource {
    pub availability: MaterializedDatasetAvailabilityResource,
    pub reason: Option<String>,
    pub actions: Vec<MaterializedDatasetUnavailableActionResource>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MaterializedDatasetEvaluationPolicyResource {
    pub precision: MaterializedDatasetEvaluationPrecisionResource,
    pub approximation: MaterializedDatasetApproximationResource,
    pub unavailable_data: MaterializedDatasetUnavailableDataResource,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MaterializedDatasetAxisSelectionResource {
    pub axis_id: String,
    pub kind: MaterializedDatasetAxisKindResource,
    pub coordinate_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MaterializedDatasetFieldProjectionResource {
    pub method: MaterializedDatasetProjectionMethodResource,
    pub target_space_id: String,
    pub producer_version: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MaterializedDatasetTransformResource {
    Projection {
        target_space_id: String,
        method: MaterializedDatasetProjectionMethodResource,
        producer_version: String,
    },
    Cut {
        selection: MaterializedDatasetSelectionResource,
    },
    Composition {
        component: String,
    },
    Difference {
        rhs_dataset_id: String,
        projection: Option<MaterializedDatasetFieldProjectionResource>,
    },
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MaterializedDatasetDefinitionResource {
    pub schema_version: String,
    pub definition_id: String,
    pub revision: String,
    pub source: MaterializedDatasetPinnedSourceResource,
    pub domain_selection: MaterializedDatasetSelectionResource,
    pub axes: Vec<MaterializedDatasetAxisSelectionResource>,
    pub transforms: Vec<MaterializedDatasetTransformResource>,
    pub evaluation_policy: MaterializedDatasetEvaluationPolicyResource,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MaterializedDatasetIdentityResource {
    pub schema_version: String,
    pub dataset_id: String,
    pub revision: String,
    pub definition_id: String,
    pub definition_revision: String,
    pub source: MaterializedDatasetPinnedSourceResource,
    pub status: MaterializedDatasetStatusResource,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MaterializedDatasetFrameResource {
    pub kind: MaterializedDatasetFrameKindResource,
    pub frame_id: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MaterializedDatasetActiveSupportResource {
    pub support_fingerprint: String,
    pub selection: Option<MaterializedDatasetSelectionResource>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MaterializedDatasetFunctionSpaceResource {
    pub space_id: String,
    pub family: String,
    pub order: String,
    pub vector_dimension: String,
    pub ordering: MaterializedDatasetFunctionSpaceOrderingResource,
    pub basis_id: String,
    pub constraints_fingerprint: Option<String>,
    pub partition_fingerprint: Option<String>,
    pub orientation_mapping_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MaterializedDatasetAxisResource {
    pub axis_id: String,
    pub unit: String,
    pub length: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MaterializedDatasetModalNormalizationResource {
    pub kind: MaterializedDatasetModalNormalizationKindResource,
    pub scale: String,
    pub unit: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MaterializedDatasetModalSemanticsResource {
    pub equilibrium_state: SolutionAcceptedStateIdResource,
    pub linearization_id: String,
    pub modal_basis_id: String,
    pub reconstruction: MaterializedDatasetModalReconstructionResource,
    pub phase_reference_id: String,
    pub normalization: MaterializedDatasetModalNormalizationResource,
    pub amplitude_semantics: MaterializedDatasetModalAmplitudeResource,
    pub producer_version: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MaterializedDatasetFieldDescriptorResource {
    pub quantity_id: MaterializedDatasetQuantityResource,
    pub unit: String,
    pub tensor_rank: String,
    pub frame: MaterializedDatasetFrameResource,
    pub sample_location: MaterializedDatasetSampleLocationResource,
    pub active_support: MaterializedDatasetActiveSupportResource,
    pub function_space: Option<MaterializedDatasetFunctionSpaceResource>,
    pub topology_id: String,
    pub carrier_id: String,
    pub layout_digest: String,
    pub axes: Vec<MaterializedDatasetAxisResource>,
    pub component_axis: Option<String>,
    pub complex_encoding: MaterializedDatasetComplexEncodingResource,
    pub harmonic_convention: Option<MaterializedDatasetHarmonicConventionResource>,
    pub normalization: MaterializedDatasetNormalizationResource,
    pub value_representation: MaterializedDatasetValueRepresentationResource,
    pub modal_semantics: Option<MaterializedDatasetModalSemanticsResource>,
    pub resolution: MaterializedDatasetResolutionResource,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MaterializedDatasetCoverageResource {
    pub total_elements: String,
    pub component_count: String,
    pub dtype: MaterializedDatasetDtypeResource,
    pub endian: String,
    pub total_bytes: String,
    pub chunk_count: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MaterializedDatasetTensorArtifactResource {
    pub artifact_id: String,
    pub schema_id: String,
    pub object_ref: String,
    pub byte_length: String,
    pub accepted_state: Option<SolutionAcceptedStateIdResource>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MaterializedDatasetFieldResource {
    pub sample_id: String,
    pub item_id: String,
    pub field_id: String,
    pub group_id: String,
    pub producer_id: String,
    pub producer_version: String,
    pub tensor_schema_id: String,
    pub tensor_byte_length: String,
    pub plane: MaterializedDatasetPlaneResource,
    pub accepted_state: Option<SolutionAcceptedStateIdResource>,
    pub tensor_artifact: MaterializedDatasetTensorArtifactResource,
    pub descriptor: MaterializedDatasetFieldDescriptorResource,
    pub coverage: MaterializedDatasetCoverageResource,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MaterializedDatasetResource {
    pub schema_version: String,
    pub project_id: String,
    pub run_id: String,
    pub solution_set_id: String,
    pub containing_solution_revision: String,
    pub owner_solution_revision: String,
    pub member_id: String,
    pub artifact_id: String,
    pub manifest_object_ref: String,
    pub manifest_byte_length: String,
    pub integrity: MaterializedDatasetIntegrityResource,
    pub dataset: MaterializedDatasetIdentityResource,
    pub definition: MaterializedDatasetDefinitionResource,
    pub source: MaterializedDatasetPinnedSourceResource,
    pub owner_execution_status: SolutionExecutionStatusResource,
    pub owner_scientific_assessment: SolutionScientificAssessmentResource,
    pub sample_id: String,
    pub item_id: String,
    pub field_id: String,
    pub field: MaterializedDatasetFieldResource,
}

impl MaterializedDatasetResource {
    /// Project one already verified session-layer result without exposing CAS
    /// chunk references or numeric payload arrays.
    pub fn from_resolved(
        project_id: String,
        run_id: String,
        resolved: &fullmag_session::materialized_dataset::ResolvedMaterializedDataset,
    ) -> anyhow::Result<Self> {
        let manifest = &resolved.manifest;
        let owner = &resolved.owner;
        let semantic_field = manifest
            .dataset
            .samples
            .first()
            .and_then(|sample| sample.items.first())
            .and_then(|item| item.fields.first())
            .ok_or_else(|| anyhow::anyhow!("materialized dataset field is missing"))?;
        let source = pinned_source(&manifest.field.source);
        let accepted_state = manifest
            .field
            .accepted_state
            .as_ref()
            .map(accepted_state_resource);

        Ok(Self {
            schema_version: MATERIALIZED_DATASET_RESOURCE_SCHEMA.to_string(),
            project_id,
            run_id,
            solution_set_id: owner.solution_set_id.clone(),
            containing_solution_revision: resolved.containing_solution_revision.to_string(),
            owner_solution_revision: manifest.field.source.solution_revision.to_string(),
            member_id: manifest.field.source.member_id.clone(),
            artifact_id: resolved.manifest_artifact.artifact_id.clone(),
            manifest_object_ref: resolved.manifest_artifact.object_ref.clone(),
            manifest_byte_length: resolved.manifest_artifact.byte_length.to_string(),
            integrity: MaterializedDatasetIntegrityResource::Verified,
            dataset: dataset_resource(&manifest.dataset, &source),
            definition: definition_resource(&manifest.definition, &source),
            source: source.clone(),
            owner_execution_status: owner.execution_status.into(),
            owner_scientific_assessment: (&owner.scientific_assessment).into(),
            sample_id: manifest.field.sample_id.clone(),
            item_id: manifest.field.item_id.clone(),
            field_id: manifest.field.field_id.clone(),
            field: MaterializedDatasetFieldResource {
                sample_id: manifest.field.sample_id.clone(),
                item_id: manifest.field.item_id.clone(),
                field_id: manifest.field.field_id.clone(),
                group_id: manifest.field.group_id.clone(),
                producer_id: manifest.field.producer_id.clone(),
                producer_version: manifest.field.producer_version.clone(),
                tensor_schema_id: manifest.field.tensor_schema_id.clone(),
                tensor_byte_length: manifest.field.tensor_byte_length.to_string(),
                plane: manifest.field.plane.into(),
                accepted_state: accepted_state.clone(),
                tensor_artifact: tensor_artifact_resource(
                    &manifest.field.tensor_artifact,
                    accepted_state.clone(),
                ),
                descriptor: descriptor_resource(&semantic_field.descriptor),
                coverage: coverage_resource(&manifest.field.coverage),
            },
        })
    }
}

fn accepted_state_resource(
    value: &fullmag_quantities::AcceptedStateId,
) -> SolutionAcceptedStateIdResource {
    SolutionAcceptedStateIdResource {
        run_id: value.run_id.clone(),
        stage_id: value.stage_id.clone(),
        accepted_step: value.accepted_step.to_string(),
        clock_digest: value.clock_digest.clone(),
        state_digest: value.state_digest.clone(),
        domain_digest: value.domain_digest.clone(),
        plan_digest: value.plan_digest.clone(),
    }
}

pub(crate) fn pinned_source(
    source: &fullmag_session::solution_tensor_source::PinnedSolutionTensorSource,
) -> MaterializedDatasetPinnedSourceResource {
    MaterializedDatasetPinnedSourceResource {
        run_id: source.run_id.clone(),
        solution_set_id: source.solution_set_id.clone(),
        solution_revision: source.solution_revision.to_string(),
        member_id: source.member_id.clone(),
        artifact_id: source.artifact_id.clone(),
        tensor_object_ref: source.tensor_object_ref.clone(),
        run_spec_digest: source.run_spec_digest.clone(),
    }
}

fn dataset_resource(
    value: &fullmag_quantities::MaterializedDataset,
    source: &MaterializedDatasetPinnedSourceResource,
) -> MaterializedDatasetIdentityResource {
    MaterializedDatasetIdentityResource {
        schema_version: value.schema_version.clone(),
        dataset_id: value.dataset_id.clone(),
        revision: value.revision.to_string(),
        definition_id: value.definition.definition_id.clone(),
        definition_revision: value.definition.revision.to_string(),
        source: source.clone(),
        status: status_resource(&value.status),
    }
}

fn definition_resource(
    value: &DatasetDefinition,
    source: &MaterializedDatasetPinnedSourceResource,
) -> MaterializedDatasetDefinitionResource {
    MaterializedDatasetDefinitionResource {
        schema_version: value.schema_version.clone(),
        definition_id: value.definition_id.clone(),
        revision: value.revision.to_string(),
        source: source.clone(),
        domain_selection: selection_resource(&value.domain_selection),
        axes: value.axes.iter().map(axis_selection_resource).collect(),
        transforms: value.transforms.iter().map(transform_resource).collect(),
        evaluation_policy: evaluation_policy_resource(&value.evaluation_policy),
    }
}

fn selection_resource(value: &SelectionReference) -> MaterializedDatasetSelectionResource {
    MaterializedDatasetSelectionResource {
        selection_id: value.selection_id.clone(),
        selection_revision: value.selection_revision.to_string(),
    }
}

fn status_resource(value: &DatasetStatus) -> MaterializedDatasetStatusResource {
    MaterializedDatasetStatusResource {
        availability: value.availability.into(),
        reason: value.reason.clone(),
        actions: value.actions.iter().copied().map(Into::into).collect(),
    }
}

fn evaluation_policy_resource(
    value: &DatasetEvaluationPolicy,
) -> MaterializedDatasetEvaluationPolicyResource {
    MaterializedDatasetEvaluationPolicyResource {
        precision: value.precision.into(),
        approximation: value.approximation.into(),
        unavailable_data: value.unavailable_data.into(),
    }
}

fn axis_selection_resource(
    value: &DatasetAxisSelection,
) -> MaterializedDatasetAxisSelectionResource {
    MaterializedDatasetAxisSelectionResource {
        axis_id: value.axis_id.clone(),
        kind: value.kind.into(),
        coordinate_ids: value.coordinate_ids.clone(),
    }
}

fn transform_resource(value: &DatasetTransform) -> MaterializedDatasetTransformResource {
    match value {
        DatasetTransform::Projection {
            target_space_id,
            method,
            producer_version,
        } => MaterializedDatasetTransformResource::Projection {
            target_space_id: target_space_id.clone(),
            method: (*method).into(),
            producer_version: producer_version.clone(),
        },
        DatasetTransform::Cut { selection } => MaterializedDatasetTransformResource::Cut {
            selection: selection_resource(selection),
        },
        DatasetTransform::Composition { component } => {
            MaterializedDatasetTransformResource::Composition {
                component: component.clone(),
            }
        }
        DatasetTransform::Difference {
            rhs_dataset_id,
            projection,
        } => MaterializedDatasetTransformResource::Difference {
            rhs_dataset_id: rhs_dataset_id.clone(),
            projection: projection.as_ref().map(|projection| {
                MaterializedDatasetFieldProjectionResource {
                    method: projection.method.into(),
                    target_space_id: projection.target_space_id.clone(),
                    producer_version: projection.producer_version.clone(),
                }
            }),
        },
    }
}

pub(crate) fn descriptor_resource(
    value: &DatasetFieldDescriptor,
) -> MaterializedDatasetFieldDescriptorResource {
    MaterializedDatasetFieldDescriptorResource {
        quantity_id: value.quantity_id.into(),
        unit: value.unit.clone(),
        tensor_rank: value.tensor_rank.to_string(),
        frame: MaterializedDatasetFrameResource {
            kind: value.frame.kind.into(),
            frame_id: value.frame.frame_id.clone(),
        },
        sample_location: value.sample_location.into(),
        active_support: active_support_resource(&value.active_support),
        function_space: value.function_space.as_ref().map(function_space_resource),
        topology_id: value.topology_id.clone(),
        carrier_id: value.carrier_id.clone(),
        layout_digest: value.layout_digest.clone(),
        axes: value
            .axes
            .iter()
            .map(|axis| MaterializedDatasetAxisResource {
                axis_id: axis.axis_id.clone(),
                unit: axis.unit.clone(),
                length: axis.length.to_string(),
            })
            .collect(),
        component_axis: value.component_axis.clone(),
        complex_encoding: value.complex_encoding.into(),
        harmonic_convention: value.harmonic_convention.map(Into::into),
        normalization: value.normalization.into(),
        value_representation: value.value_representation.into(),
        modal_semantics: value.modal_semantics.as_ref().map(modal_semantics_resource),
        resolution: value.resolution.into(),
    }
}

fn active_support_resource(
    value: &ActiveSupportDescriptor,
) -> MaterializedDatasetActiveSupportResource {
    MaterializedDatasetActiveSupportResource {
        support_fingerprint: value.support_fingerprint.clone(),
        selection: value.selection.as_ref().map(selection_resource),
    }
}

fn function_space_resource(
    value: &FunctionSpaceDescriptor,
) -> MaterializedDatasetFunctionSpaceResource {
    MaterializedDatasetFunctionSpaceResource {
        space_id: value.space_id.clone(),
        family: value.family.clone(),
        order: value.order.to_string(),
        vector_dimension: value.vector_dimension.to_string(),
        ordering: value.ordering.into(),
        basis_id: value.basis_id.clone(),
        constraints_fingerprint: value.constraints_fingerprint.clone(),
        partition_fingerprint: value.partition_fingerprint.clone(),
        orientation_mapping_ref: value.orientation_mapping_ref.clone(),
    }
}

fn modal_semantics_resource(
    value: &ModalFieldSemantics,
) -> MaterializedDatasetModalSemanticsResource {
    MaterializedDatasetModalSemanticsResource {
        equilibrium_state: accepted_state_resource(&value.equilibrium_state),
        linearization_id: value.linearization_id.clone(),
        modal_basis_id: value.modal_basis_id.clone(),
        reconstruction: value.reconstruction.into(),
        phase_reference_id: value.phase_reference_id.clone(),
        normalization: modal_normalization_resource(&value.normalization),
        amplitude_semantics: value.amplitude_semantics.into(),
        producer_version: value.producer_version.clone(),
    }
}

fn modal_normalization_resource(
    value: &ModalNormalizationDescriptor,
) -> MaterializedDatasetModalNormalizationResource {
    MaterializedDatasetModalNormalizationResource {
        kind: value.kind.into(),
        scale: value.scale.clone(),
        unit: value.unit.clone(),
    }
}

fn coverage_resource(
    value: &fullmag_session::materialized_dataset::MaterializedDatasetTensorCoverage,
) -> MaterializedDatasetCoverageResource {
    MaterializedDatasetCoverageResource {
        total_elements: value.total_elements.to_string(),
        component_count: value.component_count.to_string(),
        dtype: value.dtype.into(),
        endian: value.endian.clone(),
        total_bytes: value.total_bytes.to_string(),
        chunk_count: value.chunk_count.to_string(),
    }
}

fn tensor_artifact_resource(
    value: &SolutionArtifactRef,
    accepted_state: Option<SolutionAcceptedStateIdResource>,
) -> MaterializedDatasetTensorArtifactResource {
    MaterializedDatasetTensorArtifactResource {
        artifact_id: value.artifact_id.clone(),
        schema_id: value.schema_id.clone(),
        object_ref: value.object_ref.clone(),
        byte_length: value.byte_length.to_string(),
        accepted_state,
    }
}

impl From<FieldFrameKind> for MaterializedDatasetFrameKindResource {
    fn from(value: FieldFrameKind) -> Self {
        match value {
            FieldFrameKind::Laboratory => Self::Laboratory,
            FieldFrameKind::Object => Self::Object,
            FieldFrameKind::Material => Self::Material,
            FieldFrameKind::LocalBasis => Self::LocalBasis,
        }
    }
}

impl From<FieldSampleLocation> for MaterializedDatasetSampleLocationResource {
    fn from(value: FieldSampleLocation) -> Self {
        match value {
            FieldSampleLocation::Node => Self::Node,
            FieldSampleLocation::Cell => Self::Cell,
            FieldSampleLocation::DegreeOfFreedom => Self::DegreeOfFreedom,
            FieldSampleLocation::IntegrationPoint => Self::IntegrationPoint,
            FieldSampleLocation::Global => Self::Global,
        }
    }
}

impl From<FunctionSpaceOrdering> for MaterializedDatasetFunctionSpaceOrderingResource {
    fn from(value: FunctionSpaceOrdering) -> Self {
        match value {
            FunctionSpaceOrdering::ByNode => Self::ByNode,
            FunctionSpaceOrdering::ByComponent => Self::ByComponent,
            FunctionSpaceOrdering::Lexicographic => Self::Lexicographic,
            FunctionSpaceOrdering::NativeWithMapping => Self::NativeWithMapping,
        }
    }
}

impl From<FieldNormalization> for MaterializedDatasetNormalizationResource {
    fn from(value: FieldNormalization) -> Self {
        match value {
            FieldNormalization::None => Self::None,
            FieldNormalization::UnitVector => Self::UnitVector,
            FieldNormalization::MaxAbs => Self::MaxAbs,
            FieldNormalization::L2 => Self::L2,
            FieldNormalization::Modal => Self::Modal,
            FieldNormalization::PhysicalAmplitude => Self::PhysicalAmplitude,
        }
    }
}

impl From<FieldValueRepresentation> for MaterializedDatasetValueRepresentationResource {
    fn from(value: FieldValueRepresentation) -> Self {
        match value {
            FieldValueRepresentation::PhysicalField => Self::PhysicalField,
            FieldValueRepresentation::ModalPhysicalComponents => Self::ModalPhysicalComponents,
            FieldValueRepresentation::ModalFunctionSpaceCoefficients => {
                Self::ModalFunctionSpaceCoefficients
            }
            FieldValueRepresentation::ModalLocalTangentCoefficients => {
                Self::ModalLocalTangentCoefficients
            }
        }
    }
}

impl From<FieldResolution> for MaterializedDatasetResolutionResource {
    fn from(value: FieldResolution) -> Self {
        match value {
            FieldResolution::Quantitative => Self::Quantitative,
            FieldResolution::PreviewOnly => Self::PreviewOnly,
        }
    }
}

impl From<ComplexEncoding> for MaterializedDatasetComplexEncodingResource {
    fn from(value: ComplexEncoding) -> Self {
        match value {
            ComplexEncoding::Real => Self::Real,
            ComplexEncoding::RealImagPair => Self::RealImagPair,
        }
    }
}

impl From<HarmonicConvention> for MaterializedDatasetHarmonicConventionResource {
    fn from(value: HarmonicConvention) -> Self {
        match value {
            HarmonicConvention::ExpPositiveIOmegaT => Self::ExpPositiveIOmegaT,
            HarmonicConvention::ExpNegativeIOmegaT => Self::ExpNegativeIOmegaT,
        }
    }
}

impl From<DatasetAvailability> for MaterializedDatasetAvailabilityResource {
    fn from(value: DatasetAvailability) -> Self {
        match value {
            DatasetAvailability::Ready => Self::Ready,
            DatasetAvailability::NotRecorded => Self::NotRecorded,
            DatasetAvailability::NotApplicable => Self::NotApplicable,
            DatasetAvailability::NotYetComputed => Self::NotYetComputed,
            DatasetAvailability::Unsupported => Self::Unsupported,
            DatasetAvailability::Missing => Self::Missing,
            DatasetAvailability::Corrupt => Self::Corrupt,
        }
    }
}

impl From<UnavailableAction> for MaterializedDatasetUnavailableActionResource {
    fn from(value: UnavailableAction) -> Self {
        match value {
            UnavailableAction::SelectAvailableQuantity => Self::SelectAvailableQuantity,
            UnavailableAction::RecomputeFromRecordedState => Self::RecomputeFromRecordedState,
            UnavailableAction::CreateNewRun => Self::CreateNewRun,
            UnavailableAction::RepairOrRestoreArtifact => Self::RepairOrRestoreArtifact,
        }
    }
}

impl From<EvaluationPrecision> for MaterializedDatasetEvaluationPrecisionResource {
    fn from(value: EvaluationPrecision) -> Self {
        match value {
            EvaluationPrecision::F32 => Self::F32,
            EvaluationPrecision::F64 => Self::F64,
        }
    }
}

impl From<ApproximationPolicy> for MaterializedDatasetApproximationResource {
    fn from(value: ApproximationPolicy) -> Self {
        match value {
            ApproximationPolicy::ExactOnly => Self::ExactOnly,
            ApproximationPolicy::AllowDeclaredApproximation => Self::AllowDeclaredApproximation,
        }
    }
}

impl From<fullmag_quantities::UnavailableDataPolicy>
    for MaterializedDatasetUnavailableDataResource
{
    fn from(value: fullmag_quantities::UnavailableDataPolicy) -> Self {
        match value {
            fullmag_quantities::UnavailableDataPolicy::Fail => Self::Fail,
            fullmag_quantities::UnavailableDataPolicy::PreserveUnavailable => {
                Self::PreserveUnavailable
            }
        }
    }
}

impl From<DatasetAxisKind> for MaterializedDatasetAxisKindResource {
    fn from(value: DatasetAxisKind) -> Self {
        match value {
            DatasetAxisKind::Time => Self::Time,
            DatasetAxisKind::Frequency => Self::Frequency,
            DatasetAxisKind::WaveVector => Self::WaveVector,
            DatasetAxisKind::Mode => Self::Mode,
            DatasetAxisKind::Parameter => Self::Parameter,
        }
    }
}

impl From<fullmag_quantities::ProjectionMethod> for MaterializedDatasetProjectionMethodResource {
    fn from(value: fullmag_quantities::ProjectionMethod) -> Self {
        match value {
            fullmag_quantities::ProjectionMethod::Nearest => Self::Nearest,
            fullmag_quantities::ProjectionMethod::Linear => Self::Linear,
            fullmag_quantities::ProjectionMethod::Conservative => Self::Conservative,
            fullmag_quantities::ProjectionMethod::L2 => Self::L2,
        }
    }
}

impl From<fullmag_quantities::DatasetSlicePlane> for MaterializedDatasetPlaneResource {
    fn from(value: fullmag_quantities::DatasetSlicePlane) -> Self {
        match value {
            fullmag_quantities::DatasetSlicePlane::Values => Self::Values,
            fullmag_quantities::DatasetSlicePlane::Real => Self::Real,
            fullmag_quantities::DatasetSlicePlane::Imaginary => Self::Imaginary,
        }
    }
}

impl From<fullmag_session::TensorDtype> for MaterializedDatasetDtypeResource {
    fn from(value: fullmag_session::TensorDtype) -> Self {
        match value {
            fullmag_session::TensorDtype::U8 => Self::U8,
            fullmag_session::TensorDtype::I32 => Self::I32,
            fullmag_session::TensorDtype::U32 => Self::U32,
            fullmag_session::TensorDtype::F32 => Self::F32,
            fullmag_session::TensorDtype::F64 => Self::F64,
        }
    }
}

impl From<ModalReconstructionRule> for MaterializedDatasetModalReconstructionResource {
    fn from(value: ModalReconstructionRule) -> Self {
        match value {
            ModalReconstructionRule::PhysicalComponents => Self::PhysicalComponents,
            ModalReconstructionRule::FunctionSpaceBasisExpansion => {
                Self::FunctionSpaceBasisExpansion
            }
            ModalReconstructionRule::LocalTangentBasisToCartesian => {
                Self::LocalTangentBasisToCartesian
            }
        }
    }
}

impl From<ModalAmplitudeSemantics> for MaterializedDatasetModalAmplitudeResource {
    fn from(value: ModalAmplitudeSemantics) -> Self {
        match value {
            ModalAmplitudeSemantics::RelativeEigenvector => Self::RelativeEigenvector,
            ModalAmplitudeSemantics::PhysicalDrivenResponse => Self::PhysicalDrivenResponse,
        }
    }
}

impl From<ModalNormalizationKind> for MaterializedDatasetModalNormalizationKindResource {
    fn from(value: ModalNormalizationKind) -> Self {
        match value {
            ModalNormalizationKind::L2 => Self::L2,
            ModalNormalizationKind::MaxAbs => Self::MaxAbs,
            ModalNormalizationKind::Energy => Self::Energy,
            ModalNormalizationKind::Biorthogonal => Self::Biorthogonal,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantity_projection_keeps_canonical_wire_names() {
        let value = serde_json::to_value(MaterializedDatasetQuantityResource::HDemag).unwrap();
        assert_eq!(value, serde_json::json!("H_demag"));
        let value = serde_json::to_value(MaterializedDatasetQuantityResource::VElectric).unwrap();
        assert_eq!(value, serde_json::json!("V_electric"));
    }

    #[test]
    fn integrity_projection_is_explicitly_verified() {
        let value = serde_json::to_value(MaterializedDatasetIntegrityResource::Verified).unwrap();
        assert_eq!(value, serde_json::json!("verified"));
    }

    #[test]
    fn revisions_and_coverage_counts_are_strings_for_javascript_safety() {
        let source = MaterializedDatasetPinnedSourceResource {
            run_id: "run:test".to_string(),
            solution_set_id: "solution:test".to_string(),
            solution_revision: "9007199254740993".to_string(),
            member_id: "member:test".to_string(),
            artifact_id: "artifact:test".to_string(),
            tensor_object_ref: "a".repeat(64),
            run_spec_digest: "b".repeat(64),
        };
        let coverage = MaterializedDatasetCoverageResource {
            total_elements: "9007199254740993".to_string(),
            component_count: "3".to_string(),
            dtype: MaterializedDatasetDtypeResource::F64,
            endian: "little".to_string(),
            total_bytes: "216172782113783832".to_string(),
            chunk_count: "16384".to_string(),
        };
        let source_json = serde_json::to_value(source).unwrap();
        let coverage_json = serde_json::to_value(coverage).unwrap();
        assert!(source_json["solution_revision"].is_string());
        assert!(coverage_json["total_elements"].is_string());
        assert!(coverage_json["total_bytes"].is_string());
    }
}
