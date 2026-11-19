#!/usr/bin/env python3
"""Explicit, non-destructive recovery of one ready unpublished package."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import stat

import backend_dev as backend

SCHEMA = "fullmag.backend-candidate-recovery.v1"


def _pinned(path, digest):
    backend._assert_no_links(path, "recovery pinned file")
    data, metadata = backend._read_regular(path, "recovery pinned file", 8 * 1024 * 1024)
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        backend._fail("recovery pin is not one regular file")
    if backend._sha256_bytes(data) != digest:
        backend._fail("recovery file differs from its pin")
    return data


def _validate(root, source, request, package, build):
    marker_bytes = _pinned(root / backend.PACKAGE_CANDIDATE_MARKER, request["marker_sha256"])
    marker = json.loads(marker_bytes)
    expected = {
        "schema": backend.PACKAGE_CANDIDATE_SCHEMA, "state": "ready",
        "candidate": str(source), "package_root": str(package),
        "build_root": str(build), "cargo_profile": backend.BACKEND_CARGO_PROFILE,
        "artifact_inventory_sha256": marker.get("artifact_inventory_sha256"),
    }
    if marker != expected:
        backend._fail("recovery requires the original ready candidate marker")
    receipt, receipt_bytes, _ = backend._validated_package(
        root, "recovery candidate", exclude_candidate_marker=True)
    if backend._sha256_bytes(receipt_bytes) != request["receipt_sha256"]:
        backend._fail("recovery package receipt differs from its pin")
    records = receipt["artifacts"]
    if marker["artifact_inventory_sha256"] != backend._sha256_bytes(backend._canonical(records)):
        backend._fail("recovery marker inventory differs from package")
    backend._assert_direct_candidate_inventory(root, records, include_receipt=True)
    attempt_path = backend._failed_make_paths(build, source)[1]
    _pinned(attempt_path, request["make_attempt_sha256"])
    attempt = backend._read_failed_make_attempt(build, source)
    if attempt is None or attempt[0]["state"] != "succeeded" or attempt[0]["exit_code"] != 0:
        backend._fail("recovery requires a successful Make attempt")
    log_hash, metadata = backend._sha256_file(
        root / "direct-backend-build.log", "recovery package log", backend.MAX_BUILD_LOG_BYTES)
    if log_hash != attempt[0]["log_sha256"] or metadata.st_size != attempt[0]["log_size"]:
        backend._fail("recovery package log differs from Make attempt")


def recover(request, *, apply=False, package=None, build=None, control=None):
    package = backend._absolute(package or backend.PACKAGE_ROOT, "package")
    build = backend._absolute(build or backend.BUILD_ROOT, "build")
    control = backend._absolute(control or backend.CONTROL_ROOT, "control")
    keys = {"schema", "candidate_basename", "marker_sha256", "receipt_sha256", "make_attempt_sha256"}
    if set(request) != keys or request["schema"] != SCHEMA:
        backend._fail("invalid candidate recovery request")
    name = request["candidate_basename"]
    if not isinstance(name, str) or not backend.PACKAGE_CANDIDATE_NAME_RE.fullmatch(name):
        backend._fail("invalid recovery candidate basename")
    for key in keys - {"schema", "candidate_basename"}:
        if not isinstance(request[key], str) or not backend.SHA256_RE.fullmatch(request[key]):
            backend._fail("invalid recovery digest")
    digest = backend._sha256_bytes(backend._canonical(request))
    development = package / backend.PACKAGE_DEVELOPMENT_DIRNAME
    source = development / backend.PACKAGE_CANDIDATES_DIRNAME / name
    destination = development / "quarantine" / name
    record = control / "verification" / "candidate-recovery" / digest
    with backend._runtime_build_lock(build):
        backend._assert_no_links(development, "recovery package control")
        owner, _ = backend._read_json(development / backend.PACKAGE_DEVELOPMENT_OWNER, "package owner")
        if owner != {"schema": backend.PACKAGE_DEVELOPMENT_SCHEMA, "state": "owned", "package_root": str(package)}:
            backend._fail("recovery package owner mismatch")
        journal = development / backend.PACKAGE_ROTATION_JOURNAL_NAME
        if journal.exists() or journal.is_symlink():
            backend._fail("recovery refuses pending package rotation")
        backend._assert_no_links(record, "recovery record")
        backend._assert_no_links(source, "recovery source")
        backend._assert_no_links(destination, "recovery destination")
        source_exists, destination_exists = source.exists(), destination.exists()
        if source_exists == destination_exists:
            backend._fail("recovery requires exactly one source or destination")
        request_path = record / "request.json"
        if request_path.exists():
            stored, _ = backend._read_json(request_path, "recovery durable request")
            if stored != request:
                backend._fail("recovery durable request mismatch")
        elif destination_exists:
            backend._fail("recovery destination lacks this durable request")
        root = source if source_exists else destination
        _validate(root, source, request, package, build)
        result = {"schema": SCHEMA, "request_sha256": digest, "source": str(source),
                  "destination": str(destination), "state": "quarantined" if apply or destination_exists else "dry-run"}
        if not apply:
            return result
        _pinned(Path(__file__), os.environ.get("FULLMAG_RECOVERY_HELPER_SHA256", ""))
        _pinned(Path(backend.__file__), os.environ.get("FULLMAG_RECOVERY_BACKEND_SHA256", ""))
        backend._ensure_directory(record, "recovery record")
        if not request_path.exists():
            backend._write_json(request_path, request, "recovery durable request")
            backend._fsync_directory(record, "recovery record")
            backend._fsync_directory(record.parent, "recovery namespace")
        if source_exists:
            backend._ensure_directory(destination.parent, "candidate quarantine")
            backend._fsync_directory(development, "package control")
            backend._fsync_owned_tree(source, "candidate recovery source")
            _validate(source, source, request, package, build)
            if destination.exists() or destination.is_symlink():
                backend._fail("recovery destination appeared before rename")
            os.rename(source, destination)
        backend._fsync_directory(source.parent, "candidate namespace")
        backend._fsync_directory(destination.parent, "candidate quarantine")
        _validate(destination, source, request, package, build)
        backend._write_json(record / "result.json", result, "recovery result")
        backend._fsync_directory(record, "recovery record")
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--request-sha256", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    request = json.loads(_pinned(args.request, args.request_sha256))
    print(json.dumps(recover(request, apply=args.apply), sort_keys=True))


if __name__ == "__main__":
    main()
