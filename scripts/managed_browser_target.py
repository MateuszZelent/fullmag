"""Admit one explicitly pinned, disposable managed browser API; read-only."""
from __future__ import annotations

import json
from pathlib import Path
import re
import urllib.parse
import urllib.request
import uuid

import fullmag_storage as storage
from run_managed_browser import (
    PROFILE, attest_browser_container, compose_spec, digest, docker, host_path,
    read_json, validate_managed_build, verify_source,
)


def managed_browser_target(repo, receipt_path, expected_sha256, *, require_fresh=False):
    if not isinstance(expected_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_sha256):
        raise ValueError("Explicit managed browser receipt SHA256 required")
    layout = storage.resolve_layout(repo, PROFILE)
    runs = Path(layout["build_root"]) / "runs"
    path = storage.validate_path(Path(receipt_path), runs, "owned managed browser receipt")
    if path.name != "receipt.json" or path.parent.parent != runs.resolve() \
            or not re.fullmatch(r"[0-9a-f]{32}", path.parent.name) or digest(path) != expected_sha256:
        raise ValueError("Managed browser receipt path or digest mismatch")
    receipt = read_json(path)
    root = path.parent
    if receipt.get("schema") != "fullmag.managed-browser.v1" \
            or receipt.get("profile") != PROFILE or receipt.get("state") != "running" \
            or receipt.get("launch_state") != "succeeded" \
            or any(receipt.get(key) != "PASS" for key in ("health", "startup_identity", "source_capsule_recheck")) \
            or receipt.get("session_storage") != "disposable_tmpfs" \
            or Path(receipt.get("run_root", "")).resolve() != root \
            or Path(receipt.get("repo_root", "")).resolve() != Path(repo).resolve() \
            or receipt.get("worktree_id") != layout["worktree_id"] \
            or receipt.get("compose_project") != "fullmag-browser-" + root.name:
        raise ValueError("Receipt does not authorize this disposable browser API")
    url = urllib.parse.urlsplit(receipt.get("url", ""))
    if url.scheme != "http" or url.hostname != "localhost" or url.path != "/workspace" \
            or url.query or url.fragment or url.username or url.password or url.port in (None, 3197):
        raise ValueError("Managed browser requires its own loopback workspace URL")
    port = url.port
    job_id = receipt.get("managed_job_id", "")
    if not re.fullmatch(r"[0-9a-f]{32}", job_id):
        raise ValueError("Invalid managed browser job ID")
    build = storage.validate_path(Path(layout["runs_root"]) / job_id, layout["storage_root"])
    native = receipt.get("native_source_identity", {})
    commit = native.get("head_commit_full", "")
    snapshot = receipt.get("source_mode") == "snapshot"
    context, built = validate_managed_build(build, commit,
        source_digest=receipt.get("source_digest") if snapshot else None,
        native_snapshot_sha256=native.get("source_snapshot_sha256") if snapshot else None)
    if native != built["native_source_identity"] or receipt.get("image_digest") != context["image_digest"] \
            or digest(build / "artifacts/build-receipt.json") != receipt.get("build_receipt_sha256"):
        raise ValueError("Browser package identity changed")
    source_mounts = [m for m in read_json(build / "receipt.json").get("mounts", [])
                     if len(m) == 4 and m[0] == "bind" and m[2] == "/source" and m[3] is False]
    if len(source_mounts) != 1:
        raise ValueError("Missing unique managed source capsule")
    capsule = storage.validate_path(host_path(source_mounts[0][1]), layout["storage_root"])
    verify_source(capsule, context["source_digest"])
    compose_path = storage.validate_path(root / "compose.json", root)
    spec = read_json(compose_path)
    expected = compose_spec(context["image_digest"], capsule / "tree",
        build / "artifacts/outputs/.fullmag/local", root / "state", port, ephemeral=True)
    if spec != expected or digest(compose_path) != receipt.get("compose_sha256"):
        raise ValueError("Browser Compose specification changed")
    container = receipt.get("container_id", "")
    attest_browser_container(container, spec, receipt["compose_project"], port)
    if docker("exec", container, "stat", "-f", "-c", "%t", "/state").lower().lstrip("0") != "1021994":
        raise ValueError("Disposable browser state is not tmpfs")
    base = f"http://127.0.0.1:{port}"
    with urllib.request.urlopen(base + "/v2/sessions", timeout=10) as response:
        raw = response.read(4 * 1024**2 + 1)
        instance = response.headers.get("x-fullmag-api-instance", "")
        if response.status != 200 or response.headers.get("x-api-contract-version") != "1.0.0" \
                or len(raw) > 4 * 1024**2 or str(uuid.UUID(instance)) != instance or uuid.UUID(instance).int == 0:
            raise ValueError("Managed API instance or contract could not be pinned")
    sessions = json.loads(raw).get("sessions")
    if not isinstance(sessions, list) or (require_fresh and sessions):
        raise ValueError("A fresh managed browser API with no sessions is required")
    if digest(path) != expected_sha256:
        raise ValueError("Managed browser receipt changed during admission")
    return {"receipt": str(path), "receipt_sha256": expected_sha256,
            "api_base": base, "api_instance": instance, "container_id": container,
            "managed_job_id": job_id, "source_digest": context["source_digest"],
            "session_storage": "disposable_tmpfs"}