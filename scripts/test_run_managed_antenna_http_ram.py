"""Interpreted lifecycle/isolation regressions; never compile native tests."""
import json
import io
from pathlib import Path
import subprocess
import shutil
import sys

import pytest
from scripts import run_managed_antenna_http_ram as gate
import run_managed_antenna_ram as ram


def test_sha_supports_container_python_without_file_digest(tmp_path, monkeypatch):
    monkeypatch.delattr(gate.hashlib, "file_digest", raising=False)
    payload = b"abc" * 30000
    path = tmp_path / "bounded-tool.py"
    path.write_bytes(payload)
    assert gate.sha(path) == gate.hashlib.sha256(payload).hexdigest()


def test_http_error_preserves_bounded_real_failure(monkeypatch):
    class Opener:
        def open(self, url, timeout):
            raise gate.HTTPError(url, 404, "missing", {}, io.BytesIO(b"x" * 9000))
    monkeypatch.setattr(gate, "build_opener", lambda *args: Opener())
    with pytest.raises(ValueError) as caught:
        gate.get_json("/missing")
    assert str(caught.value) == "HTTP 404 at /missing: " + "x" * 4096


def terminal_status():
    return {"session": {"session_id": "session", "session_epoch": "scientific@123",
                        "request_scope_epoch": "api-instance:7"},
            "run": {"run_id": "run"}, "resources": {"fields": {"revision": 3}},
            "lifecycle": {"connectivity": "connected"}}


def owner_error(code):
    message = "terminal_snapshot_owner_stale" if code == 409 else "invalid terminal snapshot owner header"
    error_code = message if code == 409 else "bad_request"
    return json.dumps({"code": error_code, "error": message, "message": message}).encode()


def test_terminal_owner_probe_checks_real_rejections_without_scientific_injection(monkeypatch):
    requests = []
    status = terminal_status()
    monkeypatch.setattr(gate, "get_json", lambda path: status)
    class Opener:
        def open(self, request, timeout):
            assert timeout == 5
            assert request.full_url.endswith("/internal/live/snapshot")
            body = json.loads(request.data)
            assert set(body) == {"session_id", "metadata"}
            guard = json.loads(request.get_header("X-fullmag-terminal-owner"))
            requests.append(guard)
            code = 400 if "unknown" in guard else 409
            raise gate.HTTPError(request.full_url, code, "rejected", {}, io.BytesIO(owner_error(code)))
    monkeypatch.setattr(gate, "build_opener", lambda *args: Opener())
    result = gate.reject_stale_terminal_owners()
    assert result["status"] == "pass" and len(result["cases"]) == 5
    assert result["concurrent_race_qualified"] is False
    assert result["timeout_qualified"] is False
    assert requests[0]["session_epoch"] == 7
    assert requests[1]["session_epoch"] == 8


@pytest.mark.parametrize("failure", ["accepted", "wrong_code", "oversized", "changed_resources",
                                     "changed_lifecycle", "unrelated_error", "wrong_guard_code"])
def test_terminal_owner_probe_fails_closed(monkeypatch, failure):
    calls = []
    def status(path):
        value = terminal_status()
        if calls and failure == "changed_resources":
            value["resources"]["fields"]["revision"] = 4
        if calls and failure == "changed_lifecycle":
            value["lifecycle"]["connectivity"] = "degraded"
        return value
    monkeypatch.setattr(gate, "get_json", status)
    class Response:
        status = 200
        def __enter__(self): return self
        def __exit__(self, *args): return False
    class Opener:
        def open(self, request, timeout):
            calls.append(request)
            if failure == "accepted": return Response()
            guard = json.loads(request.get_header("X-fullmag-terminal-owner"))
            code = 400 if "unknown" in guard else 409
            if failure == "wrong_code": code = 500
            body = b"x" * 5000 if failure == "oversized" else owner_error(code)
            if failure == "unrelated_error": body = b'{}'
            if failure == "wrong_guard_code" and code == 400:
                detail = json.loads(body)
                detail["code"] = "unrelated_error"
                body = json.dumps(detail).encode()
            raise gate.HTTPError(request.full_url, code, "rejected", {}, io.BytesIO(body))
    monkeypatch.setattr(gate, "build_opener", lambda *args: Opener())
    with pytest.raises(ValueError):
        gate.reject_stale_terminal_owners()


def document(tmp_path):
    return gate.http_spec("sha256:" + "a" * 64, tmp_path / "source",
        tmp_path / "package", tmp_path / "input", tmp_path / "export", tmp_path / "tools")


def inspection(spec):
    service = spec["services"]["antenna"]
    return [{"Image": service["image"], "Config": {"User": "65532:65532",
        "Cmd": service["command"], "Entrypoint": [], "WorkingDir": service["working_dir"],
        "Env": [f"{key}={value}" for key, value in service["environment"].items()],
        "Labels": {"com.docker.compose.project": "project", "com.docker.compose.service": "antenna"}},
        "HostConfig": {"NetworkMode": "none", "PortBindings": {}, "ReadonlyRootfs": True,
            "Privileged": False, "CapDrop": ["ALL"], "SecurityOpt": ["no-new-privileges:true"],
            "Memory": 2 * 1024**3, "NanoCpus": 2 * 10**9, "PidsLimit": 128,
            "Tmpfs": {"/tmp": "rw,nosuid,nodev,size=64m", "/ram": "rw,nosuid,nodev,size=768m,mode=1777"}},
        "Mounts": [{"Type": "bind", "Source": m["source"], "Destination": m["target"],
                    "RW": not m["read_only"]} for m in service["volumes"]]}]


def test_readonly_tools_are_distinct_from_capsule_and_state_is_ram(tmp_path):
    spec = document(tmp_path)
    service = spec["services"]["antenna"]
    assert "ports" not in service and service["network_mode"] == "none"
    assert [(m["target"], m["read_only"]) for m in service["volumes"]] == [
        ("/source", True), ("/package", True), ("/input", True),
        ("/export", False), ("/tools", True)]
    assert service["environment"]["FULLMAG_API_PORT"] == "8081"
    assert service["environment"]["FULLMAG_STATE_ROOT"] == "/ram/workspace/.fullmag"
    assert service["environment"]["FULLMAG_STATE_DIR"] == "/ram/user-state"
    assert service["command"] == ["python3", "-I", "-B", "/tools/run_managed_antenna_http_ram.py", "execute"]


def test_cold_mode_is_explicit_and_does_not_change_isolation(tmp_path):
    warm = document(tmp_path)
    cold = gate.http_spec("sha256:" + "a" * 64, tmp_path / "source",
        tmp_path / "package", tmp_path / "input", tmp_path / "export", tmp_path / "tools", True)
    warm["services"]["antenna"]["command"].append("--verify-cold-import")
    assert cold == warm
    with pytest.raises(ValueError, match="Invalid cold import gate mode"):
        gate.http_spec("image", tmp_path, tmp_path, tmp_path, tmp_path, tmp_path, "yes")


def test_standalone_command_is_explicit_and_preserves_isolation(tmp_path):
    warm = document(tmp_path)
    standalone = gate.http_spec("sha256:" + "a" * 64, tmp_path / "source",
        tmp_path / "package", tmp_path / "input", tmp_path / "export", tmp_path / "tools",
        standalone=True)
    warm["services"]["antenna"]["command"].append("--standalone")
    assert standalone == warm
    with pytest.raises(ValueError, match="standalone gate mode"):
        gate.http_spec("image", tmp_path, tmp_path, tmp_path, tmp_path, tmp_path, standalone="yes")


@pytest.mark.parametrize("mutation", [None, "fields", "missing_catalog", "malformed_catalog",
    "duplicate_m", "capability", "solver", "materialization", "requestable", "materializable",
    "mesh", "ownership"])
def test_standalone_read_model_rejects_magnetic_carriers_and_stale_ownership(monkeypatch, mutation):
    entries = [{"id": quantity, "capability_state": "unsupported", "solver_capability": "unsupported",
                "materialization_state": "unsupported", "requestable": False, "materializable": False}
               for quantity in ("m", "H_eff", "H_demag")]
    fields, catalog, mesh = {"quantities": []}, {"quantities": entries}, {"revision": 1}
    if mutation == "fields": fields["quantities"] = [{"quantity_id": "m"}]
    elif mutation == "missing_catalog": entries.pop()
    elif mutation == "malformed_catalog": entries.append("m")
    elif mutation == "duplicate_m": entries.append(dict(entries[0]))
    elif mutation == "capability": entries[0]["capability_state"] = "supported"
    elif mutation == "solver": entries[0]["solver_capability"] = "supported"
    elif mutation == "materialization": entries[0]["materialization_state"] = "complete"
    elif mutation in ("requestable", "materializable"): entries[0][mutation] = True
    elif mutation == "mesh": mesh["mesh_summary"] = {"node_count": 4}
    calls = []
    def fetch(path):
        calls.append(path)
        if path.endswith("/status"):
            status = terminal_status()
            if mutation == "ownership" and len(calls) > 1:
                status["session"]["request_scope_epoch"] = "other:8"
            return status
        return {"/v2/sessions/current/data/fields": fields,
                "/v2/sessions/current/data/quantities": catalog,
                "/v2/sessions/current/meshing/summary": mesh}[path]
    monkeypatch.setattr(gate, "get_json", fetch)
    if mutation is None:
        result = gate.check_standalone_read_model()
        assert result["status"] == "pass"
        assert result["transition_from_magnetic_session_qualified"] is False
        assert result["field_catalog"] == fields
        assert len(calls) == 5
    else:
        with pytest.raises(ValueError, match="Standalone"):
            gate.check_standalone_read_model()


@pytest.mark.parametrize("mutation", [None, "missing_proof", "wrong_variant", "input", "manifest"])
def test_standalone_http_observer_requires_bound_input_and_read_model_proof(tmp_path, monkeypatch, mutation):
    root, receipt, result, observed, _ = retained_gate(tmp_path, monkeypatch)
    generated = b"standalone fixture"
    script = root / "input" / ram.SCRIPT_NAME
    script.write_bytes(generated)
    hashes = {**receipt["fixture_sha256"], ram.SCRIPT_NAME: gate.sha(script)}
    monkeypatch.setattr(ram, "fixture_identity", lambda *args, **kwargs: ({}, hashes, generated))
    manifest = {"tools_sha256": receipt["tools_sha256"], "fixture_sha256": hashes,
                "solver_capsule_attribution": False, "fixture_variant": "standalone"}
    if mutation == "manifest": manifest["fixture_variant"] = "magnetic_probe"
    (root / "tools/manifest.json").write_text(json.dumps(manifest))
    spec = json.loads((root / "compose.json").read_text())
    spec["services"]["antenna"]["command"].append("--standalone")
    observed["Config"]["Cmd"] = spec["services"]["antenna"]["command"]
    (root / "compose.json").write_text(json.dumps(spec))
    receipt.update(fixture_variant="standalone", fixture_sha256=hashes,
                   tool_manifest_sha256=gate.sha(root / "tools/manifest.json"),
                   compose_sha256=gate.sha(root / "compose.json"))
    result.update(fixture_variant="standalone", standalone_read_model={"status": "pass"},
                  tool_manifest_sha256=receipt["tool_manifest_sha256"])
    if mutation == "missing_proof": result.pop("standalone_read_model")
    elif mutation == "wrong_variant": result["fixture_variant"] = "magnetic_probe"
    elif mutation == "input": script.write_bytes(b"changed input")
    (root / "receipt.json").write_text(json.dumps(receipt))
    (root / "export/gate-result.json").write_text(json.dumps(result))
    if mutation is None:
        assert gate.observe(tmp_path, root)["state"] == "warm_http_pass_resources_retained"
    else:
        with pytest.raises(ValueError):
            gate.observe(tmp_path, root)


@pytest.mark.parametrize("mutation", ["tools_rw", "ports", "network", "state", "image", "command", "tmpfs"])
def test_changed_runtime_is_rejected(tmp_path, monkeypatch, mutation):
    spec = document(tmp_path)
    observed = inspection(spec)
    item = observed[0]
    if mutation == "tools_rw": item["Mounts"][-1]["RW"] = True
    elif mutation == "ports": item["HostConfig"]["PortBindings"] = {"8081/tcp": [{}]}
    elif mutation == "network": item["HostConfig"]["NetworkMode"] = "bridge"
    elif mutation == "state": item["Config"]["Env"].append("FULLMAG_STATE_ROOT=/export")
    elif mutation == "image": item["Image"] = "sha256:" + "b" * 64
    elif mutation == "command": item["Config"]["Cmd"] = ["true"]
    elif mutation == "tmpfs": item["HostConfig"]["Tmpfs"]["/ram"] = "rw,size=2g"
    monkeypatch.setattr(ram, "docker", lambda *args: json.dumps(observed))
    with pytest.raises(ValueError):
        ram.attest("container", spec, "project")


def test_exact_runtime_is_attested(tmp_path, monkeypatch):
    spec = document(tmp_path)
    observed = inspection(spec)
    monkeypatch.setattr(ram, "docker", lambda *args: json.dumps(observed))
    assert ram.attest("container", spec, "project") == observed[0]


def test_pin_host_tools_and_reject_tampering(tmp_path):
    for name in gate.TOOLS:
        (tmp_path / name).write_bytes(name.encode())
    manifest = gate.tool_manifest(tmp_path)
    gate.check_tools(tmp_path, manifest)
    (tmp_path / gate.TOOLS[1]).write_bytes(b"changed")
    with pytest.raises(ValueError, match="identity changed"):
        gate.check_tools(tmp_path, manifest)
    with pytest.raises(ValueError, match="identity changed"):
        gate.check_tools(tmp_path, {**manifest, "unowned.py": "a" * 64})


def test_tool_manifest_matches_actual_import_dependencies():
    repo = Path(__file__).resolve().parents[1]
    manifest = gate.tool_manifest(repo / "scripts")
    assert set(manifest) == set(gate.TOOLS)
    assert "antenna_current_source_oracle.py" in manifest
    assert "run_managed_antenna_ram.py" not in manifest


def test_cold_probe_imports_with_only_pinned_tools_in_isolated_python(tmp_path):
    repo = Path(__file__).resolve().parents[1]
    for name in gate.TOOLS:
        shutil.copyfile(repo / "scripts" / name, tmp_path / name)
    code = "import sys; sys.path.insert(0,sys.argv[1]); import antenna_inspection_cold_import_check"
    result = subprocess.run([sys.executable, "-I", "-B", "-c", code, str(tmp_path)],
                            cwd=tmp_path, capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr


def test_smoke_runs_pinned_tools_with_bounded_timeout(tmp_path, monkeypatch):
    calls = []
    def run(command, **kwargs):
        calls.append((command, kwargs))
        kwargs["stdout"].write(json.dumps({"status": "passed", "physics_qualified": False}).encode())
        return subprocess.CompletedProcess(command, 0)
    monkeypatch.setattr(gate.subprocess, "run", run)
    result = gate.smoke("smoke_antenna_inspection_display.py", "stage-000", tmp_path)
    assert result["status"] == "passed"
    command, options = calls[0]
    assert command[-5:] == ["/tools/smoke_antenna_inspection_display.py", "--origin", gate.ORIGIN,
                           "--stage-id", "stage-000"]
    assert command[1:4] == ["-I", "-B", "-c"]
    assert options["timeout"] == 120


@pytest.mark.parametrize("result,code", [({"status": "fail", "physics_qualified": False}, 0),
    ({"status": "passed", "physics_qualified": True}, 0),
    ({"status": "passed", "physics_qualified": False}, 1),
    ({"status": "pass", "physics_qualified": False}, 0)])
def test_smoke_failure_and_scope_promotion_rejected(tmp_path, monkeypatch, result, code):
    def run(command, **kwargs):
        kwargs["stdout"].write(json.dumps(result).encode())
        return subprocess.CompletedProcess(command, code)
    monkeypatch.setattr(gate.subprocess, "run", run)
    with pytest.raises(ValueError):
        gate.smoke("smoke_antenna_inspection_display.py", "stage-000", tmp_path)


def test_api_readiness_requires_real_inspection_contract(monkeypatch):
    class Api:
        def poll(self): return None
    calls = []
    def fetch(path):
        calls.append(path)
        route = "/v2/sessions/current/data/antenna/stages/{stage_id}/external-lead-inspection"
        return {"paths": {route + suffix: {} for suffix in ("", "/display", "/payloads/{payload_kind}")}}
    monkeypatch.setattr(gate, "get_json", fetch)
    gate.wait_api(Api())
    assert calls == ["/v2/platform/openapi.json"]


def test_api_exit_fails_before_solver(monkeypatch):
    class Api:
        def poll(self): return 1
    monkeypatch.setattr(gate, "get_json", lambda *args: pytest.fail("dead API must not be read"))
    with pytest.raises(ValueError, match="exited"):
        gate.wait_api(Api())


def test_timeout_stops_only_owned_api():
    class Api:
        def __init__(self): self.calls = []
        def poll(self): return None
        def terminate(self): self.calls.append("terminate")
        def kill(self): self.calls.append("kill")
        def wait(self, timeout):
            self.calls.append(("wait", timeout))
            if "kill" not in self.calls: raise subprocess.TimeoutExpired("owned-api", timeout)
    api = Api()
    gate.stop_owned(api)
    assert api.calls == ["terminate", ("wait", 10), "kill", ("wait", 10)]


def test_nonterminal_build_prevents_storage_and_docker(tmp_path, monkeypatch):
    import fullmag_storage as storage
    import run_managed_browser as browser
    def reject(*args): raise ValueError("Managed CPU release must be terminal and successful")
    monkeypatch.setattr(gate, "resolved", reject)
    monkeypatch.setattr(storage, "initialize", lambda *args: pytest.fail("no writes"))
    monkeypatch.setattr(browser, "docker", lambda *args: pytest.fail("no Docker"))
    with pytest.raises(ValueError, match="terminal"):
        gate.start(tmp_path, "a" * 32, "b" * 40, "c" * 64, "d" * 64)


def retained_gate(tmp_path, monkeypatch):
    import fullmag_storage as storage
    import verify_saved_fem_archive_roundtrip as archive
    root = tmp_path / "runs" / ("1" * 32)
    root.mkdir(parents=True)
    for name in ("tools", "input", "export"):
        (root / name).mkdir()
    fixture = root / "input/fem_antenna_current_source_inspection.py"
    fixture.write_bytes(b"fixed")
    fixtures = {fixture.name: gate.sha(fixture)}
    monkeypatch.setattr(ram, "FIXTURE_FILES", fixtures)
    tools = root / "tools"
    for name in gate.TOOLS:
        (tools / name).write_bytes(name.encode())
    tool_digests = gate.tool_manifest(tools)
    (tools / "manifest.json").write_text(json.dumps({"tools_sha256": tool_digests,
        "fixture_sha256": fixtures, "solver_capsule_attribution": False}))
    build, capsule, package = tmp_path / "build", tmp_path / "capsule", tmp_path / "package"
    (build / "artifacts").mkdir(parents=True)
    (build / "artifacts/build-receipt.json").write_bytes(b"build receipt")
    native = {"head_commit_full": "a" * 40, "source_snapshot_sha256": "b" * 64,
              "source_snapshot_dirty": True}
    image = "sha256:" + "c" * 64
    spec = gate.http_spec(image, capsule / "tree", package, root / "input", root / "export", tools)
    (root / "compose.json").write_text(json.dumps(spec))
    receipt = {"schema": gate.SCHEMA, "run_root": str(root),
        "compose_sha256": gate.sha(root / "compose.json"), "managed_job_id": "d" * 32,
        "source_digest": "e" * 64, "native_source_identity": native, "image_digest": image,
        "tools_sha256": tool_digests, "tool_manifest_sha256": gate.sha(tools / "manifest.json"),
        "fixture_sha256": fixtures, "build_receipt_sha256": gate.sha(build / "artifacts/build-receipt.json"),
        "compose_project": "fullmag-antenna-http-ram-" + root.name, "container_id": "owned"}
    (root / "receipt.json").write_text(json.dumps(receipt))
    result = {"schema": gate.SCHEMA, "state": "warm_http_pass", "solver_exit_code": 0,
        "native_canonical_bundle_redecoded": True, "physics_qualified": False,
        "durable_session_storage_qualified": False, "reuse_LLG_FFT_qualified": False,
        "tool_manifest_sha256": receipt["tool_manifest_sha256"]}
    (root / "export/gate-result.json").write_text(json.dumps(result))
    for log in ("api.log", "solver.log"):
        (root / "export" / log).write_text("startup")
    (root / "export/result.zarr").mkdir()
    monkeypatch.setattr(storage, "resolve_layout", lambda *args: {"build_root": str(tmp_path)})
    def resolved(*args):
        assert args[1:] == ("d" * 32, "a" * 40, "e" * 64, "b" * 64)
        return {}, build, {"image_digest": image}, {"native_source_identity": native}, capsule, package
    monkeypatch.setattr(gate, "resolved", resolved)
    observed = inspection(spec)[0]
    observed["Config"]["Labels"]["com.docker.compose.project"] = receipt["compose_project"]
    observed["State"] = {"Status": "exited", "Running": False, "ExitCode": 0,
                         "OOMKilled": False, "Error": ""}
    monkeypatch.setattr(ram, "docker", lambda *args: json.dumps([observed]))
    stamps = []
    monkeypatch.setattr(archive, "check_stamp", lambda *args, **kwargs: stamps.append((args, kwargs)))
    return root, receipt, result, observed, stamps


def test_terminal_gate_verifies_both_startup_identities(tmp_path, monkeypatch):
    root, receipt, _, _, stamps = retained_gate(tmp_path, monkeypatch)
    result = gate.observe(tmp_path, root)
    assert result["state"] == "warm_http_pass_resources_retained"
    assert len(stamps) == 2
    assert all(args[1:] == ("a" * 40, "b" * 64) and kwargs == {"dirty": True}
               for args, kwargs in stamps)
    stored = json.loads((root / "receipt.json").read_text())
    assert stored["cold_archive_import"] == "NOT VERIFIED"
    assert stored["gate_result_sha256"] == gate.sha(root / "export/gate-result.json")


@pytest.mark.parametrize("mutation", ["exit", "oom", "result", "scope", "canonical",
    "tools", "fixture", "image", "startup"])
def test_failed_or_tampered_terminal_gate_cannot_pass(tmp_path, monkeypatch, mutation):
    import verify_saved_fem_archive_roundtrip as archive
    root, receipt, result, observed, _ = retained_gate(tmp_path, monkeypatch)
    if mutation == "exit": observed["State"]["ExitCode"] = 1
    elif mutation == "oom": observed["State"]["OOMKilled"] = True
    elif mutation == "result": result["state"] = "failed"
    elif mutation == "scope": result["physics_qualified"] = True
    elif mutation == "canonical": result["native_canonical_bundle_redecoded"] = False
    elif mutation == "tools": (root / "tools" / gate.TOOLS[1]).write_bytes(b"changed")
    elif mutation == "fixture": (root / "input/fem_antenna_current_source_inspection.py").write_bytes(b"changed")
    elif mutation == "image": receipt["image_digest"] = "sha256:" + "f" * 64
    elif mutation == "startup":
        def reject(*args, **kwargs): raise ValueError("startup identity differs")
        monkeypatch.setattr(archive, "check_stamp", reject)
    (root / "receipt.json").write_text(json.dumps(receipt))
    (root / "export/gate-result.json").write_text(json.dumps(result))
    with pytest.raises(ValueError):
        gate.observe(tmp_path, root)


def test_live_gate_remains_pending_without_success_receipt(tmp_path, monkeypatch):
    root, _, _, observed, stamps = retained_gate(tmp_path, monkeypatch)
    observed["State"].update(Status="running", Running=True)
    assert gate.observe(tmp_path, root)["state"] == "pending"
    assert not stamps


@pytest.mark.parametrize("mutation", [None, "missing", "durability", "root", "scope", "receipt", "archive"])
def test_cold_gate_requires_retained_roundtrip_evidence(tmp_path, monkeypatch, mutation):
    root, receipt, result, observed, _ = retained_gate(tmp_path, monkeypatch)
    spec = json.loads((root / "compose.json").read_text())
    spec["services"]["antenna"]["command"].append("--verify-cold-import")
    observed["Config"]["Cmd"] = spec["services"]["antenna"]["command"]
    (root / "compose.json").write_text(json.dumps(spec))
    receipt.update(verify_cold_import=True, compose_sha256=gate.sha(root / "compose.json"))
    archive = root / "export/antenna-cold.fms"
    archive.write_bytes(b"archive" * 10)
    cold = {"status": "pass", "durable_session_storage_qualified": False,
        "physics_qualified": False, "reuse_LLG_FFT_qualified": False,
        "api_process_restarted": False, "original_output_restored": True,
        "original_root_unavailable_during_import_and_reads": True,
        "old_request_scope_rejected": True, "warm_request_scope": "instance:1",
        "cold_request_scope": "instance:2",
        "archive": {"bytes": archive.stat().st_size, "sha256": gate.sha(archive)}}
    result.update(cold_archive_import="PASS", cold_import_result=cold)
    if mutation == "missing": result.pop("cold_import_result")
    elif mutation == "durability": cold["durable_session_storage_qualified"] = True
    elif mutation == "root": cold["original_root_unavailable_during_import_and_reads"] = False
    elif mutation == "scope": cold["cold_request_scope"] = cold["warm_request_scope"]
    elif mutation == "archive": archive.write_bytes(b"changed" * 10)
    (root / "export/cold-import-result.json").write_text(json.dumps({} if mutation == "receipt" else cold))
    (root / "receipt.json").write_text(json.dumps(receipt))
    (root / "export/gate-result.json").write_text(json.dumps(result))
    if mutation is None:
        gate.observe(tmp_path, root)
        assert json.loads((root / "receipt.json").read_text())["cold_archive_import"] == "PASS"
    else:
        with pytest.raises(ValueError):
            gate.observe(tmp_path, root)
