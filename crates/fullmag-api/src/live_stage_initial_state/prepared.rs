//! Freeze the exact prepared Live magnetization as an immutable Study input.

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::error::ApiError;
use crate::live_authored_initial_state::describe_initial_state_frame;
use crate::schemas::authoring::PreparedInitialStateResource;
use crate::schemas::commands::RuntimeAuthoredInitialStateSource;
use crate::study_execution_contract::matches_prepared_request;
use crate::schemas::common::AcceptedObservationFrameRef;
use crate::shared_json::SharedJson;
use crate::types::SessionStateResponse;

use super::{plan_layout, prepared_initial_state_unavailable, unresolved};

#[derive(Debug, Clone)]
pub(crate) struct PreparedStateCapture {
    identity: PreparedInitialStateResource,
    frame: AcceptedObservationFrameRef,
    field: SharedJson,
    metadata: SharedJson,
}

#[derive(Debug, Clone)]
pub(crate) struct PreparedStateArtifact {
    pub(crate) source: PreparedInitialStateResource,
    pub(crate) artifact_id: String,
    pub(crate) content_sha256: String,
    pub(crate) bytes: Vec<u8>,
}

fn qualified(
    snapshot: &SessionStateResponse,
) -> Option<(
    &AcceptedObservationFrameRef,
    &crate::schemas::common::FieldPublicationBundle,
    &SharedJson,
)> {
    let publication = crate::live_authored_initial_state::current_publication(snapshot)?;
    let origin = publication.frame.authored_initial_state.as_ref()?;
    let bundle = snapshot.field_publication_bundles.get("m")?;
    let raw = snapshot.latest_fields.get_shared("m")?;
    let frame: AcceptedObservationFrameRef =
        serde_json::from_value(raw.get("observation_frame")?.clone()).ok()?;
    let layout = raw.pointer("/layout/backend")?.as_str()?;
    let execution = snapshot.metadata.as_ref()?.get("execution_plan")?;
    if origin.initial_state_revision != snapshot.region_realization_revisions.initial_state
        || publication.frame.source_step != 0
        || publication.frame.source_time_seconds.is_none()
        || bundle.observation_frame != publication.frame
        || bundle.field.artifact_field_locator.is_some()
        || frame != publication.frame
        || !matches!(layout, "fdm" | "fdm_multilayer" | "fem")
        || execution.pointer("/backend_plan/kind")?.as_str()? != layout
        || !raw.get("values").is_some_and(Value::is_array)
        || (layout == "fem"
            && execution
                .pointer("/backend_plan/fe_order")
                .and_then(Value::as_u64)
                != Some(1))
    {
        return None;
    }
    Some((&publication.frame, bundle, raw))
}

pub(crate) fn describe_prepared_initial_state(
    snapshot: &SessionStateResponse,
) -> Option<PreparedInitialStateResource> {
    let (frame, bundle, _) = qualified(snapshot)?;
    describe_initial_state_frame(frame, bundle)
}


impl PreparedStateCapture {
    pub(crate) fn capture(
        snapshot: &SessionStateResponse,
        request: &RuntimeAuthoredInitialStateSource,
    ) -> Result<Self, ApiError> {
        let (frame, bundle, field) =
            qualified(snapshot).ok_or_else(prepared_initial_state_unavailable)?;
        let identity = describe_initial_state_frame(frame, bundle)
            .filter(|identity| matches_prepared_request(identity, request))
            .ok_or_else(prepared_initial_state_unavailable)?;
        let metadata = snapshot
            .metadata
            .as_ref()
            .ok_or_else(prepared_initial_state_unavailable)?;
        Ok(Self {
            identity,
            frame: frame.clone(),
            field: field.clone(),
            metadata: metadata.clone(),
        })
    }

    pub(crate) fn validate(&self, snapshot: &SessionStateResponse) -> Result<(), ApiError> {
        let (frame, bundle, field) =
            qualified(snapshot).ok_or_else(prepared_initial_state_unavailable)?;
        if describe_initial_state_frame(frame, bundle).as_ref() != Some(&self.identity)
            || field.version() != self.field.version()
            || snapshot.metadata.as_ref().map(SharedJson::version) != Some(self.metadata.version())
        {
            return Err(prepared_initial_state_unavailable());
        }
        Ok(())
    }

    pub(super) fn freeze(
        &self,
        entry: &fullmag_plan::StudyProblemCatalogEntry,
        request: &RuntimeAuthoredInitialStateSource,
    ) -> Result<PreparedStateArtifact, ApiError> {
        if !matches_prepared_request(&self.identity, request) {
            return Err(prepared_initial_state_unavailable());
        }
        let plan = self
            .metadata
            .execution_plan()
            .ok_or_else(prepared_initial_state_unavailable)?;
        let layout = fullmag_runner::study_magnetization_layout_for_plan(&plan)
            .map_err(|error| unresolved(error.message))?;
        if layout != plan_layout(entry)? {
            return Err(ApiError::unprocessable_with_code(
                "initial_state_incompatible_with_target",
                "the prepared magnetization layout differs from the selected stage",
            ));
        }
        let values = Vec::<[f64; 3]>::deserialize(
            self.field
                .get("values")
                .ok_or_else(prepared_initial_state_unavailable)?,
        )
        .map_err(|error| unresolved(format!("invalid prepared magnetization samples: {error}")))?;
        let mut digest = Sha256::new();
        for component in values.iter().flatten() {
            digest.update(component.to_le_bytes());
        }
        if format!("{:x}", digest.finalize()) != self.identity.values_sha256 {
            return Err(unresolved(
                "the prepared sample digest differs from the published frame",
            ));
        }
        let layout_sha256 = fullmag_application::study_state_layout_sha256(&layout)
            .map_err(|error| unresolved(error.to_string()))?;
        let bytes = serde_json::to_vec(&json!({
            "observable": "m",
            "unit": "1",
            "step": self.frame.source_step,
            "time": self.frame.source_time_seconds,
            "solver_dt": 0.0,
            "state_identity": {
                "schema_version": fullmag_application::MAGNETIZATION_STATE_IDENTITY_SCHEMA,
                "backend": layout["backend"],
                "layout_sha256": layout_sha256,
                "sample_count": values.len(),
            },
            "layout": layout,
            "values": values,
            "provenance": {
                "source_kind": "prepared_initial_state",
                "publication": self.identity,
                "prepared_provenance": self.field.get("provenance"),
            },
        }))
        .map_err(|error| ApiError::internal(format!("encode prepared magnetization: {error}")))?;
        let content_sha256 = fullmag_application::study_artifact_content_sha256(&bytes);
        let artifact_id = format!("prepared-state-{content_sha256}");
        let binding = fullmag_application::ResolvedStudyArtifact {
            artifact_id: artifact_id.clone(),
            object_ref: content_sha256.clone(),
            data_kind: "state".into(),
            codec_id: fullmag_application::STUDY_MAGNETIZATION_CODEC_ID.into(),
            codec_version: fullmag_application::STUDY_MAGNETIZATION_CODEC_VERSION.into(),
        };
        fullmag_application::decode_study_artifact(&binding, &bytes)
            .map_err(|error| unresolved(error.to_string()))?;
        Ok(PreparedStateArtifact {
            source: self.identity.clone(),
            artifact_id,
            content_sha256,
            bytes,
        })
    }
}
