use std::collections::HashMap;
use std::fs;

use fullmag_quantities::{
    ScientificAssessment, ScientificAssessmentStatus, SolutionArtifactKind, SolutionArtifactRef,
    SolutionExecutionStatus, SolutionMember, SolutionSet, SolutionSetManifestState,
    SolutionSetProvenance, SOLUTION_SET_SCHEMA_VERSION,
};
use serde_json::json;

use crate::reachability::{walk_archive_documents, walk_store_root, ReachabilityMode};
use crate::solution_tensor_source::{
    parse_solution_tensor_artifact, resolve_solution_tensor, PinnedSolutionTensorSource,
    MAX_SOLUTION_TENSOR_CHUNKS, MAX_SOLUTION_TENSOR_METADATA_BYTES, SOLUTION_TENSOR_SCHEMA,
};
use crate::{FmsRunIntent, SessionStore, TensorChunk, TensorDescriptor, TensorDtype};

fn digest(character: char) -> String {
    format!("sha256:{}", character.to_string().repeat(64))
}

fn valid_descriptor(chunk_ref: &str, chunk_length: usize) -> TensorDescriptor {
    TensorDescriptor {
        format: SOLUTION_TENSOR_SCHEMA.to_string(),
        name: "magnetization".to_string(),
        dtype: TensorDtype::F64,
        shape: vec![2],
        logical_axes: vec!["sample".to_string()],
        endian: "little".to_string(),
        field_binding: None,
        chunks: vec![TensorChunk {
            object_ref: chunk_ref.to_string(),
            offset: 0,
            length: chunk_length,
            sha256: Some(chunk_ref.to_string()),
        }],
    }
}

fn artifact_for_descriptor(bytes: &[u8]) -> SolutionArtifactRef {
    SolutionArtifactRef {
        artifact_id: "artifact-tensor".to_string(),
        kind: SolutionArtifactKind::State,
        schema_id: SOLUTION_TENSOR_SCHEMA.to_string(),
        object_ref: crate::hex_sha256(bytes),
        byte_length: bytes.len() as u64,
        accepted_state: None,
    }
}

fn unassessed() -> ScientificAssessment {
    ScientificAssessment {
        status: ScientificAssessmentStatus::Unassessed,
        reason: Some("test fixture".to_string()),
        evidence_artifact_ids: Vec::new(),
    }
}

fn tensor_solution(
    run_id: &str,
    solution_set_id: &str,
    run_spec_digest: String,
    artifact: SolutionArtifactRef,
) -> SolutionSet {
    SolutionSet {
        schema_version: SOLUTION_SET_SCHEMA_VERSION.to_string(),
        solution_set_id: solution_set_id.to_string(),
        revision: 1,
        run_id: run_id.to_string(),
        manifest_state: SolutionSetManifestState::Closed,
        execution_status: SolutionExecutionStatus::Succeeded,
        scientific_assessment: unassessed(),
        provenance: SolutionSetProvenance {
            run_spec_digest,
            model_digest: digest('b'),
            physics_digest: digest('c'),
            discretization_digest: digest('d'),
            resolved_plan_digest: digest('e'),
            acquisition_digest: digest('f'),
            seed_digest: None,
        },
        members: vec![SolutionMember {
            member_id: "member-tensor".to_string(),
            task_id: "task-tensor".to_string(),
            attempt_id: "attempt-tensor".to_string(),
            ownership_epoch: 1,
            case_id: None,
            stage_id: "stage-tensor".to_string(),
            execution_status: SolutionExecutionStatus::Succeeded,
            scientific_assessment: unassessed(),
            artifacts: vec![artifact],
        }],
        coverage: Vec::new(),
    }
}

struct PublishedTensorFixture {
    _directory: tempfile::TempDir,
    store: SessionStore,
    solution: SolutionSet,
    artifact: SolutionArtifactRef,
    descriptor_bytes: Vec<u8>,
    chunk_ref: String,
    chunk_bytes: Vec<u8>,
    run_spec_digest: String,
}

fn published_tensor_fixture() -> PublishedTensorFixture {
    let directory = tempfile::tempdir().expect("temporary tensor store");
    let store = SessionStore::open(directory.path().join("store")).expect("open tensor store");
    let intent = FmsRunIntent::new(
        "run-tensor",
        "intent-tensor",
        json!({
            "run_id": "run-tensor",
            "solver": "test"
        }),
    );
    store
        .commit_run_intent(&intent)
        .expect("publish owner run intent");

    let chunk_bytes = vec![0_u8; 16];
    let chunk_ref = store.cas().put(&chunk_bytes).expect("publish tensor chunk");
    let descriptor = valid_descriptor(&chunk_ref, chunk_bytes.len());
    let descriptor_bytes = serde_json::to_vec(&descriptor).expect("serialize tensor descriptor");
    let descriptor_ref = store
        .cas()
        .put(&descriptor_bytes)
        .expect("publish tensor descriptor");
    assert_eq!(descriptor_ref, crate::hex_sha256(&descriptor_bytes));
    let artifact = SolutionArtifactRef {
        artifact_id: "artifact-tensor".to_string(),
        kind: SolutionArtifactKind::State,
        schema_id: SOLUTION_TENSOR_SCHEMA.to_string(),
        object_ref: descriptor_ref,
        byte_length: descriptor_bytes.len() as u64,
        accepted_state: None,
    };
    let run_spec_digest = format!("sha256:{}", intent.payload_sha256);
    let solution = tensor_solution(
        "run-tensor",
        "solution-tensor",
        run_spec_digest.clone(),
        artifact.clone(),
    );
    store
        .publish_solution_set(&solution)
        .expect("publish verified tensor solution");

    PublishedTensorFixture {
        _directory: directory,
        store,
        solution,
        artifact,
        descriptor_bytes,
        chunk_ref,
        chunk_bytes,
        run_spec_digest,
    }
}

#[test]
fn parser_rejects_tensor_shape_axes_endian_coverage_and_chunk_identity_errors() {
    let chunk_a = "a".repeat(64);
    let chunk_b = "b".repeat(64);
    let mut cases = Vec::new();

    let mut shape_axes = valid_descriptor(&chunk_a, 16);
    shape_axes.shape = vec![2, 2];
    cases.push(("shape/axes arity", shape_axes));

    let mut duplicate_axes = valid_descriptor(&chunk_a, 16);
    duplicate_axes.shape = vec![2, 2];
    duplicate_axes.logical_axes = vec!["sample".to_string(), "sample".to_string()];
    cases.push(("duplicate axes", duplicate_axes));

    let mut endian = valid_descriptor(&chunk_a, 16);
    endian.endian = "big".to_string();
    cases.push(("endianness", endian));

    let mut gap = valid_descriptor(&chunk_a, 16);
    gap.chunks = vec![
        TensorChunk {
            object_ref: chunk_a.clone(),
            offset: 0,
            length: 8,
            sha256: Some(chunk_a.clone()),
        },
        TensorChunk {
            object_ref: chunk_b.clone(),
            offset: 9,
            length: 8,
            sha256: Some(chunk_b.clone()),
        },
    ];
    cases.push(("coverage gap", gap));

    let mut short_coverage = valid_descriptor(&chunk_a, 16);
    short_coverage.chunks[0].length = 8;
    cases.push(("coverage length", short_coverage));

    let mut hash_mismatch = valid_descriptor(&chunk_a, 16);
    hash_mismatch.chunks[0].sha256 = Some(chunk_b);
    cases.push(("chunk hash", hash_mismatch));

    for (label, descriptor) in cases {
        let bytes = serde_json::to_vec(&descriptor).expect("serialize invalid descriptor");
        let artifact = artifact_for_descriptor(&bytes);
        assert!(
            parse_solution_tensor_artifact(&bytes, &artifact).is_err(),
            "parser accepted {label}"
        );
    }
}

#[test]
fn parser_rejects_root_hash_length_budget_and_chunk_count_errors() {
    let chunk_ref = "a".repeat(64);
    let descriptor = valid_descriptor(&chunk_ref, 16);
    let bytes = serde_json::to_vec(&descriptor).expect("serialize descriptor");
    let valid_artifact = artifact_for_descriptor(&bytes);

    let mut wrong_hash = valid_artifact.clone();
    wrong_hash.object_ref = "f".repeat(64);
    if wrong_hash.object_ref == valid_artifact.object_ref {
        wrong_hash.object_ref = "e".repeat(64);
    }
    assert!(parse_solution_tensor_artifact(&bytes, &wrong_hash).is_err());

    let mut wrong_length = valid_artifact.clone();
    wrong_length.byte_length += 1;
    assert!(parse_solution_tensor_artifact(&bytes, &wrong_length).is_err());

    let mut oversized = valid_artifact.clone();
    oversized.byte_length = MAX_SOLUTION_TENSOR_METADATA_BYTES + 1;
    assert!(parse_solution_tensor_artifact(&bytes, &oversized).is_err());

    let mut too_many_chunks = valid_descriptor(&chunk_ref, 8);
    too_many_chunks.shape = vec![MAX_SOLUTION_TENSOR_CHUNKS + 1];
    too_many_chunks.chunks = (0..=MAX_SOLUTION_TENSOR_CHUNKS)
        .map(|index| TensorChunk {
            object_ref: format!("{index:064x}"),
            offset: index * 8,
            length: 8,
            sha256: None,
        })
        .collect();
    let too_many_bytes = serde_json::to_vec(&too_many_chunks).expect("serialize large descriptor");
    let too_many_artifact = artifact_for_descriptor(&too_many_bytes);
    assert!(parse_solution_tensor_artifact(&too_many_bytes, &too_many_artifact).is_err());
}

#[test]
fn publish_rejects_missing_corrupt_and_length_mismatched_tensor_chunks() {
    for scenario in ["missing", "corrupt", "length"] {
        let directory = tempfile::tempdir().expect("temporary publication store");
        let store = SessionStore::open(directory.path().join("store")).expect("open store");
        let expected_payload = vec![7_u8; 16];
        let chunk_ref = match scenario {
            "missing" => crate::hex_sha256(b"missing tensor chunk"),
            "corrupt" => {
                let object_ref = store
                    .cas()
                    .put(&expected_payload)
                    .expect("publish chunk before corruption");
                fs::write(
                    store.root().join("objects/sha256").join(&object_ref),
                    b"corrupted",
                )
                .expect("corrupt chunk fixture");
                object_ref
            }
            "length" => store
                .cas()
                .put(&vec![7_u8; 8])
                .expect("publish short chunk"),
            _ => unreachable!(),
        };
        let intent = FmsRunIntent::new(
            "run-tensor",
            "intent-tensor-payload-check",
            json!({
                "run_id": "run-tensor",
                "solver": "payload-check"
            }),
        );
        store
            .commit_run_intent(&intent)
            .expect("publish tensor payload owner intent");
        let descriptor = valid_descriptor(&chunk_ref, expected_payload.len());
        let descriptor_bytes = serde_json::to_vec(&descriptor).expect("serialize descriptor");
        store
            .cas()
            .put(&descriptor_bytes)
            .expect("publish descriptor");
        let artifact = artifact_for_descriptor(&descriptor_bytes);
        let solution = tensor_solution(
            "run-tensor",
            "solution-tensor",
            format!("sha256:{}", intent.payload_sha256),
            artifact,
        );

        let result = store.publish_solution_set(&solution);
        assert!(result.is_err(), "accepted {scenario} tensor chunk");
        assert!(store
            .solution_sets()
            .read(&solution.solution_set_id)
            .expect("read unpublished solution")
            .is_none());
    }
}

#[test]
fn pinned_resolver_enforces_owner_revision_member_and_artifact_fences() {
    let fixture = published_tensor_fixture();
    let source = PinnedSolutionTensorSource {
        run_id: "run-tensor".to_string(),
        solution_set_id: fixture.solution.solution_set_id.clone(),
        solution_revision: fixture.solution.revision,
        member_id: "member-tensor".to_string(),
        artifact_id: fixture.artifact.artifact_id.clone(),
        tensor_object_ref: fixture.artifact.object_ref.clone(),
        run_spec_digest: fixture.run_spec_digest.clone(),
    };

    let resolved = resolve_solution_tensor(&fixture.store, &source).expect("resolve tensor owner");
    assert_eq!(resolved.artifact.object_ref, fixture.artifact.object_ref);
    assert_eq!(resolved.tensor.chunks[0].object_ref, fixture.chunk_ref);
    assert_eq!(resolved.execution_status, fixture.solution.execution_status);
    assert_eq!(
        resolved.scientific_assessment,
        fixture.solution.scientific_assessment
    );
    assert_eq!(
        resolved.member_scientific_assessment,
        fixture.solution.members[0].scientific_assessment
    );
    assert_eq!(resolved.accepted_state, fixture.artifact.accepted_state);

    let mut owner_mismatch = source.clone();
    owner_mismatch.run_spec_digest = digest('a');
    if owner_mismatch.run_spec_digest == source.run_spec_digest {
        owner_mismatch.run_spec_digest = digest('b');
    }
    assert!(resolve_solution_tensor(&fixture.store, &owner_mismatch).is_err());

    let mut wrong_revision = source.clone();
    wrong_revision.solution_revision = 2;
    assert!(resolve_solution_tensor(&fixture.store, &wrong_revision).is_err());

    let mut wrong_member = source.clone();
    wrong_member.member_id = "member-foreign".to_string();
    assert!(resolve_solution_tensor(&fixture.store, &wrong_member).is_err());

    let mut wrong_artifact = source.clone();
    wrong_artifact.tensor_object_ref = "f".repeat(64);
    if wrong_artifact.tensor_object_ref == source.tensor_object_ref {
        wrong_artifact.tensor_object_ref = "e".repeat(64);
    }
    assert!(resolve_solution_tensor(&fixture.store, &wrong_artifact).is_err());
    assert_eq!(
        fixture
            .store
            .solution_sets()
            .read(&fixture.solution.solution_set_id)
            .expect("read published solution after fence failures"),
        Some(fixture.solution.clone())
    );
}

#[test]
fn store_and_archive_solution_walkers_retain_tensor_chunks_from_root_only() {
    let fixture = published_tensor_fixture();
    let store_report = walk_store_root(fixture.store.root(), ReachabilityMode::Gc)
        .expect("walk published tensor store");
    assert!(store_report
        .object_refs
        .contains(&fixture.artifact.object_ref));
    assert!(store_report.object_refs.contains(&fixture.chunk_ref));

    let solution_directory = crate::hex_sha256(fixture.solution.solution_set_id.as_bytes());
    let solution_path = format!("solutions/{solution_directory}/manifest.json");
    let revision_path = format!(
        "solutions/{solution_directory}/revisions/{:020}.json",
        fixture.solution.revision
    );
    let root_path = format!("objects/sha256/{}", fixture.artifact.object_ref);
    let chunk_path = format!("objects/sha256/{}", fixture.chunk_ref);
    let solution_bytes =
        serde_json::to_vec(&fixture.solution).expect("serialize solution manifest");
    let documents = HashMap::from([
        (solution_path, solution_bytes.clone()),
        (revision_path, solution_bytes),
        (
            "runs/run-tensor/run_intent.json".to_string(),
            fs::read(fixture.store.root().join("runs/run-tensor/run_intent.json"))
                .expect("read owner intent"),
        ),
        (root_path, fixture.descriptor_bytes.clone()),
        (chunk_path.clone(), fixture.chunk_bytes.clone()),
    ]);
    let archive_report = walk_archive_documents(&documents, ReachabilityMode::Restore)
        .expect("walk archived tensor solution");
    assert!(archive_report
        .object_refs
        .contains(&fixture.artifact.object_ref));
    assert!(archive_report.object_refs.contains(&fixture.chunk_ref));

    let mut missing_owner = documents.clone();
    missing_owner.remove("runs/run-tensor/run_intent.json");
    assert!(walk_archive_documents(&missing_owner, ReachabilityMode::Restore).is_err());
    let mut foreign_owner = documents.clone();
    let other = FmsRunIntent::new(
        "run-tensor",
        "intent-foreign",
        json!({"run_id":"run-tensor", "solver":"foreign"}),
    );
    foreign_owner.insert(
        "runs/run-tensor/run_intent.json".to_string(),
        serde_json::to_vec(&other).unwrap(),
    );
    assert!(walk_archive_documents(&foreign_owner, ReachabilityMode::Restore).is_err());

    let mut missing_chunk = documents.clone();
    missing_chunk.remove(&chunk_path);
    let incomplete = walk_archive_documents(&missing_chunk, ReachabilityMode::Restore)
        .expect("restore walk reports missing chunk");
    assert!(!incomplete.complete);
    assert!(walk_archive_documents(&missing_chunk, ReachabilityMode::Gc).is_err());

    let mut corrupt_chunk = documents;
    corrupt_chunk.insert(chunk_path, b"corrupt archive chunk".to_vec());
    assert!(walk_archive_documents(&corrupt_chunk, ReachabilityMode::Restore).is_err());
}

#[test]
fn missing_typed_owner_blocks_gc_and_writer_reopen_without_erasing_metadata() {
    let fixture = published_tensor_fixture();
    let root = fixture.store.root().to_path_buf();
    fs::remove_file(root.join("runs/run-tensor/run_intent.json")).expect("remove fixture owner");
    assert!(fixture.store.gc_preview().is_err());
    assert!(walk_store_root(&root, ReachabilityMode::Gc).is_err());
    assert_eq!(
        fixture
            .store
            .solution_sets()
            .read_revision(&fixture.solution.solution_set_id, 1)
            .unwrap(),
        Some(fixture.solution)
    );
    assert!(SessionStore::open_existing(&root).is_ok());
    assert!(SessionStore::open(&root).is_err());
}
