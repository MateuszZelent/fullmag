"""Exercise Windows provider input admission without compiling unit tests."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import pytest

ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / "scripts/windows/native_fem_dependencies.ps1"
PS = shutil.which("powershell.exe") or shutil.which("pwsh")
pytestmark = pytest.mark.skipif(os.name != "nt" or not PS, reason="native Windows PowerShell required")


def run_plan(tmp_path, root, architectures):
    driver = tmp_path / "plan.ps1"
    driver.write_text("param($Module,$Root,$Arch)\n$ErrorActionPreference='Stop'\n. $Module\nGet-FullmagNativeFemDependencyPlan -BuildRoot $Root -Cuda -CudaArchitectures $Arch | ConvertTo-Json -Depth 5\n", encoding="utf-8")
    return subprocess.run([PS, "-NoProfile", "-File", str(driver), str(MODULE), root, architectures], capture_output=True, text=True, timeout=20)


def test_plan_preserves_explicit_gpu_architectures(tmp_path):
    result = run_plan(tmp_path, str(tmp_path / "build"), "89;90")
    assert result.returncode == 0, result.stderr
    plan = json.loads(result.stdout)
    assert plan["cuda"] is True
    assert plan["cuda_architectures"] == "89;90"
    assert Path(plan["prefix"]).is_relative_to(tmp_path / "build")


@pytest.mark.parametrize("architectures", ["", "auto", "89;Write-Host", "89/90"])
def test_plan_rejects_unpinned_or_injected_architecture(tmp_path, architectures):
    result = run_plan(tmp_path, str(tmp_path / "build"), architectures)
    assert result.returncode != 0


def test_plan_rejects_relative_root(tmp_path):
    result = run_plan(tmp_path, "relative-build", "89")
    assert result.returncode != 0


def test_bootstrap_requires_managed_entry_before_writes(tmp_path):
    driver = tmp_path / "guard.ps1"
    driver.write_text("param($Module,$Root)\n$ErrorActionPreference='Stop'\n. $Module\nRemove-Item Env:FULLMAG_STORAGE_MANAGED_ENTRY -ErrorAction SilentlyContinue\nInvoke-FullmagNativeFemDependencies -RepoRoot $Root -StorageLayout ([pscustomobject]@{build_root=$Root;profile='windows-native-fem-gpu'}) -Cuda -CudaArchitectures 89\n", encoding="utf-8")
    destination = tmp_path / "should-not-exist"
    result = subprocess.run([PS, "-NoProfile", "-File", str(driver), str(MODULE), str(destination)], capture_output=True, text=True, timeout=20)
    assert result.returncode != 0
    assert "managed build lease" in result.stderr
    assert not destination.exists()


def test_cpu_plan_does_not_require_cuda_architecture(tmp_path):
    driver = tmp_path / "cpu.ps1"
    driver.write_text("param($Module,$Root)\n$ErrorActionPreference='Stop'\n. $Module\nGet-FullmagNativeFemDependencyPlan -BuildRoot $Root -Cuda:$false -CudaArchitectures '' | ConvertTo-Json -Depth 5\n", encoding="utf-8")
    result = subprocess.run([PS, "-NoProfile", "-File", str(driver), str(MODULE), str(tmp_path / "cpu")], capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["cuda"] is False


def test_provider_tree_rejects_nested_junction_before_writes(tmp_path):
    driver = tmp_path / "junction.ps1"
    provider = tmp_path / "providers"
    external = tmp_path / "outside"
    provider.mkdir()
    external.mkdir()
    link = provider / "downloads"
    result = subprocess.run(["cmd.exe", "/d", "/c", "mklink", "/J", str(link), str(external)], capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    driver.write_text("param($Module,$Root)\n$ErrorActionPreference='Stop'\n. $Module\nfunction Assert-FullmagStoragePath { param($Layout,$Path,$Label,$Parent); return $Path }\nAssert-FullmagNativeFemProviderTree -Layout ([pscustomobject]@{build_root=$Root}) -Path $Root\n", encoding="utf-8")
    result = subprocess.run([PS, "-NoProfile", "-File", str(driver), str(MODULE), str(provider)], capture_output=True, text=True, timeout=20)
    assert result.returncode != 0
    assert "reparse point" in result.stderr
    assert not list(external.iterdir())
