"""Bounded PE validation regression for the Windows Burn producer."""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import uuid

import pytest


ROOT = Path(__file__).resolve().parents[1]
BUILDER = ROOT / "scripts/windows/build_windows_installer_exe.ps1"
POWERSHELL = shutil.which("powershell.exe") or shutil.which("powershell") or shutil.which("pwsh")


def _extract_function(source: str, name: str, next_name: str) -> str:
    start = source.index(f"function {name} {{")
    end = source.index(f"function {next_name} {{", start)
    return source[start:end]


def _native_windows_path(path: Path) -> str:
    value = str(path.resolve())
    if value.startswith("/mnt/") and len(value) > len("/mnt/x/"):
        return value[5].upper() + ":\\" + value[7:].replace("/", "\\")
    return value


def _canonical_runs_root() -> Path:
    sys.path.insert(0, str(ROOT / "scripts"))
    import fullmag_storage as storage  # noqa: PLC0415

    try:
        layout = storage.resolve_layout(
            ROOT,
            profile="windows-installer-source",
            environ=dict(os.environ),
        )
    except Exception as exc:  # pragma: no cover - host configuration varies
        pytest.skip(f"canonical installer runs_root is unavailable: {exc}")
    runs_root = Path(str(layout["runs_root"]))
    if not runs_root.is_absolute() or not runs_root.is_dir():
        pytest.skip("canonical installer runs_root is unavailable")
    return runs_root


def _minimal_pe(*, signature: bytes = b"PE\0\0", machine: int = 0x014C) -> bytes:
    dos = bytearray(64)
    dos[:2] = b"MZ"
    struct.pack_into("<I", dos, 0x3C, 64)
    coff = struct.pack("<HHIIIHH", machine, 1, 0, 0, 0, 224, 0x0002)
    optional = bytearray(224)
    struct.pack_into("<H", optional, 0, 0x010B)
    struct.pack_into("<H", optional, 68, 2)
    section_offset = 64 + 4 + len(coff) + len(optional) + 40
    section = bytearray(40)
    section[:8] = b".wixburn"
    struct.pack_into("<I", section, 16, 1)
    struct.pack_into("<I", section, 20, section_offset)
    return bytes(dos) + signature + coff + bytes(optional) + bytes(section) + b"\0"


def _run_fixture(*, actual_artifact: str | None = None) -> subprocess.CompletedProcess[str]:
    if POWERSHELL is None:
        pytest.skip("Windows PowerShell is unavailable")
    runs_root = _canonical_runs_root()
    fixture = runs_root / f"installer-pe-contract-{uuid.uuid4().hex}"
    fixture.mkdir()
    try:
        (fixture / "valid.exe").write_bytes(_minimal_pe())
        dos_only = bytearray(64)
        dos_only[:2] = b"MZ"
        (fixture / "mz-only.exe").write_bytes(dos_only)
        truncated = bytearray(64)
        truncated[:2] = b"MZ"
        struct.pack_into("<I", truncated, 0x3C, 64)
        (fixture / "truncated.exe").write_bytes(bytes(truncated) + b"PE\0")
        (fixture / "invalid-pe.exe").write_bytes(_minimal_pe(signature=b"NOPE"))
        helper = _extract_function(
            BUILDER.read_text(encoding="utf-8"),
            "Assert-BoundedBurnPeImage",
            "Assert-Directory",
        )
        # The production helper deliberately delegates regular-file and
        # reparse checks to the established chain. This fixture supplies the
        # smallest equivalent boundary so the PE parser itself is exercised.
        script = "\n".join(
            [
                "$ErrorActionPreference = 'Stop'",
                "function Assert-RegularFile {",
                "  param([Parameter(Mandatory=$true)][string]$Path,[Parameter(Mandatory=$true)][string]$Label,[Parameter()][string]$Extension)",
                "  $full = [IO.Path]::GetFullPath($Path)",
                "  if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw ($Label + ' missing') }",
                "  if ($Extension -and ([IO.Path]::GetExtension($full) -ine $Extension)) { throw ($Label + ' extension') }",
                "  return $full",
                "}",
                helper,
                "$valid = Assert-BoundedBurnPeImage -Path (Join-Path $PSScriptRoot 'valid.exe') -Label 'valid fixture'",
                "if ([string]$valid.machine -ne 'x86' -or [string]$valid.optional_header -ne 'PE32' -or [string]$valid.subsystem -ne 'GUI' -or [string]$valid.required_section -ne '.wixburn') { throw 'valid PE evidence is incomplete' }",
                "foreach ($name in @('mz-only.exe','truncated.exe','invalid-pe.exe')) {",
                "  $rejected = $false",
                "  try { Assert-BoundedBurnPeImage -Path (Join-Path $PSScriptRoot $name) -Label $name | Out-Null } catch { $rejected = $true }",
                "  if (-not $rejected) { throw ($name + ' was accepted') }",
                "}",
                "$actual = [Environment]::GetEnvironmentVariable('FULLMAG_INSTALLER_PE_ARTIFACT','Process')",
                "if (-not [string]::IsNullOrWhiteSpace($actual)) { $actualEvidence = Assert-BoundedBurnPeImage -Path $actual -Label 'current produced installer'; if ([string]$actualEvidence.required_section -ne '.wixburn') { throw 'current produced installer omitted WiX Burn evidence' } }",
                "Write-Output 'bounded-pe-fixture-verified'",
            ]
        )
        script_path = fixture / "pe-fixture.ps1"
        script_path.write_text(script, encoding="utf-8")
        env = dict(os.environ)
        if actual_artifact is not None:
            env["FULLMAG_INSTALLER_PE_ARTIFACT"] = actual_artifact
        return subprocess.run(
            [POWERSHELL, "-NoLogo", "-NoProfile", "-NonInteractive", "-File", _native_windows_path(script_path)],
            capture_output=True,
            text=True,
            timeout=30,
            env=env,
            check=False,
        )
    finally:
        shutil.rmtree(fixture, ignore_errors=True)


def test_builder_exposes_bounded_pe32_burn_contract() -> None:
    source = BUILDER.read_text(encoding="utf-8")
    helper = _extract_function(source, "Assert-BoundedBurnPeImage", "Assert-Directory")
    for marker in (
        "MZ DOS header",
        "out-of-bounds PE header offset",
        "section table outside the file bounds",
        "expected x86 PE32 GUI executable",
        "marked as a DLL",
        "expected WiX Burn section",
        "[IO.File]::Open",
        "ReadBytes(64)",
    ):
        assert marker in helper
    assert "Assert-BoundedBurnPeImage -Path $output" in source
    assert "pe_contract = [ordered]@{" in source
    assert "pe_validation = $peEvidence" in source


@pytest.mark.skipif(POWERSHELL is None, reason="Windows PowerShell is unavailable")
def test_bounded_pe_parser_accepts_valid_fixture_and_rejects_malformed_headers() -> None:
    result = _run_fixture()
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.strip() == "bounded-pe-fixture-verified"


@pytest.mark.skipif(
    POWERSHELL is None or not os.environ.get("FULLMAG_INSTALLER_PE_ARTIFACT"),
    reason="set FULLMAG_INSTALLER_PE_ARTIFACT to a produced installer",
)
def test_current_produced_installer_passes_bounded_pe_parser() -> None:
    result = _run_fixture(actual_artifact=os.environ["FULLMAG_INSTALLER_PE_ARTIFACT"])
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.strip() == "bounded-pe-fixture-verified"
