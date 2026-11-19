#!/usr/bin/env python3
"""Run two pinned Rust unit-test filters in an existing claimed-runtime backend.

This focused check never builds or publishes a backend package and never
starts or solves a runtime. Cargo runs only in the selected fixed backend,
under the existing BuildControl operation and runtime/claimed-store locks.
"""

from __future__ import annotations

import argparse
import hashlib
import inspect
import json
from pathlib import Path
import re
import subprocess
import sys
from typing import Any, Mapping

from docker_build_control import (
    BuildControl,
    BuildControlError,
    ControlOutcomeUnknown,
    canonical,
    docker_capture,
    mirror_console,
)
from docker_compose_identity import validate_source_labels
from docker_dev_host import docker_argv

import docker_dev_recovery_build as recovery_build


RESULT_SCHEMA = "fullmag.claimed-runtime-focused-checks.v1"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
CONTAINER_ID_RE = re.compile(r"^[0-9a-f]{64}$")
IMAGE_ID_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
CLAIMED_PIN_RE = re.compile(r"^verification/claimed-interruption/[0-9a-f]{32}/build-pin\.json$")
CANDIDATE_RE = re.compile(r"^\.backend-package-candidate-[A-Za-z0-9._-]+$")
MAX_TEST_OUTPUT_TAIL_BYTES = 1024 * 1024
MAX_RECORDED_TESTS = 128
TEST_COMMAND_REQUIREMENTS = (("claimed_interruption", 6), ("claimed_worker_interruption::tests", 2))

# These are deliberately data constants. No command string or Cargo argument
# is accepted from the caller.
CARGO_TEST_COMMANDS: tuple[tuple[str, ...], ...] = (
    (
        "cargo", "test", "--locked", "--profile", "backend-dev",
        "-p", "fullmag-session", "--lib", "claimed_interruption",
        "--", "--test-threads=1",
    ),
    (
        "cargo", "test", "--locked", "--profile", "backend-dev",
        "-p", "fullmag-api", "--bin", "fullmag-runtime-service",
        "claimed_worker_interruption::tests", "--", "--test-threads=1",
    ),
)


def parse_test_harness_tail(output: bytes, command_index: int) -> dict[str, Any]:
    """Parse bounded Rust test output and reject zero-test or wrong-filter passes."""

    require(isinstance(output, bytes), "Cargo test output tail must be bytes")
    require(len(output) <= MAX_TEST_OUTPUT_TAIL_BYTES, "Cargo test output tail exceeds its memory bound")
    require(command_index in (0, 1), "Cargo test command index is invalid")
    marker, minimum = TEST_COMMAND_REQUIREMENTS[command_index]
    test_line = re.compile(r"^test\s+(\S+)\s+\.\.\.\s+(ok|FAILED|ignored)\s*$")
    summary_line = re.compile(
        r"^test result: (?:ok|FAILED)\.\s+(\d+) passed;\s+(\d+) failed;\s+"
        r"(\d+) ignored;\s+(\d+) measured;\s+(\d+) filtered out;\s+finished in \S+$"
    )
    counts = {"passed": 0, "failed": 0, "ignored": 0}
    records: list[dict[str, str]] = []
    test_line_count = 0
    unexpected = 0
    summaries: list[dict[str, int]] = []
    for raw_line in output.decode("utf-8", "replace").splitlines():
        line = raw_line.strip()
        match = test_line.fullmatch(line)
        if match:
            test_line_count += 1
            name, status = match.groups()
            key = {"ok": "passed", "FAILED": "failed", "ignored": "ignored"}[status]
            counts[key] += 1
            if marker not in name:
                unexpected += 1
            if len(records) < MAX_RECORDED_TESTS:
                records.append({"name": name, "status": status})
            continue
        summary_match = summary_line.fullmatch(line)
        if summary_match:
            passed, failed, ignored, measured, filtered = map(int, summary_match.groups())
            summaries.append({
                "passed": passed,
                "failed": failed,
                "ignored": ignored,
                "measured": measured,
                "filtered_out": filtered,
            })

    errors: list[str] = []
    summary = summaries[0] if len(summaries) == 1 else None
    if summary is None:
        errors.append("expected exactly one Rust test harness summary")
    else:
        if summary["passed"] < minimum:
            errors.append(f"expected at least {minimum} passing tests for fixed filter")
        if summary["failed"] != 0:
            errors.append("Rust test harness reported failed tests")
        if summary["ignored"] != 0:
            errors.append("Rust test harness reported ignored tests")
        if sum(summary[key] for key in ("passed", "failed", "ignored")) != test_line_count:
            errors.append("Rust test lines differ from harness totals")
        if counts != {key: summary[key] for key in counts}:
            errors.append("Rust test line statuses differ from harness totals")
    if unexpected:
        errors.append("Rust test output contains a name outside the fixed filter")
    return {
        "test_summary": summary,
        "test_output_counts": counts,
        "test_line_count": test_line_count,
        "unexpected_test_line_count": unexpected,
        "test_records": records,
        "gate_error": "; ".join(errors) if errors else None,
    }


def require(condition: object, message: str) -> None:
    if not condition:
        raise BuildControlError(message)


def _is_sha(value: object) -> bool:
    return isinstance(value, str) and SHA256_RE.fullmatch(value) is not None


def candidate_inventory_sha256(artifacts: list[object]) -> str:
    """Match backend_dev._canonical, which terminates canonical JSON with LF."""

    return hashlib.sha256(canonical(artifacts) + b"\n").hexdigest()


def _expected_identity(args: argparse.Namespace, source_root: Path, project: str) -> dict[str, str]:
    return {
        "source_root": str(source_root),
        "compose_project": project,
        "backend_container_id": args.backend_container_id,
        "image_id": args.image_id,
        "candidate_basename": args.candidate_basename,
        "candidate_receipt_sha256": args.candidate_receipt_sha256,
    }


def validate_execution_result(
    process_exit_code: int,
    value: object,
    expected_identity: Mapping[str, str],
) -> dict[str, Any]:
    """Accept only acknowledged, stable results; unknown process state is retained."""

    if type(process_exit_code) is not int or process_exit_code not in {0, 42, 44}:
        raise ControlOutcomeUnknown(
            "Focused-check container process/transport outcome is unknown; managed lease retained"
        )
    require(isinstance(value, dict), "Focused-check result is not an object")
    result = value
    required = {
        "schema", "state", "identity", "runtime_evidence_before_sha256",
        "runtime_evidence_after_sha256", "workspace_source_before_sha256",
        "workspace_source_after_sha256", "source_manifest_sha256",
        "source_manifest_live_sha256", "workspace_source_file_count",
        "workspace_source_directory_count",
        "candidate_native_source_identity_sha256", "candidate_inventory_sha256",
        "candidate_artifact_count", "candidate_source", "candidate_artifacts",
        "commands", "runtime_qualification",
    }
    optional = {"refusal_reason"}
    require(set(result) in (required, required | optional), "Focused-check result fields differ")
    require(result["schema"] == RESULT_SCHEMA, "Focused-check result schema differs")
    require(result["identity"] == dict(expected_identity), "Focused-check result identity differs")
    require(result["runtime_qualification"] == "NOT VERIFIED",
            "Focused Rust unit checks cannot qualify runtime behavior")

    runtime_before = result["runtime_evidence_before_sha256"]
    runtime_after = result["runtime_evidence_after_sha256"]
    require(_is_sha(runtime_before) and _is_sha(runtime_after),
            "Focused-check runtime evidence digest is invalid")
    if runtime_before != runtime_after:
        raise ControlOutcomeUnknown("Runtime/ledger evidence changed during focused checks; managed lease retained")

    state = result["state"]
    commands = result["commands"]
    if process_exit_code == 42:
        require(state == "refused-before-tests" and commands == [],
                "Exit 42 is not an exact pre-test refusal")
        workspace_before = result["workspace_source_before_sha256"]
        workspace_after = result["workspace_source_after_sha256"]
        require((workspace_before is None and workspace_after is None)
                or (_is_sha(workspace_before) and workspace_before == workspace_after),
                "Pre-test refusal has changed or invalid workspace evidence")
        require(result["source_manifest_sha256"] is None
                and result["source_manifest_live_sha256"] is None
                and result["workspace_source_file_count"] == 0
                and result["workspace_source_directory_count"] == 0
                and result["candidate_native_source_identity_sha256"] is None
                and result["candidate_inventory_sha256"] is None
                and result["candidate_source"] is None
                and result["candidate_artifacts"] == []
                and result["candidate_artifact_count"] == 0,
                "Pre-test refusal unexpectedly claims candidate validation")
        require(isinstance(result.get("refusal_reason"), str)
                and bool(result["refusal_reason"].strip()),
                "Pre-test refusal has no reason")
        return result

    if process_exit_code == 0:
        require(state == "passed", "Exit 0 is not an exact passing result")
    else:
        require(state == "tests-failed-known", "Exit 44 is not an exact known test failure")

    for field in (
        "source_manifest_sha256", "source_manifest_live_sha256",
        "candidate_native_source_identity_sha256",
        "candidate_inventory_sha256",
    ):
        require(_is_sha(result[field]), "Focused-check result digest is invalid: " + field)
    for field in ("workspace_source_file_count", "workspace_source_directory_count"):
        require(type(result[field]) is int and result[field] >= 0,
                "Focused-check workspace inventory count is invalid: " + field)
    workspace_before = result["workspace_source_before_sha256"]
    workspace_after = result["workspace_source_after_sha256"]
    require(_is_sha(workspace_before) and _is_sha(workspace_after),
            "Focused-check workspace source digest is invalid")
    if workspace_before != workspace_after:
        raise ControlOutcomeUnknown("Captured source workspace changed during checks; managed lease retained")

    candidate_source = result["candidate_source"]
    artifacts = result["candidate_artifacts"]
    require(isinstance(candidate_source, dict) and isinstance(artifacts, list)
            and len(artifacts) == result["candidate_artifact_count"]
            and len(artifacts) > 0,
            "Focused-check candidate source/artifact inventory is incomplete")
    require(candidate_source.get("manifest_sha256") == result["source_manifest_sha256"],
            "Candidate receipt and current source manifest differ")
    require(candidate_inventory_sha256(artifacts) == result["candidate_inventory_sha256"],
            "Focused-check candidate artifact inventory digest differs")
    if not isinstance(commands, list) or len(commands) != len(CARGO_TEST_COMMANDS):
        raise ControlOutcomeUnknown("Focused-check command inventory is incomplete; managed lease retained")
    codes: list[int] = []
    gate_errors: list[str] = []
    for index, (record, expected_argv) in enumerate(zip(commands, CARGO_TEST_COMMANDS)):
        required_command_fields = {
            "argv", "exit_code", "process_started", "wait_observed",
            "test_summary", "test_output_counts", "test_line_count",
            "unexpected_test_line_count", "test_records", "gate_error",
        }
        require(isinstance(record, dict)
                and set(record) in (required_command_fields, required_command_fields | {"spawn_error"})
                and record["argv"] == list(expected_argv),
                f"Focused-check command {index} differs from the fixed argv")
        code = record["exit_code"]
        require(type(code) is int and -255 <= code <= 255,
                f"Focused-check command {index} has no known integer exit")
        started = record["process_started"]
        waited = record["wait_observed"]
        require(type(started) is bool and type(waited) is bool,
                f"Focused-check command {index} process evidence is invalid")
        summary = record["test_summary"]
        counts = record["test_output_counts"]
        test_records = record["test_records"]
        test_line_count = record["test_line_count"]
        unexpected_count = record["unexpected_test_line_count"]
        gate_error = record["gate_error"]
        require(isinstance(counts, dict) and set(counts) == {"passed", "failed", "ignored"}
                and all(type(counts[key]) is int and counts[key] >= 0 for key in counts),
                f"Focused-check command {index} test-line counts are invalid")
        require(type(test_line_count) is int and test_line_count >= 0
                and type(unexpected_count) is int and 0 <= unexpected_count <= test_line_count
                and isinstance(test_records, list)
                and len(test_records) == min(test_line_count, MAX_RECORDED_TESTS),
                f"Focused-check command {index} bounded test inventory is invalid")
        require(gate_error is None or isinstance(gate_error, str) and bool(gate_error.strip()),
                f"Focused-check command {index} gate error is malformed")
        if summary is not None:
            require(isinstance(summary, dict)
                    and set(summary) == {"passed", "failed", "ignored", "measured", "filtered_out"}
                    and all(type(summary[key]) is int and summary[key] >= 0 for key in summary),
                    f"Focused-check command {index} harness summary is invalid")
        for test in test_records:
            require(isinstance(test, dict) and set(test) == {"name", "status"}
                    and isinstance(test["name"], str) and bool(test["name"])
                    and test["status"] in {"ok", "FAILED", "ignored"},
                    f"Focused-check command {index} test case record is invalid")
        if gate_error is not None:
            gate_errors.append(gate_error)
        if started:
            require(waited and "spawn_error" not in record,
                    f"Focused-check command {index} process wait is unknown")
            if summary is None:
                require(gate_error is not None,
                        f"Focused-check command {index} is missing a harness summary without a gate error")
        else:
            require(not waited and code == 127 and isinstance(record.get("spawn_error"), str)
                    and bool(record["spawn_error"]) and summary is None
                    and test_line_count == 0 and not test_records and gate_error is not None,
                    f"Focused-check command {index} spawn failure is not bounded")
        if code == 0 and gate_error is None:
            marker, minimum = TEST_COMMAND_REQUIREMENTS[index]
            require(started and summary is not None
                    and summary["passed"] >= minimum and summary["failed"] == 0
                    and summary["ignored"] == 0
                    and test_line_count == summary["passed"] + summary["failed"] + summary["ignored"]
                    and counts == {key: summary[key] for key in counts}
                    and unexpected_count == 0
                    and counts["passed"] == summary["passed"]
                    and all(marker in test["name"] and test["status"] == "ok" for test in test_records),
                    f"Focused-check command {index} did not run the required passing filtered tests")
        elif code == 0:
            require(process_exit_code == 44 and state == "tests-failed-known",
                    f"Focused-check command {index} has a failed count gate but is labeled passing")
        codes.append(code)

    if process_exit_code == 0:
        require(codes == [0, 0] and not gate_errors,
                "Passing result contains a nonzero Cargo exit or failed test-count gate")
    else:
        require(any(code != 0 for code in codes) or bool(gate_errors),
                "Known-failure result contains no failed Cargo command or test-count gate")
    return result


def inside_code() -> str:
    """Embed the existing recovery evidence/lock runtime without its main call."""

    definitions = (
        "import hashlib, json\nfrom pathlib import Path\nfrom typing import Any\n"
        + f"MAX_TEST_OUTPUT_TAIL_BYTES = {MAX_TEST_OUTPUT_TAIL_BYTES}\n"
        + f"MAX_RECORDED_TESTS = {MAX_RECORDED_TESTS}\n"
        + f"TEST_COMMAND_REQUIREMENTS = {TEST_COMMAND_REQUIREMENTS!r}\n"
        + f"CARGO_TEST_COMMANDS = {CARGO_TEST_COMMANDS!r}\n"
    )
    for function in (
        recovery_build.require,
        recovery_build.validate_terminal,
        recovery_build.validate_diagnostic_build,
        recovery_build.validate_claimed_build_snapshot,
    ):
        definitions += "\n" + inspect.getsource(function)
    definitions += "\n" + inspect.getsource(parse_test_harness_tail)
    return (
        definitions + "\n" + recovery_build.RUNTIME + "\n" + INNER_RUNTIME
        + "\nraise SystemExit(run_claimed_runtime_checks(json.loads(sys.argv[1])))\n"
    )


INNER_RUNTIME = r'''
import backend_source as source_capture


def sha_bytes(data):
    return hashlib.sha256(data).hexdigest()


def canonical_sha(value):
    return sha_bytes(backend._canonical(value))


def read_bounded_regular(path, label, maximum):
    backend._assert_no_links(path, label)
    data, metadata = backend._read_regular(path, label, maximum)
    require(metadata.st_nlink == 1, label + ' must be one regular file')
    return data, metadata


def workspace_source_snapshot(workspace, capsule):
    # Read-only proof against the manifest produced by the candidate build.
    # Never call _prepare_locked, _materialize_source, or capture a new manifest.
    backend._verify_shadow_source(workspace, capsule)
    files, directories = backend._workspace_tree_inventory(workspace)
    records = {}
    for relative, path in sorted(files.items()):
        digest, metadata = backend._sha256_file(
            path, 'captured source workspace ' + relative, backend.MAX_SOURCE_BYTES
        )
        records[relative] = {
            'sha256': digest,
            'size': metadata.st_size,
            'mode': stat.S_IMODE(metadata.st_mode),
        }
    value = {'files': records, 'directories': sorted(directories)}
    return value, canonical_sha(value)


def package_snapshot(root, name, *, current=False):
    receipt, receipt_raw, children = backend._validated_package(
        root,
        name,
        exclude_development_control=current,
        exclude_candidate_marker=not current,
    )
    if current:
        return {'receipt': receipt, 'receipt_raw': receipt_raw, 'children': children}
    marker_path = root / backend.PACKAGE_CANDIDATE_MARKER
    marker_raw, _ = read_bounded_regular(marker_path, 'candidate owner marker', 16 * 1024)
    marker = json.loads(marker_raw)
    artifacts = receipt.get('artifacts')
    require(isinstance(artifacts, list) and bool(artifacts),
            'Candidate artifact inventory is missing')
    require(marker.get('artifact_inventory_sha256') == canonical_sha(artifacts),
            'Ready candidate marker and artifact inventory differ')
    return {
        'receipt': receipt,
        'receipt_raw': receipt_raw,
        'marker_raw': marker_raw,
        'children': children,
    }


def candidate_and_workspace(request, current_package):
    package = backend.PACKAGE_ROOT
    development = package / backend.PACKAGE_DEVELOPMENT_DIRNAME
    candidates_root = development / backend.PACKAGE_CANDIDATES_DIRNAME
    backend._assert_no_links(development, 'package development root')
    backend._assert_no_links(candidates_root, 'package candidates root')
    require(development.is_dir() and candidates_root.is_dir(),
            'Existing backend package candidate namespace is required')
    candidate = candidates_root / request['candidate_basename']
    candidate_entries = tuple(candidates_root.iterdir())
    require(candidate in candidate_entries and candidate.is_dir()
            and all(entry.is_dir() for entry in candidate_entries),
            'Pinned ready candidate is missing or candidate namespace is malformed')
    require(not (development / backend.PACKAGE_ROTATION_JOURNAL_NAME).exists(),
            'Pending package rotation requires its existing recovery')
    marker = backend._validate_candidate_marker(
        candidate, package, Path('/build'), state='ready'
    )
    candidate_snapshot = package_snapshot(candidate, 'pinned candidate package')
    receipt = candidate_snapshot['receipt']
    receipt_raw = candidate_snapshot['receipt_raw']
    receipt_sha = sha_bytes(receipt_raw)
    require(receipt_sha == request['candidate_receipt_sha256'],
            'Candidate receipt SHA-256 differs from the exact CLI pin')
    require(marker.get('cargo_profile') == backend.BACKEND_CARGO_PROFILE
            and receipt.get('build', {}).get('cargo_profile') == backend.BACKEND_CARGO_PROFILE,
            'Candidate does not use the canonical backend-dev Cargo profile')
    native = receipt.get('native_source_identity')
    require(isinstance(native, dict)
            and receipt.get('native_source_identity_sha256') == canonical_sha(native),
            'Candidate native source identity is invalid')
    source = receipt.get('source')
    require(isinstance(source, dict), 'Candidate receipt source identity is missing')

    manifest_path = (Path('/build') / source_capture.LIVE_MANIFEST_DIRNAME
                     / source_capture.LIVE_MANIFEST_FILENAME)
    manifest_raw, _ = read_bounded_regular(
        manifest_path, 'candidate current live-source manifest', source_capture.MAX_MANIFEST_BYTES
    )
    manifest_document = json.loads(manifest_raw)
    capsule, manifest_native, _git_objects, live_manifest_sha = backend._validate_live_manifest(
        manifest_document
    )
    manifest_sha = sha_bytes(manifest_raw)
    require(manifest_document.get('source_root') == '/opt/fullmag/source',
            'Current source manifest is not for the fixed readonly workspace mount')
    require(source.get('source_mode') == backend.LIVE_SOURCE_MODE
            and source.get('manifest_sha256') == manifest_sha
            and source.get('live_manifest_sha256') == live_manifest_sha
            and source.get('source_digest') == capsule.get('source_digest')
            and source.get('resolved_commit') == capsule.get('resolved_commit')
            and source.get('source_snapshot_sha256') == manifest_native.get('source_snapshot_sha256')
            and source.get('runtime_source_digest') == backend._runtime_source_digest(capsule),
            'Candidate receipt does not match the current captured source manifest')
    require(native == manifest_native,
            'Candidate native source identity differs from current captured workspace')

    workspace = Path('/build/workspace')
    backend._assert_no_links(workspace, 'candidate captured source workspace')
    require(workspace.is_dir(), 'Candidate captured source workspace is unavailable')
    owner_path = workspace / backend.OWNER_MARKER
    owner_raw, _ = read_bounded_regular(owner_path, 'candidate workspace owner marker', 16 * 1024)
    owner = json.loads(owner_raw)
    require(owner.get('schema') == 'fullmag.direct-compose.backend-workspace.v1'
            and owner.get('state') == 'ready'
            and owner.get('source_mode') == backend.LIVE_SOURCE_MODE
            and owner.get('source_digest') == capsule.get('source_digest')
            and owner.get('live_manifest_sha256') == live_manifest_sha
            and owner.get('workspace_inventory_schema') == backend.WORKSPACE_INVENTORY_SCHEMA
            and owner.get('workspace_inventory_sha256') == capsule.get('source_digest'),
            'Captured source workspace owner marker differs from the current manifest')
    workspace_value, workspace_sha = workspace_source_snapshot(workspace, capsule)
    return {
        'candidate': candidate,
        'candidate_snapshot': candidate_snapshot,
        'candidate_receipt': receipt,
        'candidate_source': source,
        'candidate_artifacts': receipt['artifacts'],
        'candidate_receipt_sha256': receipt_sha,
        'candidate_inventory_sha256': canonical_sha(receipt['artifacts']),
        'candidate_native_source_identity_sha256': receipt['native_source_identity_sha256'],
        'source_manifest_path': manifest_path,
        'source_manifest_raw': manifest_raw,
        'source_manifest_sha256': manifest_sha,
        'source_manifest_live_sha256': live_manifest_sha,
        'capsule': capsule,
        'native_source_identity': native,
        'workspace': workspace,
        'workspace_owner_raw': owner_raw,
        'workspace_source_value': workspace_value,
        'workspace_source_sha256': workspace_sha,
        'workspace_source_file_count': len(workspace_value['files']),
        'workspace_source_directory_count': len(workspace_value['directories']),
        'current_package_snapshot': current_package,
    }


def current_candidate_workspace_matches(before, request, current_package):
    after_candidate = package_snapshot(
        before['candidate'], 'pinned candidate package after focused checks'
    )
    after_current = package_snapshot(
        backend.PACKAGE_ROOT, 'unchanged current package after focused checks', current=True
    )
    manifest_raw, _ = read_bounded_regular(
        before['source_manifest_path'], 'candidate current live-source manifest after checks',
        source_capture.MAX_MANIFEST_BYTES,
    )
    owner_raw, _ = read_bounded_regular(
        before['workspace'] / backend.OWNER_MARKER,
        'candidate workspace owner marker after checks', 16 * 1024,
    )
    workspace_value, workspace_sha = workspace_source_snapshot(
        before['workspace'], before['capsule']
    )
    return (
        after_candidate == before['candidate_snapshot']
        and after_current == current_package
        and sha_bytes(manifest_raw) == before['source_manifest_sha256']
        and owner_raw == before['workspace_owner_raw']
        and workspace_value == before['workspace_source_value']
        and workspace_sha == before['workspace_source_sha256']
    )


def result_identity(request):
    return {key: request[key] for key in (
        'source_root', 'compose_project', 'backend_container_id', 'image_id',
        'candidate_basename', 'candidate_receipt_sha256',
    )}


def result_record(request, state, runtime_before, runtime_after, *, source=None,
                  commands=None, refusal_reason=None):
    source = source or {}
    record = {
        'schema': 'fullmag.claimed-runtime-focused-checks.v1',
        'state': state,
        'identity': result_identity(request),
        'runtime_evidence_before_sha256': canonical_sha(runtime_before),
        'runtime_evidence_after_sha256': canonical_sha(runtime_after),
        'workspace_source_before_sha256': source.get('workspace_source_sha256'),
        'workspace_source_after_sha256': source.get('workspace_source_sha256'),
        'source_manifest_sha256': source.get('source_manifest_sha256'),
        'source_manifest_live_sha256': source.get('source_manifest_live_sha256'),
        'workspace_source_file_count': source.get('workspace_source_file_count', 0),
        'workspace_source_directory_count': source.get('workspace_source_directory_count', 0),
        'candidate_native_source_identity_sha256': source.get('candidate_native_source_identity_sha256'),
        'candidate_inventory_sha256': source.get('candidate_inventory_sha256'),
        'candidate_artifact_count': len(source.get('candidate_artifacts', [])),
        'candidate_source': source.get('candidate_source'),
        'candidate_artifacts': source.get('candidate_artifacts', []),
        'commands': commands or [],
        'runtime_qualification': 'NOT VERIFIED',
    }
    if refusal_reason is not None:
        record['refusal_reason'] = str(refusal_reason)[:2048]
    return record


def run_claimed_runtime_checks(request):
    require(isinstance(request, dict), 'Focused-check request is not an object')
    require(os.environ.get('FULLMAG_COMPOSE_PROJECT') == request.get('compose_project'),
            'Selected Compose project differs')
    require(os.environ.get('FULLMAG_SOURCE_HOST_ROOT') == request.get('source_root'),
            'Selected readonly source root differs')
    require(os.environ.get('FULLMAG_BACKEND_CARGO_PROFILE', 'backend-dev') == 'backend-dev',
            'Focused checks require backend-dev profile')
    require(request.get('diagnostic_api_only') is True
            and isinstance(request.get('claimed_interruption_build'), dict),
            'Focused checks require the exact claimed diagnostic-build permit')
    require(request.get('result_path', '').startswith('/opt/fullmag/control/'),
            'Focused-check result must stay in the BuildControl volume')

    with runtime_locks() as paths, claimed_build_locks(request, paths):
        runtime_before = pinned_evidence(request, paths)
        try:
            current_package = package_snapshot(
                backend.PACKAGE_ROOT, 'current package before focused checks', current=True
            )
            source = candidate_and_workspace(request, current_package)
            require(source['candidate_receipt_sha256'] == request['candidate_receipt_sha256'],
                    'Candidate receipt changed during preflight')
            jobs = int(os.environ.get('CARGO_BUILD_JOBS', '2'))
            require(1 <= jobs <= 64, 'Cargo job budget is invalid')
            build_root = Path('/build')
            environment = backend._build_environment(
                source['workspace'], build_root, source['native_source_identity'], jobs
            )
            require(environment.get('FULLMAG_BACKEND_CARGO_PROFILE') == 'backend-dev'
                    and environment.get('CARGO_TARGET_DIR')
                    == '/workspace/.fullmag-build/cargo-targets/direct'
                    and environment.get('CARGO_HOME') in ('/build/cargo', '/opt/fullmag/shared-cargo')
                    and environment.get('TMPDIR') == '/build/tmp',
                    'Cargo environment differs from the managed backend-dev cache')
            # These Rust unit filters create temporary local POSIX fixtures.
            # Do not let the container's production store-admission profile
            # reinterpret those temp roots as the actual mounted runtime store.
            for name in (
                'FULLMAG_SESSION_STORAGE_PROFILE', 'FULLMAG_DOCKER_HOST_ID',
                'FULLMAG_RUNTIME_IMAGE_ID', 'FULLMAG_RUNTIME_CONTROL_ROOT',
                'FULLMAG_RUNTIME_SERVICES_ROOT', 'FULLMAG_HOST_LEDGER_ROOT',
                'FULLMAG_STATE_ROOT',
            ):
                environment.pop(name, None)
        except (Exception, SystemExit) as error:
            runtime_after = pinned_evidence(request, paths)
            if runtime_after != runtime_before:
                retained_unknown()
            refusal = result_record(
                request, 'refused-before-tests', runtime_before, runtime_after,
                refusal_reason=error,
            )
            backend._write_json(Path(request['result_path']), refusal,
                                'claimed focused-check refusal')
            print('CLAIMED_RUNTIME_CHECKS_RESULT=' + json.dumps(refusal, sort_keys=True), flush=True)
            return 42

        command_results = []
        for command_index, command in enumerate(CARGO_TEST_COMMANDS):
            record = {
                'argv': list(command),
                'exit_code': 127,
                'process_started': False,
                'wait_observed': False,
                'test_summary': None,
                'test_output_counts': {'passed': 0, 'failed': 0, 'ignored': 0},
                'test_line_count': 0,
                'unexpected_test_line_count': 0,
                'test_records': [],
                'gate_error': 'cargo test process did not start',
            }
            try:
                process = subprocess.Popen(
                    command,
                    cwd=str(source['workspace']),
                    env=environment,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                )
            except OSError as error:
                record['spawn_error'] = str(error)[:1024]
                command_results.append(record)
                continue

            record['process_started'] = True
            output_tail = bytearray()
            try:
                while True:
                    chunk = process.stdout.read(65536)
                    if not chunk:
                        break
                    output_tail.extend(chunk)
                    if len(output_tail) > MAX_TEST_OUTPUT_TAIL_BYTES:
                        del output_tail[:-MAX_TEST_OUTPUT_TAIL_BYTES]
                    sys.stdout.buffer.write(chunk)
                    sys.stdout.buffer.flush()
                record['exit_code'] = process.wait()
                record['wait_observed'] = True
                record.update(parse_test_harness_tail(bytes(output_tail), command_index))
            except BaseException:
                # A child/pipe outcome that cannot be reaped is not a known
                # failed test. Keep runtime and claimed-store locks held.
                retained_unknown()
            command_results.append(record)

        runtime_after = pinned_evidence(request, paths)
        if runtime_after != runtime_before:
            retained_unknown()
        if not current_candidate_workspace_matches(source, request, current_package):
            retained_unknown()

        all_passed = all(
            record['exit_code'] == 0 and record['gate_error'] is None
            for record in command_results
        )
        report_state = 'passed' if all_passed else 'tests-failed-known'
        report = result_record(
            request, report_state, runtime_before, runtime_after,
            source=source, commands=command_results,
        )
        backend._write_json(Path(request['result_path']), report,
                            'claimed focused Rust checks result')
        print('CLAIMED_RUNTIME_CHECKS_RESULT=' + json.dumps(report, sort_keys=True), flush=True)
        return 0 if all_passed else 44
'''


def inspect_one(kind: str, name: str) -> dict[str, Any]:
    rows = json.loads(docker_capture(kind, "inspect", name).stdout)
    require(len(rows) == 1, "Exactly one Docker identity is required")
    return rows[0]


def _read_claimed_pin(control: BuildControl, relative: str, expected_sha256: str) -> dict[str, Any]:
    require(CLAIMED_PIN_RE.fullmatch(relative) is not None,
            "Claimed build pin must use its canonical control-relative path")
    require(_is_sha(expected_sha256), "Claimed build pin SHA-256 is invalid")
    from docker_volume_reconcile import read_raw

    raw = read_raw(control, relative)
    require(len(raw) <= 256 * 1024 and hashlib.sha256(raw).hexdigest() == expected_sha256,
            "Claimed build immutable control pin differs")
    try:
        pin = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise BuildControlError("Claimed build control pin is not JSON") from error
    require(isinstance(pin, dict)
            and pin.get("schema_version") == "fullmag.claimed-interruption-build-pin.v1",
            "Claimed build control pin schema differs")
    return pin


def _validate_args(args: argparse.Namespace) -> None:
    for value, pattern, label in (
        (args.backend_container_id, CONTAINER_ID_RE, "backend container id"),
        (args.image_id, IMAGE_ID_RE, "backend image id"),
        (args.process_receipt_sha256, SHA256_RE, "process receipt SHA-256"),
        (args.owner_sha256, SHA256_RE, "runtime owner SHA-256"),
        (args.claimed_build_pin_sha256, SHA256_RE, "claimed build pin SHA-256"),
        (args.candidate_receipt_sha256, SHA256_RE, "candidate receipt SHA-256"),
    ):
        require(pattern.fullmatch(value or "") is not None, "Invalid immutable pin: " + label)
    require(CLAIMED_PIN_RE.fullmatch(args.claimed_build_pin or "") is not None,
            "Invalid claimed build control-relative pin")
    require(CANDIDATE_RE.fullmatch(args.candidate_basename or "") is not None,
            "Invalid candidate basename")


def run(args: argparse.Namespace) -> None:
    from docker_dev import _compose_identity, _select_source
    import docker_backend_volume_cache as cache
    from docker_volume_dev import _validate_retained_service
    from docker_volume_reconcile import fingerprint, read_raw
    import fullmag_storage as storage

    _validate_args(args)
    selected, layout = _select_source(Path(args.source_root), args.source_root)
    identity = _compose_identity(layout)
    control = BuildControl(identity, args.image_id)
    control.prepare()
    previous, authority, document, profile, authority_pins = recovery_build.recovery_authority(
        control, args, selected
    )
    image = inspect_one("image", args.image_id)
    require(image.get("Id") == args.image_id, "Selected backend image identity differs")
    actual = inspect_one("container", args.backend_container_id)
    recovery_build.validate_backend(actual, identity, args.backend_container_id, args.image_id)
    _validate_retained_service(document, actual, "backend", image["Config"])
    require(authority.get("state") == "succeeded"
            and previous.get("compose_project") == control.project
            and previous.get("inputs", {}).get("source_root") == str(selected)
            and previous.get("inputs", {}).get("image_id") == args.image_id
            and authority.get("backend_container") == args.backend_container_id
            and document.get("name") == control.project,
            "Verified source/backend authority differs")
    if authority_pins:
        require(actual.get("State", {}).get("StartedAt") == authority.get("backend_started_at"),
                "Backend incarnation differs from pinned retained authority")

    expected_cache = cache.cache_key(
        selected, identity["worktree_id"], profile["toolchain_image_id"], profile["cargo_profile"]
    )
    require(profile.get("cache_key") == expected_cache["key"],
            "Build cache belongs to another source/toolchain")
    profile = {
        **profile,
        "volume_documents": {
            role: inspect_one("volume", name)
            for role, name in profile["volume_names"].items()
        },
    }
    cache.validate_container(actual, profile)
    ids = docker_capture("ps", "--quiet", "--no-trunc").stdout.decode().split()
    rows = json.loads(docker_capture("inspect", *ids).stdout) if ids else []
    recovery_build.validate_other_cache_consumers(profile, rows, args.backend_container_id)

    claimed_pin = _read_claimed_pin(
        control, args.claimed_build_pin, args.claimed_build_pin_sha256
    )
    source_commit = storage.git(selected, "rev-parse", "HEAD")
    controller_sha256 = hashlib.sha256(inside_code().encode("utf-8")).hexdigest()
    inputs = {
        "source_root": str(selected),
        "source_commit": source_commit,
        "compose_project": control.project,
        "backend_container_id": args.backend_container_id,
        "image_id": args.image_id,
        "backend_started_at": actual["State"]["StartedAt"],
        "container_fingerprint": fingerprint(actual),
        "process_receipt_sha256": args.process_receipt_sha256,
        "owner_sha256": args.owner_sha256,
        "claimed_build_pin": args.claimed_build_pin,
        "claimed_build_pin_sha256": args.claimed_build_pin_sha256,
        "claimed_interruption_build": claimed_pin,
        "candidate_basename": args.candidate_basename,
        "candidate_receipt_sha256": args.candidate_receipt_sha256,
        "cargo_test_commands": [list(command) for command in CARGO_TEST_COMMANDS],
        "controller_sha256": controller_sha256,
        "runtime_qualification": "NOT VERIFIED",
        **({"retained_authority": authority_pins} if authority_pins else {}),
    }

    with control.operation("claimed-runtime-checks", inputs) as operation:
        if hashlib.sha256(read_raw(control, args.claimed_build_pin)).hexdigest() != args.claimed_build_pin_sha256:
            raise BuildControlError("Claimed build pin changed before focused checks")
        if authority_pins:
            require(recovery_build.recovery_authority(control, args, selected)[4] == authority_pins,
                    "Pinned recovery authority changed before focused checks")
        fresh = inspect_one("container", args.backend_container_id)
        require(fingerprint(fresh) == inputs["container_fingerprint"]
                and fresh.get("State", {}).get("StartedAt") == inputs["backend_started_at"]
                and fresh.get("State", {}).get("Running") is True,
                "Backend incarnation changed before focused checks")
        recovery_build.validate_backend(fresh, identity, args.backend_container_id, args.image_id)
        request = {
            **inputs,
            "diagnostic_api_only": True,
            "result_path": recovery_build.backend_control_path(
                control.path(operation["root"] + "/result.json")
            ),
        }
        operation["daemon_pending"] = True
        process = subprocess.Popen(
            docker_argv(
                "exec", args.backend_container_id, "/usr/local/bin/python3", "-B",
                "-c", inside_code(), json.dumps(request, sort_keys=True),
            ),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        for chunk in iter(lambda: process.stdout.read1(65536), b""):
            operation["logger"].stdin.write(chunk)
            operation["logger"].stdin.flush()
            mirror_console(chunk)
        process_exit_code = process.wait()
        result = control.read(operation["root"] + "/result.json")
        expected_identity = _expected_identity(args, selected, control.project)
        result = validate_execution_result(process_exit_code, result, expected_identity)
        operation["daemon_pending"] = False
        if process_exit_code == 42:
            operation["receipt"].update(
                state="failed-confirmed", image_id=args.image_id,
                result=result, runtime_qualification="NOT VERIFIED",
            )
            raise BuildControlError(
                "Focused Rust checks refused before either test; managed guards released with known refusal"
            )
        if process_exit_code == 44:
            operation["receipt"].update(
                state="failed-confirmed", image_id=args.image_id,
                result=result, runtime_qualification="NOT VERIFIED",
            )
            failed = [entry["exit_code"] for entry in result["commands"] if entry["exit_code"] != 0]
            raise BuildControlError(
                "Focused Rust tests completed with known nonzero exit(s) "
                + ",".join(str(code) for code in failed)
                + "; runtime evidence unchanged and managed guards released"
            )
        operation["receipt"].update(
            state="succeeded", image_id=args.image_id, result=result,
            runtime_qualification="NOT VERIFIED",
        )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--backend-container-id", required=True)
    parser.add_argument("--image-id", required=True)
    parser.add_argument("--process-receipt-sha256", required=True)
    parser.add_argument("--owner-sha256", required=True)
    parser.add_argument("--claimed-build-pin", required=True,
                        help="canonical control-relative verification/.../build-pin.json")
    parser.add_argument("--claimed-build-pin-sha256", required=True)
    parser.add_argument("--candidate-basename", required=True)
    parser.add_argument("--candidate-receipt-sha256", required=True)
    return parser


def main() -> None:
    parser = build_parser()
    try:
        run(parser.parse_args())
    except (BuildControlError, ValueError, OSError) as error:
        parser.exit(2, str(error) + "\n")


if __name__ == "__main__":
    main()
