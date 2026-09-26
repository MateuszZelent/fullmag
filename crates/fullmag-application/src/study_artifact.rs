//! Versioned codecs for typed study outputs consumed by worker boundaries.
//!
//! The field-state codec reads the runner's explicit `m_final.json` document;
//! it never discovers files by scanning an output directory. Scalar values
//! use a small SI-valued envelope with their quantity and unit named.

use crate::execution::{ExecutionError, ResolvedStudyArtifact};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const STUDY_MAGNETIZATION_CODEC_ID: &str = "fullmag.runner.field_json";
pub const STUDY_MAGNETIZATION_CODEC_VERSION: &str = "v1";
pub const STUDY_SCALAR_CODEC_ID: &str = "fullmag.study.scalar_json";
pub const STUDY_SCALAR_CODEC_VERSION: &str = "v1";
pub const STUDY_SCALAR_ARTIFACT_SCHEMA: &str = "study_scalar.v1";
pub const MAGNETIZATION_STATE_IDENTITY_SCHEMA: &str = "magnetization_state.v1";

#[derive(Clone, Debug, PartialEq)]
pub enum DecodedStudyArtifact {
    MagnetizationState(MagnetizationStateArtifact),
    Scalar(StudyScalarArtifact),
}

#[derive(Clone, Debug, PartialEq)]
pub struct MagnetizationStateArtifact {
    pub step: u64,
    pub time_s: f64,
    pub solver_dt_s: f64,
    pub space_fingerprint: String,
    pub layout: Value,
    pub provenance: Value,
    pub values: Vec<[f64; 3]>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StudyScalarArtifact {
    pub schema_version: String,
    pub quantity_id: String,
    pub unit: String,
    pub value_si: f64,
    pub step: u64,
    pub time_s: f64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MagnetizationFieldArtifactV1 {
    observable: String,
    unit: String,
    step: u64,
    time: f64,
    solver_dt: f64,
    layout: Value,
    provenance: Value,
    state_identity: MagnetizationStateIdentityV1,
    values: Vec<[f64; 3]>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MagnetizationStateIdentityV1 {
    schema_version: String,
    backend: String,
    layout_sha256: String,
    sample_count: usize,
}

/// Decode one immutable CAS artifact after checking its manifest codec and
/// content identity. The returned layout remains available to the worker so
/// it can enforce exact or explicitly supported cross-space transfer rules.
pub fn decode_study_artifact(
    artifact: &ResolvedStudyArtifact,
    bytes: &[u8],
) -> Result<DecodedStudyArtifact, ExecutionError> {
    artifact.validate()?;
    let actual_digest = study_artifact_content_sha256(bytes);
    if actual_digest != artifact.object_ref {
        return Err(invalid(
            "study artifact bytes differ from the manifest CAS digest",
        ));
    }

    match (
        artifact.data_kind.as_str(),
        artifact.codec_id.as_str(),
        artifact.codec_version.as_str(),
    ) {
        (
            "state" | "initial_state",
            STUDY_MAGNETIZATION_CODEC_ID,
            STUDY_MAGNETIZATION_CODEC_VERSION,
        ) => decode_magnetization_state(bytes).map(DecodedStudyArtifact::MagnetizationState),
        ("scalar", STUDY_SCALAR_CODEC_ID, STUDY_SCALAR_CODEC_VERSION) => {
            decode_scalar(bytes).map(DecodedStudyArtifact::Scalar)
        }
        _ => Err(invalid("unsupported study artifact codec")),
    }
}

/// Validate and decode bytes before publication, while the producer still
/// owns them and before any CAS object is pinned into the artifact catalog.
pub fn decode_study_artifact_bytes(
    data_kind: &str,
    codec_id: &str,
    codec_version: &str,
    bytes: &[u8],
) -> Result<DecodedStudyArtifact, ExecutionError> {
    let artifact = ResolvedStudyArtifact {
        artifact_id: "study-output-validation".into(),
        object_ref: study_artifact_content_sha256(bytes),
        data_kind: data_kind.into(),
        codec_id: codec_id.into(),
        codec_version: codec_version.into(),
    };
    decode_study_artifact(&artifact, bytes)
}

/// Encode one scalar result in SI units for a declared scalar study port.
pub fn encode_study_scalar_artifact(
    quantity_id: impl Into<String>,
    unit: impl Into<String>,
    value_si: f64,
    step: u64,
    time_s: f64,
) -> Result<Vec<u8>, ExecutionError> {
    let artifact = StudyScalarArtifact {
        schema_version: STUDY_SCALAR_ARTIFACT_SCHEMA.into(),
        quantity_id: quantity_id.into(),
        unit: unit.into(),
        value_si,
        step,
        time_s,
    };
    validate_scalar(&artifact)?;
    serde_json::to_vec(&artifact)
        .map_err(|error| invalid(format!("serialize study scalar artifact: {error}")))
}

/// Stable digest for the exact bytes stored in CAS.
pub fn study_artifact_content_sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Stable digest for the runner field-layout JSON embedded in a state artifact.
pub fn study_state_layout_sha256(layout: &Value) -> Result<String, ExecutionError> {
    let bytes = serde_json::to_vec(layout)
        .map_err(|error| invalid(format!("serialize magnetization layout: {error}")))?;
    Ok(study_artifact_content_sha256(&bytes))
}

fn decode_magnetization_state(bytes: &[u8]) -> Result<MagnetizationStateArtifact, ExecutionError> {
    let payload: MagnetizationFieldArtifactV1 = serde_json::from_slice(bytes)
        .map_err(|error| invalid(format!("parse runner magnetization field JSON v1: {error}")))?;
    if payload.observable != "m" || payload.unit != "1" {
        return Err(invalid(
            "magnetization state artifact must describe observable m in unit 1",
        ));
    }
    if !payload.time.is_finite()
        || payload.time < 0.0
        || !payload.solver_dt.is_finite()
        || payload.solver_dt < 0.0
    {
        return Err(invalid(
            "magnetization state time and solver_dt must be finite and non-negative",
        ));
    }
    if payload.values.is_empty()
        || payload
            .values
            .iter()
            .flatten()
            .any(|component| !component.is_finite())
    {
        return Err(invalid(
            "magnetization state must contain finite three-component samples",
        ));
    }
    if !payload.provenance.is_object() {
        return Err(invalid("magnetization state provenance must be an object"));
    }

    let layout_backend = payload
        .layout
        .get("backend")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("magnetization state layout has no backend identity"))?;
    if payload.state_identity.schema_version != MAGNETIZATION_STATE_IDENTITY_SCHEMA
        || payload.state_identity.backend != layout_backend
        || payload.state_identity.sample_count != payload.values.len()
        || payload.state_identity.layout_sha256 != study_state_layout_sha256(&payload.layout)?
    {
        return Err(invalid(
            "magnetization state identity does not match its layout and samples",
        ));
    }
    validate_magnetization_layout(layout_backend, &payload.layout, payload.values.len())?;

    Ok(MagnetizationStateArtifact {
        step: payload.step,
        time_s: payload.time,
        solver_dt_s: payload.solver_dt,
        space_fingerprint: payload.state_identity.layout_sha256,
        layout: payload.layout,
        provenance: payload.provenance,
        values: payload.values,
    })
}

fn validate_magnetization_layout(
    backend: &str,
    layout: &Value,
    sample_count: usize,
) -> Result<(), ExecutionError> {
    match backend {
        "fdm" => {
            let cells = u64_triplet(layout.get("grid_cells"))
                .ok_or_else(|| invalid("FDM state layout has invalid grid_cells"))?;
            let expected = cells
                .into_iter()
                .try_fold(1usize, |product, count| {
                    let count = usize::try_from(count).ok()?;
                    if count == 0 {
                        return None;
                    }
                    product.checked_mul(count)
                })
                .ok_or_else(|| invalid("FDM state layout grid size is invalid or overflows"))?;
            if expected != sample_count
                || !valid_digest_identity(layout.get("grid_fingerprint"))
                || !finite_triplet(layout.get("origin_m"))
                || !positive_finite_triplet(layout.get("cell_size"))
            {
                return Err(invalid(
                    "FDM state samples do not match the identified cell grid",
                ));
            }
        }
        "fdm_multilayer" => {
            if layout.get("layout_error").is_some() {
                return Err(invalid("FDM multilayer state layout reports an error"));
            }
            let layers = layout
                .get("layers")
                .and_then(Value::as_array)
                .filter(|layers| !layers.is_empty())
                .ok_or_else(|| invalid("FDM multilayer state layout has no layers"))?;
            let mut expected_offset = 0usize;
            for layer in layers {
                let offset = layer
                    .get("value_offset")
                    .and_then(Value::as_u64)
                    .and_then(|value| usize::try_from(value).ok())
                    .ok_or_else(|| invalid("FDM multilayer state layer has no value_offset"))?;
                let count = layer
                    .get("value_count")
                    .and_then(Value::as_u64)
                    .and_then(|value| usize::try_from(value).ok())
                    .filter(|value| *value > 0)
                    .ok_or_else(|| invalid("FDM multilayer state layer has invalid value_count"))?;
                if offset != expected_offset
                    || !valid_digest_identity(layer.get("native_grid_fingerprint"))
                {
                    return Err(invalid(
                        "FDM multilayer state layer order or grid identity is invalid",
                    ));
                }
                expected_offset = expected_offset
                    .checked_add(count)
                    .ok_or_else(|| invalid("FDM multilayer state sample count overflows"))?;
            }
            if expected_offset != sample_count {
                return Err(invalid(
                    "FDM multilayer state samples do not match the native layer layout",
                ));
            }
        }
        "fem" | "fem_eigen" | "fem_frequency_response" => {
            let order = layout.get("fe_order").and_then(Value::as_u64);
            let node_count = layout.get("n_nodes").and_then(Value::as_u64);
            if order != Some(1)
                || node_count.and_then(|value| usize::try_from(value).ok()) != Some(sample_count)
                || !valid_digest_identity(layout.get("topology_fingerprint"))
            {
                return Err(invalid(
                    "FEM state codec v1 only supports identified H1 P1 nodal samples",
                ));
            }
        }
        _ => {
            return Err(invalid(format!(
                "unsupported magnetization layout `{backend}`"
            )))
        }
    }
    Ok(())
}

fn decode_scalar(bytes: &[u8]) -> Result<StudyScalarArtifact, ExecutionError> {
    let artifact: StudyScalarArtifact = serde_json::from_slice(bytes)
        .map_err(|error| invalid(format!("parse study scalar artifact v1: {error}")))?;
    validate_scalar(&artifact)?;
    Ok(artifact)
}

fn validate_scalar(artifact: &StudyScalarArtifact) -> Result<(), ExecutionError> {
    if artifact.schema_version != STUDY_SCALAR_ARTIFACT_SCHEMA
        || !portable_token(&artifact.quantity_id)
        || artifact.unit.trim().is_empty()
        || artifact.unit.len() > 128
        || !artifact.unit.is_ascii()
        || artifact.unit.chars().any(char::is_control)
        || !artifact.value_si.is_finite()
        || !artifact.time_s.is_finite()
        || artifact.time_s < 0.0
    {
        return Err(invalid(
            "study scalar artifact has invalid identity, unit, or value",
        ));
    }
    Ok(())
}

fn valid_digest_identity(value: Option<&Value>) -> bool {
    let Some(value) = value.and_then(Value::as_str) else {
        return false;
    };
    let digest = value.strip_prefix("sha256:").unwrap_or(value);
    digest.len() == 64
        && digest
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn u64_triplet(value: Option<&Value>) -> Option<[u64; 3]> {
    let values = value?.as_array()?;
    if values.len() != 3 {
        return None;
    }
    Some([
        values.first()?.as_u64()?,
        values.get(1)?.as_u64()?,
        values.get(2)?.as_u64()?,
    ])
}

fn finite_triplet(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_array)
        .is_some_and(|values| values.len() == 3 && values.iter().all(finite_number))
}

fn positive_finite_triplet(value: Option<&Value>) -> bool {
    value.and_then(Value::as_array).is_some_and(|values| {
        values.len() == 3
            && values.iter().all(|value| {
                value
                    .as_f64()
                    .is_some_and(|number| number.is_finite() && number > 0.0)
            })
    })
}

fn finite_number(value: &Value) -> bool {
    value.as_f64().is_some_and(f64::is_finite)
}

fn portable_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && value.is_ascii()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        && value != "."
        && value != ".."
        && !value.ends_with('.')
}

fn invalid(message: impl Into<String>) -> ExecutionError {
    ExecutionError::Invalid(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fdm_layout() -> Value {
        json!({
            "backend": "fdm",
            "origin_m": [0.0, 0.0, 0.0],
            "grid_cells": [1, 1, 2],
            "cell_size": [1.0e-9, 1.0e-9, 1.0e-9],
            "total_cell_count": 2,
            "grid_fingerprint": "a".repeat(64),
        })
    }

    fn state_bytes(layout: Value) -> Vec<u8> {
        let backend = layout["backend"].as_str().unwrap().to_owned();
        let layout_sha256 = study_state_layout_sha256(&layout).unwrap();
        serde_json::to_vec(&json!({
            "observable": "m",
            "unit": "1",
            "step": 4,
            "time": 4.0e-12,
            "solver_dt": 1.0e-12,
            "layout": layout,
            "provenance": {"execution_resolution": {"requested": backend}},
            "state_identity": {
                "schema_version": MAGNETIZATION_STATE_IDENTITY_SCHEMA,
                "backend": backend,
                "layout_sha256": layout_sha256,
                "sample_count": 2,
            },
            "values": [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
        }))
        .unwrap()
    }

    fn decode_bytes(
        data_kind: &str,
        codec_id: &str,
        codec_version: &str,
        bytes: &[u8],
    ) -> Result<DecodedStudyArtifact, ExecutionError> {
        decode_study_artifact_bytes(data_kind, codec_id, codec_version, bytes)
    }

    #[test]
    fn decodes_runner_magnetization_json_with_exact_layout_and_content_identity() {
        let bytes = state_bytes(fdm_layout());
        let decoded = decode_bytes(
            "state",
            STUDY_MAGNETIZATION_CODEC_ID,
            STUDY_MAGNETIZATION_CODEC_VERSION,
            &bytes,
        )
        .unwrap();
        let DecodedStudyArtifact::MagnetizationState(state) = decoded else {
            panic!("expected a magnetization state");
        };
        assert_eq!(state.step, 4);
        assert_eq!(state.values, vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]);
        assert_eq!(
            state.space_fingerprint,
            study_state_layout_sha256(&state.layout).unwrap()
        );
    }

    #[test]
    fn decodes_fdm_multilayer_with_ordered_native_layer_fingerprints() {
        let layout = json!({
            "backend": "fdm_multilayer",
            "layer_count": 2,
            "layers": [
                {
                    "value_offset": 0,
                    "value_count": 1,
                    "native_grid_fingerprint": format!("sha256:{}", "a".repeat(64)),
                },
                {
                    "value_offset": 1,
                    "value_count": 1,
                    "native_grid_fingerprint": "b".repeat(64),
                },
            ],
        });
        let decoded = decode_bytes(
            "state",
            STUDY_MAGNETIZATION_CODEC_ID,
            STUDY_MAGNETIZATION_CODEC_VERSION,
            &state_bytes(layout),
        )
        .unwrap();
        let DecodedStudyArtifact::MagnetizationState(state) = decoded else {
            panic!("expected a magnetization state");
        };
        assert_eq!(state.values.len(), 2);
        assert_eq!(state.layout["backend"], "fdm_multilayer");
    }

    #[test]
    fn decodes_only_identified_fem_h1_p1_nodal_state() {
        let layout = json!({
            "backend": "fem",
            "fe_order": 1,
            "n_nodes": 2,
            "n_elements": 1,
            "topology_fingerprint": format!("sha256:{}", "c".repeat(64)),
        });
        let decoded = decode_bytes(
            "state",
            STUDY_MAGNETIZATION_CODEC_ID,
            STUDY_MAGNETIZATION_CODEC_VERSION,
            &state_bytes(layout),
        )
        .unwrap();
        assert!(matches!(
            decoded,
            DecodedStudyArtifact::MagnetizationState(_)
        ));

        let p2_layout = json!({
            "backend": "fem",
            "fe_order": 2,
            "n_nodes": 2,
            "n_elements": 1,
            "topology_fingerprint": "c".repeat(64),
        });
        let error = decode_bytes(
            "state",
            STUDY_MAGNETIZATION_CODEC_ID,
            STUDY_MAGNETIZATION_CODEC_VERSION,
            &state_bytes(p2_layout),
        )
        .unwrap_err();
        assert!(error.to_string().contains("only supports identified H1 P1"));
    }

    #[test]
    fn rejects_magnetization_layout_and_sample_count_mismatch() {
        let mut layout = fdm_layout();
        layout["grid_cells"] = json!([2, 2, 2]);
        let error = decode_bytes(
            "state",
            STUDY_MAGNETIZATION_CODEC_ID,
            STUDY_MAGNETIZATION_CODEC_VERSION,
            &state_bytes(layout),
        )
        .unwrap_err();
        assert!(error.to_string().contains("do not match"));
    }

    #[test]
    fn scalar_codec_round_trips_si_value_and_rejects_unknown_codec() {
        let bytes = encode_study_scalar_artifact("E_total", "J", -2.5e-18, 7, 3.0e-12).unwrap();
        let decoded = decode_bytes(
            "scalar",
            STUDY_SCALAR_CODEC_ID,
            STUDY_SCALAR_CODEC_VERSION,
            &bytes,
        )
        .unwrap();
        assert_eq!(
            decoded,
            DecodedStudyArtifact::Scalar(StudyScalarArtifact {
                schema_version: STUDY_SCALAR_ARTIFACT_SCHEMA.into(),
                quantity_id: "E_total".into(),
                unit: "J".into(),
                value_si: -2.5e-18,
                step: 7,
                time_s: 3.0e-12,
            })
        );
        assert!(decode_bytes("scalar", "opaque", "v1", &bytes).is_err());
    }
}
