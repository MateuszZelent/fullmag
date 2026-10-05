"""Prepare diagnostic ready status and run bounded selector contract checks."""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from windows import development_handoff as capsule
from windows import development_restore_launch as restore
from windows import development_status
from windows import runtime_bundle
from windows import select_development_candidate as selector
from windows.workspace_backend_identity import fingerprint


DIAGNOSTIC_PROFILE = "development-backend-api-checks"
NATIVE_PROFILE = "windows-native-fdm-cpu-dev"
STATUS_NAME = "backend-watch-status.json"


def _managed_probe_scope(repo_root: str) -> tuple[Path, dict[str, Any], Path, Path, Path, str, str]:
    if (
        os.environ.get("FULLMAG_DEVELOPMENT_OWNER_PROBE") != "1"
        or os.environ.get("FULLMAG_NATIVE_RUNTIME_ACTIVE") != "1"
        or os.environ.get("FULLMAG_STORAGE_PROFILE") != NATIVE_PROFILE
    ):
        raise capsule.HandoffError("Candidate diagnostics require the managed native owner probe")

    repo = runtime_bundle._require_directory(repo_root, "repository root").resolve(strict=True)
    native_layout, runtime_root = restore._verified_workspace(str(repo))
    registered_repo = runtime_bundle._require_directory(
        native_layout["repo_root"], "registered repository root"
    ).resolve(strict=True)
    if not selector._samefile(repo, registered_repo, "registered repository root"):
        raise capsule.HandoffError("Candidate diagnostic repository is not the registered worktree")

    storage_root = capsule._validate_runtime_root(native_layout["storage_root"])
    environment_storage = capsule._validate_runtime_root(
        os.environ.get("FULLMAG_PROJECT_STORAGE_ROOT", "")
    )
    worktree_id = native_layout.get("worktree_id")
    generation_id = os.environ.get("FULLMAG_DEVELOPMENT_BACKEND_GENERATION", "")
    if (
        not isinstance(worktree_id, str)
        or development_status.WORKTREE_ID.fullmatch(worktree_id) is None
        or os.environ.get("FULLMAG_WORKTREE_ID") != worktree_id
        or not selector._samefile(storage_root, environment_storage, "owner storage root")
        or development_status.GENERATION_ID.fullmatch(generation_id) is None
    ):
        raise capsule.HandoffError("Candidate diagnostic owner scope is invalid")

    checks_layout = capsule._STORAGE.resolve_layout(str(repo), DIAGNOSTIC_PROFILE)
    checks_storage = capsule._validate_runtime_root(checks_layout["storage_root"])
    checks_root = runtime_bundle._require_directory(checks_layout["build_root"], "diagnostic status profile").resolve(
        strict=True
    )
    expected_checks_root = storage_root / "builds" / worktree_id / DIAGNOSTIC_PROFILE
    native_build_root = runtime_bundle._require_directory(
        native_layout["build_root"], "native watcher profile"
    ).resolve(strict=True)
    if (
        checks_layout.get("profile") != DIAGNOSTIC_PROFILE
        or checks_layout.get("worktree_id") != worktree_id
        or not selector._samefile(checks_storage, storage_root, "diagnostic storage root")
        or not selector._samefile(checks_root, expected_checks_root, "diagnostic status profile")
        or selector._samefile(checks_root, native_build_root, "diagnostic status profile")
    ):
        raise capsule.HandoffError("Candidate diagnostic profile is not the fixed isolated profile")

    status_path = checks_root / STATUS_NAME
    native_status_path = native_build_root / STATUS_NAME
    runtime_bundle._check_path_chain(status_path, "diagnostic backend status", allow_missing=True)
    capsule._contained_path(status_path, storage_root, "diagnostic backend status")
    if runtime_bundle._same_path(status_path, native_status_path):
        raise capsule.HandoffError("Diagnostic backend status aliases the native watcher")

    env_status = runtime_bundle._absolute_path(
        os.environ.get("FULLMAG_DEVELOPMENT_BACKEND_STATUS_FILE", ""),
        "managed backend status path",
    )
    runtime_bundle._check_path_chain(env_status, "managed backend status path", allow_missing=True)
    if not runtime_bundle._same_path(env_status, status_path):
        raise capsule.HandoffError("Managed backend status path is not the fixed diagnostic status")
    if os.path.lexists(status_path):
        capsule._read_limited(status_path, storage_root, "diagnostic backend status", selector.MAX_STATUS_BYTES)
        if not selector._samefile(env_status, status_path, "managed backend status path"):
            raise capsule.HandoffError("Managed backend status path differs from diagnostic status")

    return repo, native_layout, Path(runtime_root), checks_root, status_path, generation_id, worktree_id


def prepare_diagnostic_ready_status(repo_root: str) -> dict[str, str]:
    """Publish a ready frame only under the fixed probe-only diagnostic profile."""
    repo, native_layout, runtime_root, _checks_root, status_path, generation_id, worktree_id = (
        _managed_probe_scope(repo_root)
    )
    native_build_root = Path(native_layout["build_root"])
    manifest_path = runtime_bundle._absolute_path(
        native_build_root / "windows-runtime" / "build-manifest.json",
        "managed backend build manifest",
    )
    runtime_bundle._require_regular_file(manifest_path, "managed backend build manifest", nonempty=True)
    canonical_manifest = manifest_path.resolve(strict=True)
    if not selector._samefile(manifest_path, canonical_manifest, "managed backend build manifest"):
        raise capsule.HandoffError("Managed backend build manifest is not canonical")

    source_before = fingerprint(repo).get("sha256")
    ready_identity = development_status.verified_build_identity(
        native_build_root, runtime_root, canonical_manifest, source_before
    )
    if fingerprint(repo).get("sha256") != source_before:
        raise capsule.HandoffError("Backend sources changed during diagnostic status preparation")

    publisher = development_status.DevelopmentStatusPublisher(status_path, generation_id, worktree_id)
    document = publisher.publish(
        {
            "state": "ready",
            "source_sha256": source_before,
            **ready_identity,
        }
    )
    validated = selector._read_ready_status(status_path, Path(native_layout["storage_root"]))
    selector._validate_status_pins(validated, generation_id, worktree_id)
    if (
        validated["ready_build_id"] != ready_identity["ready_build_id"]
        or validated["ready_source_sha256"] != ready_identity["ready_source_sha256"]
        or selector._status_identity(document) != selector._status_identity(validated)
        or fingerprint(repo).get("sha256") != source_before
        or not selector._samefile(
            Path(os.environ["FULLMAG_DEVELOPMENT_BACKEND_STATUS_FILE"]),
            status_path,
            "managed backend status path",
        )
    ):
        raise capsule.HandoffError("Diagnostic ready status changed during publication")
    return {
        "schema": "fullmag.development-ready-candidate-diagnostic-status.v1",
        "generation_id": generation_id,
        "worktree_id": worktree_id,
        "ready_build_id": ready_identity["ready_build_id"],
        "ready_source_sha256": ready_identity["ready_source_sha256"],
    }


def _expect_refusal(label: str, action: Callable[[], Any], checks: list[str]) -> None:
    try:
        action()
    except capsule.HandoffError:
        checks.append(label)
        return
    raise capsule.HandoffError(f"Candidate diagnostic did not refuse {label}")


def run_contract_regressions(repo_root: str) -> list[str]:
    """Run lightweight selector contract cases inside the managed check profile."""
    _repo, native_layout, _runtime_root, checks_root, _status_path, generation, worktree = (
        _managed_probe_scope(repo_root)
    )
    checks: list[str] = []
    now_ms = int(time.time() * 1000)
    request = {
        "schema": selector.REQUEST_SCHEMA,
        "storage_root": str(Path(os.environ["FULLMAG_PROJECT_STORAGE_ROOT"])),
        "worktree_id": worktree,
        "generation_id": generation,
    }
    if selector._validate_request_document(request) != request:
        raise capsule.HandoffError("Candidate diagnostic valid request changed")
    checks.append("candidate-request-strict-schema-accepts-exact-v1")
    _expect_refusal(
        "candidate-request-unknown-field",
        lambda: selector._validate_request_document({**request, "extra": True}),
        checks,
    )
    _expect_refusal(
        "candidate-request-unsupported-schema",
        lambda: selector._validate_request_document({**request, "schema": "unknown"}),
        checks,
    )
    _expect_refusal(
        "candidate-request-invalid-generation-pin",
        lambda: selector._validate_request_document({**request, "generation_id": "A" * 32}),
        checks,
    )
    _expect_refusal(
        "candidate-request-owner-pin-mismatch",
        lambda: selector._validate_owner_pins(request, "0" * 32, worktree),
        checks,
    )

    valid_status = {
        "schema": development_status.SCHEMA,
        "generation_id": generation,
        "worktree_id": worktree,
        "state": "ready",
        "source_sha256": "a" * 64,
        "ready_build_id": "b" * 64,
        "ready_source_sha256": "a" * 64,
        "revision": 1,
        "updated_unix_ms": now_ms,
    }
    if selector._validate_ready_status_document(valid_status, now_ms) != valid_status:
        raise capsule.HandoffError("Candidate diagnostic valid status changed")
    selector._validate_status_pins(valid_status, generation, worktree)
    request_status = {**valid_status, "request_id": str(uuid.uuid4())}
    if selector._validate_ready_status_document(request_status, now_ms) != request_status:
        raise capsule.HandoffError("Candidate diagnostic request-correlated status changed")
    checks.append("candidate-ready-status-accepts-optional-canonical-request-id")
    _expect_refusal(
        "candidate-status-unknown-field",
        lambda: selector._validate_ready_status_document({**valid_status, "extra": True}, now_ms),
        checks,
    )
    _expect_refusal(
        "candidate-status-missing-field",
        lambda: selector._validate_ready_status_document(
            {key: value for key, value in valid_status.items() if key != "revision"}, now_ms
        ),
        checks,
    )
    _expect_refusal(
        "candidate-status-not-ready",
        lambda: selector._validate_ready_status_document({**valid_status, "state": "waiting"}, now_ms),
        checks,
    )
    _expect_refusal(
        "candidate-status-source-pair-mismatch",
        lambda: selector._validate_ready_status_document(
            {**valid_status, "ready_source_sha256": "c" * 64}, now_ms
        ),
        checks,
    )
    _expect_refusal(
        "candidate-status-invalid-request-id",
        lambda: selector._validate_ready_status_document(
            {**valid_status, "request_id": "A" * 36}, now_ms
        ),
        checks,
    )
    _expect_refusal(
        "candidate-status-nil-request-id",
        lambda: selector._validate_ready_status_document(
            {**valid_status, "request_id": "00000000-0000-0000-0000-000000000000"}, now_ms
        ),
        checks,
    )
    _expect_refusal(
        "candidate-status-boolean-revision",
        lambda: selector._validate_ready_status_document({**valid_status, "revision": True}, now_ms),
        checks,
    )
    _expect_refusal(
        "candidate-status-stale-timestamp",
        lambda: selector._validate_ready_status_document(
            {**valid_status, "updated_unix_ms": now_ms - selector.STATUS_FRESHNESS_MS - 1}, now_ms
        ),
        checks,
    )
    _expect_refusal(
        "candidate-status-future-timestamp",
        lambda: selector._validate_ready_status_document(
            {**valid_status, "updated_unix_ms": now_ms + selector.STATUS_FUTURE_TOLERANCE_MS + 1}, now_ms
        ),
        checks,
    )
    _expect_refusal(
        "candidate-status-generation-pin-mismatch",
        lambda: selector._validate_status_pins(valid_status, "0" * 32, worktree),
        checks,
    )
    _expect_refusal(
        "candidate-status-worktree-pin-mismatch",
        lambda: selector._validate_status_pins(valid_status, generation, "other-worktree"),
        checks,
    )

    heartbeat = {**valid_status, "updated_unix_ms": now_ms + 1}
    selector._validate_final_ready_identity(valid_status, heartbeat, "a" * 64, "a" * 64)
    checks.append("candidate-status-race-allows-heartbeat-only-update")
    _expect_refusal(
        "candidate-status-race-revision-change",
        lambda: selector._validate_final_ready_identity(
            valid_status, {**valid_status, "revision": 2}, "a" * 64, "a" * 64
        ),
        checks,
    )
    _expect_refusal(
        "candidate-status-race-ready-build-change",
        lambda: selector._validate_final_ready_identity(
            valid_status, {**valid_status, "ready_build_id": "c" * 64}, "a" * 64, "a" * 64
        ),
        checks,
    )
    _expect_refusal(
        "candidate-status-race-source-change",
        lambda: selector._validate_final_ready_identity(valid_status, heartbeat, "c" * 64, "a" * 64),
        checks,
    )

    storage_root = capsule._validate_runtime_root(os.environ["FULLMAG_PROJECT_STORAGE_ROOT"])
    diagnostic_status = selector._selected_status_path(native_layout, storage_root, worktree)
    if diagnostic_status != checks_root / STATUS_NAME:
        raise capsule.HandoffError("Candidate diagnostic status escaped its fixed profile")
    checks.append("candidate-probe-status-uses-fixed-diagnostic-profile")
    owner_probe_value = os.environ.pop("FULLMAG_DEVELOPMENT_OWNER_PROBE", None)
    try:
        production_status = selector._selected_status_path(native_layout, storage_root, worktree)
    finally:
        if owner_probe_value is not None:
            os.environ["FULLMAG_DEVELOPMENT_OWNER_PROBE"] = owner_probe_value
    if production_status != Path(native_layout["build_root"]) / STATUS_NAME:
        raise capsule.HandoffError("Production selector status path changed under diagnostics")
    checks.append("candidate-production-status-remains-native-watcher-profile")

    with tempfile.TemporaryDirectory(prefix="candidate-selector-", dir=checks_root) as temporary_root:
        temporary = Path(temporary_root)
        bundles_root = temporary / "native-bundles"
        foreign_root = temporary / "other-bundles"
        bundles_root.mkdir()
        foreign_root.mkdir()
        selector._validate_candidate_namespace(bundles_root / ("d" * 32), bundles_root)
        checks.append("candidate-namespace-accepts-direct-bundle-id")
        _expect_refusal(
            "candidate-namespace-wrong-parent",
            lambda: selector._validate_candidate_namespace(foreign_root / ("d" * 32), bundles_root),
            checks,
        )
        _expect_refusal(
            "candidate-namespace-invalid-id",
            lambda: selector._validate_candidate_namespace(bundles_root / "not-a-bundle", bundles_root),
            checks,
        )
    return checks


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--prepare-ready-status", action="store_true")
    parser.add_argument("--contract-regressions", action="store_true")
    args = parser.parse_args()
    try:
        if not args.prepare_ready_status and not args.contract_regressions:
            raise capsule.HandoffError("Candidate diagnostics require an explicit operation")
        result: dict[str, Any] = {"schema": "fullmag.development-candidate-check.v1"}
        if args.contract_regressions:
            result["checks"] = run_contract_regressions(args.repo_root)
        if args.prepare_ready_status:
            result["ready_status"] = prepare_diagnostic_ready_status(args.repo_root)
        sys.stdout.buffer.write(json.dumps(result, sort_keys=True, separators=(",", ":")).encode("utf-8") + b"\n")
        return 0
    except Exception:
        print("Development candidate diagnostic failed", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
