//! Derived CAS tensor roots for typed study magnetization states.
//!
//! The runner's field JSON remains the immutable producer artifact.  This
//! module only projects an explicitly typed FEM H1/P1 state into the tensor
//! representation owned by the enclosing `SolutionSet`; it never changes the
//! study output manifest or publishes a separate dataset root.

use anyhow::{bail, Context, Result};
use fullmag_application::{
    decode_magnetization_field_semantics, decode_study_artifact_bytes, DecodedStudyArtifact,
    STUDY_MAGNETIZATION_CODEC_ID, STUDY_MAGNETIZATION_CODEC_VERSION,
};
use fullmag_ir::ExecutionPlanIR;
use fullmag_quantities::{
    DatasetSlicePlane, MaterializedDatasetRef, SolutionArtifactKind, SolutionArtifactRef,
};
use fullmag_session::solution_tensor_field::{TensorFieldBinding, TENSOR_FIELD_BINDING_SCHEMA};
use fullmag_session::solution_tensor_source::{MAX_SOLUTION_TENSOR_CHUNKS, SOLUTION_TENSOR_SCHEMA};
use fullmag_session::{
    canonical_json_sha256, FmsStudyOutputManifestEntry, SessionStore, TensorChunk, TensorDescriptor,
};
use serde_json::json;
use sha2::{Digest, Sha256};

mod native_map_geometry;
mod saved_snapshot_gate;
pub use saved_snapshot_gate::verify_pinned_native_fem_snapshot;

const MAX_SOURCE_STATE_BYTES: u64 =
    fullmag_quantities::fem_local_node_map::MAX_FEM_MAPPED_STATE_JSON_BYTES as u64;
const NODES_PER_CHUNK: usize = 8_192;
const BYTES_PER_NODE: usize = 3 * std::mem::size_of::<f64>();
const FIELD_ID: &str = "field:m";

/// Verify a saved native snapshot against its exact historical source and all
/// derived F64 tensor bytes. This is an explicit full-field integrity read,
/// not a viewport slice or a certificate of native mesh-index correspondence.
/// Mapped sources additionally require their exact saved geometry owner and
/// canonical periodic classes; live native coordinates remain unqualified.
/// Legacy sources without a receipt return None after their binding is checked.
pub fn read_pinned_study_tensor_snapshot(
    store: &SessionStore,
    pinned: &fullmag_session::solution_tensor_source::PinnedSolutionTensorSource,
    output: &FmsStudyOutputManifestEntry,
) -> Result<Option<fullmag_quantities::fem_state_snapshot_receipt::FemLocalNodeSnapshotReceipt>> {
    let resolved = fullmag_session::solution_tensor_source::resolve_solution_tensor(store, pinned)?;
    let owner = store
        .solution_sets()
        .read_revision(&pinned.solution_set_id, pinned.solution_revision)?
        .context("saved snapshot exact owner revision is missing")?;
    let source = owner
        .members
        .iter()
        .find(|member| member.member_id == pinned.member_id)
        .and_then(|member| {
            member
                .artifacts
                .iter()
                .find(|artifact| artifact.artifact_id == output.artifact_id)
        })
        .context("saved snapshot source is missing from the exact tensor owner")?;
    validate_source_identity(source, output, &pinned.run_id, &pinned.run_spec_digest)?;
    if !matches!(output.data_kind.as_str(), "state" | "initial_state")
        || output.codec_id != STUDY_MAGNETIZATION_CODEC_ID
        || output.codec_version != STUDY_MAGNETIZATION_CODEC_VERSION
        || source.accepted_state != resolved.artifact.accepted_state
    {
        bail!("saved snapshot source codec or accepted state differs from its tensor");
    }
    let state = read_source_state(store, source, output)?;
    let semantics = decode_magnetization_field_semantics(&state)?
        .context("saved snapshot source has no typed FEM P1 semantics")?;
    validate_plan_and_state_identity(&state.layout, state.values.len(), &semantics)?;
    validate_snapshot_tensor_binding(
        &resolved.tensor,
        &state,
        &semantics,
        &pinned.run_id,
        &pinned.run_spec_digest,
        source,
        output,
    )?;
    let Some(receipt) = state.native_state_snapshot else {
        return Ok(None);
    };
    // No source field or chunk-sized duplicate is retained during tensor IO.
    drop(state.values);
    if let Some(map) = &state.native_node_map {
        native_map_geometry::validate_saved_native_map_geometry(
            store,
            pinned,
            map,
            receipt.native_indexed_geometry_sha256.as_deref(),
        )?;
    }
    drop(state.native_node_map);
    verify_snapshot_tensor_bytes(store.cas(), &resolved.tensor, &receipt.values_sha256)?;
    Ok(Some(receipt))
}

fn verify_snapshot_tensor_bytes(
    cas: &fullmag_session::CasStore,
    tensor: &TensorDescriptor,
    expected_digest: &str,
) -> Result<()> {
    let mut chunks = tensor.chunks.iter().collect::<Vec<_>>();
    chunks.sort_unstable_by_key(|chunk| chunk.offset);
    let mut digest = Sha256::new();
    const MAX_CHUNK_BYTES: u64 = (NODES_PER_CHUNK * BYTES_PER_NODE) as u64;
    for chunk in chunks {
        let range = cas
            .get_verified_range(&chunk.object_ref, 0, chunk.length as u64, MAX_CHUNK_BYTES)?
            .context("saved snapshot tensor chunk is missing")?;
        if range.object_length != chunk.length as u64 || range.bytes.len() != chunk.length {
            bail!("saved snapshot tensor chunk length mismatch");
        }
        digest.update(&range.bytes);
    }
    if format!("sha256:{:x}", digest.finalize()) != expected_digest {
        bail!("saved tensor values differ from the native source snapshot receipt");
    }
    Ok(())
}

fn validate_snapshot_tensor_binding(
    tensor: &TensorDescriptor,
    state: &fullmag_application::MagnetizationStateArtifact,
    semantics: &fullmag_quantities::fem_state_field::FemP1MagnetizationFieldSemantics,
    run_id: &str,
    run_spec_digest: &str,
    source: &SolutionArtifactRef,
    output: &FmsStudyOutputManifestEntry,
) -> Result<()> {
    let binding = tensor
        .field_binding
        .as_ref()
        .context("saved snapshot tensor binding is missing")?;
    let fingerprint = tensor_owner_fingerprint(run_id, run_spec_digest, source, output);
    let expected = TensorFieldBinding {
        format: TENSOR_FIELD_BINDING_SCHEMA.to_string(),
        dataset: MaterializedDatasetRef {
            dataset_id: format!("dataset:study-state:{fingerprint}"),
            revision: 1,
        },
        sample_id: output.case_id.clone(),
        item_id: source.artifact_id.clone(),
        field_id: FIELD_ID.to_string(),
        group_id: format!("group:{fingerprint}"),
        producer_id: semantics.producer_id.clone(),
        producer_version: semantics.producer_version.clone(),
        plane: DatasetSlicePlane::Values,
        descriptor: semantics.descriptor.clone(),
    };
    if binding != &expected
        || tensor.dtype != fullmag_session::TensorDtype::F64
        || tensor.name != "m"
        || tensor.shape != vec![state.values.len(), 3]
        || tensor.logical_axes
            != semantics
                .descriptor
                .axes
                .iter()
                .map(|axis| axis.axis_id.clone())
                .collect::<Vec<_>>()
    {
        bail!("saved snapshot tensor binding differs from its exact producer source");
    }
    binding.validate_for_tensor(tensor)
}

fn read_source_state(
    store: &SessionStore,
    source: &SolutionArtifactRef,
    output: &FmsStudyOutputManifestEntry,
) -> Result<fullmag_application::MagnetizationStateArtifact> {
    if source.byte_length == 0 || source.byte_length > MAX_SOURCE_STATE_BYTES {
        bail!("typed study state exceeds the source metadata byte budget");
    }
    let range = store
        .cas()
        .get_verified_range(
            &source.object_ref,
            0,
            source.byte_length,
            MAX_SOURCE_STATE_BYTES,
        )?
        .context("typed study state CAS object is missing")?;
    if range.object_length != source.byte_length || range.bytes.len() as u64 != source.byte_length {
        bail!("typed study state CAS object length differs from its solution artifact");
    }
    let decoded = decode_study_artifact_bytes(
        &output.data_kind,
        &output.codec_id,
        &output.codec_version,
        &range.bytes,
    )?;
    let DecodedStudyArtifact::MagnetizationState(state) = decoded else {
        bail!("magnetization field output did not decode to a state artifact");
    };
    Ok(state)
}

/// Materialize a typed FEM H1/P1 magnetization state as a durable tensor root.
///
/// Legacy field JSON without the producer semantics envelope is deliberately
/// preserved as an opaque source artifact and returns `Ok(None)`.  Once the
/// envelope is present, every plan and payload identity must agree exactly;
/// malformed or ambiguous typed data fails closed before a solution revision
/// can be published.
pub(crate) fn materialize_study_state_tensor(
    store: &SessionStore,
    plan: &ExecutionPlanIR,
    source: &SolutionArtifactRef,
    output: &FmsStudyOutputManifestEntry,
    run_id: &str,
    run_spec_digest: &str,
) -> Result<Option<SolutionArtifactRef>> {
    if !matches!(output.data_kind.as_str(), "state" | "initial_state")
        || output.codec_id != STUDY_MAGNETIZATION_CODEC_ID
        || output.codec_version != STUDY_MAGNETIZATION_CODEC_VERSION
    {
        return Ok(None);
    }

    validate_source_identity(source, output, run_id, run_spec_digest)?;
    // Resolve the accepted producer contract before reading the potentially
    // large legacy JSON.  FDM, eigen, frequency-response, and higher-order
    // plans have no tensor materializer in this increment and remain opaque.
    let expected_semantics = fullmag_runner::fem_p1_magnetization_field_semantics(plan)
        .map_err(|error| anyhow::anyhow!(error))?;
    let Some(expected_semantics) = expected_semantics else {
        return Ok(None);
    };
    if source.byte_length > MAX_SOURCE_STATE_BYTES {
        // The supported producer path must never silently lose its typed
        // tensor. A bounded streaming decoder is required for larger states.
        bail!(
            "FEM P1 study state `{}` is {} bytes, above the {}-byte tensor materialization budget",
            source.artifact_id,
            source.byte_length,
            MAX_SOURCE_STATE_BYTES
        );
    }

    let state = read_source_state(store, source, output)?;
    let Some(producer_semantics) = decode_magnetization_field_semantics(&state)? else {
        return Ok(None);
    };

    if producer_semantics != expected_semantics {
        bail!("typed FEM magnetization state semantics differ from the accepted execution plan");
    }

    validate_plan_and_state_identity(&state.layout, state.values.len(), &expected_semantics)?;
    let total_bytes = state
        .values
        .len()
        .checked_mul(BYTES_PER_NODE)
        .context("magnetization tensor byte length overflows")?;
    let chunk_count = state
        .values
        .len()
        .checked_add(NODES_PER_CHUNK - 1)
        .context("magnetization tensor chunk count overflows")?
        / NODES_PER_CHUNK;
    if chunk_count == 0 || chunk_count > MAX_SOLUTION_TENSOR_CHUNKS {
        bail!("magnetization tensor exceeds the durable chunk budget");
    }

    let owner_fingerprint = tensor_owner_fingerprint(run_id, run_spec_digest, source, output);
    let dataset = MaterializedDatasetRef {
        dataset_id: format!("dataset:study-state:{owner_fingerprint}"),
        revision: 1,
    };
    let field_binding = TensorFieldBinding {
        format: TENSOR_FIELD_BINDING_SCHEMA.to_string(),
        dataset,
        sample_id: output.case_id.clone(),
        item_id: source.artifact_id.clone(),
        field_id: FIELD_ID.to_string(),
        group_id: format!("group:{owner_fingerprint}"),
        producer_id: producer_semantics.producer_id.clone(),
        producer_version: producer_semantics.producer_version.clone(),
        plane: DatasetSlicePlane::Values,
        descriptor: producer_semantics.descriptor.clone(),
    };

    let axes = producer_semantics
        .descriptor
        .axes
        .iter()
        .map(|axis| axis.axis_id.clone())
        .collect::<Vec<_>>();
    let mut descriptor = TensorDescriptor::new_f64("m", vec![state.values.len(), 3], axes);
    descriptor.field_binding = Some(field_binding);
    descriptor
        .field_binding
        .as_ref()
        .context("magnetization tensor field binding is missing")?
        .validate_for_tensor(&descriptor)
        .context("validate magnetization tensor field binding")?;

    let mut offset = 0usize;
    for node_chunk in state.values.chunks(NODES_PER_CHUNK) {
        let bytes = encode_node_chunk_bytes(node_chunk)?;
        let chunk_len = bytes.len();
        let object_ref = store.cas().put(&bytes)?;
        descriptor.chunks.push(TensorChunk {
            object_ref: object_ref.clone(),
            offset,
            length: chunk_len,
            sha256: Some(object_ref),
        });
        offset = offset
            .checked_add(chunk_len)
            .context("magnetization tensor offset overflows")?;
    }
    if offset != total_bytes || descriptor.chunks.len() != chunk_count {
        bail!("magnetization tensor chunks do not cover the complete field");
    }

    let descriptor_bytes = serde_json::to_vec_pretty(&descriptor)
        .context("serialize magnetization tensor descriptor")?;
    if descriptor_bytes.is_empty()
        || descriptor_bytes.len()
            > fullmag_session::solution_tensor_source::MAX_SOLUTION_TENSOR_METADATA_BYTES as usize
    {
        bail!("magnetization tensor descriptor exceeds the metadata budget");
    }
    let descriptor_ref = store.cas().put(&descriptor_bytes)?;

    Ok(Some(SolutionArtifactRef {
        artifact_id: format!("solution-tensor-{descriptor_ref}"),
        kind: SolutionArtifactKind::State,
        schema_id: SOLUTION_TENSOR_SCHEMA.to_string(),
        object_ref: descriptor_ref,
        byte_length: descriptor_bytes.len() as u64,
        accepted_state: source.accepted_state.clone(),
    }))
}

fn validate_source_identity(
    source: &SolutionArtifactRef,
    output: &FmsStudyOutputManifestEntry,
    run_id: &str,
    run_spec_digest: &str,
) -> Result<()> {
    fullmag_session::repository_path::validate_store_id(run_id)
        .context("typed study tensor run identifier is invalid")?;
    if !fullmag_quantities::is_canonical_sha256(run_spec_digest) {
        bail!("typed study tensor requires a canonical RunSpec digest");
    }
    if source.kind != SolutionArtifactKind::State
        || source.artifact_id != output.artifact_id
        || source.object_ref != output.object_ref
        || output.object_ref != output.content_sha256
        || source.schema_id != format!("{}@{}", output.codec_id, output.codec_version)
        || source.byte_length == 0
    {
        bail!("typed study state source does not match its output manifest entry");
    }
    fullmag_session::repository_path::validate_store_id(&output.port_id)
        .context("typed study tensor port identifier is invalid")?;
    fullmag_session::repository_path::validate_store_id(&output.case_id)
        .context("typed study tensor case identifier is invalid")?;
    fullmag_session::repository_path::validate_store_id(&output.artifact_id)
        .context("typed study tensor artifact identifier is invalid")?;
    if let Some(accepted_state) = &source.accepted_state {
        accepted_state
            .validate()
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        if accepted_state.run_id != run_id {
            bail!("typed study tensor accepted state belongs to another run");
        }
    }
    validate_bare_hash(&source.object_ref, "typed study tensor source object")
}

fn encode_node_chunk_bytes(node_chunk: &[[f64; 3]]) -> Result<Vec<u8>> {
    let chunk_len = node_chunk
        .len()
        .checked_mul(BYTES_PER_NODE)
        .context("magnetization tensor chunk length overflows")?;
    let mut bytes = Vec::with_capacity(chunk_len);
    for value in node_chunk {
        for component in value {
            bytes.extend_from_slice(&component.to_le_bytes());
        }
    }
    if bytes.len() != chunk_len {
        bail!("magnetization tensor chunk has an unexpected byte length");
    }
    Ok(bytes)
}

fn tensor_owner_fingerprint(
    run_id: &str,
    run_spec_digest: &str,
    source: &SolutionArtifactRef,
    output: &FmsStudyOutputManifestEntry,
) -> String {
    canonical_json_sha256(&json!({
        "format": "fullmag.study-state-tensor-owner.v1",
        "run_id": run_id,
        "run_spec_digest": run_spec_digest,
        "source_artifact_id": &source.artifact_id,
        "source_object_ref": &source.object_ref,
        "source_schema_id": &source.schema_id,
        "port_id": &output.port_id,
        "case_id": &output.case_id,
        "data_kind": &output.data_kind,
        "codec_id": &output.codec_id,
        "codec_version": &output.codec_version,
    }))
}

fn validate_plan_and_state_identity(
    layout: &serde_json::Value,
    sample_count: usize,
    expected: &fullmag_quantities::fem_state_field::FemP1MagnetizationFieldSemantics,
) -> Result<()> {
    if layout.get("backend").and_then(serde_json::Value::as_str) != Some("fem")
        || layout.get("fe_order").and_then(serde_json::Value::as_u64) != Some(1)
    {
        bail!("typed FEM magnetization state has an unsupported backend or finite-element order");
    }
    let topology = layout
        .get("topology_fingerprint")
        .and_then(serde_json::Value::as_str)
        .context("typed FEM magnetization state has no topology fingerprint")?;
    let topology = fullmag_quantities::fem_state_field::normalize_topology_fingerprint(topology)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    if expected.descriptor.topology_id != topology
        || expected.active_node_mask.len() != sample_count
        || expected
            .descriptor
            .axes
            .first()
            .map(|axis| axis.length as usize)
            != Some(sample_count)
        || layout.get("n_nodes").and_then(serde_json::Value::as_u64) != Some(sample_count as u64)
    {
        bail!(
            "typed FEM magnetization state does not match the accepted plan topology or node count"
        );
    }
    Ok(())
}

fn validate_bare_hash(value: &str, field: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        bail!("{field} must be a lowercase 64-character SHA-256 digest");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_quantities::fem_state_field::FemP1MagnetizationFieldSemantics;
    use serde_json::json;

    fn topology(digit: char) -> String {
        std::iter::repeat(digit).take(64).collect()
    }

    #[test]
    fn tensor_chunk_encoding_is_row_major_little_endian() {
        let values = [[1.0_f64, -2.0, 3.5], [0.0, 4.0, -8.0]];
        let bytes = encode_node_chunk_bytes(&values).expect("small tensor chunk encodes");
        let expected = values
            .iter()
            .flat_map(|value| value.iter().flat_map(|component| component.to_le_bytes()))
            .collect::<Vec<_>>();
        assert_eq!(bytes, expected);
        assert_eq!(bytes.len(), values.len() * BYTES_PER_NODE);
    }

    #[test]
    fn snapshot_tensor_hash_uses_logical_chunk_order_and_rejects_changed_values() {
        let directory = tempfile::tempdir().unwrap();
        let cas = fullmag_session::CasStore::open(directory.path().join("objects")).unwrap();
        let values = [[1.0, -0.0, 0.25], [-0.5, 0.0, 1.0]];
        let expected =
            fullmag_quantities::fem_state_snapshot_receipt::local_node_values_sha256(&values)
                .unwrap();
        let mut tensor =
            TensorDescriptor::new_f64("m", vec![2, 3], vec!["node".into(), "component".into()]);
        for (index, row) in values.iter().enumerate().rev() {
            let bytes = encode_node_chunk_bytes(std::slice::from_ref(row)).unwrap();
            let hash = cas.put(&bytes).unwrap();
            tensor.chunks.push(TensorChunk {
                object_ref: hash.clone(),
                offset: index * BYTES_PER_NODE,
                length: bytes.len(),
                sha256: Some(hash),
            });
        }
        verify_snapshot_tensor_bytes(&cas, &tensor, &expected).unwrap();
        let mut changed = values;
        changed[0][1] = 0.0;
        let bytes = encode_node_chunk_bytes(&changed[..1]).unwrap();
        let hash = cas.put(&bytes).unwrap();
        let index = tensor
            .chunks
            .iter()
            .position(|chunk| chunk.offset == 0)
            .unwrap();
        tensor.chunks[index].object_ref = hash.clone();
        tensor.chunks[index].sha256 = Some(hash);
        assert!(verify_snapshot_tensor_bytes(&cas, &tensor, &expected).is_err());
        tensor.chunks[index].length -= 8;
        assert!(verify_snapshot_tensor_bytes(&cas, &tensor, &expected).is_err());
    }

    #[test]
    fn snapshot_tensor_rejects_oversized_chunk_without_materializing_it() {
        let directory = tempfile::tempdir().unwrap();
        let cas = fullmag_session::CasStore::open(directory.path().join("objects")).unwrap();
        let length = NODES_PER_CHUNK * BYTES_PER_NODE + 8;
        let mut tensor =
            TensorDescriptor::new_f64("m", vec![1, 3], vec!["node".into(), "component".into()]);
        tensor.chunks.push(TensorChunk {
            object_ref: "a".repeat(64),
            offset: 0,
            length,
            sha256: None,
        });
        let error =
            verify_snapshot_tensor_bytes(&cas, &tensor, &format!("sha256:{}", "a".repeat(64)))
                .unwrap_err();
        assert!(error.to_string().contains("outside the positive"));
    }

    #[test]
    fn state_identity_rejects_topology_mismatch_before_materialization() {
        let expected = FemP1MagnetizationFieldSemantics::new(&topology('a'), 2, vec![true, true])
            .expect("valid FEM P1 semantics");
        let layout = json!({
            "backend": "fem",
            "fe_order": 1,
            "n_nodes": 2,
            "topology_fingerprint": topology('b'),
        });
        assert!(validate_plan_and_state_identity(&layout, 2, &expected).is_err());
    }

    #[test]
    fn tensor_owner_fingerprint_is_replay_stable_and_case_scoped() {
        let source = SolutionArtifactRef {
            artifact_id: "state-output-1".to_string(),
            kind: SolutionArtifactKind::State,
            schema_id: "fullmag.runner.field_json@v1".to_string(),
            object_ref: "a".repeat(64),
            byte_length: 1,
            accepted_state: None,
        };
        let output = FmsStudyOutputManifestEntry {
            port_id: "m-final".to_string(),
            case_id: "case-a".to_string(),
            data_kind: "state".to_string(),
            codec_id: STUDY_MAGNETIZATION_CODEC_ID.to_string(),
            codec_version: STUDY_MAGNETIZATION_CODEC_VERSION.to_string(),
            artifact_id: source.artifact_id.clone(),
            object_ref: source.object_ref.clone(),
            content_sha256: source.object_ref.clone(),
        };
        let first = tensor_owner_fingerprint(
            "run-1",
            &format!("sha256:{}", "b".repeat(64)),
            &source,
            &output,
        );
        let second = tensor_owner_fingerprint(
            "run-1",
            &format!("sha256:{}", "b".repeat(64)),
            &source,
            &output,
        );
        assert_eq!(first, second);

        let mut other_case = output.clone();
        other_case.case_id = "case-b".to_string();
        assert_ne!(
            first,
            tensor_owner_fingerprint(
                "run-1",
                &format!("sha256:{}", "b".repeat(64)),
                &source,
                &other_case,
            )
        );
    }
}
