//! Typed, metadata-only transport for immutable durable solution revisions.
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

pub const SOLUTION_RESOURCE_SCHEMA: &str = "fullmag.analysis.solution_revision.v1";

/// One verified scalar payload, independent of the active session.
#[derive(Debug, Serialize, ToSchema)]
pub struct SolutionScalarResource {
    pub schema_version: String,
    pub project_id: String,
    pub run_id: String,
    pub solution_set_id: String,
    pub revision: String,
    pub manifest_digest: String,
    pub member_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub ownership_epoch: String,
    pub artifact_id: String,
    pub object_ref: String,
    pub byte_length: String,
    pub quantity_id: String,
    pub unit: String,
    pub value_si: f64,
    /// Canonical decimal u64, preserved without browser rounding.
    pub step: String,
    pub time_s: f64,
    pub integrity: SolutionScalarIntegrityResource,
    pub manifest_state: SolutionSetManifestStateResource,
    pub execution_status: SolutionExecutionStatusResource,
    pub member_execution_status: SolutionExecutionStatusResource,
    pub scientific_assessment: SolutionScientificAssessmentResource,
    pub member_scientific_assessment: SolutionScientificAssessmentResource,
    pub provenance: SolutionProvenanceResource,
    /// Preserved from the artifact; never inferred from scalar step/time.
    pub accepted_state: Option<SolutionAcceptedStateIdResource>,
}

/// CAS verification does not certify the scientific result.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SolutionScalarIntegrityResource {
    Verified,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SolutionSetManifestStateResource {
    Open,
    Closed,
}
impl From<fullmag_quantities::SolutionSetManifestState> for SolutionSetManifestStateResource {
    fn from(value: fullmag_quantities::SolutionSetManifestState) -> Self {
        match value {
            fullmag_quantities::SolutionSetManifestState::Open => Self::Open,
            fullmag_quantities::SolutionSetManifestState::Closed => Self::Closed,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SolutionExecutionStatusResource {
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Interrupted,
}
impl From<fullmag_quantities::SolutionExecutionStatus> for SolutionExecutionStatusResource {
    fn from(value: fullmag_quantities::SolutionExecutionStatus) -> Self {
        match value {
            fullmag_quantities::SolutionExecutionStatus::Running => Self::Running,
            fullmag_quantities::SolutionExecutionStatus::Succeeded => Self::Succeeded,
            fullmag_quantities::SolutionExecutionStatus::Failed => Self::Failed,
            fullmag_quantities::SolutionExecutionStatus::Cancelled => Self::Cancelled,
            fullmag_quantities::SolutionExecutionStatus::Interrupted => Self::Interrupted,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ScientificAssessmentStatusResource {
    Converged,
    ToleranceNotMet,
    LimitReached,
    Invalid,
    Unassessed,
}
impl From<fullmag_quantities::ScientificAssessmentStatus> for ScientificAssessmentStatusResource {
    fn from(value: fullmag_quantities::ScientificAssessmentStatus) -> Self {
        match value {
            fullmag_quantities::ScientificAssessmentStatus::Converged => Self::Converged,
            fullmag_quantities::ScientificAssessmentStatus::ToleranceNotMet => {
                Self::ToleranceNotMet
            }
            fullmag_quantities::ScientificAssessmentStatus::LimitReached => Self::LimitReached,
            fullmag_quantities::ScientificAssessmentStatus::Invalid => Self::Invalid,
            fullmag_quantities::ScientificAssessmentStatus::Unassessed => Self::Unassessed,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SolutionArtifactKindResource {
    State,
    Trajectory,
    Modal,
    FrequencyResponse,
    Table,
    Diagnostic,
    QualityReport,
    Other,
}
impl From<fullmag_quantities::SolutionArtifactKind> for SolutionArtifactKindResource {
    fn from(value: fullmag_quantities::SolutionArtifactKind) -> Self {
        match value {
            fullmag_quantities::SolutionArtifactKind::State => Self::State,
            fullmag_quantities::SolutionArtifactKind::Trajectory => Self::Trajectory,
            fullmag_quantities::SolutionArtifactKind::Modal => Self::Modal,
            fullmag_quantities::SolutionArtifactKind::FrequencyResponse => Self::FrequencyResponse,
            fullmag_quantities::SolutionArtifactKind::Table => Self::Table,
            fullmag_quantities::SolutionArtifactKind::Diagnostic => Self::Diagnostic,
            fullmag_quantities::SolutionArtifactKind::QualityReport => Self::QualityReport,
            fullmag_quantities::SolutionArtifactKind::Other => Self::Other,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SolutionCoverageStateResource {
    Complete,
    Partial,
    Unknown,
}
impl From<fullmag_quantities::SolutionCoverageState> for SolutionCoverageStateResource {
    fn from(value: fullmag_quantities::SolutionCoverageState) -> Self {
        match value {
            fullmag_quantities::SolutionCoverageState::Complete => Self::Complete,
            fullmag_quantities::SolutionCoverageState::Partial => Self::Partial,
            fullmag_quantities::SolutionCoverageState::Unknown => Self::Unknown,
        }
    }
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct SolutionScientificAssessmentResource {
    pub status: ScientificAssessmentStatusResource,
    pub reason: Option<String>,
    pub evidence_artifact_count: u64,
}

impl From<&fullmag_quantities::ScientificAssessment> for SolutionScientificAssessmentResource {
    fn from(value: &fullmag_quantities::ScientificAssessment) -> Self {
        Self {
            status: value.status.into(),
            reason: value.reason.clone(),
            evidence_artifact_count: value.evidence_artifact_ids.len() as u64,
        }
    }
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct SolutionProvenanceResource {
    pub run_spec_digest: String,
    pub model_digest: String,
    pub physics_digest: String,
    pub discretization_digest: String,
    pub resolved_plan_digest: String,
    pub acquisition_digest: String,
    pub seed_digest: Option<String>,
}
impl From<&fullmag_quantities::SolutionSetProvenance> for SolutionProvenanceResource {
    fn from(v: &fullmag_quantities::SolutionSetProvenance) -> Self {
        Self {
            run_spec_digest: v.run_spec_digest.clone(),
            model_digest: v.model_digest.clone(),
            physics_digest: v.physics_digest.clone(),
            discretization_digest: v.discretization_digest.clone(),
            resolved_plan_digest: v.resolved_plan_digest.clone(),
            acquisition_digest: v.acquisition_digest.clone(),
            seed_digest: v.seed_digest.clone(),
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SolutionSetResource {
    pub schema_version: String,
    pub project_id: String,
    pub run_id: String,
    pub solution_set_id: String,
    /// Canonical positive decimal u64; a string prevents browser precision loss.
    pub revision: String,
    pub manifest_digest: String,
    pub manifest_state: SolutionSetManifestStateResource,
    pub execution_status: SolutionExecutionStatusResource,
    pub scientific_assessment: SolutionScientificAssessmentResource,
    pub provenance: SolutionProvenanceResource,
    pub member_count: u64,
    pub artifact_count: u64,
    pub coverage_count: u64,
}

pub const SOLUTION_SET_DISCOVERY_RESOURCE_SCHEMA: &str =
    "fullmag.analysis.solution_set_discovery.v1";

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct SolutionSetDiscoveryRefResource {
    pub solution_set_id: String,
    /// Canonical positive decimal u64, preserved without rounding.
    pub revision: String,
    pub manifest_digest: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SolutionSetDiscoveryPageResource {
    pub schema_version: String,
    pub project_id: String,
    pub run_id: String,
    pub items: Vec<SolutionSetDiscoveryRefResource>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SolutionSetMemberResource {
    pub member_id: String,
    pub task_id: String,
    pub attempt_id: String,
    /// Canonical decimal u64, preserved without rounding.
    pub ownership_epoch: String,
    pub case_id: Option<String>,
    pub stage_id: String,
    pub execution_status: SolutionExecutionStatusResource,
    pub scientific_assessment: SolutionScientificAssessmentResource,
    pub artifact_count: u64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SolutionCoverageSummaryResource {
    pub state: SolutionCoverageStateResource,
    pub expected_samples: Option<String>,
    pub committed_samples: String,
    pub segment_count: u64,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct SolutionAcceptedStateIdResource {
    pub run_id: String,
    pub stage_id: Option<String>,
    pub accepted_step: String,
    pub clock_digest: String,
    pub state_digest: String,
    pub domain_digest: String,
    pub plan_digest: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SolutionArtifactIntegrityStatusResource {
    NotVerified,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SolutionSetArtifactResource {
    pub artifact_id: String,
    pub kind: SolutionArtifactKindResource,
    pub schema_id: String,
    pub object_ref: String,
    /// Canonical decimal u64, preserved without rounding.
    pub byte_length: String,
    pub accepted_state: Option<SolutionAcceptedStateIdResource>,
    pub integrity: SolutionArtifactIntegrityStatusResource,
    pub coverage: Option<SolutionCoverageSummaryResource>,
    pub scientific_evidence: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SolutionSetMemberPageResource {
    pub schema_version: String,
    pub project_id: String,
    pub run_id: String,
    pub solution_set_id: String,
    pub revision: String,
    pub manifest_digest: String,
    pub items: Vec<SolutionSetMemberResource>,
    pub next_after_member_id: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SolutionSetArtifactPageResource {
    pub schema_version: String,
    pub project_id: String,
    pub run_id: String,
    pub solution_set_id: String,
    pub revision: String,
    pub manifest_digest: String,
    pub member_id: String,
    pub items: Vec<SolutionSetArtifactResource>,
    pub next_after_artifact_id: Option<String>,
}

#[derive(Debug, Default, Deserialize, IntoParams, ToSchema)]
#[serde(deny_unknown_fields)]
#[into_params(parameter_in = Query)]
pub struct SolutionSetMemberPageQuery {
    pub after_member_id: Option<String>,
    /// Default 50, maximum 100.
    pub limit: Option<usize>,
}

#[derive(Debug, Default, Deserialize, IntoParams, ToSchema)]
#[serde(deny_unknown_fields)]
#[into_params(parameter_in = Query)]
pub struct SolutionSetArtifactPageQuery {
    pub after_artifact_id: Option<String>,
    /// Default 50, maximum 100.
    pub limit: Option<usize>,
}

#[derive(Debug, Default, Deserialize, IntoParams, ToSchema)]
#[serde(deny_unknown_fields)]
#[into_params(parameter_in = Query)]
pub struct SolutionSetDiscoveryPageQuery {
    pub cursor: Option<String>,
    /// Default 25, maximum 50.
    pub limit: Option<usize>,
}
