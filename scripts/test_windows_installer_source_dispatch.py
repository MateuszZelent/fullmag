"""Verify closed installer build dispatch without running a compiler."""
import importlib.util
from pathlib import Path
import pytest

SPEC = importlib.util.spec_from_file_location("installer_storage", Path(__file__).with_name("fullmag_storage.py"))
storage = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(storage)

@pytest.mark.parametrize("windows,profile", [(False, "windows-installer-source"), (True, "windows-native-fdm-cpu"), (True, "windows-native-fem-gpu")])
def test_installer_dispatch_rejects_other_host_or_profile(monkeypatch, windows, profile):
    monkeypatch.setattr(storage, "_is_native_windows", lambda: windows)
    monkeypatch.setattr(storage, "_run_managed_command", lambda *a, **k: pytest.fail("command must not start"))
    with pytest.raises(storage.StorageError):
        storage.run_windows_installer_source({"profile": profile})

@pytest.mark.parametrize("mode", [None, "initial-build", "setup-only"])
def test_installer_dispatch_uses_fixed_producer_and_manifest(tmp_path, monkeypatch, mode):
    producer = tmp_path / "scripts/windows/build_installer_from_source.ps1"
    producer.parent.mkdir(parents=True)
    producer.write_text("# fixture, never executed")
    layout = {"repo_root": str(tmp_path), "profile": "windows-installer-source"}
    monkeypatch.setattr(storage, "_is_native_windows", lambda: True)
    calls = []
    def record(*args, **kwargs):
        calls.append((args, kwargs))
        return 17
    monkeypatch.setattr(storage, "_run_managed_command", record)
    if mode is None:
        assert storage.run_windows_installer_source(layout) == 17
    else:
        assert storage.run_windows_installer_source(layout, mode) == 17
    args, options = calls[0]
    expected_mode = mode or "initial-build"
    assert args[1] == ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(producer), "-ManagedBuild", "-BootstrapMode", expected_mode]
    assert options["native_user_build"] and options["native_installer_paths"]
    assert options["installer_bootstrap_mode"] == expected_mode
    assert options["execution_mode"] == "windows-installer-source-build"
    assert options["native_manifest_relative"] == "installer-source/build-manifest.json"

def test_installer_cli_rejects_arbitrary_command(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(storage, "resolve_layout", lambda *a: {"repo_root": str(tmp_path), "profile": "windows-installer-source"})
    monkeypatch.setattr(storage, "run_windows_installer_source", lambda *a: pytest.fail("producer must not start"))
    assert storage.main(["run-windows-installer-source", "--repo-root", str(tmp_path), "--", "cargo", "build"]) == 2
    assert "does not accept an arbitrary command" in capsys.readouterr().err

def test_installer_cli_rejects_profile_before_storage_writes(monkeypatch, capsys):
    monkeypatch.setattr(storage, "resolve_layout", lambda *a: pytest.fail("profile mismatch must precede storage discovery"))
    assert storage.main(["run-windows-installer-source", "--profile", "windows-native-fem-gpu"]) == 2
    assert "Windows installer producer" in capsys.readouterr().err

@pytest.mark.parametrize("mode", ["initial-build", "setup-only"])
def test_installer_cli_rejects_explicit_mode_for_non_installer(monkeypatch, capsys, mode):
    monkeypatch.setattr(storage, "resolve_layout", lambda *a: pytest.fail("non-installer mode must be rejected before storage discovery"))
    assert storage.main(["resolve", "--bootstrap-mode", mode]) == 2
    assert "only valid for run-windows-installer-source" in capsys.readouterr().err

@pytest.mark.skipif(__import__("os").name == "nt", reason="Bash fake-Windows dispatch fixture")
@pytest.mark.parametrize("suffix,windows,accepted", [("", True, True), (" -BootstrapMode \"setup-only\"", True, True), ("", False, False), ("; echo bypass", True, False), (" -ManagedBuild", True, False), (" -BootstrapMode \"invalid\"", True, False)])
def test_installer_shell_dispatch_is_closed(tmp_path, suffix, windows, accepted):
    import json
    import os
    import shutil
    import subprocess
    root = Path(__file__).resolve().parents[1]
    repo = tmp_path / "checkout with spaces"
    (repo / "scripts/windows").mkdir(parents=True)
    (repo / "bin").mkdir()
    shutil.copy2(root / "scripts/just_storage_shell.sh", repo / "scripts/just_storage_shell.sh")
    (repo / "scripts/fullmag_storage.py").write_text("# unused resolver fixture")
    logger = repo / "bin/powershell.exe"
    logger.write_text("#!/usr/bin/env python3\nimport json,os,sys\nfrom pathlib import Path\nPath(os.environ['INSTALLER_LOG']).write_text(json.dumps(sys.argv[1:]))\n")
    logger.chmod(0o755)
    log = tmp_path / "dispatch.json"
    env = os.environ.copy()
    env["PATH"] = str(repo / "bin") + os.pathsep + env["PATH"]
    env["OS"] = "Windows_NT" if windows else "Linux"
    env["INSTALLER_LOG"] = str(log)
    recipe = 'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "untrusted/checkout/scripts/windows/build_installer_from_source.ps1"' + suffix
    result = subprocess.run(["bash", "scripts/just_storage_shell.sh", recipe], cwd=repo, env=env, capture_output=True, text=True)
    if accepted:
        assert result.returncode == 0, result.stderr
        arguments = json.loads(log.read_text())
        assert arguments == ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(repo / "scripts/windows/build_installer_from_source.ps1"), "-BootstrapMode", ("setup-only" if suffix else "initial-build")]
    else:
        assert result.returncode == 2, result.stderr
        assert not log.exists()

@pytest.mark.parametrize("damage", [None, "old_attempt", "changed_artifact", "outside_runs", "wrong_name"])
def test_installer_terminal_manifest_binds_attempt_and_artifact(tmp_path, damage):
    import hashlib
    runs = tmp_path / "runs"
    artifact = runs / "installer" / "fullmag.exe"
    artifact.parent.mkdir(parents=True)
    artifact.write_bytes(b"fixture artifact, never executed")
    attempt = "a" * 32
    manifest = {"schema": "fullmag.windows-installer-source-build.v1", "state": "completed",
                "profile": "windows-installer-source", "attempt_id": attempt,
                "artifact": str(artifact), "artifact_sha256": hashlib.sha256(artifact.read_bytes()).hexdigest()}
    if damage == "old_attempt":
        manifest["attempt_id"] = "b" * 32
    elif damage == "changed_artifact":
        artifact.write_bytes(b"different bytes")
    elif damage == "outside_runs":
        external = tmp_path / "fullmag.exe"
        external.write_bytes(artifact.read_bytes())
        manifest["artifact"] = str(external)
    elif damage == "wrong_name":
        renamed = artifact.with_name("other.exe")
        artifact.rename(renamed)
        manifest["artifact"] = str(renamed)
    if damage is None:
        # Legacy v1 manifests without bootstrap_mode remain valid when no new
        # expected mode is supplied.
        storage.validate_installer_terminal_manifest({"runs_root": str(runs)}, manifest, attempt)
    else:
        with pytest.raises(storage.StorageError):
            storage.validate_installer_terminal_manifest({"runs_root": str(runs)}, manifest, attempt)

def _write_bootstrap_sidecars(root, artifact_hash, mode="setup-only"):
    import hashlib
    import json
    provenance = {"schema": "fullmag.windows-installer-provenance.v1",
                  "source_first": {"mode": mode}}
    provenance_path = root / "fullmag-installer-provenance.json"
    provenance_bytes = json.dumps(provenance).encode("utf-8")
    provenance_path.write_bytes(provenance_bytes)
    (root / "fullmag-installer-receipt.json").write_text(json.dumps({
        "schema": "fullmag.windows-installer-receipt.v1",
        "source_first_mode": mode,
        "output_sha256": artifact_hash,
        "provenance_sha256": hashlib.sha256(provenance_bytes).hexdigest(),
    }))

@pytest.mark.parametrize("damage", [None, "missing_mode", "receipt_mode", "receipt_output", "receipt_provenance", "provenance_mode", "missing_run", "invalid_run", "other_run", "relocated_parent"])
def test_installer_terminal_manifest_binds_bootstrap_sidecars(tmp_path, damage):
    import hashlib
    import json
    runs = tmp_path / "runs"
    run_id = "c" * 32
    artifact = runs / ("windows-installer-source-" + run_id) / "fullmag.exe"
    artifact.parent.mkdir(parents=True)
    artifact.write_bytes(b"fixture artifact, never executed")
    attempt = "a" * 32
    artifact_hash = hashlib.sha256(artifact.read_bytes()).hexdigest()
    _write_bootstrap_sidecars(artifact.parent, artifact_hash)
    manifest = {"schema": "fullmag.windows-installer-source-build.v1", "state": "completed",
                "profile": "windows-installer-source", "attempt_id": attempt,
                "bootstrap_mode": "setup-only", "run_id": run_id, "artifact": str(artifact),
                "artifact_sha256": artifact_hash}
    if damage == "missing_run":
        manifest.pop("run_id")
    elif damage == "invalid_run":
        manifest["run_id"] = "not-a-run"
    elif damage == "other_run":
        manifest["run_id"] = "d" * 32
    elif damage == "relocated_parent":
        relocated = runs / "relocated"
        artifact.parent.rename(relocated)
        manifest["artifact"] = str(relocated / "fullmag.exe")
    elif damage == "missing_mode":
        manifest.pop("bootstrap_mode")
    elif damage == "receipt_mode":
        path = artifact.parent / "fullmag-installer-receipt.json"
        value = json.loads(path.read_text())
        value["source_first_mode"] = "initial-build"
        path.write_text(json.dumps(value))
    elif damage == "receipt_output":
        path = artifact.parent / "fullmag-installer-receipt.json"
        value = json.loads(path.read_text())
        value["output_sha256"] = "0" * 64
        path.write_text(json.dumps(value))
    elif damage == "receipt_provenance":
        path = artifact.parent / "fullmag-installer-receipt.json"
        value = json.loads(path.read_text())
        value["provenance_sha256"] = "0" * 64
        path.write_text(json.dumps(value))
    elif damage == "provenance_mode":
        path = artifact.parent / "fullmag-installer-provenance.json"
        value = json.loads(path.read_text())
        value["source_first"]["mode"] = "initial-build"
        path.write_text(json.dumps(value))
    if damage is None:
        storage.validate_installer_terminal_manifest(
            {"runs_root": str(runs)}, manifest, attempt, expected_bootstrap_mode="setup-only"
        )
    else:
        with pytest.raises(storage.StorageError):
            storage.validate_installer_terminal_manifest(
                {"runs_root": str(runs)}, manifest, attempt, expected_bootstrap_mode="setup-only"
            )
