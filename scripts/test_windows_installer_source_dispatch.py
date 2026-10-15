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

def test_installer_dispatch_uses_fixed_producer_and_manifest(tmp_path, monkeypatch):
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
    assert storage.run_windows_installer_source(layout) == 17
    args, options = calls[0]
    assert args[1] == ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(producer), "-ManagedBuild"]
    assert options["native_user_build"] and options["native_installer_paths"]
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

@pytest.mark.skipif(__import__("os").name == "nt", reason="Bash fake-Windows dispatch fixture")
@pytest.mark.parametrize("suffix,windows,accepted", [("", True, True), ("", False, False), ("; echo bypass", True, False), (" -ManagedBuild", True, False)])
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
        assert arguments == ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(repo / "scripts/windows/build_installer_from_source.ps1")]
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
        storage.validate_installer_terminal_manifest({"runs_root": str(runs)}, manifest, attempt)
    else:
        with pytest.raises(storage.StorageError):
            storage.validate_installer_terminal_manifest({"runs_root": str(runs)}, manifest, attempt)
