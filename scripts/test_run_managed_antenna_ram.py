"""Interpreted isolation checks; no compiled unit-test targets."""
import copy
import ast
import hashlib
import json
from pathlib import Path

import pytest
from scripts import run_managed_antenna_ram as launcher


def spec(tmp_path):
    return launcher.scientific_spec("sha256:" + "a" * 64, tmp_path / "source",
        tmp_path / "package", tmp_path / "input", tmp_path / "export")


def inspection(document):
    service = document["services"]["antenna"]
    return [{"Image": service["image"], "Config": {"User": "65532:65532",
        "Cmd": [part.replace("$$", "$") for part in service["command"]],
        "Entrypoint": [], "WorkingDir": service["working_dir"],
        "Env": [f"{key}={value}" for key, value in service["environment"].items()],
        "Labels": {"com.docker.compose.project": "project",
                   "com.docker.compose.service": "antenna"}},
        "HostConfig": {"NetworkMode": "none", "PortBindings": {},
            "ReadonlyRootfs": True, "Privileged": False, "CapDrop": ["ALL"],
            "SecurityOpt": ["no-new-privileges:true"], "Memory": 2 * 1024**3,
            "NanoCpus": 2 * 10**9, "PidsLimit": 128,
            "Tmpfs": {"/tmp": "rw,nosuid,nodev,size=64m",
                      "/ram": "rw,nosuid,nodev,size=768m,mode=1777"}},
        "Mounts": [{"Type": "bind", "Source": m["source"],
                    "Destination": m["target"], "RW": not m["read_only"]}
                   for m in service["volumes"]]}]


def test_ram_route_has_no_network_volumes_or_persistent_session(tmp_path):
    service = spec(tmp_path)["services"]["antenna"]
    assert "ports" not in service
    assert service["network_mode"] == "none"
    assert [(m["target"], m["read_only"]) for m in service["volumes"]] == [
        ("/source", True), ("/package", True), ("/input", True), ("/export", False)]
    assert service["environment"]["FULLMAG_STATE_ROOT"].startswith("/ram/")
    assert service["environment"]["FULLMAG_STATE_DIR"] == "/ram/user-state"
    assert service["environment"]["FULLMAG_API_PORT"] == "0"
    assert service["environment"]["FULLMAG_FEM_MESH_CACHE_DIR"].startswith("/ram/")
    command = service["command"][2]
    assert "--headless --expect-script-sha256 " + launcher.FIXTURE_FILES[
        "fem_antenna_current_source_inspection.py"] in command
    assert "--output-dir /ram/result.zarr" in command
    assert "cp -R /ram/result.zarr /export/result.zarr" in command
    assert 'exit "$${solver_code}"' not in command
    assert 'exit "$$solver_code"' in command
    assert "cargo" not in command and "cmake" not in command


def test_attests_exact_isolation(tmp_path, monkeypatch):
    document = spec(tmp_path)
    observed = inspection(document)
    monkeypatch.setattr(launcher, "docker", lambda *args: json.dumps(observed))
    assert launcher.attest("container", document, "project") == observed[0]


@pytest.mark.parametrize("mutation", ["image", "network", "ports", "volume", "source_rw",
    "user", "privileged", "readonly", "ram_size", "cpu", "memory", "caps",
    "command", "entrypoint", "working_dir", "environment", "owner"])
def test_rejects_changed_container(tmp_path, monkeypatch, mutation):
    document = spec(tmp_path)
    observed = copy.deepcopy(inspection(document))
    item, config = observed[0], observed[0]["HostConfig"]
    if mutation == "image": item["Image"] = "sha256:" + "b" * 64
    elif mutation == "network": config["NetworkMode"] = "bridge"
    elif mutation == "ports": config["PortBindings"] = {"8081/tcp": [{}]}
    elif mutation == "volume": item["Mounts"].append({"Type": "volume"})
    elif mutation == "source_rw": item["Mounts"][0]["RW"] = True
    elif mutation == "user": item["Config"]["User"] = "0"
    elif mutation == "privileged": config["Privileged"] = True
    elif mutation == "readonly": config["ReadonlyRootfs"] = False
    elif mutation == "ram_size": config["Tmpfs"]["/ram"] = "rw,size=4g"
    elif mutation == "cpu": config["NanoCpus"] = 4 * 10**9
    elif mutation == "memory": config["Memory"] = 0
    elif mutation == "caps": config["CapDrop"] = []
    elif mutation == "command": item["Config"]["Cmd"] = ["true"]
    elif mutation == "entrypoint": item["Config"]["Entrypoint"] = ["sh"]
    elif mutation == "working_dir": item["Config"]["WorkingDir"] = "/export"
    elif mutation == "environment": item["Config"]["Env"].append("FULLMAG_STATE_ROOT=/export")
    elif mutation == "owner": item["Config"]["Labels"]["com.docker.compose.project"] = "other"
    monkeypatch.setattr(launcher, "docker", lambda *args: json.dumps(observed))
    with pytest.raises(ValueError, match="isolation|command/environment/owner"):
        launcher.attest("container", document, "project")


def test_actual_fixed_input_and_tamper_fail_closed(tmp_path):
    repo = Path(__file__).resolve().parents[1]
    assert set(launcher.fixture_paths(repo)) == set(launcher.FIXTURE_FILES)
    examples = tmp_path / "examples"
    examples.mkdir()
    (examples / "fem_antenna_current_source_inspection.py").write_text("changed")
    with pytest.raises(ValueError, match="input differs"):
        launcher.fixture_paths(tmp_path)


def test_standalone_changes_only_probe_physics(tmp_path):
    repo = Path(__file__).resolve().parents[1]
    paths, hashes, generated = launcher.fixture_identity(repo, standalone=True)
    original = ast.parse(paths["fem_antenna_current_source_inspection.py"].read_text())
    actual = ast.parse(generated)
    expected = []
    for node in original.body[1:]:
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            target = node.targets[0]
            if isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name) and target.value.id == "probe":
                continue
            if isinstance(target, ast.Name) and target.id == "probe":
                node.value.func.attr = "geometry_object"
                node.value.keywords.append(ast.keyword(arg="type", value=ast.Constant(value="geometry")))
        expected.append(node)
    assert [ast.dump(node) for node in actual.body[1:]] == [ast.dump(node) for node in expected]
    assert {k: v for k, v in hashes.items() if k != launcher.SCRIPT_NAME} == launcher.FIXTURE_FILES
    assert hashes[launcher.SCRIPT_NAME] == hashlib.sha256(generated).hexdigest()
    document = launcher.scientific_spec("sha256:" + "a" * 64, tmp_path / "source",
        tmp_path / "package", tmp_path / "input", tmp_path / "export",
        standalone_hash=hashes[launcher.SCRIPT_NAME])
    command = document["services"]["antenna"]["command"][2]
    assert "/input/" + launcher.SCRIPT_NAME in command
    assert "--expect-script-sha256 " + hashes[launcher.SCRIPT_NAME] in command


@pytest.mark.parametrize("mutation", ["missing_state", "duplicate_state", "constructor", "missing_solve"])
def test_standalone_transform_refuses_changed_input(mutation):
    repo = Path(__file__).resolve().parents[1]
    source = launcher.fixture_paths(repo)["fem_antenna_current_source_inspection.py"].read_text()
    if mutation == "missing_state": source = source.replace("probe.alpha = 0.02", "")
    elif mutation == "duplicate_state": source += "\nprobe.alpha = 0.02\n"
    elif mutation == "constructor": source = source.replace("probe = study.geometry(", "probe = study.antenna_object(")
    elif mutation == "missing_solve": source = source.replace("add_antenna_field_solve(", "add_other_stage(")
    with pytest.raises(ValueError, match="probe|Standalone"):
        launcher.standalone_source(source)


def test_unknown_fixture_variant_rejected_before_docker(tmp_path, monkeypatch):
    root, _, receipt, _ = retained_run(tmp_path, monkeypatch)
    receipt["fixture_variant"] = "arbitrary-script"
    (root / "receipt.json").write_text(json.dumps(receipt))
    monkeypatch.setattr(launcher, "docker", lambda *args: pytest.fail("must reject before Docker"))
    with pytest.raises(ValueError, match="variant"):
        launcher.observe(tmp_path, root)


def test_generated_standalone_lowers_without_magnetic_state():
    import fullmag as fm
    import fullmag.world as world
    from fullmag.runtime.loader import load_problem_from_script
    repo = Path(__file__).resolve().parents[1]
    paths, _, generated = launcher.fixture_identity(repo, standalone=True)
    original = paths["fem_antenna_current_source_inspection.py"]
    baseline = load_problem_from_script(original, lightweight_assets=True).problem.to_ir(include_geometry_assets=False)
    fm.reset()
    world.begin_script_capture(original.parent)
    try:
        exec(compile(generated, launcher.SCRIPT_NAME, "exec"),
             {"__file__": str(original.parent / launcher.SCRIPT_NAME), "__name__": "__main__"})
        actual = world._build_problem().to_ir(include_geometry_assets=False)
        assert actual["magnets"] == []
        assert actual["energy_terms"] == []
        assert actual["study"] == {"kind": "antenna_field_solve", "sampling": {"outputs": []}}
        for key in ("current_modules", "antenna_port_modes", "antenna_field_solve_stages"):
            assert actual[key] == baseline[key]
    finally:
        world.finish_script_capture()
        fm.reset()


@pytest.mark.parametrize("mutation", ["bytes", "hash", "variant"])
def test_standalone_observer_refuses_tampered_binding(tmp_path, monkeypatch, mutation):
    root, _, receipt, _ = retained_run(tmp_path, monkeypatch)
    generated = b"standalone test input"
    hashes = {**receipt["fixture_sha256"], launcher.SCRIPT_NAME: hashlib.sha256(generated).hexdigest()}
    monkeypatch.setattr(launcher, "fixture_identity", lambda *args, **kwargs: ({}, hashes, generated))
    (root / "input" / launcher.SCRIPT_NAME).write_bytes(generated)
    receipt["fixture_sha256"] = dict(hashes)
    receipt["fixture_variant"] = "standalone"
    if mutation == "bytes": (root / "input" / launcher.SCRIPT_NAME).write_bytes(b"modified test input")
    elif mutation == "hash": receipt["fixture_sha256"][launcher.SCRIPT_NAME] = "a" * 64
    elif mutation == "variant": receipt["fixture_variant"] = "magnetic_probe"
    (root / "receipt.json").write_text(json.dumps(receipt))
    monkeypatch.setattr(launcher, "docker", lambda *args: pytest.fail("must reject before Docker"))
    with pytest.raises(ValueError, match="changed|differs"):
        launcher.observe(tmp_path, root)


def test_running_build_is_rejected_before_docker_or_storage(tmp_path, monkeypatch):
    monkeypatch.setattr(launcher.storage, "resolve_layout", lambda *args: {
        "storage_root": str(tmp_path), "runs_root": str(tmp_path / "runs")})
    def reject(*args, **kwargs):
        raise ValueError("Managed CPU release must be terminal and successful")
    monkeypatch.setattr(launcher, "validate_managed_build", reject)
    monkeypatch.setattr(launcher, "docker", lambda *args: pytest.fail("Docker must not run"))
    monkeypatch.setattr(launcher.storage, "initialize", lambda *args: pytest.fail("no storage writes"))
    with pytest.raises(ValueError, match="terminal"):
        launcher.start(tmp_path, "1" * 32, "a" * 40, "b" * 64, "c" * 64)


def retained_run(tmp_path, monkeypatch):
    root = tmp_path / "runs" / ("1" * 32)
    root.mkdir(parents=True)
    (root / "input").mkdir()
    (root / "export").mkdir()
    source, package, build = tmp_path / "capsule", tmp_path / "package", tmp_path / "build"
    (build / "artifacts").mkdir(parents=True)
    (build / "artifacts/build-receipt.json").write_text("{}")
    inputs = {"fem_antenna_current_source_inspection.py": hashlib.sha256(b"input").hexdigest()}
    monkeypatch.setattr(launcher, "FIXTURE_FILES", inputs)
    (root / "input/fem_antenna_current_source_inspection.py").write_bytes(b"input")
    document = launcher.scientific_spec("sha256:" + "a" * 64,
        source / "tree", package, root / "input", root / "export")
    (root / "compose.json").write_text(json.dumps(document))
    receipt = {"schema": "fullmag.managed-antenna-ram.v1", "run_root": str(root),
        "compose_sha256": launcher.digest(root / "compose.json"), "managed_job_id": "2" * 32,
        "native_source_identity": {"head_commit_full": "c" * 40,
            "source_snapshot_sha256": "d" * 64, "source_snapshot_dirty": True},
        "source_digest": "e" * 64, "fixture_sha256": inputs,
        "image_digest": "sha256:" + "a" * 64, "container_id": "container",
        "compose_project": "fullmag-antenna-ram-" + root.name,
        "build_receipt_sha256": launcher.digest(build / "artifacts/build-receipt.json")}
    (root / "receipt.json").write_text(json.dumps(receipt))
    monkeypatch.setattr(launcher.storage, "resolve_layout", lambda *args: {"build_root": str(tmp_path)})
    def binding(*args):
        assert args[1:] == ("2" * 32, "c" * 40, "e" * 64, "d" * 64)
        return {}, build, {"image_digest": "sha256:" + "a" * 64}, {}, source, package
    monkeypatch.setattr(launcher, "resolved_build", binding)
    return root, document, receipt, build


@pytest.mark.parametrize("status", ["created", "running", "restarting", "paused"])
def test_nonterminal_container_remains_pending(tmp_path, monkeypatch, status):
    root, document, receipt, _ = retained_run(tmp_path, monkeypatch)
    observed = inspection(document)
    observed[0]["Config"]["Labels"]["com.docker.compose.project"] = receipt["compose_project"]
    observed[0]["State"] = {"Status": status, "Running": status in {"running", "paused"}}
    monkeypatch.setattr(launcher, "docker", lambda *args: json.dumps(observed))
    assert launcher.observe(tmp_path, root)["state"] == "pending"


@pytest.mark.parametrize("mutation", ["same_size_fixture", "receipt_bytes", "package", "source"])
def test_observe_rechecks_build_and_actual_input_before_docker(tmp_path, monkeypatch, mutation):
    root, _, _, build = retained_run(tmp_path, monkeypatch)
    if mutation == "same_size_fixture":
        (root / "input/fem_antenna_current_source_inspection.py").write_bytes(b"other")
    elif mutation == "receipt_bytes":
        (build / "artifacts/build-receipt.json").write_text("[]")
    else:
        def reject(*args):
            raise ValueError(f"{mutation} validation rejected changed bytes")
        monkeypatch.setattr(launcher, "resolved_build", reject)
    monkeypatch.setattr(launcher, "docker", lambda *args: pytest.fail("must reject before Docker"))
    with pytest.raises(ValueError, match="changed|differs"):
        launcher.observe(tmp_path, root)


@pytest.mark.parametrize("code,oom", [(1, False), (0, True)])
def test_terminal_failure_never_counts_as_success(tmp_path, monkeypatch, code, oom):
    root, document, receipt, _ = retained_run(tmp_path, monkeypatch)
    observed = inspection(document)
    observed[0]["Config"]["Labels"]["com.docker.compose.project"] = receipt["compose_project"]
    observed[0]["State"] = {"Status": "exited", "Running": False, "ExitCode": code,
                             "OOMKilled": oom, "Error": ""}
    monkeypatch.setattr(launcher, "docker", lambda *args: json.dumps(observed))
    with pytest.raises(ValueError, match="failed"):
        launcher.observe(tmp_path, root)
    assert json.loads((root / "receipt.json").read_text())["state"] == "failed_resources_retained"


@pytest.mark.parametrize("mutation", ["package", "source"])
def test_real_build_binding_rejects_same_size_byte_mutations(tmp_path, monkeypatch, mutation):
    from scripts.test_run_managed_browser import retained_build
    from local_runner.worker_entrypoint import SCHEMA, canonical
    capsule = tmp_path / "capsule"
    tree = capsule / "tree"
    tree.mkdir(parents=True)
    (tree / "fixture.py").write_bytes(b"x")
    core = {"schema_version": SCHEMA, "source_mode": "snapshot", "resolved_commit": "a" * 40,
        "files": [{"path": "fixture.py", "type": "file", "mode": "100644",
                   "size": 1, "sha256": hashlib.sha256(b"x").hexdigest()}],
        "deleted": [], "included_untracked": [], "excluded": []}
    source_digest = hashlib.sha256(canonical(core)).hexdigest()
    (capsule / "manifest.json").write_text(json.dumps({**core, "source_digest": source_digest}))
    build = retained_build(tmp_path, source_digest=source_digest)
    journal = json.loads((build / "receipt.json").read_text())
    journal["mounts"] = [["bind", str(capsule), "/source", False]]
    (build / "receipt.json").write_text(json.dumps(journal))
    monkeypatch.setattr(launcher.storage, "resolve_layout", lambda *args: {
        "storage_root": str(tmp_path), "runs_root": str(tmp_path)})
    launcher.resolved_build(tmp_path, build.name, "a" * 40, source_digest, "e" * 64)
    if mutation == "source":
        (tree / "fixture.py").write_bytes(b"y")
    else:
        artifact = build / "artifacts/outputs/.fullmag/local/bin/fullmag-bin"
        before = artifact.read_bytes()
        artifact.write_bytes(b"X" + before[1:])
    with pytest.raises(ValueError, match="Artifact|Capsule bytes changed"):
        launcher.resolved_build(tmp_path, build.name, "a" * 40, source_digest, "e" * 64)
