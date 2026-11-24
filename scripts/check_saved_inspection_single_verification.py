#!/usr/bin/env python3
"""Source-contract regression only; does not replace managed build/HTTP checks."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "crates/fullmag-runtime-control/src"


def region(text, start, end):
    assert start in text, f"missing source boundary: {start}"
    tail = text.split(start, 1)[1]
    assert end in tail, f"missing source boundary after {start}: {end}"
    return tail.split(end, 1)[0]


def check():
    integrity = (BASE / "study_inspection_integrity.rs").read_text()
    completion = (BASE / "study.rs").read_text()
    accepted = (BASE / "study_inspection.rs").read_text()
    runner = (ROOT / "crates/fullmag-runner/src/antenna_field_solution/closed_loop_public_inspection.rs").read_text()
    read = region(integrity, "fn read_saved_inspection_inner<'a, R, T>(", "fn decode_inspection(")
    assert read.count("read_study_task_completion_with_inspection(") == 1
    assert read.count("decode_inspection(&accepted, recovered.coordinator.claim(), problem, step, bytes, maximum)") == 1
    assert read.index("read_study_task_completion_with_inspection(") < read.index("decode_inspection(&accepted") < read.index("completion.into_inspection(")
    assert "get_bounded(expected_object" not in read
    assert "completion.into_inspection(expected_object)?" in read
    verify = region(integrity, "pub fn verify_saved_inspection(", "pub fn load_saved_inspection(")
    load = region(integrity, "pub fn load_saved_inspection(", "pub(crate) fn acquire_inspection_read_transaction(")
    assert "store.read_transaction()" in verify
    assert "expected_object, None, crate::study_inspection::validate_accepted_inspection_bytes" in verify
    assert "acquire_inspection_read_transaction(" in load
    assert "expected_object, None, crate::study_inspection::load_accepted_inspection_bytes" in load
    assert load.index("acquire_inspection_read_transaction(") < load.index("read_saved_inspection(")
    assert "task.lifecycle != FmsTaskLifecycle::Succeeded" in read
    assert read.count("exact_attempt(") == 2
    for fence in ["load_accepted_study_snapshot(",
                  "study_task_input_fingerprint(", "read_task_preparation(",
                  "recover_coordinator_with_journal(", "WorkerEvent::Completed",
                  "manifests.len() != 1", "outputs.len() != 1",
                  "output.content_sha256 != expected_object",
                  "expected_artifact.is_some_and(|artifact_id| output.artifact_id != artifact_id)"]:
        assert fence in read, fence
    complete = region(completion, "pub(crate) fn read_study_task_completion_for_snapshot(",
                      "/// Bind the accepted StepOutput identity")
    for fence in ["read_run_intent(", "accepted.run.intent.study_object_ref.is_none()",
                  "task.attempt_id.as_deref()", "task.ownership_epoch",
                  "artifact_catalog\n        .validate()", "manifests.next().is_some()",
                  "open_published_terminal_manifest(", "manifest.run_id != run_id",
                  "manifest.task_id != task_id", "manifest.step_id != source_step.step_id",
                  "manifest.attempt_id != attempt_id", "manifest.ownership_epoch != ownership_epoch",
                  "entry.study_output.as_ref() == Some(&identity)",
                  "output.object_ref != output.content_sha256", "get_bounded(&output.object_ref",
                  "inspection completion cannot accept solver outputs or state",
                  "decode_study_artifact(", "outside its manifest allow-list",
                  "accepted quantity bundle differs from its manifest state"]:
        assert fence in complete, fence
    default = region(complete, "read_study_task_completion_with_inspection(", "pub(crate) fn read_study_task_completion_with_inspection<T>(")
    assert default.count("load_accepted_inspection_bytes(") == 1
    assert default.count("validate_accepted_inspection_bytes(") == 1
    assert "if retain_inspection {" in default and "} else {" in default
    branch = region(complete, "let loaded = decode_inspection(", "inspections.push(")
    assert branch.count("problem, source_step, &output_bytes, maximum)?") == 1
    assert complete.count("let loaded = decode_inspection(") == 1
    assert complete.rindex("Ok(VerifiedStudyCompletion { inspections })") > complete.rindex("bail!(")
    token = region(completion, "pub(crate) struct VerifiedStudyCompletion", "pub(crate) fn read_study_task_completion_for_snapshot(")
    assert "    inspections:" in token and "pub inspections" not in token
    assert "inspections.next().is_some() || object != expected_object" in token
    helper = region(accepted, "fn with_accepted_inspection_bytes<T>(", "#[cfg(test)]")
    for fence in ["validate_closed_loop_operation(", "decode_antenna_inspection_bundle(",
                  "input.validate_field_policy()", "manifest[\"requested_intent\"]!=expected_intent",
                  "manifest[\"source_object_id\"]!=input.source.object_id",
                  "manifest[\"current_transport_id\"]!=input.stage.current_transport_id"]:
        assert fence in helper, fence
    load = region(accepted, "pub(crate) fn load_accepted_inspection_bytes(", "pub(crate) fn load_accepted_retained_current_source_bytes(")
    assert load.count("load_antenna_closed_loop_inspection_bytes(") == 1
    assert "verify_antenna_closed_loop_inspection_bytes(" not in load
    runner_load = region(runner, "pub fn load_antenna_closed_loop_inspection_bytes(", "fn inspection_view(")
    assert runner_load.count("verify_antenna_closed_loop_inspection_bytes(") == 1
    assert runner_load.index("verify_antenna_closed_loop_inspection_bytes(") < runner_load.index("inspection_view(")
    retained = (ROOT / "crates/fullmag-runner/src/antenna_field_solution/retained_current_execution.rs").read_text()
    parent = (BASE / "study_retained_current.rs").read_text()
    source_load = region(accepted, "pub(crate) fn load_accepted_retained_current_source_bytes(", "fn with_accepted_inspection_bytes<T>(")
    assert source_load.count("with_accepted_inspection_bytes(") == 1
    assert source_load.count("verify_retained_current_source_content(") == 1
    source_verify = region(retained, "pub fn verify_retained_current_source_content(", "pub fn verify_retained_current_parent_content(")
    assert source_verify.count("validate_inspection_envelope(") == 1
    assert source_verify.count("verify_and_decode_source(") == 1
    assert "closed_loop_v2::verify(" not in source_verify
    compatibility = region(retained, "pub fn verify_retained_current_parent_content(", "pub struct ProducedRetainedCurrentField")
    assert compatibility.index("validate_parent_evidence_bytes(") < compatibility.index("verify_retained_current_source_content(")
    bind = region(retained, "pub fn bind_parent(", "pub fn verify_retained_current_source_content(")
    assert "validate_parent_evidence_bytes(" in bind and "bind_source_digests(" in bind
    assert "verify_and_decode_source(" not in bind and "closed_loop_v2::verify(" not in bind
    parent_load = region(parent, "pub fn load_saved_retained_current(", "fn validate_locator_project(")
    assert parent_load.count("read_saved_inspection(") == 1
    assert "Some(artifact_id)" in parent_load
    assert "load_accepted_retained_current_source_bytes" in parent_load
    assert parent_load.index("validate_locator_project(") < parent_load.index("acquire_inspection_read_transaction(")
    assert "    owner: ParentInspectionOwner" in parent and "    content: VerifiedRetainedCurrentSourceContent" in parent
    assert "pub owner:" not in parent and "pub content:" not in parent
    assert read.index("read_study_task_completion_with_inspection(") < read.index("completion.into_inspection(") < read.index("    build(")
    legacy_parent = region(parent, "pub fn load_saved_retained_current(", "fn read_saved_retained_current<'a, T>(")
    assert legacy_parent.count("acquire_inspection_read_transaction(") == 1
    assert legacy_parent.count("read_saved_retained_current(") == 1
    capture = region(parent, "pub fn load_saved_retained_current_with_evidence(", "pub fn load_saved_retained_current_with_store_evidence(")
    assert capture.count("acquire_inspection_read_transaction(") == 1
    assert capture.count("read_saved_retained_current(") == 1
    assert capture.index("validate_locator_project(") < capture.index("validate_evidence_context(") < capture.index("acquire_inspection_read_transaction(")
    assert capture.index("read_saved_retained_current(") < capture.index("capture_parent_evidence(") < capture.index("drop(transaction)")
    store_capture = region(parent, "pub fn load_saved_retained_current_with_store_evidence(", "pub fn load_saved_retained_current_with_pinned_evidence(")
    assert store_capture.count("acquire_inspection_read_transaction(") == 1
    assert store_capture.count("read_saved_retained_current(") == 1
    assert store_capture.index("validate_locator_project(") < store_capture.index("acquire_inspection_read_transaction(")
    assert "accepted_store::store_binding(store.root())" in store_capture
    assert "accepted_run_id: run_id.clone()" in store_capture
    assert "captured_live" not in store_capture and "captured_scene" not in store_capture
    assert store_capture.index("read_saved_retained_current(") < store_capture.index("ParentCaptureContext::Store(&context)") < store_capture.index("drop(transaction)")
    closure = region(parent, "fn capture_parent_evidence(", "fn validate_locator_project(")
    for fence in ["plan_accepted_provenance_with_record_budget(", "MAX_RECORD_BYTES_TOTAL",
                  "plan.read_record(record)", "validate_detached_records_with_exact_cas_and_ranges(",
                  "required typed metadata CAS is missing", "validate_parent_closure_owner(",
                  "bind_closed_inspection_preparation(", "task != read.task",
                  "*packages[0] != read.artifact", "*outputs[0] != read.output_manifest",
                  "item.codec_id != PARENT_CODEC_ID", "output.accepted_state_ref.is_some()",
                  "output.observation_source.is_some()", "bounded_metadata_bytes("]:
        assert fence in closure, fence
    assert "plan_accepted_store_provenance_with_record_budget(" in closure
    assert "AcceptedEvidenceManifest::from_bytes(&manifest_bytes)" in parent
    assert "Ok(None)" not in closure
    for mutation in [".put(", ".put_bounded(", "write_transaction(", "claim_task("]:
        assert mutation not in closure and mutation not in capture, mutation
    pinned = region(parent, "pub fn load_saved_retained_current_with_pinned_evidence(", "pub(crate) fn load_pinned_retained_current_for_publication(")
    assert pinned.count("acquire_inspection_read_transaction(") == 1
    assert pinned.count("read_pinned_retained_current(") == 1
    assert pinned.index("validate_pinned_parent_locator(") < pinned.index("acquire_inspection_read_transaction(")
    assert pinned.index("read_pinned_retained_current(") < pinned.index("drop(transaction)")
    exclusive = region(parent, "pub(crate) fn load_pinned_retained_current_for_publication(", "fn validate_pinned_parent_locator(")
    assert "let transaction = store.write_transaction()?" in exclusive
    assert "acquire_inspection_read_transaction(" not in exclusive
    assert exclusive.index("store.write_transaction()?") < exclusive.index("read_pinned_retained_current(") < exclusive.index("drop(transaction)")
    pinned_common = region(parent, "fn read_pinned_retained_current<'a>(", "fn read_pinned_parent_evidence(")
    assert pinned_common.count("read_saved_retained_current(") == 1
    for fence in ["loaded.owner() != &expected_parent.owner", "loaded.source_digests() != expected_parent.source",
                  "loaded.content.bind_parent(expected_parent, capsule_bytes)"]:
        assert fence in pinned_common, fence
    pinned_read = region(parent, "fn read_pinned_parent_evidence(", "fn validate_evidence_context(")
    for fence in ["validate_parent_evidence_bytes(", "validate_pinned_record_set(",
                  "validate_detached_records_with_exact_cas_and_ranges(", ".verified_length(",
                  "bytes != object.byte_count", "validate_parent_closure_owner(",
                  "manifest.source_store_binding() !=", "read_parent_metadata_object(",
                  "Sha256::digest(&bytes)"]:
        assert fence in pinned_read, fence
    assert "plan_accepted_provenance" not in pinned_read and "capture_parent_evidence(" not in pinned_read
    assert "&bound_preparation != current_preparation" in closure
    for mutation in [".put(", ".put_bounded(", "write_transaction(", "claim_task("]:
        assert mutation not in pinned and mutation not in pinned_read and mutation not in pinned_common, mutation
    legacy_cold = region(integrity, "pub(crate) fn read_saved_inspection<'a, R, T>(", "pub(crate) fn read_saved_retained_field_inspection<'a, R, T>(")
    child_cold = region(integrity, "pub(crate) fn read_saved_retained_field_inspection<'a, R, T>(", "enum SavedInspectionContract")
    assert "SavedInspectionContract::ClosedLoop" in legacy_cold and "SavedInspectionContract::RetainedField" not in legacy_cold
    assert "SavedInspectionContract::RetainedField" in child_cold and "SavedInspectionContract::ClosedLoop" not in child_cold
    assert "SavedInspectionFence::Exclusive(_transaction)" in read
    assert "store.read_coordinator_journal(run.as_str())" in read
    assert "fullmag_application::AcceptedPreparationReceipt::ClosedLoop(current_preparation) = read.preparation" in closure
    field = (BASE / "study_retained_current_field.rs").read_text()
    cold = region(field, "pub fn load_saved_retained_current_field_inspection(", "|evidence, bundle, _|")
    assert cold.count("acquire_inspection_read_transaction(") == 1
    assert cold.count("read_saved_retained_field_inspection(") == 1
    assert cold.count("validate_retained_current_completion_output(") == 1
    preparer = (ROOT / "crates/fullmag-api/src/accepted_fem_preparer.rs").read_text()
    retained_prepare = region(preparer, "fn prepare_retained_current_task(", "/// Upper bound for the field values")
    for fence in ["bind_retained_current_preparation(", "load_saved_retained_current_with_pinned_evidence(",
                  "load_saved_retained_current_with_store_evidence(", "validate_source_intent(",
                  "RetainedCurrentPreparationReceipt::ready(", "commit_task_preparation_receipt_with_preparation_lease(",
                  "verified.validate_for(", "actual != expected"]:
        assert fence in retained_prepare, fence
    assert retained_prepare.index("load_saved_retained_current_with_store_evidence(") < retained_prepare.index("store.cas().put(bytes)")
    for forbidden in ["produce_native_fem_evidence(", "publish_prepared_observation(", "native_prepare_fem_mesh_space(", "parameters", "captured_live"]:
        assert forbidden not in retained_prepare, forbidden
    print("PASS: one physical source verifier per HTTP/H-only reader; pinned historical evidence uses exact typed CAS closure and current owner/preparation under the same read fence. New pinned runtime NOT VERIFIED.")


if __name__ == "__main__":
    check()
