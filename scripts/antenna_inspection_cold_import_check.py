"""Owned-RAM FMS roundtrip probe; not durable-storage or physics qualification.

Called only after the managed gate's real native solve and warm HTTP smokes.
No stage references, scientific records, or archive hashes are synthesized.
"""
from __future__ import annotations

import base64
from contextlib import contextmanager
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import ProxyHandler, Request, build_opener
import uuid
import zipfile

import smoke_antenna_external_lead_inspection as transport
import smoke_antenna_inspection_display as display_smoke

ORIGIN = "http://127.0.0.1:8081"
OUTPUT_ROOT = Path("/ram/result.zarr")
EXPORT_ROUTE = "/v2/sessions/current/persistence/exports"
IMPORT_ROUTE = "/v2/sessions/current/persistence/imports"
STATUS_ROUTE = "/v2/sessions/current/status"
MAX_ARCHIVE = 32 << 20
MAX_EXPORT_JSON = ((MAX_ARCHIVE + 2) // 3) * 4 + (1 << 20)
MAX_UNPACKED = 128 << 20
MAX_FIELD = 16 << 20
MAX_TOTAL_FIELDS = 64 << 20
SCHEMA = "fullmag.antenna_inspection_cold_import.v1"
require = transport.require


def post_json(path, body, *, limit=transport.MAX_METADATA_BYTES):
    """Bounded loopback-only POST; no redirects/proxies or opaque HTTP errors."""
    require(path in (EXPORT_ROUTE, IMPORT_ROUTE), "unsupported persistence mutation")
    encoded = json.dumps(body, allow_nan=False).encode()
    require(len(encoded) <= MAX_EXPORT_JSON, "persistence request exceeds bound")
    opener = build_opener(ProxyHandler({}), transport.NoRedirect())
    request = Request(ORIGIN + path, data=encoded, method="POST",
                      headers={"content-type": "application/json"})
    try:
        response = opener.open(request, timeout=60)
    except HTTPError as error:
        response = error
    with response:
        bound = limit if response.code == 200 else 4096
        raw = response.read(bound + 1)
        require(len(raw) <= bound, f"HTTP {response.code} at {path}: response exceeds bound")
        return transport.HttpResult(response.code,
            {key.lower(): value for key, value in response.headers.items()}, raw)


def success_json(response, path):
    require(response.status == 200,
            f"HTTP {response.status} at {path}: {response.body.decode('utf-8', errors='replace')}")
    return transport.json_body(response, 200)


def status():
    return transport.json_body(transport.request(ORIGIN, STATUS_ROUTE, {},
                                                 transport.MAX_METADATA_BYTES), 200)


def owner_state(value):
    # Do not compare wall-clock diagnostics or throughput with a static owner.
    return {key: value[key] for key in ("session", "run", "resources", "lifecycle")}


def capture(stage_id):
    path = ("/v2/sessions/current/data/antenna/stages/" + quote(stage_id, safe="")
            + "/external-lead-inspection")
    response = transport.request(ORIGIN, path, {}, transport.MAX_METADATA_BYTES)
    metadata = transport.json_body(response, 200)
    etag = transport.strong_etag(response)
    manifest, digest = transport.validate_resource(metadata, stage_id)
    require("current_display" in manifest, "cold V/J/H gate requires published current density")
    headers = {"x-fullmag-session-scope": transport.session_scope(
        metadata, metadata["request_scope_epoch"])}
    query = urlencode({"content_digest": digest})
    display = transport.json_body(transport.request(ORIGIN, path + "/display?" + query,
                                                    headers, transport.MAX_METADATA_BYTES), 200)
    require(display.get("capabilities") == {"display": True, "current_density": True,
        "per_ampere_basis": False, "source_fft": False, "llg_drive": False},
        "cold import must not promote inspection capabilities")
    for key in ("session_id", "session_epoch", "request_scope_epoch", "run_id",
                "runtime_stage_id", "record_content_digest", "stage_revision"):
        require(display.get(key) == metadata[key], f"display owner mismatch: {key}")
    require(display.get("content_digest") == digest, "display scientific digest mismatch")
    descriptors = {kind: manifest[kind] for kind in transport.PAYLOADS}
    descriptors.update({kind: display[kind] for kind in ("device_positions", "device_topology")})
    current = display["device_current"]
    require(current["receipt"] == manifest["current_display"], "current receipt mismatch")
    descriptors["current_snapshot"] = current["ordered_snapshot"]
    descriptors.update({kind: current[details[0]] for kind, details in display_smoke.CURRENT_CARRIERS.items()})
    sizes = [descriptor["byte_count"] for descriptor in descriptors.values()]
    require(all(type(size) is int and 0 < size <= MAX_FIELD for size in sizes)
            and sum(sizes) <= MAX_TOTAL_FIELDS, "scientific fields exceed cold gate budget")
    payloads = {}
    for kind, descriptor in descriptors.items():
        raw, _ = transport.verify_binary(ORIGIN, path + f"/payloads/{kind}?{query}",
                                        headers, kind, descriptor)
        payloads[kind] = {"sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw),
                          "unit": descriptor["unit"]}
    unchanged = transport.request(ORIGIN, path, {**headers, "If-None-Match": etag},
                                  transport.MAX_METADATA_BYTES)
    require(unchanged.status == 304 and not unchanged.body,
            "inspection changed during bounded capture")
    return {"metadata": metadata, "display": display, "payloads": payloads}


def archive_snapshot(raw, stage_id, warm):
    """Inspect genuine exported bytes without extracting or rewriting anything."""
    require(32 < len(raw) <= MAX_ARCHIVE, "exported FMS exceeds cold gate budget")
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        require(0 < len(entries) <= 10000 and len(set(names)) == len(names),
                "FMS entry count or duplicate names exceed probe contract")
        require(sum(entry.file_size for entry in entries) <= MAX_UNPACKED,
                "FMS uncompressed inventory exceeds probe budget")
        for entry in entries:
            path = PurePosixPath(entry.filename)
            require(not path.is_absolute() and ".." not in path.parts
                    and "\\" not in entry.filename
                    and not stat.S_ISLNK(entry.external_attr >> 16),
                    "FMS contains unsafe member name or symlink")
        member = archive.getinfo("project/current_live_snapshot.json")
        require(member.file_size <= transport.MAX_METADATA_BYTES, "FMS snapshot exceeds bound")
        with archive.open(member) as stream:
            snapshot_raw = stream.read(transport.MAX_METADATA_BYTES + 1)
        require(len(snapshot_raw) == member.file_size, "FMS snapshot size mismatch")
        snapshot = transport.json_body(transport.HttpResult(200,
            {"content-type": "application/json"}, snapshot_raw), 200)
        session, run = snapshot["session"], snapshot.get("run")
        require(session["session_id"] == warm["metadata"]["session_id"]
                and session["run_id"] == warm["metadata"]["run_id"], "FMS owner differs from warm solve")
        require(run is not None and run["run_id"] == session["run_id"], "FMS run mismatch")
        root = run.get("artifact_dir") or session["artifact_dir"]
        # orchestrator::run_headless uses workspace_dir.join("artifacts").
        require(root == str(OUTPUT_ROOT / "artifacts"), "FMS artifact root is not the owned native output")
        stages = [stage for stage in snapshot["stage_execution"]["stages"]
                  if stage.get("stage_id") == stage_id]
        require(len(stages) == 1 and stages[0]["status"] == "completed", "FMS lacks unique completed stage")
        relative = f"antenna/external_lead_stage_outputs/{stage_id}/antenna_external_lead_stage_output.v1.json"
        refs = stages[0].get("artifact_refs", [])
        require(refs.count(root + "/" + relative) == 1, "warm stage did not register the actual absolute record")
        prefix = f"runs/{session['run_id']}/artifacts/"
        require(prefix + relative in names, "FMS omitted registered stage record")
        manifest_ref = warm["metadata"]["outputs"][0]["manifest_ref"]
        require(prefix + manifest_ref in names, "FMS omitted inspection manifest")
        solution = str(PurePosixPath(manifest_ref).parent)
        descriptors = [warm["metadata"]["manifest"][kind] for kind in transport.PAYLOADS]
        descriptors.append(warm["metadata"]["manifest"]["current_display"]["payload"])
        require(all(prefix + solution + "/" + descriptor["path"] in names for descriptor in descriptors),
                "FMS omitted canonical scientific payload")
        return {"original_artifact_root": root, "registered_record": relative,
                "members": len(entries), "uncompressed_bytes": sum(entry.file_size for entry in entries)}


def reject_malformed_archive(raw):
    before = owner_state(status())
    response = post_json(IMPORT_ROUTE, {"fms_base64": base64.b64encode(raw[:32]).decode(),
                                       "restore_mode": "visualization_only"})
    detail = transport.json_body(response, 400)
    require(detail.get("code") == "invalid_fms_preflight"
            and str(detail.get("message", "")).startswith("invalid_fms_preflight:"),
            "malformed archive was not rejected by native FMS preflight")
    require(owner_state(status()) == before, "rejected archive changed active owner or resources")
    return {"status": "pass", "http_status": response.status, "error": detail,
            "active_owner_and_resources_unchanged": True,
            "coverage": "truncated real archive only; no traversal/hash-tampering qualification"}


@contextmanager
def hidden_output(root):
    require(root.is_dir() and not root.is_symlink() and not root.parent.is_symlink(),
            "owned scientific output is missing or linked")
    hidden = root.with_name(root.name + ".cold-hidden-" + uuid.uuid4().hex)
    require(not hidden.exists() and not hidden.is_symlink(), "cold backup collision")
    root.rename(hidden)
    try:
        require(not root.exists() and not root.is_symlink(), "original scientific root remains available")
        yield hidden
    finally:
        require(not root.exists() and not root.is_symlink(),
                f"refusing to overwrite recreated output; original retained at {hidden}")
        hidden.rename(root)


def compare_captures(warm, cold):
    require(warm["metadata"]["request_scope_epoch"] != cold["metadata"]["request_scope_epoch"],
            "import did not rotate request scope")
    for kind in ("metadata", "display"):
        # Import resets snapshot.state_version, exposed as stage_revision.
        # These owner/lifecycle tokens are not scientific content identities.
        scientific = lambda value: {key: item for key, item in value.items()
                                   if key not in ("session_epoch", "request_scope_epoch", "stage_revision")}
        require(scientific(warm[kind]) == scientific(cold[kind]), f"cold {kind} scientific data changed")
    require(warm["payloads"] == cold["payloads"], "cold scientific binary digests changed")


def require_owned_container(export_dir):
    expected = {"FULLMAG_REPO_ROOT": "/ram/workspace", "FULLMAG_STATE_ROOT": "/ram/workspace/.fullmag",
                "FULLMAG_STATE_DIR": "/ram/user-state", "FULLMAG_API_PORT": "8081"}
    require(os.name == "posix" and Path("/.dockerenv").is_file()
            and all(os.environ.get(key) == value for key, value in expected.items()),
            "cold import is restricted to the owned RAM gate container")
    require(export_dir == Path("/export") and export_dir.is_dir() and not export_dir.is_symlink(),
            "cold evidence must use the owned export mount")
    with Path("/proc/self/mountinfo").open() as stream:
        mountinfo = stream.read(1 << 20)
    require(len(mountinfo) < 1 << 20 and any(
        len(parts := line.split(" - ")) == 2 and parts[0].split()[4] == "/ram"
        and parts[1].split()[0] == "tmpfs" for line in mountinfo.splitlines()),
        "scientific output is not on the gate's tmpfs")


def output_identity(root):
    if root.is_symlink() or not root.is_dir():
        return None
    metadata = root.stat()
    return metadata.st_dev, metadata.st_ino


def verify_cold_import(stage_id: str = "stage-000", export_dir: Path = Path("/export")) -> dict:
    require_owned_container(export_dir)
    require(re.fullmatch(r"[A-Za-z0-9_-]{1,200}", stage_id) is not None, "invalid gate stage ID")
    receipt = {"schema": SCHEMA, "status": "failed", "qualification": "NOT VERIFIED",
               "physics_qualified": False, "durable_session_storage_qualified": False,
               "reuse_LLG_FFT_qualified": False, "runtime_stage_id": stage_id,
               "api_process_restarted": False, "original_output_restored": False}
    receipt_path = export_dir / "cold-import-result.json"
    require(not receipt_path.exists(), "cold evidence already exists")
    original_identity = output_identity(OUTPUT_ROOT)
    require(original_identity is not None, "owned scientific output is missing or linked")
    try:
        warm = capture(stage_id)
        exported = success_json(post_json(EXPORT_ROUTE, {"profile": "archive", "compression": "speed"},
                                         limit=MAX_EXPORT_JSON), EXPORT_ROUTE)
        require(exported.get("profile") == "archive" and exported.get("session_id")
                == warm["metadata"]["session_id"], "export profile/owner mismatch")
        raw = base64.b64decode(exported["fms_base64"], validate=True)
        require(len(raw) == exported["size_bytes"], "exported FMS byte count mismatch")
        with (export_dir / "antenna-cold.fms").open("xb") as stream:
            stream.write(raw)
        receipt["archive"] = {"sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw),
                              **archive_snapshot(raw, stage_id, warm)}
        receipt["malformed_archive"] = reject_malformed_archive(raw)
        with hidden_output(OUTPUT_ROOT):
            imported = success_json(post_json(IMPORT_ROUTE, {"fms_base64": exported["fms_base64"],
                                               "restore_mode": "visualization_only"}), IMPORT_ROUTE)
            require(imported.get("session_id") == exported["session_id"]
                    and imported.get("restore_mode") == "visualization_only", "unexpected import response")
            cold = capture(stage_id)
            compare_captures(warm, cold)
            receipt["display_smoke"] = display_smoke.verify(ORIGIN, stage_id)
            require(receipt["display_smoke"].get("status") == "passed"
                    and receipt["display_smoke"].get("physics_qualified") is False,
                    "cold display smoke failed or promoted qualification")
            require(not OUTPUT_ROOT.exists(), "cold reads recreated or reused original output")
            old_scope = {"x-fullmag-session-scope": transport.session_scope(
                warm["metadata"], warm["metadata"]["request_scope_epoch"])}
            path = "/v2/sessions/current/" + warm["metadata"]["resource_id"]
            stale = transport.json_body(transport.request(ORIGIN, path, old_scope,
                                                         transport.MAX_METADATA_BYTES), 409)
            require(stale.get("error") == "request_context_stale", "old request scope was not fenced")
            receipt.update(status="pass", qualification="owned_RAM_archive_HTTP_roundtrip_only",
                original_root_unavailable_during_import_and_reads=True,
                warm_request_scope=warm["metadata"]["request_scope_epoch"],
                cold_request_scope=cold["metadata"]["request_scope_epoch"],
                warm_stage_revision=warm["metadata"]["stage_revision"],
                cold_stage_revision=cold["metadata"]["stage_revision"],
                metadata=cold["metadata"], display=cold["display"], payloads=cold["payloads"],
                old_request_scope_rejected=True, import_response=imported)
    except Exception as error:
        receipt.update(status="failed", error=str(error))
        raise
    finally:
        receipt["original_output_restored"] = output_identity(OUTPUT_ROOT) == original_identity
        encoded = json.dumps(receipt, sort_keys=True, allow_nan=False)
        require(len(encoded.encode()) <= 4 << 20, "cold receipt exceeds bound")
        with receipt_path.open("x") as stream:
            stream.write(encoded)
    return receipt
