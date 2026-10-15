"""Focused source and PowerShell parser checks for native Windows launcher guards."""

from pathlib import Path
import shutil
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]
LAUNCHER = ROOT / "scripts" / "windows" / "run_fullmag.ps1"
POWERSHELL = shutil.which("pwsh") or shutil.which("powershell.exe")


def _source() -> str:
    return LAUNCHER.read_text(encoding="utf-8-sig")


def _function_body(source: str, name: str, next_name: str) -> str:
    start = source.index(f"function {name} {{")
    end = source.index(f"function {next_name} {{", start)
    return source[start:end]


def test_uv_resolver_uses_manifest_pin_and_setup_prefix_without_unpinned_fallback() -> None:
    source = _source()
    resolver = _function_body(source, "Invoke-Uv", "Add-NodePaths")

    assert "Get-PinnedUvVersion" in resolver
    assert 'Join-Path $CacheRoot "tools\\uv\\Scripts\\uv.exe"' in resolver
    assert "Assert-PinnedUvExecutable" in resolver
    assert "python-packages" not in resolver
    assert '"pip", "install"' not in resolver
    assert "Get-WindowsBuildRequirements" in source
    assert '"windows_build_requirements.json"' in source


def test_managed_cargo_bin_is_on_path_before_command_admission() -> None:
    source = _source()

    cargo_path = 'Prepend-PathEntry -Path $CargoBin'
    assert '$CargoBin = Join-Path $CargoHome "bin"' in source
    assert cargo_path in source
    assert source.index(cargo_path) < source.index('Require-Command "cargo"')


def test_fem_prefix_is_canonical_and_receipt_is_verified_before_mfem_plan() -> None:
    source = _source()
    receipt = _function_body(source, "Assert-NativeFemProviderReceipt", "Invoke-NativeFemBuild")
    fem_build = _function_body(source, "Invoke-NativeFemBuild", "Stage-NativeFemRuntime")

    assert 'Join-Path $BuildRoot "fem-dependencies"' in receipt
    assert 'Join-Path $providerRoot "installed"' in receipt
    assert 'Join-Path $providerRoot "provider-receipt.json"' in receipt
    assert "FULLMAG_FEM_DEPENDENCY_PREFIX must be the canonical managed provider prefix" in receipt
    assert "$receipt.plan.cuda" in receipt
    assert "$receipt.plan.cuda_architectures" in receipt
    assert "$receipt.plan.providers" in receipt
    assert 'foreach ($kind in @("files", "tools"))' in source
    assert "Get-Sha256File $resolved" in source
    assert "Assert-NativeFemPathChain" in source
    assert "Get-Sha256File $archive" in source
    assert "Assert-NativeFemStagedPeAudit" in source
    assert "Assert-NativeFemCopyDestination" in source
    assert "dependency_audit_sha256" in source
    assert "LaunchRoot" in source
    assert "Assert-NativeFemProviderReceipt" in fem_build
    assert fem_build.index("Assert-NativeFemProviderReceipt") < fem_build.index(
        "Get-FullmagMsiBuildPlan"
    )
    assert "provider_receipt_path" in fem_build
    assert "provider_receipt_sha256" in fem_build
    assert "Assert-NativeFemProviderArtifacts" in source


def test_fem_runtime_admission_binds_attempt_gpu_intent_and_final_launch_audit() -> None:
    source = _source()
    stage_start = source.index("function Stage-NativeFemRuntime {")
    stage = source[stage_start:]

    assert "$NativeFemAttemptId" in source
    assert "Native Windows FEM requires the managed attempt identity" in source
    assert '$manifest.state = "completed"' in source
    assert "$manifest.native_fem_attempt_id = $NativeFemAttemptId" in source
    assert "$manifest.cuda -isnot [bool]" in source
    assert "$manifest.native_fem.strict_gpu -isnot [bool]" in source
    assert "$manifest.native_fem.requested_device -ne $NativeFemRequestedDevice" in source
    assert stage.count("Assert-NativeFemStagedPeAudit") >= 2
    assert "-LaunchRoot $launchRoot -LaunchBase $TargetRoot" in stage
    assert "Native FEM build DLL hash changed before staging" in stage
    assert "Native FEM launch DLL hash does not match the built FEM DLL" in stage
    assert "provider_config_sha256" in stage
    assert "provider_receipt_path" in stage
    assert "provider_receipt_sha256" in stage


def test_fem_runtime_reuse_revalidates_provider_provenance() -> None:
    source = _source()
    reuse_start = source.index(
        'if ($Backend -eq "fem") {\n    if ([string]$manifest.backend'
    )
    reuse = source[reuse_start:source.index("elseif ($useCuda)", reuse_start)]

    assert "Assert-NativeFemProviderArtifacts" in reuse
    assert "$manifest.native_fem.provider_config" in reuse
    assert "$manifest.native_fem.provider_config_sha256" in reuse
    assert "$manifest.native_fem.provider_receipt_path" in reuse
    assert "$manifest.native_fem.provider_receipt_sha256" in reuse


def test_cuda_compiler_is_checked_against_the_frozen_requirements_manifest() -> None:
    source = _source()
    resolver = _function_body(source, "Resolve-CudaCompiler", "Test-NvidiaRuntime")

    assert "Get-WindowsBuildRequirements" in resolver
    assert "cudaRequirement.minimum" in resolver
    assert '"--version"' in resolver
    assert "minimumCudaVersion" in resolver
    assert "explicitCudaCompiler" in resolver
    assert "Explicit CUDACXX" in resolver
    assert "CPU fallback is forbidden" in resolver


def test_native_fem_does_not_rebind_shared_compatibility_links() -> None:
    source = _source()
    compat_guard_start = source.index("if (-not $SkipCompatibilityLinks")
    compat_guard_end = source.index("$prepareArguments.Compat = $true", compat_guard_start)
    compat_guard = source[compat_guard_start:compat_guard_end]

    assert '$RunMode -ne "workspace"' in compat_guard
    assert '$Backend -ne "fem"' in compat_guard


@pytest.mark.skipif(POWERSHELL is None, reason="PowerShell is unavailable")
def test_launcher_is_accepted_by_the_native_powershell_parser(tmp_path: Path) -> None:
    probe = tmp_path / "parse.ps1"
    probe.write_text(
        r"""
param([string]$Path)
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count) { throw ($errors | Out-String) }
Write-Output "parsed"
""",
        encoding="utf-8",
    )
    result = subprocess.run(
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-File", str(probe), str(LAUNCHER)],
        capture_output=True,
        text=True,
        timeout=20,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "parsed"
