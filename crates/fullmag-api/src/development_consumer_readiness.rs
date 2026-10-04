//! Short-lived, in-memory proof that the launcher validated the current cold candidate.

use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};

use crate::{
    router_v2::handlers::platform::development_backend::DevelopmentBackendObservation,
    schemas::development_backend::DevelopmentBackendState,
};

const READINESS_LEASE_TTL: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CandidateReadiness {
    pub worktree_id: String,
    pub generation_id: String,
    pub ready_build_id: String,
    pub ready_source_sha256: String,
    pub candidate_bundle_id: String,
    pub candidate_manifest_sha256: String,
}

impl CandidateReadiness {
    pub(crate) fn is_well_formed(&self) -> bool {
        fullmag_session::repository_path::validate_store_id(&self.worktree_id).is_ok()
            && is_lower_hex(&self.generation_id, 32)
            && is_lower_hex(&self.ready_build_id, 64)
            && is_lower_hex(&self.ready_source_sha256, 64)
            && is_lower_hex(&self.candidate_bundle_id, 32)
            && is_lower_hex(&self.candidate_manifest_sha256, 64)
    }
}

#[derive(Debug, Clone, Default)]
pub(crate) struct DevelopmentConsumerReadiness {
    lease: Arc<Mutex<Option<Lease>>>,
}

#[derive(Debug)]
struct Lease {
    api_instance_id: String,
    worktree_id: String,
    generation_id: String,
    candidate: CandidateReadiness,
    expires_at: Instant,
}

impl DevelopmentConsumerReadiness {
    /// Return true only while the announced candidate still matches a fresh watcher observation.
    pub(crate) fn is_ready(
        &self,
        observation: &DevelopmentBackendObservation,
        api_instance_id: &str,
    ) -> bool {
        let Ok(mut lease) = self.lease.lock() else {
            return false;
        };
        let Some(current) = lease.as_ref() else {
            return false;
        };
        let valid = current.expires_at > Instant::now()
            && current.api_instance_id == api_instance_id
            && current.worktree_id == current.candidate.worktree_id
            && current.generation_id == current.candidate.generation_id
            && candidate_matches_observation(&current.candidate, observation);
        if !valid {
            // Seeing a changed or unavailable candidate retires this proof.
            // Its return cannot revive a lease without a fresh announcement.
            *lease = None;
        }
        valid
    }

    /// Replace the active proof with a fixed five-second lease after a fresh match.
    pub(crate) fn renew(
        &self,
        candidate: &CandidateReadiness,
        observation: &DevelopmentBackendObservation,
        api_instance_id: &str,
    ) -> bool {
        if !candidate.is_well_formed() || !candidate_matches_observation(candidate, observation) {
            return false;
        }
        let Ok(mut lease) = self.lease.lock() else {
            return false;
        };
        *lease = Some(Lease {
            api_instance_id: api_instance_id.to_string(),
            worktree_id: candidate.worktree_id.clone(),
            generation_id: candidate.generation_id.clone(),
            candidate: candidate.clone(),
            expires_at: Instant::now() + READINESS_LEASE_TTL,
        });
        true
    }

    /// Revoke an announced proof. Poisoned state fails closed.
    pub(crate) fn revoke(&self) -> bool {
        let Ok(mut lease) = self.lease.lock() else {
            return false;
        };
        *lease = None;
        true
    }
}

fn candidate_matches_observation(
    candidate: &CandidateReadiness,
    observation: &DevelopmentBackendObservation,
) -> bool {
    let resource = &observation.resource;
    if !resource.configured
        || resource.state != DevelopmentBackendState::Ready
        || observation.worktree_id.as_deref() != Some(candidate.worktree_id.as_str())
        || observation.generation_id.as_deref() != Some(candidate.generation_id.as_str())
    {
        return false;
    }
    let (Some(current), Some(ready)) = (&resource.current_build, &resource.ready_build) else {
        return false;
    };
    ready.id == candidate.ready_build_id
        && ready.source_sha256 == candidate.ready_source_sha256
        && current.source_sha256 != candidate.ready_source_sha256
}

fn is_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
