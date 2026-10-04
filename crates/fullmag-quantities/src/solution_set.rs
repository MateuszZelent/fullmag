//! Durable, backend-neutral catalog of solver results.
//!
//! A solution set records immutable artifact identities and execution/scientific
//! status. It does not own presentation recipes or mutable runtime resources.

use crate::AcceptedStateId;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fmt;

pub const SOLUTION_SET_SCHEMA_VERSION: &str = "1.0.0";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SolutionSetManifestState {
    Open,
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SolutionExecutionStatus {
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Interrupted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScientificAssessmentStatus {
    Converged,
    ToleranceNotMet,
    LimitReached,
    Invalid,
    Unassessed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScientificAssessment {
    pub status: ScientificAssessmentStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence_artifact_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SolutionSetProvenance {
    pub run_spec_digest: String,
    pub model_digest: String,
    pub physics_digest: String,
    pub discretization_digest: String,
    pub resolved_plan_digest: String,
    pub acquisition_digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed_digest: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SolutionArtifactKind {
    State,
    Trajectory,
    Modal,
    FrequencyResponse,
    Table,
    Diagnostic,
    QualityReport,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SolutionArtifactRef {
    pub artifact_id: String,
    pub kind: SolutionArtifactKind,
    pub schema_id: String,
    /// Existing Fullmag CAS object identity: a bare lowercase SHA-256 hex.
    pub object_ref: String,
    pub byte_length: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accepted_state: Option<AcceptedStateId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SolutionMember {
    pub member_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub ownership_epoch: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub case_id: Option<String>,
    pub stage_id: String,
    pub execution_status: SolutionExecutionStatus,
    pub scientific_assessment: ScientificAssessment,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifacts: Vec<SolutionArtifactRef>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SolutionCoverageState {
    Complete,
    Partial,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SolutionSegmentRef {
    pub segment_id: String,
    pub start_sample: u64,
    pub end_sample_exclusive: u64,
    pub object_ref: String,
    pub byte_length: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SolutionArtifactCoverage {
    pub artifact_id: String,
    pub state: SolutionCoverageState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_samples: Option<u64>,
    pub committed_samples: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub segments: Vec<SolutionSegmentRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SolutionSet {
    pub schema_version: String,
    pub solution_set_id: String,
    pub revision: u64,
    pub run_id: String,
    pub manifest_state: SolutionSetManifestState,
    pub execution_status: SolutionExecutionStatus,
    pub scientific_assessment: ScientificAssessment,
    pub provenance: SolutionSetProvenance,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub members: Vec<SolutionMember>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub coverage: Vec<SolutionArtifactCoverage>,
}

impl SolutionSet {
    pub fn validate(&self) -> Result<(), SolutionSetError> {
        if self.schema_version != SOLUTION_SET_SCHEMA_VERSION {
            return Err(SolutionSetError::UnsupportedSchema(
                self.schema_version.clone(),
            ));
        }
        require_id("solution_set_id", &self.solution_set_id)?;
        require_id("run_id", &self.run_id)?;
        match (self.manifest_state, self.execution_status) {
            (SolutionSetManifestState::Open, SolutionExecutionStatus::Running)
            | (SolutionSetManifestState::Closed, SolutionExecutionStatus::Succeeded)
            | (SolutionSetManifestState::Closed, SolutionExecutionStatus::Failed)
            | (SolutionSetManifestState::Closed, SolutionExecutionStatus::Cancelled)
            | (SolutionSetManifestState::Closed, SolutionExecutionStatus::Interrupted) => {}
            _ => return Err(SolutionSetError::InconsistentManifestState),
        }
        validate_assessment(&self.scientific_assessment)?;
        validate_provenance(&self.provenance)?;

        let mut member_ids = BTreeSet::new();
        let mut artifact_ids = BTreeSet::new();
        for member in &self.members {
            let mut member_artifact_ids = BTreeSet::new();
            require_id("member_id", &member.member_id)?;
            if !member_ids.insert(member.member_id.as_str()) {
                return Err(SolutionSetError::DuplicateId {
                    field: "member_id",
                    value: member.member_id.clone(),
                });
            }
            require_id("task_id", &member.task_id)?;
            require_id("attempt_id", &member.attempt_id)?;
            require_id("stage_id", &member.stage_id)?;
            if let Some(case_id) = &member.case_id {
                require_id("case_id", case_id)?;
            }
            validate_assessment(&member.scientific_assessment)?;
            for artifact in &member.artifacts {
                validate_artifact(artifact)?;
                if !artifact_ids.insert(artifact.artifact_id.as_str()) {
                    return Err(SolutionSetError::DuplicateId {
                        field: "artifact_id",
                        value: artifact.artifact_id.clone(),
                    });
                }
                member_artifact_ids.insert(artifact.artifact_id.as_str());
            }
            validate_assessment_evidence(&member.scientific_assessment, &member_artifact_ids)?;
        }

        let mut covered_artifacts = BTreeSet::new();
        for coverage in &self.coverage {
            require_id("coverage artifact_id", &coverage.artifact_id)?;
            if !artifact_ids.contains(coverage.artifact_id.as_str()) {
                return Err(SolutionSetError::UnknownCoverageArtifact(
                    coverage.artifact_id.clone(),
                ));
            }
            if !covered_artifacts.insert(coverage.artifact_id.as_str()) {
                return Err(SolutionSetError::DuplicateId {
                    field: "coverage artifact_id",
                    value: coverage.artifact_id.clone(),
                });
            }
            validate_coverage(coverage)?;
        }
        validate_assessment_evidence(&self.scientific_assessment, &artifact_ids)?;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SolutionSetError {
    UnsupportedSchema(String),
    EmptyId(&'static str),
    DuplicateId { field: &'static str, value: String },
    InvalidDigest(&'static str),
    InconsistentManifestState,
    InvalidAcceptedState,
    InvalidAssessmentReason,
    UnknownAssessmentEvidence(String),
    UnknownCoverageArtifact(String),
    InvalidCoverageRange(String),
    OverlappingCoverage(String),
    CoverageCountMismatch(String),
    IncompleteDeclaredComplete(String),
}

impl fmt::Display for SolutionSetError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedSchema(schema) => write!(formatter, "unsupported solution set schema '{schema}'"),
            Self::EmptyId(field) => write!(formatter, "solution set {field} must not be empty"),
            Self::DuplicateId { field, value } => write!(formatter, "solution set {field} '{value}' must be unique"),
            Self::InvalidDigest(field) => write!(formatter, "solution set {field} must be a canonical SHA-256 identity"),
            Self::InconsistentManifestState => formatter.write_str("open solution sets must be running and terminal solution sets must be closed"),
            Self::InvalidAcceptedState => formatter.write_str("solution artifact accepted state identity is invalid"),
            Self::InvalidAssessmentReason => formatter.write_str("non-converged scientific assessment requires a reason"),
            Self::UnknownAssessmentEvidence(id) => write!(formatter, "scientific assessment refers to unknown artifact '{id}'"),
            Self::UnknownCoverageArtifact(id) => write!(formatter, "coverage refers to unknown artifact '{id}'"),
            Self::InvalidCoverageRange(id) => write!(formatter, "solution segment '{id}' has an invalid sample range"),
            Self::OverlappingCoverage(id) => write!(formatter, "solution segment '{id}' overlaps preceding coverage"),
            Self::CoverageCountMismatch(id) => write!(formatter, "coverage '{id}' committed sample count does not match its segments"),
            Self::IncompleteDeclaredComplete(id) => write!(formatter, "coverage '{id}' is declared complete but does not exactly cover its expected samples"),
        }
    }
}

impl std::error::Error for SolutionSetError {}

fn validate_provenance(provenance: &SolutionSetProvenance) -> Result<(), SolutionSetError> {
    for (field, digest) in [
        ("run_spec_digest", provenance.run_spec_digest.as_str()),
        ("model_digest", provenance.model_digest.as_str()),
        ("physics_digest", provenance.physics_digest.as_str()),
        (
            "discretization_digest",
            provenance.discretization_digest.as_str(),
        ),
        (
            "resolved_plan_digest",
            provenance.resolved_plan_digest.as_str(),
        ),
        ("acquisition_digest", provenance.acquisition_digest.as_str()),
    ] {
        require_digest(field, digest)?;
    }
    if let Some(seed_digest) = &provenance.seed_digest {
        require_digest("seed_digest", seed_digest)?;
    }
    Ok(())
}

fn validate_artifact(artifact: &SolutionArtifactRef) -> Result<(), SolutionSetError> {
    require_id("artifact_id", &artifact.artifact_id)?;
    require_id("artifact schema_id", &artifact.schema_id)?;
    require_cas_object_ref("artifact object_ref", &artifact.object_ref)?;
    if let Some(accepted_state) = &artifact.accepted_state {
        accepted_state
            .validate()
            .map_err(|_| SolutionSetError::InvalidAcceptedState)?;
    }
    Ok(())
}

fn validate_assessment(assessment: &ScientificAssessment) -> Result<(), SolutionSetError> {
    if assessment.status != ScientificAssessmentStatus::Converged
        && assessment
            .reason
            .as_deref()
            .is_none_or(|reason| reason.trim().is_empty())
    {
        return Err(SolutionSetError::InvalidAssessmentReason);
    }
    require_unique_ids(
        "assessment evidence artifact_id",
        &assessment.evidence_artifact_ids,
    )
}

fn validate_assessment_evidence(
    assessment: &ScientificAssessment,
    artifact_ids: &BTreeSet<&str>,
) -> Result<(), SolutionSetError> {
    for artifact_id in &assessment.evidence_artifact_ids {
        if !artifact_ids.contains(artifact_id.as_str()) {
            return Err(SolutionSetError::UnknownAssessmentEvidence(
                artifact_id.clone(),
            ));
        }
    }
    Ok(())
}

fn validate_coverage(coverage: &SolutionArtifactCoverage) -> Result<(), SolutionSetError> {
    let mut segment_ids = BTreeSet::new();
    let mut previous_end = 0_u64;
    let mut committed = 0_u64;
    for (index, segment) in coverage.segments.iter().enumerate() {
        require_id("segment_id", &segment.segment_id)?;
        if !segment_ids.insert(segment.segment_id.as_str()) {
            return Err(SolutionSetError::DuplicateId {
                field: "segment_id",
                value: segment.segment_id.clone(),
            });
        }
        require_cas_object_ref("segment object_ref", &segment.object_ref)?;
        if segment.start_sample >= segment.end_sample_exclusive {
            return Err(SolutionSetError::InvalidCoverageRange(
                segment.segment_id.clone(),
            ));
        }
        if index > 0 && segment.start_sample < previous_end {
            return Err(SolutionSetError::OverlappingCoverage(
                segment.segment_id.clone(),
            ));
        }
        committed = committed
            .checked_add(segment.end_sample_exclusive - segment.start_sample)
            .ok_or_else(|| SolutionSetError::CoverageCountMismatch(coverage.artifact_id.clone()))?;
        previous_end = segment.end_sample_exclusive;
    }
    if committed != coverage.committed_samples {
        return Err(SolutionSetError::CoverageCountMismatch(
            coverage.artifact_id.clone(),
        ));
    }
    if coverage.state == SolutionCoverageState::Complete {
        let expected = coverage.expected_samples.ok_or_else(|| {
            SolutionSetError::IncompleteDeclaredComplete(coverage.artifact_id.clone())
        })?;
        let contiguous = coverage
            .segments
            .iter()
            .scan(0_u64, |expected_start, segment| {
                let matches = segment.start_sample == *expected_start;
                *expected_start = segment.end_sample_exclusive;
                Some(matches)
            })
            .all(|matches| matches);
        if !contiguous || previous_end != expected || committed != expected {
            return Err(SolutionSetError::IncompleteDeclaredComplete(
                coverage.artifact_id.clone(),
            ));
        }
    }
    Ok(())
}

fn require_id(field: &'static str, value: &str) -> Result<(), SolutionSetError> {
    if value.trim().is_empty() {
        Err(SolutionSetError::EmptyId(field))
    } else {
        Ok(())
    }
}

fn require_unique_ids(field: &'static str, values: &[String]) -> Result<(), SolutionSetError> {
    let mut unique = BTreeSet::new();
    for value in values {
        require_id(field, value)?;
        if !unique.insert(value.as_str()) {
            return Err(SolutionSetError::DuplicateId {
                field,
                value: value.clone(),
            });
        }
    }
    Ok(())
}

fn require_digest(field: &'static str, value: &str) -> Result<(), SolutionSetError> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err(SolutionSetError::InvalidDigest(field));
    };
    if is_lower_hex_sha256(hex) {
        Ok(())
    } else {
        Err(SolutionSetError::InvalidDigest(field))
    }
}

fn require_cas_object_ref(field: &'static str, value: &str) -> Result<(), SolutionSetError> {
    if is_lower_hex_sha256(value) {
        Ok(())
    } else {
        Err(SolutionSetError::InvalidDigest(field))
    }
}

fn is_lower_hex_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest(character: char) -> String {
        format!("sha256:{}", character.to_string().repeat(64))
    }

    fn object_ref(character: char) -> String {
        character.to_string().repeat(64)
    }

    fn assessment(status: ScientificAssessmentStatus) -> ScientificAssessment {
        ScientificAssessment {
            status,
            reason: (status != ScientificAssessmentStatus::Converged)
                .then(|| "solver did not establish convergence".to_string()),
            evidence_artifact_ids: Vec::new(),
        }
    }

    fn solution_set() -> SolutionSet {
        let artifact = SolutionArtifactRef {
            artifact_id: "artifact:trajectory".to_string(),
            kind: SolutionArtifactKind::Trajectory,
            schema_id: "fullmag.trajectory.v1".to_string(),
            object_ref: object_ref('a'),
            byte_length: 128,
            accepted_state: None,
        };
        SolutionSet {
            schema_version: SOLUTION_SET_SCHEMA_VERSION.to_string(),
            solution_set_id: "solution:run-1".to_string(),
            revision: 2,
            run_id: "run:1".to_string(),
            manifest_state: SolutionSetManifestState::Closed,
            execution_status: SolutionExecutionStatus::Succeeded,
            scientific_assessment: assessment(ScientificAssessmentStatus::Converged),
            provenance: SolutionSetProvenance {
                run_spec_digest: digest('a'),
                model_digest: digest('b'),
                physics_digest: digest('c'),
                discretization_digest: digest('d'),
                resolved_plan_digest: digest('e'),
                acquisition_digest: digest('f'),
                seed_digest: None,
            },
            members: vec![SolutionMember {
                member_id: "member:stage-1".to_string(),
                task_id: "task:1".to_string(),
                attempt_id: "attempt:1".to_string(),
                ownership_epoch: 1,
                case_id: None,
                stage_id: "stage:1".to_string(),
                execution_status: SolutionExecutionStatus::Succeeded,
                scientific_assessment: assessment(ScientificAssessmentStatus::Converged),
                artifacts: vec![artifact],
            }],
            coverage: vec![SolutionArtifactCoverage {
                artifact_id: "artifact:trajectory".to_string(),
                state: SolutionCoverageState::Complete,
                expected_samples: Some(4),
                committed_samples: 4,
                segments: vec![SolutionSegmentRef {
                    segment_id: "segment:0".to_string(),
                    start_sample: 0,
                    end_sample_exclusive: 4,
                    object_ref: object_ref('b'),
                    byte_length: 128,
                }],
            }],
        }
    }

    #[test]
    fn complete_coverage_requires_exact_contiguous_range() {
        let mut solution = solution_set();
        solution.coverage[0].segments[0].start_sample = 1;
        assert_eq!(
            solution.validate(),
            Err(SolutionSetError::IncompleteDeclaredComplete(
                "artifact:trajectory".to_string()
            ))
        );
    }

    #[test]
    fn execution_and_scientific_assessment_are_independent() {
        let mut solution = solution_set();
        solution.scientific_assessment = assessment(ScientificAssessmentStatus::ToleranceNotMet);
        assert!(solution.validate().is_ok());
    }
}
