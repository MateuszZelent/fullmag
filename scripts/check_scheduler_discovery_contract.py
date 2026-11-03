#!/usr/bin/env python3
"""Source-only scheduler regression; does not compile or qualify Rust runtime."""
from pathlib import Path
from types import SimpleNamespace
import itertools
import re

ROOT = Path(__file__).resolve().parents[1]

def read(relative):
    return (ROOT / relative).read_text()

def section(source, start, end):
    return source.split(start, 1)[1].split(end, 1)[0]

def preparation_predicate(source):
    value = section(source, "if !catalog.tasks.iter().any(|task| {", "}) {")
    value = re.sub(
        r"matches!\(\s*&task.readiness,\s*FmsTaskReadiness::Blocked \{ reason \}\s*"
        r"if reason == FMS_TASK_AWAITING_PREPARATION_REASON\s*\)",
        "(task.readiness == 'blocked' and task.reason == 'awaiting_preparation')", value,
    )
    value = value.replace("FmsTaskLifecycle::Accepted", "'accepted'")
    value = re.sub(r"task\.(\w+)\.is_none\(\)", r"(task.\1 is None)", value)
    return " ".join(value.replace("&&", "and").split())

def main():
    store = read("crates/fullmag-session/src/store.rs")
    compute = read("crates/fullmag-api/src/accepted_scheduler_main.rs")
    supervisor = read("crates/fullmag-api/src/accepted_study_supervisor.rs")
    prepare = read("crates/fullmag-api/src/accepted_fem_preparation_scheduler_main.rs")
    host = read("crates/fullmag-runtime-control/src/host_runtime.rs")
    checks = 0
    discovery = section(store, "pub fn list_run_intent_ids", "/// Enumerate accepted intents")
    for token in ["fs::symlink_metadata(&runs)", "reject_link(&runs)?", "reject_link(&entry.path())?",
                  "entry.file_type()?.is_dir()", "validate_store_id(&run_id)?",
                  "fs::symlink_metadata(&path)", "metadata.is_file()", "reject_link(&path)?"]:
        assert token in discovery, token
        checks += 1
    for token in ["fs::read(", "serde_json", "intent.validate", "write_transaction", "commit_"]:
        assert token not in discovery, token
        checks += 1
    full = section(store, "pub fn list_run_intents", "pub fn read_scheduler_pool_checkpoint")
    assert "intent.validate()?" in full and "serde_json::from_slice" in full
    checks += 1
    queue = section(compute, "fn build_run_queue_snapshot", "#[allow(clippy::too_many_arguments)]")
    assert queue.index("read_run_catalog") < queue.index("read_run_intent") < queue.index("specification\n            .validate()")
    assert queue.index("accepted_run_start_permitted") < queue.index("accepted_run_has_scheduler_ready_task")
    checks += 2
    predicate = section(queue, "if !catalog.tasks.iter().any(|task| {", "}) {")
    states = re.findall(r"fullmag_session::FmsTaskLifecycle::(\w+)", predicate)
    assert states == ["Accepted", "Queued"]
    checks += 1
    for state in ["Accepted", "Queued", "Preparing", "Running", "Stopping", "Succeeded", "Failed", "Cancelled", "Interrupted"]:
        # Broad observational prefilter must retain both admission frontiers;
        # actual readiness remains the canonical helper below it.
        assert (state in states) == (state in ["Accepted", "Queued"])
        checks += 1
    scheduler_loop = section(
        compute, "fn run_scheduler(", "fn build_run_queue_snapshot"
    )
    assert (
        "const ACTIVE_WORKER_EXIT_POLL_INTERVAL: Duration = Duration::from_millis(10);"
        in compute
    )
    assert "idle_poll_interval.min(MAX_ACTIVE_ADMISSION_POLL_INTERVAL)" in compute
    assert (
        "const MAX_ACTIVE_ADMISSION_POLL_INTERVAL: Duration = Duration::from_millis(100);"
        in compute
    )
    gate_start = scheduler_loop.index("let should_run_admission_pass =")
    assert scheduler_loop.index("let draining = shutdown_requested.load") < gate_start
    assert scheduler_loop.index("let finished_resource_id =") < gate_start
    admission_gate = section(
        scheduler_loop,
        "let should_run_admission_pass =",
        "resolve_pending_task_outcomes",
    )
    for token in [
        "active_workers.is_empty()",
        "finished_resource_id.is_some()",
        "drain_reconciliation_pending",
        "Instant::now() >= next_admission_pass_at",
    ]:
        assert token in admission_gate, token
        checks += 1
    assert "if !should_run_admission_pass" in scheduler_loop
    admission_pass = section(
        scheduler_loop,
        "let should_run_admission_pass =",
        "if active_workers.is_empty() {",
    )
    for token in [
        "resolve_pending_task_outcomes",
        "reconcile_tentative_store_admissions",
        "reconcile_released_store_reservations",
        "reconcile_task_cancellations",
        "if args.discover_resources",
        "if args.discover_runs",
        "build_run_queue_snapshot",
        "recover_exited_worker_tasks",
        "schedule_next_ready_accepted_task",
    ]:
        assert token in admission_pass, token
        checks += 1
    assert (
        scheduler_loop.index("let Some(resource_id) = finished_resource_id else")
        > gate_start
    )
    assert "std::thread::sleep(ACTIVE_WORKER_EXIT_POLL_INTERVAL);" in scheduler_loop
    assert "next_admission_pass_at = Instant::now();" in scheduler_loop
    assert "if draining && !drain_observed" in scheduler_loop
    checks += 5
    worker_poll_start = "    loop {\n        if let Some(status) = child.try_wait()"
    worker_poll = worker_poll_start + section(
        supervisor, worker_poll_start, "\n}\n\nfn spawn_output_reader"
    )
    assert worker_poll.index("child.try_wait()") < worker_poll.index("stop_requested()")
    assert "std::thread::sleep(Duration::from_millis(10));" in worker_poll
    checks += 2
    candidates = section(prepare, "fn preparation_candidates", "fn distinct_run_ids")
    assert candidates.index("read_run_catalog") < candidates.index("read_run_intent") < candidates.index("specification\n            .validate()")
    assert "read_task_preparation_receipt" in candidates and "preparation_attempt_authorization_sequence" in candidates
    checks += 2
    expression = preparation_predicate(candidates)
    for state, readiness, reason, attempt, epoch, resource in itertools.product(
            ["accepted", "running", "succeeded"], ["blocked", "ready"],
            ["awaiting_preparation", "dependency"], [None, "attempt"],
            [None, 1], [None, "resource"]):
        task = SimpleNamespace(lifecycle=state, readiness=readiness, reason=reason,
                               attempt_id=attempt, ownership_epoch=epoch, resource_id=resource)
        observed = eval(expression, {"__builtins__": {}}, {"task": task})
        expected = state == "accepted" and readiness == "blocked" and reason == "awaiting_preparation" and attempt is None and epoch is None and resource is None
        assert observed == expected, task
        checks += 1
    cancellations = section(host, "pub fn reconcile_task_cancellations", "pub fn ")
    assert cancellations.index("list_run_intent_ids") < cancellations.index("list_task_cancellation_intents") < cancellations.index("if intents.is_empty()") < cancellations.index("read_run_intent") < cancellations.index("for intent in intents")
    assert "intent.validate_task_scope(store, task, catalog.revision)?" in cancellations
    assert "store.request_task_cancellation_intent(" in cancellations
    checks += 3
    print(
        "PASS: {} source-only scheduler/discovery checks; "
        "Rust build/runtime/performance NOT VERIFIED".format(checks)
    )

if __name__ == "__main__":
    main()
