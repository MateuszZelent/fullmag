use super::*;
use fullmag_application::{ResourceBudget, ResourceKind, ResourceLease, RunId, TaskRecord};
use serde_json::json;

fn analysis_outputs(identity: &WorkerExecutionReceiptIdentity) -> Vec<StudyOutputPayload> {
    let owner = json!({
        "session_id":"session-fr", "run_id":identity.claim.run_id.as_str(),
        "task_id":identity.claim.task_id.as_str(), "stage_id":"stage-fr",
        "scope_id":"scope:driven-response", "runtime_id":"runtime:fr:attempt",
        "attempt_id":identity.claim.attempt_id.as_str(),
        "ownership_epoch":identity.claim.ownership_epoch.value(),
        "case_id":identity.case_id, "plan_fingerprint":format!("sha256:{}",identity.plan_fingerprint),
        "topology_fingerprint":format!("sha256:{}","d".repeat(64)),
        "equilibrium_sha256":"e".repeat(64), "equilibrium_verified":false,
    });
    let encode = |point: bool, points: serde_json::Value| {
        let path = if point {
            "response/points/0/values.bin"
        } else {
            "frequency_domain/manifest.v1.json"
        };
        let files = BTreeMap::from([(path.into(), vec![1_u8])]);
        let manifest = json!({
            "schema_version":if point {"fullmag.fem.driven_response_point.v1"} else {"fullmag.fem.driven_response_index.v1"},
            "status":"complete", "study_product":"driven_response", "identity":owner,
            "frequency_count":1, "payloads":BTreeMap::from([(path,json!({
                "byte_length":1,"sha256":fullmag_application::study_artifact_content_sha256(&[1]),
                "role":if point {"field_values"} else {"native_metadata"}}))]),
            "native_metadata":{},
            "point":if point {json!({"index":0,"frequency_hz":1e9,
                "port_id":"response-frequency-000000","converged":true,
                "relative_residual_l2":1e-10,"solver_relative_tolerance":1e-8})} else {json!(null)},
            "points":points,
        });
        let bytes = serde_json::to_vec(&manifest).unwrap();
        if point {
            fullmag_application::encode_frequency_response_point_bundle(&bytes, &files, 1 << 20)
        } else {
            fullmag_application::encode_frequency_response_index_bundle(&bytes, &files, 1 << 20)
        }
        .unwrap()
    };
    let point = encode(true, json!([]));
    let index = encode(
        false,
        json!([{"index":0,"frequency_hz":1e9,
        "port_id":"response-frequency-000000",
        "bundle_sha256":fullmag_application::study_artifact_content_sha256(&point)}]),
    );
    [
        (
            "response",
            fullmag_application::FREQUENCY_RESPONSE_INDEX_CODEC_ID,
            index,
        ),
        (
            "response-frequency-000000",
            fullmag_application::FREQUENCY_RESPONSE_POINT_CODEC_ID,
            point,
        ),
    ]
    .into_iter()
    .map(|(port_id, codec_id, bytes)| StudyOutputPayload {
        port_id: port_id.into(),
        case_id: identity.case_id.clone(),
        codec_id: codec_id.into(),
        codec_version: "v1".into(),
        bytes,
    })
    .collect()
}

#[test]
fn response_receipt_reopens_typed_cas_outputs_without_an_accepted_state() {
    let directory = tempfile::tempdir().unwrap();
    let store = SessionStore::open(directory.path().join("store")).unwrap();
    let mut task =
        TaskRecord::new(RunId::parse("run-fr-receipt").unwrap(), "a".repeat(64)).unwrap();
    task.queue().unwrap();
    let claim = task
        .claim(
            ResourceLease::new(
                "gpu-fr",
                ResourceKind::Gpu,
                ResourceBudget {
                    cpu_millis: 1000,
                    memory_bytes: 1 << 20,
                    gpu_memory_bytes: 1 << 20,
                    storage_bytes: 1 << 20,
                },
            )
            .unwrap(),
        )
        .unwrap();
    let identity = WorkerExecutionReceiptIdentity {
        schema_version: WORKER_EXECUTION_RECEIPT_SCHEMA.into(),
        claim,
        start_message_id: "start-fr".into(),
        start_sequence: 1,
        case_id: "physical-case".into(),
        plan_fingerprint: "c".repeat(64),
    };
    let outputs = analysis_outputs(&identity);
    let ports = outputs
        .iter()
        .map(|o| StudyOutputPort {
            port_id: o.port_id.clone(),
            data_kind: StudyPortDataKind::Artifact,
        })
        .collect::<Vec<_>>();
    let attempt = directory.path().join("attempt");
    fs::create_dir(&attempt).unwrap();
    write_immutable_attempt_receipt(
        &attempt,
        WORKER_EXECUTION_STARTED_RECEIPT,
        &WorkerExecutionStartedReceipt {
            identity: identity.clone(),
        },
    )
    .unwrap();
    persist_completed_worker_execution(
        &store,
        &attempt,
        &identity,
        &ports,
        RunStatus::Completed,
        1,
        &outputs,
        None,
        None,
        None,
        None,
    )
    .unwrap();
    let recovered = recover_completed_worker_execution(
        &store,
        &attempt,
        &identity,
        &ports,
        1 << 20,
        None,
        None,
    )
    .unwrap();
    assert!(recovered.recovered_from_receipt);
    assert!(recovered.accepted_state_ref.is_none());
    assert!(recovered.observation_source.is_none());
    assert!(recovered.terminal_stats.is_none());
    assert_eq!(recovered.completed_step_count, 1);
    for (a, b) in recovered.outputs.iter().zip(&outputs) {
        assert_eq!(a.bytes, b.bytes);
        assert_eq!(a.case_id, "physical-case");
    }
    let other = directory.path().join("other");
    fs::create_dir(&other).unwrap();
    let mut wrong = analysis_outputs(&identity);
    wrong[1].case_id = "frequency-as-case".into();
    assert!(persist_completed_worker_execution(
        &store,
        &other,
        &identity,
        &ports,
        RunStatus::Completed,
        1,
        &wrong,
        None,
        None,
        None,
        None
    )
    .is_err());
}
