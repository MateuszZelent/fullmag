//! Authority for the prepared initial state currently published in Live.

pub(crate) mod apply_preparation;

use std::collections::{BTreeSet, VecDeque};

use fullmag_authoring::SceneDocument;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::schemas::authoring::{
    MagnetizationApplyReceiptResource, MagnetizationApplyRequest, MagnetizationApplyStatus,
};
use crate::schemas::common::{AcceptedObservationFrameRef, AuthoredInitialStateOrigin};
use crate::types::{CurrentLiveRequestContext, SessionStateResponse};

#[derive(Debug, Clone)]
pub(crate) struct AuthoredInitialStatePublication {
    pub(crate) frame: AcceptedObservationFrameRef,
    owner_run_id: String,
    retired_run_id: Option<String>,
}

impl AuthoredInitialStatePublication {
    pub(crate) fn new(
        snapshot: &SessionStateResponse,
        origin: AuthoredInitialStateOrigin,
        start_time_s: f64,
    ) -> Self {
        let frame = crate::session::accepted_observation_frame_ref(snapshot, 0, Some(start_time_s))
            .with_authored_initial_state(origin);
        let retired_run_id = snapshot
            .run
            .as_ref()
            .filter(|run| matches!(run.status.as_str(), "completed" | "failed" | "cancelled" | "stopped"))
            .map(|run| run.run_id.clone())
            .or_else(|| {
                snapshot
                    .accepted_terminal_field_generation
                    .as_ref()
                    // A completed stage may already be visible while its
                    // owning Study is still running. Preparing the next
                    // stage must not retire that same active run.
                    .filter(|generation| snapshot.run.as_ref()
                        .is_none_or(|run| run.run_id != generation.run_id))
                    .map(|generation| generation.run_id.clone())
            });
        Self {
            frame,
            owner_run_id: snapshot.session.run_id.clone(),
            retired_run_id,
        }
    }
}

pub(crate) fn current_publication(
    snapshot: &SessionStateResponse,
) -> Option<&AuthoredInitialStatePublication> {
    let publication = snapshot.authored_initial_state.as_ref()?;
    let frame = &publication.frame;
    let origin = frame.authored_initial_state.as_ref()?;
    let domain = crate::session::accepted_observation_frame_ref(
        snapshot,
        frame.source_step,
        frame.source_time_seconds,
    );
    (publication.owner_run_id == snapshot.session.run_id
        && snapshot
            .scene_document
            .as_ref()
            .is_none_or(|scene| scene.revision == origin.scene_revision)
        && frame.session_epoch == domain.session_epoch
        && frame.domain_generation_id == domain.domain_generation_id
        && frame.topology_revision == domain.topology_revision)
        .then_some(publication)
}

/// Identity of the visual publication. The solver independently qualifies
/// whether it can reuse that field as a new stage's initial state.
pub(crate) fn describe_preview(
    snapshot: &SessionStateResponse,
) -> Option<crate::schemas::authoring::PreparedInitialStateResource> {
    let frame = &current_publication(snapshot)?.frame;
    let bundle = snapshot.field_publication_bundles.get("m")?;
    describe_initial_state_frame(frame, bundle)
}

pub(crate) fn describe_initial_state_frame(
    frame: &AcceptedObservationFrameRef,
    bundle: &crate::schemas::common::FieldPublicationBundle,
) -> Option<crate::schemas::authoring::PreparedInitialStateResource> {
    if frame != &bundle.observation_frame || bundle.field.artifact_field_locator.is_some() {
        return None;
    }
    let origin = frame.authored_initial_state.as_ref()?;
    Some(crate::schemas::authoring::PreparedInitialStateResource {
        scene_revision: origin.scene_revision,
        initial_state_revision: origin.initial_state_revision,
        publication_id: bundle.publication_id.clone(),
        observation_frame_id: frame.observation_frame_id.clone(),
        domain_generation_id: frame.domain_generation_id.clone(),
        values_sha256: origin.values_sha256.clone(),
    })
}

pub(crate) fn qualifies_frame(
    snapshot: &SessionStateResponse,
    frame: &AcceptedObservationFrameRef,
) -> bool {
    current_publication(snapshot).is_some_and(|publication| publication.frame == *frame)
}

pub(crate) fn supersedes_run(snapshot: &SessionStateResponse, run_id: &str) -> bool {
    if snapshot.magnetization_applies.pending.as_ref().is_some_and(|pending| {
        pending.retired_run_id == run_id && pending.owner_run_id == snapshot.session.run_id
    }) {
        return true;
    }
    snapshot
        .authored_initial_state
        .as_ref()
        .is_some_and(|publication| {
            publication.owner_run_id == snapshot.session.run_id
                && publication.retired_run_id.as_deref() == Some(run_id)
        })
}

const MAX_RECENT_APPLIES: usize = 64;
const MAX_APPLY_SCOPES: usize = 4096;

#[derive(Debug, Clone)]
pub(crate) struct MagnetizationApply {
    pub(crate) request: MagnetizationApplyRequest,
    payload_sha256: String,
}

impl MagnetizationApply {
    pub(crate) fn validate_request(
        request: MagnetizationApplyRequest,
        base_revision: u64,
        payload: &Value,
        idempotency_key: Option<&str>,
    ) -> Result<Self, ApiError> {
        let id = &request.operation_id;
        if idempotency_key != Some(id.as_str()) || id.len() != 32
            || !id.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(ApiError::bad_request("magnetization apply requires a matching Idempotency-Key"));
        }
        if request.scopes.is_empty() || request.scopes.len() > MAX_APPLY_SCOPES {
            return Err(ApiError::bad_request("invalid number of magnetization apply scopes"));
        }
        let mut seen = BTreeSet::new();
        for scope in &request.scopes {
            if !seen.insert((&scope.object_id, &scope.region_id)) {
                return Err(ApiError::bad_request("duplicate magnetization apply scope"));
            }
        }
        let payload_sha256 = fullmag_session::canonical_json_sha256(&json!({
            "base_revision": base_revision, "scene": payload, "magnetization_apply": request,
        }));
        Ok(Self { request, payload_sha256 })
    }

    pub(crate) fn validate_scopes(&self, scene: &SceneDocument) -> Result<(), ApiError> {
        for scope in &self.request.scopes {
            let object = scene.objects.iter()
                .find(|object| object.id == scope.object_id && object.role == "magnet")
                .ok_or_else(|| ApiError::bad_request("magnetization apply target is not an authored magnetic object"))?;
            if let Some(region_id) = scope.region_id.as_deref() {
                if !object.regions.iter().any(|region| region.region_id == region_id) {
                    return Err(ApiError::bad_request("magnetization apply region does not belong to its object"));
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
struct MagnetizationApplyRecord {
    session_id: String,
    request_scope_epoch: String,
    payload_sha256: String,
    receipt: MagnetizationApplyReceiptResource,
}

#[derive(Debug, Clone)]
pub(crate) struct PendingMagnetizationApply {
    pub(crate) receipt: MagnetizationApplyReceiptResource,
    owner_run_id: String,
    retired_run_id: String,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct MagnetizationApplyState {
    recent: VecDeque<MagnetizationApplyRecord>,
    pub(crate) pending: Option<PendingMagnetizationApply>,
}

impl MagnetizationApplyState {
    pub(crate) fn replay(
        &self,
        apply: &MagnetizationApply,
        context: &CurrentLiveRequestContext,
        scene: Option<&SceneDocument>,
    ) -> Result<Option<(SceneDocument, MagnetizationApplyReceiptResource)>, ApiError> {
        let Some(record) = self.recent.iter().find(|record| {
            record.session_id == context.session_id
                && record.request_scope_epoch == context.request_scope_epoch
                && record.receipt.operation_id == apply.request.operation_id
        }) else { return Ok(None); };
        if record.payload_sha256 != apply.payload_sha256 {
            return Err(ApiError::conflict_with_code(
                "magnetization_apply_intent_conflict",
                "the magnetization apply key already identifies a different request",
            ));
        }
        scene.filter(|scene| scene.revision == record.receipt.scene_revision)
            .map(|scene| (scene.clone(), record.receipt.clone()))
            .map(Some).ok_or_else(|| ApiError::conflict_with_code(
                "magnetization_apply_scene_advanced",
                format!("magnetization apply committed at scene revision {}, but a newer scene is now current",
                    record.receipt.scene_revision),
            ))
    }

    pub(crate) fn record(
        &mut self,
        apply: &MagnetizationApply,
        context: &CurrentLiveRequestContext,
        receipt: MagnetizationApplyReceiptResource,
        owner_run_id: String,
        retired_run_id: String,
    ) {
        if self.recent.len() == MAX_RECENT_APPLIES {
            self.recent.pop_front();
        }
        self.recent.push_back(MagnetizationApplyRecord {
            session_id: context.session_id.clone(),
            request_scope_epoch: context.request_scope_epoch.clone(),
            payload_sha256: apply.payload_sha256.clone(),
            receipt: receipt.clone(),
        });
        self.pending = (receipt.status == MagnetizationApplyStatus::InitialStatePending)
            .then_some(PendingMagnetizationApply { receipt, owner_run_id, retired_run_id });
    }
}
