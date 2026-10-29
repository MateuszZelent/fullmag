#!/usr/bin/env python3
"""Source-contract regression only; does not replace managed build/HTTP checks."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "crates/fullmag-runtime-control/src"


def region(text, start, end):
    return text.split(start, 1)[1].split(end, 1)[0]


def check():
    integrity = (BASE / "study_inspection_integrity.rs").read_text()
    completion = (BASE / "study.rs").read_text()
    accepted = (BASE / "study_inspection.rs").read_text()
    runner = (ROOT / "crates/fullmag-runner/src/antenna_field_solution/closed_loop_public_inspection.rs").read_text()
    read = region(integrity, "fn read_saved_inspection<T>(", "fn decode_inspection(")
    assert read.count("read_study_task_completion_for_snapshot(") == 1
    assert "decode_inspection(" not in read
    assert "get_bounded(expected_object" not in read
    assert "completion.into_inspection(expected_object)?" in read
    assert "expected_object, false," in integrity
    assert "expected_object, true," in integrity
    assert "task.lifecycle != FmsTaskLifecycle::Succeeded" in read
    assert read.count("exact_attempt(") == 2
    for fence in ["read_transaction()", "load_accepted_study_snapshot(",
                  "study_task_input_fingerprint(", "read_task_preparation(",
                  "recover_coordinator_with_journal(", "WorkerEvent::Completed",
                  "manifests.len() != 1", "outputs.len() != 1",
                  "output.content_sha256 != expected_object"]:
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
    branch = region(complete, "let loaded = if retain_inspection {", "inspections.push(")
    assert branch.count("load_accepted_inspection_bytes(") == 1
    assert branch.count("validate_accepted_inspection_bytes(") == 1
    assert "} else {" in branch
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
    load = region(accepted, "pub(crate) fn load_accepted_inspection_bytes(", "fn with_accepted_inspection_bytes<T>(")
    assert load.count("load_antenna_closed_loop_inspection_bytes(") == 1
    assert "verify_antenna_closed_loop_inspection_bytes(" not in load
    runner_load = region(runner, "pub fn load_antenna_closed_loop_inspection_bytes(", "fn inspection_view(")
    assert runner_load.count("verify_antenna_closed_loop_inspection_bytes(") == 1
    assert runner_load.index("verify_antenna_closed_loop_inspection_bytes(") < runner_load.index("inspection_view(")
    print("PASS: source call graph has one full verifier per retained cold read; durable/CAS fences remain. Runtime NOT VERIFIED.")


if __name__ == "__main__":
    check()
