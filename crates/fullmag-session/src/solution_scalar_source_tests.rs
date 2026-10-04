use std::fs;

use fullmag_quantities::{
    ScientificAssessment, ScientificAssessmentStatus, SolutionArtifactKind, SolutionArtifactRef,
    SolutionExecutionStatus, SolutionMember, SolutionSet, SolutionSetManifestState,
    SolutionSetProvenance, SOLUTION_SET_SCHEMA_VERSION,
};
use serde_json::json;

use crate::solution_scalar_source::{
    read_solution_scalar_artifact, resolve_solution_scalar, PinnedSolutionScalarSource,
    ResolvedSolutionScalar, MAX_SOLUTION_SCALAR_BYTES, SOLUTION_SCALAR_SCHEMA,
};
use crate::{FmsRunIntent, SessionStore};

fn digest(character: char) -> String {
    format!("sha256:{}", character.to_string().repeat(64))
}

fn scalar_bytes() -> Vec<u8> {
    br#"{"schema_version":"study_scalar.v1","quantity_id":"E_total","unit":"J","value_si":-1.25e-18,"step":9007199254740993,"time_s":2e-9}"#.to_vec()
}

fn unassessed() -> ScientificAssessment {
    ScientificAssessment {
        status: ScientificAssessmentStatus::Unassessed,
        reason: Some("test fixture".to_string()),
        evidence_artifact_ids: Vec::new(),
    }
}

fn scalar_solution(
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
            member_id: "member-scalar".to_string(),
            task_id: "task-scalar".to_string(),
            attempt_id: "attempt-scalar".to_string(),
            ownership_epoch: 1,
            case_id: None,
            stage_id: "stage-scalar".to_string(),
            execution_status: SolutionExecutionStatus::Succeeded,
            scientific_assessment: unassessed(),
            artifacts: vec![artifact],
        }],
        coverage: Vec::new(),
    }
}

struct PublishedScalarFixture {
    _directory: tempfile::TempDir,
    store: SessionStore,
    source: PinnedSolutionScalarSource,
    artifact: SolutionArtifactRef,
    bytes: Vec<u8>,
    solution: SolutionSet,
}

fn published_scalar_fixture() -> PublishedScalarFixture {
    let directory = tempfile::tempdir().expect("temporary scalar store");
    let store = SessionStore::open(directory.path().join("store")).expect("open scalar store");
    let intent = FmsRunIntent::new(
        "run-scalar",
        "intent-scalar",
        json!({
            "run_id": "run-scalar",
            "solver": "test"
        }),
    );
    store
        .commit_run_intent(&intent)
        .expect("publish owner run intent");

    let bytes = scalar_bytes();
    let object_ref = store.cas().put(&bytes).expect("publish scalar object");
    let artifact = SolutionArtifactRef {
        artifact_id: "artifact-scalar".to_string(),
        kind: SolutionArtifactKind::Table,
        schema_id: SOLUTION_SCALAR_SCHEMA.to_string(),
        object_ref: object_ref.clone(),
        byte_length: bytes.len() as u64,
        accepted_state: None,
    };
    let run_spec_digest = format!("sha256:{}", intent.payload_sha256);
    let solution = scalar_solution(
        "run-scalar",
        "solution-scalar",
        run_spec_digest.clone(),
        artifact.clone(),
    );
    store
        .publish_solution_set(&solution)
        .expect("publish scalar solution");
    let source = PinnedSolutionScalarSource {
        run_id: "run-scalar".to_string(),
        solution_set_id: "solution-scalar".to_string(),
        solution_revision: 1,
        member_id: "member-scalar".to_string(),
        artifact_id: "artifact-scalar".to_string(),
        scalar_object_ref: object_ref,
        run_spec_digest,
    };
    PublishedScalarFixture {
        _directory: directory,
        store,
        source,
        artifact,
        bytes,
        solution,
    }
}

#[test]
fn resolver_returns_bounded_bytes_and_immutable_owner_states() {
    let fixture = published_scalar_fixture();
    let resolved: ResolvedSolutionScalar =
        resolve_solution_scalar(&fixture.store, &fixture.source).expect("resolve scalar");

    assert_eq!(resolved.bytes, fixture.bytes);
    assert_eq!(resolved.artifact, fixture.artifact);
    assert_eq!(resolved.source, fixture.source);
    assert_eq!(resolved.manifest_state, fixture.solution.manifest_state);
    assert_eq!(resolved.execution_status, fixture.solution.execution_status);
    assert_eq!(
        resolved.member_execution_status,
        fixture.solution.members[0].execution_status
    );
    assert_eq!(resolved.provenance, fixture.solution.provenance);
    assert_eq!(resolved.accepted_state, None);
}

#[test]
fn scalar_schema_constant_matches_persisted_codec_tuple() {
    assert_eq!(SOLUTION_SCALAR_SCHEMA, "fullmag.study.scalar_json@v1");
}

#[test]
fn resolver_rejects_foreign_run_spec_owner() {
    let fixture = published_scalar_fixture();
    let mut source = fixture.source.clone();
    source.run_spec_digest = digest('a');
    assert!(resolve_solution_scalar(&fixture.store, &source).is_err());
}

#[test]
fn resolver_rejects_missing_revision_member_artifact_run_and_object_pin() {
    let fixture = published_scalar_fixture();

    let mut missing_revision = fixture.source.clone();
    missing_revision.solution_revision = 2;
    assert!(resolve_solution_scalar(&fixture.store, &missing_revision).is_err());

    let mut missing_member = fixture.source.clone();
    missing_member.member_id = "member-other".to_string();
    assert!(resolve_solution_scalar(&fixture.store, &missing_member).is_err());

    let mut missing_artifact = fixture.source.clone();
    missing_artifact.artifact_id = "artifact-other".to_string();
    assert!(resolve_solution_scalar(&fixture.store, &missing_artifact).is_err());

    let mut foreign_run = fixture.source.clone();
    foreign_run.run_id = "run-other".to_string();
    assert!(resolve_solution_scalar(&fixture.store, &foreign_run).is_err());

    let mut foreign_object = fixture.source.clone();
    foreign_object.scalar_object_ref = digest('a').trim_start_matches("sha256:").to_string();
    assert!(resolve_solution_scalar(&fixture.store, &foreign_object).is_err());
}

#[test]
fn scalar_boundary_rejects_wrong_kind_schema_and_size_before_read() {
    let fixture = published_scalar_fixture();

    let mut wrong_kind = fixture.artifact.clone();
    wrong_kind.kind = SolutionArtifactKind::State;
    assert!(read_solution_scalar_artifact(&fixture.store, &wrong_kind).is_err());

    let mut wrong_schema = fixture.artifact.clone();
    wrong_schema.schema_id = "study_scalar.v1".to_string();
    assert!(read_solution_scalar_artifact(&fixture.store, &wrong_schema).is_err());

    let mut oversized = fixture.artifact.clone();
    oversized.byte_length = MAX_SOLUTION_SCALAR_BYTES + 1;
    assert!(read_solution_scalar_artifact(&fixture.store, &oversized).is_err());

    let mut wrong_length = fixture.artifact.clone();
    wrong_length.byte_length += 1;
    assert!(read_solution_scalar_artifact(&fixture.store, &wrong_length).is_err());
}

#[test]
fn scalar_boundary_rejects_tampered_cas_bytes() {
    let fixture = published_scalar_fixture();
    let path = fixture
        .store
        .root()
        .join("objects")
        .join("sha256")
        .join(&fixture.artifact.object_ref);
    let mut tampered = fixture.bytes.clone();
    tampered[0] ^= 0xff;
    fs::write(path, tampered).expect("tamper fixture CAS object");
    assert!(resolve_solution_scalar(&fixture.store, &fixture.source).is_err());
}

#[test]
fn scalar_boundary_rejects_actual_cas_object_larger_than_budget() {
    let fixture = published_scalar_fixture();
    let oversized_bytes = vec![b'x'; (MAX_SOLUTION_SCALAR_BYTES + 1) as usize];
    let object_ref = fixture
        .store
        .cas()
        .put(&oversized_bytes)
        .expect("publish oversized scalar fixture");
    let mut artifact = fixture.artifact.clone();
    artifact.object_ref = object_ref;
    artifact.byte_length = MAX_SOLUTION_SCALAR_BYTES;
    assert!(read_solution_scalar_artifact(&fixture.store, &artifact).is_err());
}

#[test]
fn resolver_rejects_oversized_run_owner_before_payload_read() {
    let fixture = published_scalar_fixture();
    let path = fixture
        .store
        .root()
        .join("runs")
        .join("run-scalar")
        .join("run_intent.json");
    let file = fs::OpenOptions::new()
        .write(true)
        .open(path)
        .expect("open owner fixture");
    file.set_len(16 * 1024 * 1024 + 1)
        .expect("oversize owner fixture");
    assert!(resolve_solution_scalar(&fixture.store, &fixture.source).is_err());
}
