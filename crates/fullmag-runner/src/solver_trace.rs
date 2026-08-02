//! Bounded, sampled solver-to-render trace primitives.
//!
//! The native and browser clocks are intentionally kept in separate domains.
//! A trace carries durations (not absolute timestamps), so a browser sample
//! can be joined to a server revision without pretending that `performance.now`
//! and the server monotonic clock share an origin.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub const SOLVER_TRACE_FORMAT_VERSION: &str = "fullmag.solver_trace.v1";
pub const MAX_TRACE_ID_BYTES: usize = 192;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SolverTraceClockDomain {
    ServerMonotonic,
    BrowserPerformance,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SolverTraceSegmentKind {
    NativeToRunnerCallback,
    RunnerCallbackToPublisherEnqueue,
    PublisherQueue,
    PublisherApply,
    ApiRevisionVisibility,
    BrowserFetch,
    BrowserDecodeToCommit,
    CommitToAnimationFrame,
}

impl SolverTraceSegmentKind {
    pub const ALL: [Self; 8] = [
        Self::NativeToRunnerCallback,
        Self::RunnerCallbackToPublisherEnqueue,
        Self::PublisherQueue,
        Self::PublisherApply,
        Self::ApiRevisionVisibility,
        Self::BrowserFetch,
        Self::BrowserDecodeToCommit,
        Self::CommitToAnimationFrame,
    ];

    pub const fn clock_domain(self) -> SolverTraceClockDomain {
        match self {
            Self::NativeToRunnerCallback
            | Self::RunnerCallbackToPublisherEnqueue
            | Self::PublisherQueue
            | Self::PublisherApply
            | Self::ApiRevisionVisibility => SolverTraceClockDomain::ServerMonotonic,
            Self::BrowserFetch | Self::BrowserDecodeToCommit | Self::CommitToAnimationFrame => {
                SolverTraceClockDomain::BrowserPerformance
            }
        }
    }

    pub const fn id(self) -> &'static str {
        match self {
            Self::NativeToRunnerCallback => "native_to_runner_callback_ns",
            Self::RunnerCallbackToPublisherEnqueue => "runner_callback_to_publisher_enqueue_ns",
            Self::PublisherQueue => "publisher_queue_ns",
            Self::PublisherApply => "publisher_apply_ns",
            Self::ApiRevisionVisibility => "api_revision_visibility_ns",
            Self::BrowserFetch => "browser_fetch_ns",
            Self::BrowserDecodeToCommit => "browser_decode_to_commit_ns",
            Self::CommitToAnimationFrame => "commit_to_animation_frame_ns",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SolverTraceId {
    pub value: String,
    pub run_generation: String,
    pub stage_sequence: u64,
    pub accepted_step: u64,
    pub sample_sequence: u64,
}

impl SolverTraceId {
    pub fn new(
        run_generation: impl Into<String>,
        stage_sequence: u64,
        accepted_step: u64,
        sample_sequence: u64,
    ) -> Result<Self, SolverTraceValidationError> {
        let run_generation = run_generation.into();
        validate_trace_component("run_generation", &run_generation)?;
        let value = format!(
            "{}:{}:{}:{}",
            run_generation, stage_sequence, accepted_step, sample_sequence
        );
        if value.len() > MAX_TRACE_ID_BYTES {
            return Err(SolverTraceValidationError::TraceIdTooLong {
                actual_bytes: value.len(),
                max_bytes: MAX_TRACE_ID_BYTES,
            });
        }
        Ok(Self {
            value,
            run_generation,
            stage_sequence,
            accepted_step,
            sample_sequence,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SolverTraceSegment {
    pub kind: SolverTraceSegmentKind,
    pub duration_ns: u64,
    pub clock_domain: SolverTraceClockDomain,
}

impl SolverTraceSegment {
    pub fn new(kind: SolverTraceSegmentKind, duration_ns: u64) -> Self {
        Self {
            kind,
            duration_ns,
            clock_domain: kind.clock_domain(),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SolverTraceCompleteness {
    ServerOnly,
    Complete,
    Partial,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SolverTrace {
    pub format: String,
    pub trace_id: SolverTraceId,
    pub segments: BTreeMap<String, SolverTraceSegment>,
    pub api_revision: Option<u64>,
    pub completeness: SolverTraceCompleteness,
    pub unaccounted_server_ns: u64,
    pub unaccounted_browser_ns: u64,
}

impl SolverTrace {
    pub fn server_only(trace_id: SolverTraceId) -> Self {
        Self {
            format: SOLVER_TRACE_FORMAT_VERSION.to_string(),
            trace_id,
            segments: BTreeMap::new(),
            api_revision: None,
            completeness: SolverTraceCompleteness::ServerOnly,
            unaccounted_server_ns: 0,
            unaccounted_browser_ns: 0,
        }
    }

    pub fn insert_segment(
        &mut self,
        segment: SolverTraceSegment,
    ) -> Result<(), SolverTraceValidationError> {
        let expected_domain = segment.kind.clock_domain();
        if segment.clock_domain != expected_domain {
            return Err(SolverTraceValidationError::ClockDomainMismatch {
                segment: segment.kind.id().to_string(),
                expected: expected_domain,
                actual: segment.clock_domain,
            });
        }
        let key = segment.kind.id().to_string();
        if self.segments.contains_key(&key) {
            return Err(SolverTraceValidationError::DuplicateSegment { segment: key });
        }
        self.segments.insert(key, segment);
        self.refresh_completeness();
        Ok(())
    }

    pub fn set_api_revision(&mut self, revision: u64) -> Result<(), SolverTraceValidationError> {
        if self.api_revision.is_some() {
            return Err(SolverTraceValidationError::DuplicateApiRevision);
        }
        if !self
            .segments
            .contains_key(SolverTraceSegmentKind::ApiRevisionVisibility.id())
        {
            return Err(SolverTraceValidationError::RevisionWithoutVisibilitySegment);
        }
        self.api_revision = Some(revision);
        self.refresh_completeness();
        Ok(())
    }

    pub fn validate(&self) -> Result<(), SolverTraceValidationError> {
        if self.format != SOLVER_TRACE_FORMAT_VERSION {
            return Err(SolverTraceValidationError::UnsupportedFormat {
                format: self.format.clone(),
            });
        }
        if self.trace_id.value.len() > MAX_TRACE_ID_BYTES {
            return Err(SolverTraceValidationError::TraceIdTooLong {
                actual_bytes: self.trace_id.value.len(),
                max_bytes: MAX_TRACE_ID_BYTES,
            });
        }
        for (key, segment) in &self.segments {
            if key != segment.kind.id() {
                return Err(SolverTraceValidationError::SegmentKeyMismatch {
                    key: key.clone(),
                    expected: segment.kind.id().to_string(),
                });
            }
            if segment.clock_domain != segment.kind.clock_domain() {
                return Err(SolverTraceValidationError::ClockDomainMismatch {
                    segment: key.clone(),
                    expected: segment.kind.clock_domain(),
                    actual: segment.clock_domain,
                });
            }
        }
        if self.api_revision.is_some()
            && !self
                .segments
                .contains_key(SolverTraceSegmentKind::ApiRevisionVisibility.id())
        {
            return Err(SolverTraceValidationError::RevisionWithoutVisibilitySegment);
        }
        Ok(())
    }

    pub fn accounted_end_to_end_ns(&self) -> u64 {
        self.segments
            .values()
            .map(|segment| segment.duration_ns)
            .fold(0, u64::saturating_add)
    }

    fn refresh_completeness(&mut self) {
        let server_complete = SolverTraceSegmentKind::ALL
            .iter()
            .filter(|kind| kind.clock_domain() == SolverTraceClockDomain::ServerMonotonic)
            .all(|kind| self.segments.contains_key(kind.id()));
        let browser_complete = SolverTraceSegmentKind::ALL
            .iter()
            .filter(|kind| kind.clock_domain() == SolverTraceClockDomain::BrowserPerformance)
            .all(|kind| self.segments.contains_key(kind.id()));
        let has_any_segment = !self.segments.is_empty();
        self.completeness = if server_complete && browser_complete {
            SolverTraceCompleteness::Complete
        } else if has_any_segment || self.api_revision.is_some() {
            SolverTraceCompleteness::Partial
        } else {
            SolverTraceCompleteness::ServerOnly
        };
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SolverTraceValidationError {
    EmptyTraceComponent {
        name: &'static str,
    },
    InvalidTraceComponent {
        name: &'static str,
    },
    TraceIdTooLong {
        actual_bytes: usize,
        max_bytes: usize,
    },
    UnsupportedFormat {
        format: String,
    },
    DuplicateSegment {
        segment: String,
    },
    DuplicateApiRevision,
    RevisionWithoutVisibilitySegment,
    SegmentKeyMismatch {
        key: String,
        expected: String,
    },
    ClockDomainMismatch {
        segment: String,
        expected: SolverTraceClockDomain,
        actual: SolverTraceClockDomain,
    },
}

impl std::fmt::Display for SolverTraceValidationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl std::error::Error for SolverTraceValidationError {}

fn validate_trace_component(
    name: &'static str,
    value: &str,
) -> Result<(), SolverTraceValidationError> {
    if value.is_empty() {
        return Err(SolverTraceValidationError::EmptyTraceComponent { name });
    }
    if value.contains(':') || value.chars().any(char::is_control) {
        return Err(SolverTraceValidationError::InvalidTraceComponent { name });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trace_id_is_deterministic_and_bounded() {
        let left = SolverTraceId::new("run-17", 3, 42, 5).unwrap();
        let right = SolverTraceId::new("run-17", 3, 42, 5).unwrap();
        assert_eq!(left, right);
        assert_eq!(left.value, "run-17:3:42:5");
        assert!(SolverTraceId::new("run:17", 3, 42, 5).is_err());
        assert!(SolverTraceId::new("x".repeat(MAX_TRACE_ID_BYTES), 0, 0, 0).is_err());
    }

    #[test]
    fn duplicate_segments_and_revision_mappings_are_rejected() {
        let id = SolverTraceId::new("run", 0, 1, 0).unwrap();
        let mut trace = SolverTrace::server_only(id);
        let segment = SolverTraceSegment::new(SolverTraceSegmentKind::PublisherApply, 7);
        trace.insert_segment(segment.clone()).unwrap();
        assert!(matches!(
            trace.insert_segment(segment),
            Err(SolverTraceValidationError::DuplicateSegment { .. })
        ));
        assert!(matches!(
            trace.set_api_revision(9),
            Err(SolverTraceValidationError::RevisionWithoutVisibilitySegment)
        ));
    }

    #[test]
    fn api_revision_requires_visibility_and_clock_domains_never_mix() {
        let id = SolverTraceId::new("run", 2, 4, 1).unwrap();
        let mut trace = SolverTrace::server_only(id);
        trace
            .insert_segment(SolverTraceSegment::new(
                SolverTraceSegmentKind::ApiRevisionVisibility,
                11,
            ))
            .unwrap();
        trace.set_api_revision(12).unwrap();
        assert_eq!(trace.completeness, SolverTraceCompleteness::Partial);
        assert!(trace.validate().is_ok());

        let invalid = SolverTraceSegment {
            kind: SolverTraceSegmentKind::BrowserFetch,
            duration_ns: 1,
            clock_domain: SolverTraceClockDomain::ServerMonotonic,
        };
        assert!(matches!(
            trace.insert_segment(invalid),
            Err(SolverTraceValidationError::ClockDomainMismatch { .. })
        ));
    }

    #[test]
    fn complete_trace_keeps_server_and_browser_segments_separate() {
        let id = SolverTraceId::new("run", 1, 8, 2).unwrap();
        let mut trace = SolverTrace::server_only(id);
        for kind in SolverTraceSegmentKind::ALL {
            trace
                .insert_segment(SolverTraceSegment::new(kind, 10))
                .unwrap();
        }
        trace.set_api_revision(3).unwrap();
        assert_eq!(trace.completeness, SolverTraceCompleteness::Complete);
        assert_eq!(trace.accounted_end_to_end_ns(), 80);
        trace.validate().unwrap();
    }
}
