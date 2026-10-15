"""Interpreted contract checks for the all-capabilities Windows package."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import uuid

import pytest


ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "scripts" / "windows" / "run_fullmag.ps1"
HELPER = ROOT / "scripts" / "windows" / "native_full_package.ps1"
sys.path.insert(0, str(ROOT / "scripts" / "windows"))
import runtime_bundle  # noqa: E402


RUNTIME_FAMILY_NAMES = tuple(
    name for name in runtime_bundle.BINARY_NAMES if name != "fullmag-ui.exe"
)


def _powershell() -> str | None:
    if os.name == "nt":
        return shutil.which("powershell.exe") or shutil.which("powershell")
    for candidate in (
        Path("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"),
        Path("/mnt/c/Windows/Sysnative/WindowsPowerShell/v1.0/powershell.exe"),
    ):
        if candidate.is_file():
            return str(candidate)
    return shutil.which("powershell.exe") or shutil.which("powershell")


def _windows_path(path: Path) -> str:
    if os.name == "nt":
        return str(path)
    wslpath = shutil.which("wslpath")
    if wslpath is None:
        pytest.skip("wslpath is required for native PowerShell")
    result = subprocess.run(
        [wslpath, "-w", str(path)], check=True, capture_output=True, text=True
    )
    return result.stdout.strip()


def _ps_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _canonical_runs_root() -> Path:
    sys.path.insert(0, str(ROOT / "scripts"))
    import fullmag_storage as storage  # noqa: PLC0415

    try:
        layout = storage.resolve_layout(
            ROOT, profile="windows-native-fem-gpu", environ=dict(os.environ)
        )
    except Exception as exc:  # pragma: no cover - host configuration varies
        pytest.skip(f"canonical native FEM runs_root is unavailable: {exc}")
    runs_root = Path(str(layout["runs_root"]))
    if not runs_root.is_absolute() or not runs_root.is_dir():
        pytest.skip("canonical native FEM runs_root is unavailable")
    return runs_root


def _write_fixture(path: Path, data: bytes) -> str:
    path.write_bytes(data)
    return hashlib.sha256(data).hexdigest()


def _runtime_family_inventory_sha256(artifacts: dict[str, dict[str, object]]) -> str:
    lines = [
        f"{name}|{artifacts[name]['size_bytes']}|{artifacts[name]['sha256']}"
        for name in artifacts
    ]
    return hashlib.sha256(("\n".join(lines) + "\n").encode("utf-8")).hexdigest()


def test_all_backends_source_contract_is_closed() -> None:
    runner = RUNNER.read_text(encoding="utf-8-sig")
    helper = HELPER.read_text(encoding="utf-8-sig")
    for marker in (
        "[switch]$AllBackends",
        "-AllBackends is only valid for an empty workspace",
        "Backend=auto and Device=auto",
        "-AllBackends requires the release native workspace profile",
        "-AllBackends",
        "Assert-FullmagFullRuntimeManifest",
        "Get-FullmagFullPackageCanonicalRuntimeNames",
        "-ToolsRoot (Get-WindowsBuildToolsRoot)",
        "Get-NativeFemMsvcDesktopX64RedistRoot",
        'x64\\Microsoft.VC143.CRT',
        "runtime_family_inventory_sha256",
        "allBackendFemAuditSha256",
        "-ExpectedAuditSha256 $allBackendFemAuditSha256",
        "FULLMAG_FULL_RUNTIME_MANIFEST",
        '"run-windows-full-workspace-build"',
        '"run-windows-full-workspace"',
        '"--full-expected-build-id"',
    ):
        assert marker in runner
    assert '-Browser is only supported for the managed native FEM workspace' in runner
    assert 'if ($AllBackendsRequested)' in runner
    assert 'Remove-Item Env:FULLMAG_FDM_EXECUTION' in runner
    assert 'schema = "fullmag.windows-full-capability-package.v1"' in helper
    assert 'components.fdm_cpu' in helper
    assert 'components.fdm_gpu' in helper
    assert 'components.fem_cpu' in helper
    assert 'components.fem_gpu' in helper
    assert 'Assert-FullmagFullPackageRuntimeFamily' in helper
    assert 'bin_pe_static_and_delay_imports' in helper
    assert 'FULLMAG_FDM_EXECUTION = $null' in helper
    assert 'FULLMAG_FEM_EXECUTION = $null' in helper
    assert 'FULLMAG_RELAX_DEVICE = $null' in helper


@pytest.mark.skipif(_powershell() is None, reason="Windows PowerShell is unavailable")
def test_native_helper_creates_and_rejects_tampered_capability_package() -> None:
    powershell = _powershell()
    assert powershell is not None
    runs_root = _canonical_runs_root()
    fixture = runs_root / f"full-capability-contract-{uuid.uuid4().hex}"
    fixture.mkdir(parents=True)
    try:
        source_commit = "a" * 40
        source_snapshot = "b" * 64
        attempt_id = "c" * 32
        binary = fixture / "fullmag.exe"
        api_binary = fixture / "fullmag-api.exe"
        fdm_dll = fixture / "fullmag_fdm.dll"
        fem_dll = fixture / "fullmag_fem.dll"
        hashes = {
            "binary": _write_fixture(binary, b"fullmag-exe"),
            "api": _write_fixture(api_binary, b"fullmag-api"),
            "fdm": _write_fixture(fdm_dll, b"fullmag-fdm"),
            "fem": _write_fixture(fem_dll, b"fullmag-fem"),
        }
        family_artifacts: dict[str, dict[str, object]] = {}
        for name in RUNTIME_FAMILY_NAMES:
            path = fixture / name
            if name == "fullmag.exe":
                data = binary.read_bytes()
            elif name == "fullmag-api.exe":
                data = api_binary.read_bytes()
            else:
                data = name.encode("ascii")
                path.write_bytes(data)
            family_artifacts[name] = {
                "name": name,
                "path": str(path),
                "size_bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
            }
        audit = fixture / "windows-pe-dependencies.json"
        audit_data = {
            "schema_version": 1,
            "target": "x86_64-pc-windows-msvc",
            "scope": "bin_pe_static_and_delay_imports",
            "images": [
                {"path": f"bin/{name}", "sha256": record["sha256"]}
                for name, record in family_artifacts.items()
            ],
            "limitations": [],
        }
        audit_sha256 = _write_fixture(audit, (json.dumps(audit_data) + "\n").encode("utf-8"))
        origin = fixture / "physical-build-manifest.json"
        origin_data = {
            "schema_version": 1,
            "backend": "fem",
            "state": "completed",
            "cuda": True,
            "native_fem": {
                "device": "gpu",
                "strict_gpu": True,
                "runtime_family_root": str(fixture),
                "runtime_family": list(family_artifacts.values()),
                "runtime_family_inventory": list(RUNTIME_FAMILY_NAMES),
                "runtime_family_inventory_sha256": _runtime_family_inventory_sha256(family_artifacts),
                "dependency_audit_path": str(audit),
                "dependency_audit_sha256": audit_sha256,
            },
            "source_commit_after": source_commit,
            "source_snapshot_sha256_after": source_snapshot,
            "native_fem_attempt_id": attempt_id,
            "source_worktree_state_after": "clean",
            "target_triple": "x86_64-pc-windows-msvc",
            "compiler_profile": "release",
            "features": ["fem-gpu"],
            "git_commit": source_commit,
            "worktree_state": "clean",
            "source_snapshot_sha256": source_snapshot,
            "build_version": {"schema": "fullmag.build-version.v1"},
            "build_source_snapshot": {"record_path": str(fixture / "snapshot.json"), "inventory_sha256": "d" * 64},
            "frontend_mode": "static",
            "frontend_workspace_root": str(fixture),
            "frontend_cache_root": str(fixture),
            "frontend_source_manifest": str(origin),
            "frontend_source_manifest_sha256": "e" * 64,
            "browser_workspace": True,
            "node_version": "",
            "pnpm_version": "",
        }
        origin.write_text(json.dumps(origin_data), encoding="utf-8")
        probe = fixture / "probe.ps1"
        probe.write_text(
            "\n".join(
                [
                    "$ErrorActionPreference = 'Stop'",
                    f". {_ps_literal(_windows_path(HELPER))}",
                    f"$manifestPath = {_ps_literal(_windows_path(fixture / 'build-manifest.json'))}",
                    f"$originPath = {_ps_literal(_windows_path(origin))}",
                    f"$outputRoot = {_ps_literal(_windows_path(fixture))}",
                    f"$sourceCommit = '{source_commit}'",
                    f"$sourceSnapshot = '{source_snapshot}'",
                    f"$attemptId = '{attempt_id}'",
                    "$null = New-FullmagFullRuntimeManifest -OutputRoot $outputRoot -ManifestPath $manifestPath -OriginManifestPath $originPath "
                    f"-FullmagExe {_ps_literal(_windows_path(binary))} -FullmagApiExe {_ps_literal(_windows_path(api_binary))} "
                    f"-NativeFdmDll {_ps_literal(_windows_path(fdm_dll))} -NativeFemDll {_ps_literal(_windows_path(fem_dll))} "
                    "-SourceCommit $sourceCommit -SourceSnapshotSha256 $sourceSnapshot -AttemptId $attemptId -BuildRoot $outputRoot",
                    "$expected = (Get-FullmagFullPackageSha256 -Path $manifestPath)",
                    "$null = Assert-FullmagFullRuntimeManifest -ManifestPath $manifestPath -OriginManifestPath $originPath "
                    f"-FullmagExe {_ps_literal(_windows_path(binary))} -FullmagApiExe {_ps_literal(_windows_path(api_binary))} "
                    f"-NativeFdmDll {_ps_literal(_windows_path(fdm_dll))} -NativeFemDll {_ps_literal(_windows_path(fem_dll))} "
                    "-ExpectedBuildId $expected -SourceCommit $sourceCommit -SourceSnapshotSha256 $sourceSnapshot -AttemptId $attemptId -BuildRoot $outputRoot",
                    f"$receipt = Join-Path $outputRoot 'components\\{attempt_id}\\fdm_cpu.receipt.json'",
                    "$receiptText = Get-Content -LiteralPath $receipt -Raw",
                    "[IO.File]::WriteAllText($receipt, $receiptText.Replace('fdm_cpu', 'fdm_cpu-tampered'), [Text.UTF8Encoding]::new($false))",
                    "$rejected = $false",
                    "try { $null = Assert-FullmagFullRuntimeManifest -ManifestPath $manifestPath -OriginManifestPath $originPath "
                    f"-FullmagExe {_ps_literal(_windows_path(binary))} -FullmagApiExe {_ps_literal(_windows_path(api_binary))} "
                    f"-NativeFdmDll {_ps_literal(_windows_path(fdm_dll))} -NativeFemDll {_ps_literal(_windows_path(fem_dll))} "
                    "-ExpectedBuildId $expected -SourceCommit $sourceCommit -SourceSnapshotSha256 $sourceSnapshot -AttemptId $attemptId -BuildRoot $outputRoot } catch { $rejected = $true }",
                    "if (-not $rejected) { throw 'tampered capability receipt was accepted' }",
                    f"$binaryPath = {_ps_literal(_windows_path(binary))}",
                    f"$apiBinaryPath = {_ps_literal(_windows_path(api_binary))}",
                    f"$fdmPath = {_ps_literal(_windows_path(fdm_dll))}",
                    f"$femPath = {_ps_literal(_windows_path(fem_dll))}",
                    "$newCommon = @{ OriginManifestPath = $originPath; FullmagExe = $binaryPath; FullmagApiExe = $apiBinaryPath; NativeFdmDll = $fdmPath; NativeFemDll = $femPath; SourceCommit = $sourceCommit; SourceSnapshotSha256 = $sourceSnapshot; BuildRoot = $outputRoot }",
                    "$outsideManifest = Join-Path (Split-Path -Parent $outputRoot) ('outside-full-capability-' + [Guid]::NewGuid().ToString('N') + '.json')",
                    "$outsideRejected = $false",
                    "try { $null = New-FullmagFullRuntimeManifest -OutputRoot $outputRoot -ManifestPath $outsideManifest -AttemptId $attemptId @newCommon } catch { $outsideRejected = $true }",
                    "if (-not $outsideRejected) { throw 'outside package manifest destination was accepted' }",
                    "Write-Output 'full-capability-outside-rejected'",
                    "if (Test-Path -LiteralPath $outsideManifest) { Remove-Item -LiteralPath $outsideManifest -Force }",
                    "$reparseTarget = Join-Path $outputRoot ('reparse-target-' + [Guid]::NewGuid().ToString('N'))",
                    "$reparseParent = Join-Path $outputRoot ('reparse-parent-' + [Guid]::NewGuid().ToString('N'))",
                    "New-Item -ItemType Directory -Force -Path $reparseTarget | Out-Null",
                    "$reparseCreated = $false",
                    "$reparseUnsupported = $false",
                    "try { New-Item -ItemType SymbolicLink -Path $reparseParent -Target $reparseTarget -ErrorAction Stop | Out-Null; $reparseCreated = $true } catch { $reparseUnsupported = $true }",
                    "if ($reparseCreated) {",
                    "  $badOutput = Join-Path $reparseParent 'nested-output'",
                    "  $badManifest = Join-Path $badOutput 'build-manifest.json'",
                    "  $reparseRejected = $false",
                    "  try { $null = New-FullmagFullRuntimeManifest -OutputRoot $badOutput -ManifestPath $badManifest -AttemptId $attemptId @newCommon } catch { $reparseRejected = $true }",
                    "  if (-not $reparseRejected) { throw 'reparse parent was accepted for package output' }",
                    "  Remove-Item -LiteralPath $reparseParent -Force -ErrorAction SilentlyContinue",
                    "  Remove-Item -LiteralPath $reparseTarget -Force -Recurse -ErrorAction SilentlyContinue",
                    "  Write-Output 'full-capability-reparse-rejected'",
                    "} else {",
                    "  Remove-Item -LiteralPath $reparseTarget -Force -Recurse -ErrorAction SilentlyContinue",
                    "  Write-Output 'full-capability-reparse-unsupported'",
                    "}",
                    "$secondAttempt = 'dddddddddddddddddddddddddddddddd'",
                    "$originObject = Get-Content -LiteralPath $originPath -Raw | ConvertFrom-Json",
                    "$originObject.native_fem_attempt_id = $secondAttempt",
                    "$originObject | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $originPath -Encoding UTF8",
                    "$null = New-FullmagFullRuntimeManifest -OutputRoot $outputRoot -ManifestPath $manifestPath -OriginManifestPath $originPath "
                    f"-FullmagExe {_ps_literal(_windows_path(binary))} -FullmagApiExe {_ps_literal(_windows_path(api_binary))} "
                    f"-NativeFdmDll {_ps_literal(_windows_path(fdm_dll))} -NativeFemDll {_ps_literal(_windows_path(fem_dll))} "
                    "-SourceCommit $sourceCommit -SourceSnapshotSha256 $sourceSnapshot -AttemptId $secondAttempt -BuildRoot $outputRoot",
                    "if (-not (Test-Path -LiteralPath $receipt -PathType Leaf)) { throw 'previous immutable attempt was deleted' }",
                    "$schedulerPath = Join-Path $outputRoot 'fullmag-api-accepted-scheduler.exe'",
                    "Remove-Item -LiteralPath $schedulerPath -Force",
                    "$missingSchedulerRejected = $false",
                    "try { $null = Assert-FullmagFullRuntimeManifest -ManifestPath $manifestPath -OriginManifestPath $originPath "
                    f"-FullmagExe {_ps_literal(_windows_path(binary))} -FullmagApiExe {_ps_literal(_windows_path(api_binary))} "
                    f"-NativeFdmDll {_ps_literal(_windows_path(fdm_dll))} -NativeFemDll {_ps_literal(_windows_path(fem_dll))} "
                    "-ExpectedBuildId (Get-FullmagFullPackageSha256 -Path $manifestPath) -SourceCommit $sourceCommit -SourceSnapshotSha256 $sourceSnapshot -AttemptId $secondAttempt -BuildRoot $outputRoot } catch { $missingSchedulerRejected = $true }",
                    "if (-not $missingSchedulerRejected) { throw 'missing scheduler was accepted by the full capability validator' }",
                    "Write-Output 'full-capability-missing-scheduler-rejected'",
                    "Write-Output 'full-capability-helper-verified'",
                ]
            ),
            encoding="utf-8",
        )
        result = subprocess.run(
            [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", _windows_path(probe)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
            check=False,
        )
        assert result.returncode == 0, result.stdout + result.stderr
        assert "full-capability-outside-rejected" in result.stdout
        assert "full-capability-reparse-" in result.stdout
        assert "full-capability-missing-scheduler-rejected" in result.stdout
        assert "full-capability-helper-verified" in result.stdout
        if "full-capability-reparse-unsupported" in result.stdout:
            pytest.skip("native reparse-link creation is unavailable on this host")
        assert "full-capability-reparse-rejected" in result.stdout
        assert result.stdout.strip().endswith("full-capability-helper-verified")
        assert hashes["binary"] == hashlib.sha256(binary.read_bytes()).hexdigest()
    finally:
        shutil.rmtree(fixture, ignore_errors=True)


@pytest.mark.skipif(_powershell() is None, reason="Windows PowerShell is unavailable")
def test_native_runtime_inventory_uses_bound_frozen_tools() -> None:
    powershell = _powershell()
    assert powershell is not None
    runs_root = _canonical_runs_root()
    fixture = runs_root / f"full-capability-tools-{uuid.uuid4().hex}"
    origin = fixture / "origin"
    frozen = fixture / "frozen"
    fixture.mkdir(parents=True)
    origin.mkdir()
    frozen.mkdir()
    try:
        (origin / "runtime_bundle.py").write_text(
            "BINARY_NAMES = ('origin-runtime.exe',)\n", encoding="utf-8"
        )
        (frozen / "runtime_bundle.py").write_text(
            "BINARY_NAMES = ('frozen-runtime.exe',)\n", encoding="utf-8"
        )
        probe = fixture / "probe.ps1"
        probe.write_text(
            "\n".join(
                [
                    "$ErrorActionPreference = 'Stop'",
                    f". {_ps_literal(_windows_path(HELPER))}",
                    f"$origin = {_ps_literal(_windows_path(origin))}",
                    f"$frozen = {_ps_literal(_windows_path(frozen))}",
                    "$frozenNames = @(Get-FullmagFullPackageCanonicalRuntimeNames -ToolsRoot $frozen)",
                    "if ($frozenNames.Count -ne 1 -or $frozenNames[0] -cne 'frozen-runtime.exe') { throw 'frozen runtime inventory was not selected' }",
                    "Set-Content -LiteralPath (Join-Path $origin 'runtime_bundle.py') -Value \"BINARY_NAMES = ('origin-mutated.exe',)\" -Encoding UTF8",
                    "$afterOriginMutation = @(Get-FullmagFullPackageCanonicalRuntimeNames -ToolsRoot $frozen)",
                    "if ($afterOriginMutation.Count -ne 1 -or $afterOriginMutation[0] -cne 'frozen-runtime.exe') { throw 'origin mutation changed frozen runtime inventory' }",
                    "$originNames = @(Get-FullmagFullPackageCanonicalRuntimeNames -ToolsRoot $origin)",
                    "if ($originNames.Count -ne 1 -or $originNames[0] -cne 'origin-mutated.exe') { throw 'origin fixture was not independently observable' }",
                    "Write-Output 'frozen-runtime-inventory-bound'",
                ]
            ),
            encoding="utf-8",
        )
        result = subprocess.run(
            [
                powershell,
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                _windows_path(probe),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
            check=False,
        )
        assert result.returncode == 0, result.stdout + result.stderr
        assert "frozen-runtime-inventory-bound" in result.stdout
    finally:
        shutil.rmtree(fixture, ignore_errors=True)


@pytest.mark.skipif(_powershell() is None, reason="Windows PowerShell is unavailable")
def test_native_launcher_rejects_all_backends_outside_empty_workspace() -> None:
    powershell = _powershell()
    assert powershell is not None
    result = subprocess.run(
        [
            powershell,
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            _windows_path(RUNNER),
            "-BuildMode",
            "false",
            "-RunMode",
            "interactive",
            "-Backend",
            "auto",
            "-Device",
            "auto",
            "-AllBackends",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
        check=False,
    )
    assert result.returncode != 0
    assert "only valid for an empty workspace" in (result.stdout + result.stderr)


@pytest.mark.skipif(_powershell() is None, reason="Windows PowerShell is unavailable")
def test_native_msvc_selector_rejects_onecore_or_missing_desktop_runtime() -> None:
    """Exercise the production CRT selector, including its fail-closed cases."""
    powershell = _powershell()
    assert powershell is not None
    runs_root = _canonical_runs_root()
    fixture = runs_root / f"msvc-redist-selector-{uuid.uuid4().hex}"
    fixture.mkdir(parents=True)
    redist = fixture / "redist"
    probe = fixture / "probe.ps1"
    probe.write_text(
        "\n".join(
            [
                "$ErrorActionPreference = 'Stop'",
                f"$sourcePath = {_ps_literal(_windows_path(RUNNER))}",
                "$tokens = $null; $parseErrors = $null",
                "$sourceAst = [System.Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$parseErrors)",
                "if ($parseErrors.Count) { throw 'run_fullmag.ps1 parse failed' }",
                "$functionNames = @('Test-NativeFemPathWithin', 'Assert-NativeFemPathChain', 'Resolve-AbsolutePath', 'Get-NativeFemMsvcDesktopX64RedistRoot')",
                "foreach ($functionName in $functionNames) {",
                "  $functionAst = @($sourceAst.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) | Where-Object { $_.Name -eq $functionName }) | Select-Object -First 1",
                "  if ($null -eq $functionAst) { throw \"missing production function: $functionName\" }",
                "  . ([scriptblock]::Create($functionAst.Extent.Text))",
                "}",
                f"$redistRoot = {_ps_literal(_windows_path(redist))}",
                "$desktop = Join-Path $redistRoot 'x64\\Microsoft.VC143.CRT'",
                "$onecore = Join-Path $redistRoot 'onecore\\x64\\Microsoft.VC143.CRT'",
                "New-Item -ItemType Directory -Force -Path $desktop, $onecore | Out-Null",
                "Set-Content -LiteralPath (Join-Path $desktop 'vcruntime140.dll') -Value 'desktop' -Encoding ASCII",
                "Set-Content -LiteralPath (Join-Path $onecore 'vcruntime140.dll') -Value 'onecore' -Encoding ASCII",
                "$env:VCToolsRedistDir = $redistRoot",
                "$selected = Get-NativeFemMsvcDesktopX64RedistRoot",
                "if ([System.IO.Path]::GetFullPath($selected) -ine [System.IO.Path]::GetFullPath($desktop)) { throw 'desktop CRT root was not selected' }",
                "Write-Output 'native-msvc-desktop-x64-selected'",
                "Remove-Item -LiteralPath $desktop -Recurse -Force",
                "$onecoreOnlyRejected = $false",
                "try { $null = Get-NativeFemMsvcDesktopX64RedistRoot } catch { $onecoreOnlyRejected = $true }",
                "if (-not $onecoreOnlyRejected) { throw 'onecore-only CRT was accepted' }",
                "Write-Output 'native-msvc-onecore-only-rejected'",
                "New-Item -ItemType Directory -Force -Path $desktop | Out-Null",
                "$missingVcruntimeRejected = $false",
                "try { $null = Get-NativeFemMsvcDesktopX64RedistRoot } catch { $missingVcruntimeRejected = $true }",
                "if (-not $missingVcruntimeRejected) { throw 'desktop CRT without vcruntime140.dll was accepted' }",
                "Write-Output 'native-msvc-desktop-vcruntime-missing-rejected'",
            ]
        ),
        encoding="utf-8",
    )
    try:
        result = subprocess.run(
            [
                powershell,
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                _windows_path(probe),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
            check=False,
        )
        assert result.returncode == 0, result.stdout + result.stderr
        output = result.stdout + result.stderr
        assert "native-msvc-desktop-x64-selected" in output
        assert "native-msvc-onecore-only-rejected" in output
        assert "native-msvc-desktop-vcruntime-missing-rejected" in output
    finally:
        shutil.rmtree(fixture, ignore_errors=True)
