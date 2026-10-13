"""Interpreted/frozen probe regressions; not native archive or physics evidence."""
import base64
import copy
import io
import json
from pathlib import Path
import zipfile

import pytest

from scripts import antenna_inspection_cold_import_check as probe
from test_smoke_antenna_inspection_display import FrozenInspection


def response(body, status=200):
    return probe.transport.HttpResult(status, {"content-type": "application/json"},
                                      json.dumps(body).encode())


def capture_fixture(monkeypatch):
    fixture = FrozenInspection(2)
    monkeypatch.setattr(probe.transport, "request", fixture.serve)
    return probe.capture("stage-000")


def archive_bytes(warm, root, *, mutation=None):
    relative = "antenna/external_lead_stage_outputs/stage-000/antenna_external_lead_stage_output.v1.json"
    snapshot = {"session": {"session_id": "session", "run_id": "run", "artifact_dir": str(root / "artifacts")},
                "run": {"run_id": "run", "artifact_dir": str(root / "artifacts")},
                "stage_execution": {"stages": [{"stage_id": "stage-000", "status": "completed",
                                                  "artifact_refs": [str(root / "artifacts") + "/" + relative]}]}}
    if mutation == "foreign_root": snapshot["run"]["artifact_dir"] = "/foreign/artifacts"
    if mutation == "wrong_run": snapshot["run"]["run_id"] = "other"
    if mutation == "duplicate_stage": snapshot["stage_execution"]["stages"] *= 2
    if mutation == "missing_ref": snapshot["stage_execution"]["stages"][0]["artifact_refs"] = []
    prefix = "runs/run/artifacts/"
    manifest_ref = warm["metadata"]["outputs"][0]["manifest_ref"]
    manifest = warm["metadata"]["manifest"]
    members = {"project/current_live_snapshot.json": json.dumps(snapshot).encode(),
               prefix + relative: b"frozen test record, never submitted to native API",
               prefix + manifest_ref: b"frozen test manifest"}
    for descriptor in [manifest[kind] for kind in probe.transport.PAYLOADS] + [manifest["current_display"]["payload"]]:
        members[prefix + str(Path(manifest_ref).parent).replace("\\", "/") + "/" + descriptor["path"]] = b"frozen"
    if mutation == "missing_record": del members[prefix + relative]
    if mutation == "missing_payload": members.pop(next(name for name in members if name.endswith("H.f64le.bin")))
    if mutation == "unsafe_member": members["../escape"] = b"x"
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, raw in members.items(): archive.writestr(name, raw)
    return output.getvalue()


def test_capture_reads_actual_frozen_bytes_and_requires_v_j_h(monkeypatch):
    result = capture_fixture(monkeypatch)
    assert len(result["payloads"]) == 12
    assert result["payloads"]["device_potential"]["unit"] == "V"
    assert result["payloads"]["current_center_density"]["unit"] == "A/m^2"
    assert result["payloads"]["magnetic_field"]["unit"] == "A/m"
    fixture = FrozenInspection(1)
    monkeypatch.setattr(probe.transport, "request", fixture.serve)
    with pytest.raises(ValueError, match="requires published current"):
        probe.capture("stage-000")


def test_archive_inventory_uses_existing_exact_refs_without_rewriting(monkeypatch, tmp_path):
    warm = capture_fixture(monkeypatch)
    root = tmp_path / "result.zarr"
    monkeypatch.setattr(probe, "OUTPUT_ROOT", root)
    raw = archive_bytes(warm, root)
    before = bytes(raw)
    result = probe.archive_snapshot(raw, "stage-000", warm)
    assert result["original_artifact_root"] == str(root / "artifacts")
    assert result["members"] == 9 and raw == before


@pytest.mark.parametrize("mutation", ["foreign_root", "wrong_run", "duplicate_stage", "missing_ref",
                                     "missing_record", "missing_payload", "unsafe_member"])
def test_archive_inventory_fails_closed(monkeypatch, tmp_path, mutation):
    warm = capture_fixture(monkeypatch)
    root = tmp_path / "result.zarr"
    monkeypatch.setattr(probe, "OUTPUT_ROOT", root)
    with pytest.raises(ValueError):
        probe.archive_snapshot(archive_bytes(warm, root, mutation=mutation), "stage-000", warm)


def test_hidden_output_restores_original_on_failure(tmp_path):
    root = tmp_path / "result.zarr"
    root.mkdir()
    (root / "payload").write_bytes(b"original")
    with pytest.raises(RuntimeError, match="import failed"):
        with probe.hidden_output(root) as hidden:
            assert not root.exists() and (hidden / "payload").read_bytes() == b"original"
            raise RuntimeError("import failed")
    assert (root / "payload").read_bytes() == b"original"
    assert not list(tmp_path.glob("*.cold-hidden-*"))


def test_hidden_output_never_overwrites_recreated_root(tmp_path):
    root = tmp_path / "result.zarr"
    root.mkdir()
    (root / "payload").write_bytes(b"original")
    with pytest.raises(ValueError, match="refusing to overwrite"):
        with probe.hidden_output(root):
            root.mkdir()
            (root / "payload").write_bytes(b"new owner")
    assert (root / "payload").read_bytes() == b"new owner"
    hidden, = tmp_path.glob("*.cold-hidden-*")
    assert (hidden / "payload").read_bytes() == b"original"


@pytest.mark.parametrize("mutation", ["same_scope", "metadata", "display", "binary"])
def test_comparison_rejects_scientific_drift_or_missing_rekey(monkeypatch, mutation):
    warm = capture_fixture(monkeypatch)
    cold = copy.deepcopy(warm)
    cold["metadata"]["request_scope_epoch"] += "-new"
    cold["display"]["request_scope_epoch"] += "-new"
    cold["metadata"]["stage_revision"] = cold["display"]["stage_revision"] = 0
    probe.compare_captures(warm, cold)
    if mutation == "same_scope": cold = copy.deepcopy(warm)
    elif mutation == "metadata": cold["metadata"]["record_content_digest"] = "sha256:" + "0" * 64
    elif mutation == "display": cold["display"]["device_node_count"] += 1
    else: cold["payloads"]["magnetic_field"]["sha256"] = "0" * 64
    with pytest.raises(ValueError): probe.compare_captures(warm, cold)


def owner():
    return {"session": {"session_id": "session", "request_scope_epoch": "api:1"},
            "run": {"run_id": "run"}, "resources": {"revision": 1}, "lifecycle": {"state": "completed"}}


@pytest.mark.parametrize("mutation", [None, "accepted", "wrong_error", "owner_changed"])
def test_malformed_probe_preserves_owner_and_requires_native_preflight(monkeypatch, mutation):
    reads = []
    def current():
        result = owner()
        if reads and mutation == "owner_changed": result["resources"]["revision"] += 1
        reads.append(True)
        return result
    def post(path, body):
        assert path == probe.IMPORT_ROUTE
        assert body["restore_mode"] == "visualization_only"
        assert base64.b64decode(body["fms_base64"]) == b"x" * 32
        return response({"code": "invalid_fms_preflight", "message": "invalid_fms_preflight: invalid ZIP"
                         if mutation != "wrong_error" else "different failure"},
                        200 if mutation == "accepted" else 400)
    monkeypatch.setattr(probe, "status", current)
    monkeypatch.setattr(probe, "post_json", post)
    if mutation:
        with pytest.raises(ValueError): probe.reject_malformed_archive(b"x" * 100)
    else:
        result = probe.reject_malformed_archive(b"x" * 100)
        assert result["status"] == "pass" and result["active_owner_and_resources_unchanged"]


@pytest.mark.parametrize("failure", [None, "export", "import", "capture", "scientific_drift"])
def test_probe_lifecycle_restores_output_and_retains_bounded_evidence(monkeypatch, tmp_path, failure):
    warm = capture_fixture(monkeypatch)
    root = tmp_path / "result.zarr"
    (root / "artifacts").mkdir(parents=True)
    (root / "artifacts" / "original").write_bytes(b"retained")
    export = tmp_path / "export"
    export.mkdir()
    monkeypatch.setattr(probe, "OUTPUT_ROOT", root)
    monkeypatch.setattr(probe, "require_owned_container", lambda path: None)
    raw = archive_bytes(warm, root)
    calls = []
    def capture(stage):
        if not calls: return warm
        assert not root.exists()
        if failure == "capture": raise ValueError("cold read failed")
        cold = copy.deepcopy(warm)
        for name in ("metadata", "display"): cold[name]["request_scope_epoch"] += "-new"
        if failure == "scientific_drift": cold["payloads"]["magnetic_field"]["sha256"] = "bad"
        return cold
    def post(path, body, **kwargs):
        if path == probe.EXPORT_ROUTE:
            assert body == {"profile": "archive", "compression": "speed"}
            if failure == "export": return response({"message": "actual canonical script blocker"}, 409)
            return response({"profile": "archive", "session_id": "session", "size_bytes": len(raw),
                             "fms_base64": base64.b64encode(raw).decode()})
        assert path == probe.IMPORT_ROUTE and not root.exists()
        assert base64.b64decode(body["fms_base64"]) == raw
        calls.append("import")
        if failure == "import": return response({"message": "actual native import blocker"}, 400)
        return response({"session_id": "session", "restore_mode": "visualization_only"})
    monkeypatch.setattr(probe, "capture", capture)
    monkeypatch.setattr(probe, "post_json", post)
    monkeypatch.setattr(probe, "reject_malformed_archive", lambda value: {"status": "pass"})
    monkeypatch.setattr(probe.display_smoke, "verify", lambda *args: {"status": "passed", "physics_qualified": False})
    monkeypatch.setattr(probe.transport, "request", lambda *args: response({"error": "request_context_stale"}, 409))
    if failure:
        with pytest.raises(ValueError): probe.verify_cold_import("stage-000", export)
    else:
        result = probe.verify_cold_import("stage-000", export)
        assert result["status"] == "pass" and result["durable_session_storage_qualified"] is False
        assert result["physics_qualified"] is False and result["old_request_scope_rejected"]
    assert (root / "artifacts" / "original").read_bytes() == b"retained"
    assert not list(tmp_path.glob("*.cold-hidden-*"))
    receipt = json.loads((export / "cold-import-result.json").read_text())
    assert receipt["original_output_restored"] is True
    assert receipt["status"] == ("failed" if failure else "pass")
    if failure == "export": assert "actual canonical script blocker" in receipt["error"]
    if failure == "import": assert "actual native import blocker" in receipt["error"]
    if failure != "export": assert (export / "antenna-cold.fms").read_bytes() == raw


def test_host_call_is_refused_before_network_or_mutation(monkeypatch, tmp_path):
    monkeypatch.setattr(probe.os, "environ", {})
    monkeypatch.setattr(probe, "capture", lambda *args: pytest.fail("unexpected network"))
    with pytest.raises(ValueError, match="owned RAM gate container"):
        probe.verify_cold_import(export_dir=tmp_path)
    assert list(tmp_path.iterdir()) == []


def test_post_is_fixed_origin_bounded_and_does_not_follow_redirects(monkeypatch):
    class Reply:
        code = 409
        headers = {"content-type": "application/json"}
        def __enter__(self): return self
        def __exit__(self, *args): return False
        def read(self, size):
            assert size == 4097
            return b'{"message":"exact failure"}'
    class Opener:
        def open(self, request, timeout):
            assert request.full_url == "http://127.0.0.1:8081" + probe.EXPORT_ROUTE
            assert request.method == "POST" and timeout == 60
            return Reply()
    def build(*handlers):
        assert any(isinstance(handler, probe.transport.NoRedirect) for handler in handlers)
        return Opener()
    monkeypatch.setattr(probe, "build_opener", build)
    result = probe.post_json(probe.EXPORT_ROUTE, {"profile": "archive"})
    with pytest.raises(ValueError, match="HTTP 409.*exact failure"):
        probe.success_json(result, probe.EXPORT_ROUTE)
    with pytest.raises(ValueError, match="unsupported persistence mutation"):
        probe.post_json("http://localhost:3197/workspace", {})
