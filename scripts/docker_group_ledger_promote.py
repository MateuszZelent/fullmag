"""Publish one verified group-migration candidate; never build, start or recover a runtime."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys

import docker_group_ledger_bootstrap as bootstrap

SCHEMA = "fullmag.group-ledger-promote.v1"
FIELDS = {"schema", "request_id", "compose_project", "control_volume", "source_root",
          "bootstrap_request", "relocation_receipt", "provenance_sha256", "promote_script_sha256", "result_path"}


def validate_request(value):
    bootstrap.require(isinstance(value, dict) and set(value) == FIELDS and value["schema"] == SCHEMA,
                      "Unsupported group migration promotion request")
    bootstrap.require(isinstance(value["request_id"], str) and re.fullmatch(r"[0-9a-f]{32}", value["request_id"]),
                      "Invalid promotion request identity")
    for role in ("bootstrap_request", "relocation_receipt"):
        pin = value[role]
        bootstrap.require(isinstance(pin, dict) and set(pin) == {"path", "sha256"} and bootstrap.sha(pin["sha256"]),
                          "Invalid promotion evidence pin")
        bootstrap.safe_path(pin["path"])
    for field in ("provenance_sha256", "promote_script_sha256"):
        bootstrap.require(bootstrap.sha(value[field]), "Invalid " + field)
    target = bootstrap.CONTROL / "group-ledger-promote/attempts" / value["request_id"] / "result.json"
    bootstrap.require(bootstrap.safe_path(value["result_path"]) == target, "Promotion result path differs")
    return value


def pinned(pin, *, semantic=False):
    raw = bootstrap.regular(bootstrap.safe_path(pin["path"]))
    value = bootstrap.strict_json(raw)
    bootstrap.require(bootstrap.digest(bootstrap.canonical(value) if semantic else raw) == pin["sha256"],
                      "Promotion evidence CAS differs")
    return value


def evidence(request):
    original = bootstrap.validate_request(pinned(request["bootstrap_request"]))
    bootstrap.require(all(original[name] == request[name] for name in ("compose_project", "control_volume", "source_root")),
                      "Promotion group differs from bootstrap")
    original_root = bootstrap.CONTROL / "group-ledger-bootstrap/attempts" / original["request_id"]
    bootstrap.require(Path(request["bootstrap_request"]["path"]) == original_root / "request.json",
                      "Bootstrap request path differs")
    receipt = pinned(request["relocation_receipt"], semantic=True)
    bootstrap.require(receipt.get("schema") == "fullmag.group-ledger-relocation.v1"
                      and receipt.get("state") == "verified" and receipt.get("runtime_started") is False
                      and receipt.get("solve_started") is False, "Relocation has not been verified")
    relocation = receipt["request"]
    bootstrap.require(relocation.get("schema") == "fullmag.group-ledger-relocation.v1"
                      and all(relocation.get(name) == request[name] for name in ("compose_project", "control_volume", "source_root"))
                      and relocation.get("source_commit") == original["source_commit"]
                      and relocation.get("logical_root") == "/host-ledger/ledger"
                      and relocation.get("target_subpath") == "private/ledger", "Relocation identity or target differs")
    root = Path(request["relocation_receipt"]["path"]).parent
    bootstrap.require(root.parent == bootstrap.CONTROL / "group-ledger-relocation/attempts"
                      and re.fullmatch(r"[0-9a-f]{32}", root.name)
                      and Path(request["relocation_receipt"]["path"]).name == "relocation.json", "Relocation evidence path differs")
    binding = relocation["bootstrap"]
    for role in ("terminal", "result"):
        path = bootstrap.CONTROL / binding[role + "_path"]
        bootstrap.require(path == original_root / (role + ".json"), "Relocation bootstrap evidence path differs")
        value = pinned({"path": str(path), "sha256": binding[role + "_sha256"]}, semantic=True)
        if role == "terminal":
            bootstrap.require(value.get("schema") == "fullmag.docker-build-operation.v1"
                and value.get("phase") == "group-ledger-bootstrap" and value.get("state") == "succeeded"
                and value.get("compose_project") == request["compose_project"]
                and value.get("bootstrap_backend_container") == binding["container_id"]
                and value.get("bootstrap_started_at") == binding["started_at"]
                and value.get("bootstrap_exit_code") == 0
                and value.get("source_group_ledger") == {"volume_name": relocation["source_volume"], "host_id": relocation["host_id"]},
                "Bootstrap terminal authority differs")
        else:
            result = value
    program = relocation["native_program"]
    bootstrap.require(isinstance(program, dict)
        and set(program) == {"image_id", "package_volume", "package_subpath", "candidate", "receipt_sha256", "cli_sha256"}
        and isinstance(program["image_id"], str) and re.fullmatch(r"sha256:[0-9a-f]{64}", program["image_id"])
        and isinstance(program["package_volume"], str) and re.fullmatch(r"[a-z0-9][a-z0-9_.-]*", program["package_volume"])
        and isinstance(program["package_subpath"], str) and re.fullmatch(r"groups/[0-9a-f]{64}", program["package_subpath"])
        and bootstrap.sha(program["receipt_sha256"]) and bootstrap.sha(program["cli_sha256"]), "Native migration package pins differ")
    candidate = Path(program["candidate"])
    bootstrap.require(candidate.parent == Path("/opt/fullmag/package/.development/candidates")
        and re.fullmatch(r"\.backend-package-candidate-[A-Za-z0-9_-]+", candidate.name)
        and result.get("schema") == bootstrap.SCHEMA and result.get("state") == "candidate-ready"
        and result.get("candidate") == str(candidate) and result.get("candidate_receipt_sha256") == program["receipt_sha256"]
        and result.get("candidate_cli_sha256") == program["cli_sha256"]
        and result.get("source", {}).get("resolved_commit") == original["source_commit"]
        and result.get("request_sha256") == request["bootstrap_request"]["sha256"]
        and result.get("package_promoted") is False and result.get("runtime_started") is False,
        "Candidate is not the verified bootstrap result")
    inspection = receipt["source_inspection"]
    source_path = root / "source-inspection.json"
    source_raw = bootstrap.regular(source_path)
    source_sha = bootstrap.digest(source_raw)
    expected = {"schema_version": "fullmag.group-ledger-relocation-preview.v1", "status": "verified",
                "expected_inspection_sha256": source_sha, "inspection": inspection}
    bootstrap.require(source_raw == bootstrap.canonical(inspection)
        and inspection == relocation["expected_inspection"] and inspection.get("host_id") == relocation["host_id"]
        and receipt.get("target_preview") == expected, "Native relocation preview evidence differs")
    return original, receipt, candidate, source_path, source_sha


def native_preview(candidate, relocation, source_path, source_sha):
    command = [str(candidate / "bin/fullmag-bin"), "runtime", "ledger-relocation-preview",
        "--ledger-root", "/host-ledger/ledger", "--host-id", relocation["request"]["host_id"],
        "--expected-inspection", str(source_path), "--expected-inspection-sha256", source_sha]
    result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        timeout=120, env={**os.environ, "LD_LIBRARY_PATH": str(candidate / "lib")})
    bootstrap.require(result.returncode == 0 and len(result.stdout) + len(result.stderr) <= bootstrap.MAX_RECORD,
                      "Native target preview refused publication")
    actual = bootstrap.strict_json(result.stdout)
    bootstrap.require(actual == relocation["target_preview"], "Native target preview changed before publication")
    return actual


def promote(request, backend, runtime):
    original, receipt, candidate, source_path, source_sha = evidence(request)
    program = receipt["request"]["native_program"]
    bootstrap.require(os.environ.get("FULLMAG_COMPOSE_PROJECT") == request["compose_project"]
        and os.environ.get("FULLMAG_BUILD_CONTROL_VOLUME") == request["control_volume"]
        and os.environ.get("FULLMAG_SOURCE_HOST_ROOT") == request["source_root"]
        and os.environ.get("FULLMAG_DOCKER_ROLE") == "backend"
        and os.environ.get("FULLMAG_RUNTIME_IMAGE_ID") == program["image_id"], "Promotion backend binding differs")
    bootstrap.require(bootstrap.digest(bootstrap.regular(Path(__file__))) == request["promote_script_sha256"],
                      "Promotion helper source changed")
    bootstrap.check_mounts(Path("/proc/self/mountinfo").read_text())
    paths = runtime.canonical_paths()
    with bootstrap.runtime_guards(runtime, paths) as guards, backend._runtime_build_lock(Path("/build")):
        bootstrap.check_native_aliases(original, runtime, paths)
        bootstrap.read_records(original)
        bootstrap.no_native_processes()
        bootstrap.capture(backend, original)
        current = bootstrap.package_pin(backend, original)
        control = backend._ensure_package_development_root(backend.PACKAGE_ROOT)
        bootstrap.require(not os.path.lexists(control / backend.PACKAGE_ROTATION_JOURNAL_NAME), "Package rotation is already pending")
        bootstrap.require(sorted((control / backend.PACKAGE_CANDIDATES_DIRNAME).iterdir()) == [candidate],
                          "Other candidate publication is pending")
        marker = backend._validate_candidate_marker(candidate, backend.PACKAGE_ROOT, Path("/build"), state="ready")
        incoming = backend._validated_package(candidate, "migration candidate", exclude_candidate_marker=True)
        bootstrap.require(bootstrap.digest(incoming[1]) == program["receipt_sha256"]
            and marker.get("artifact_inventory_sha256") == bootstrap.digest(backend._canonical(incoming[0]["artifacts"]))
            and backend._sha256_file(candidate / "bin/fullmag-bin", "migration CLI", 512 * 1024**2, package_artifact=True)[0] == program["cli_sha256"],
            "Migration candidate identity differs")
        provenance_before = bootstrap.regular(backend.PROVENANCE_PATH)
        bootstrap.require(bootstrap.digest(provenance_before) == request["provenance_sha256"]
            and provenance_before == backend._canonical(bootstrap.strict_json(provenance_before)),
            "Previous provenance CAS or canonical byte format differs")
        preview = native_preview(candidate, receipt, source_path, source_sha)
        guards()
        bootstrap.require(evidence(request)[:2] == (original, receipt), "Migration evidence changed during preview")
        bootstrap.capture(backend, original)
        bootstrap.require(bootstrap.package_pin(backend, original) == current, "Predecessor package changed during preview")
        bootstrap.require(backend._validated_package(candidate, "migration candidate after preview", exclude_candidate_marker=True) == incoming,
                          "Candidate changed during preview")
        rotation, committed = None, False
        try:
            rotation = backend._rotate_package(backend.PACKAGE_ROOT, candidate, control, current[2], current[1], incoming[1])
            backend._publish_runtime_provenance(backend.PACKAGE_ROOT)
            committed = True
            published = backend._validated_package(backend.PACKAGE_ROOT, "published migration package", exclude_development_control=True)
            bootstrap.require(published[1] == incoming[1], "Published package differs from verified candidate")
            new_provenance = bootstrap.strict_json(bootstrap.regular(backend.PROVENANCE_PATH))
            bootstrap.require(new_provenance.get("image_id") == program["image_id"]
                and new_provenance.get("build_receipt_sha256") == program["receipt_sha256"]
                and new_provenance.get("commit") == original["source_commit"]
                and new_provenance.get("source_snapshot_sha256") == original["source_snapshot_sha256"],
                "Published provenance differs from the verified migration package")
            backend._finalize_published_candidate(candidate, rotation)
            backend._clear_rotation_journal(rotation)
        except BaseException:
            if not committed:
                backend._restore_bound_provenance(provenance_before)
                if rotation is not None:
                    errors = backend._rollback_package_rotation(rotation)
                    bootstrap.require(not errors, "Migration publication rollback is incomplete: " + "; ".join(errors))
            raise
        guards()
        bootstrap.read_records(original)
        result = {"schema": SCHEMA, "state": "promoted", "request_sha256": bootstrap.digest(bootstrap.canonical(request)),
            "package_receipt_sha256": program["receipt_sha256"], "cli_sha256": program["cli_sha256"],
            "provenance_sha256": bootstrap.digest(bootstrap.regular(backend.PROVENANCE_PATH)),
            "rollback_package": rotation["backup"], "native_target_preview": preview,
            "relocation_receipt": request["relocation_receipt"], "package_promoted": True,
            "runtime_started": False, "solve_started": False}
        target = bootstrap.safe_path(request["result_path"])
        bootstrap.require(not target.exists(), "Promotion result already exists")
        backend._write_json(target, result, "group migration promotion result")
        return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", required=True)
    parser.add_argument("--request-sha256", required=True)
    args = parser.parse_args(argv)
    raw = bootstrap.regular(bootstrap.safe_path(args.request))
    bootstrap.require(bootstrap.sha(args.request_sha256) and bootstrap.digest(raw) == args.request_sha256,
                      "Promotion request CAS differs")
    request = validate_request(bootstrap.strict_json(raw))
    bootstrap.require(raw == bootstrap.canonical(request), "Promotion request is not canonical JSON")
    sys.path.insert(0, "/opt/fullmag")
    import backend_dev
    import runtime_service
    print(json.dumps(promote(request, backend_dev, runtime_service), sort_keys=True), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
