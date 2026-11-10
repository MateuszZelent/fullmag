//! Durable Study output identities and their relation to the current authoring document.

use super::relaxation::{StageMetricKind, StageMetricUnit, StageStopReason};
use super::scalars::ScalarSeriesIdentity;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

#[derive(Debug, Default, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct StudyStageResultsQuery {
    /// Authored stage ID or exact durable execution ID. Omit to include all final states.
    pub stage_id: Option<String>,
    /// Exact durable run in the owning workspace.
    pub run_id: Option<String>,
    /// Opaque continuation from a previous response with the same filters.
    pub cursor: Option<String>,
    /// Page size, from 1 to 100. The default is 25.
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum StudyResultAuthoredRelation {
    MatchingAuthoredInput,
    AuthoredInputChanged,
    StageAbsent,
    AuthoringUnavailable,
}

/// Terminal solver evidence qualified against the same final state and attempt.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct StudyResultCompletion {
    /// Absent when this completion carries no relaxation evidence.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub converged: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<StageStopReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metric_kind: Option<StageMetricKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metric_unit: Option<StageMetricUnit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metric_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metric_value: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub threshold: Option<f64>,
}

impl From<fullmag_ir::StageCompletionIR> for StudyResultCompletion {
    fn from(completion: fullmag_ir::StageCompletionIR) -> Self {
        let relaxation_evidence = completion.reason.is_some()
            || completion.metric_name.as_deref() == Some("all_active_dofs_frozen_relaxation");
        Self {
            converged: relaxation_evidence.then_some(completion.converged),
            reason: completion.reason.map(Into::into),
            metric_kind: completion.metric.map(Into::into),
            metric_unit: completion.metric.map(Into::into),
            metric_name: completion.metric_name,
            metric_value: completion.metric_value,
            threshold: completion.threshold,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum StudyResultInputSelection {
    Predecessor,
    SelectedResult,
    LatestCompatible,
    PinnedResult,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StudyResultInitialStateSource {
    Authored {
        reference: String,
    },
    StageResult {
        run_id: String,
        step_id: String,
        case_id: String,
        artifact_id: String,
        content_sha256: String,
        selection: StudyResultInputSelection,
    },
    Prepared {
        publication_id: String,
        artifact_id: String,
        content_sha256: String,
    },
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct StudyResultResetScope {
    pub object_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region_id: Option<String>,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct StudyResultInitialState {
    pub source: StudyResultInitialStateSource,
    /// Authored samples that replaced the base state at the named scopes.
    pub reset_scopes: Vec<StudyResultResetScope>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum StudyResultDomainRelation {
    MatchingPublishedLayout,
    DifferentPublishedLayout,
    #[default]
    Unavailable,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum StudyResultPredecessorRelation {
    NewerDifferentOutput,
    EarlierPredecessorChanged,
    NewerSameOutput,
    NoLaterMatchingInput,
    NotApplicable,
    #[default]
    Unavailable,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct StudyStageResult {
    pub project_id: String,
    pub study_id: String,
    /// The owner of both the final state and the archived scalar series.
    pub source: ScalarSeriesIdentity,
    /// Authored stage identity when it can be mapped to the durable execution.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authored_stage_id: Option<String>,
    pub artifact_id: String,
    pub artifact_sha256: String,
    pub codec_id: String,
    pub codec_version: String,
    pub accepted_at: String,
    pub authored_relation: StudyResultAuthoredRelation,
    /// Omitted when no exact terminal completion record is available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion: Option<StudyResultCompletion>,
    /// Qualified input of the producing task attempt. Legacy evidence may be absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_state: Option<StudyResultInitialState>,
    /// Comparison with the published live magnetization layout.
    #[serde(default)]
    pub domain_relation: StudyResultDomainRelation,
    /// Later successful results along the inherited chain of admitted inputs.
    #[serde(default)]
    pub predecessor_relation: StudyResultPredecessorRelation,
    /// Same-space and input-port admission are verified when a command is submitted.
    pub supports_magnetization_input: bool,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct StudyStageResultsResource {
    pub revision: String,
    /// Current project. Each result retains the original project for playback.
    pub project_id: String,
    pub scene_revision: Option<u64>,
    pub authored_input_sha256: Option<String>,
    pub authored_stage_ids: Vec<String>,
    pub results: Vec<StudyStageResult>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct StudyResultLayerGeometry {
    pub layer_id: String,
    pub object_id: String,
    pub grid_cells: [u32; 3],
    pub origin_m: [f64; 3],
    pub cell_size_m: [f64; 3],
    pub value_offset: u64,
    pub value_count: u64,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StudyResultGeometry {
    Fdm {
        grid_cells: [u32; 3],
        origin_m: [f64; 3],
        cell_size_m: [f64; 3],
    },
    FdmMultilayer {
        layers: Vec<StudyResultLayerGeometry>,
    },
    Fem {
        node_count: u64,
        element_count: u64,
    },
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct StudyResultStateResource {
    pub project_id: String,
    pub source: ScalarSeriesIdentity,
    pub artifact_id: String,
    pub artifact_sha256: String,
    pub step: u64,
    pub time_s: f64,
    pub sample_count: u64,
    /// Exact layout fingerprint, including the magnetically active support.
    pub domain_generation_id: String,
    pub topology_fingerprint: String,
    pub geometry: StudyResultGeometry,
    /// If true, the support subresource returns FMSP in sample order.
    pub support_available: bool,
}
