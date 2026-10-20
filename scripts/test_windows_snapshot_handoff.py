"""Execute the launcher's frozen-source handoff without compiling the product."""
from pathlib import Path
import json
import shutil
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("mutation,accepted", [
    ("none", True),
    ("inventory", False),
    ("backend", False),
    ("missing-backend", False),
])
def test_frozen_manifest_handoff(tmp_path, mutation, accepted):
    powershell = shutil.which("powershell.exe") or shutil.which("pwsh")
    if not powershell:
        pytest.skip("Native PowerShell is required for this interpreted probe")
    source = (ROOT / "scripts/windows/run_fullmag.ps1").read_text(encoding="utf-8-sig")
    start = source.index('if ($BuildMode -eq "false" -and $existingFrozenManifest')
    end = source.index('if ($BuildMode -eq "true") {', start)
    handoff = source[start:end]
    manifest = {
        "backend_source_sha256": "b" * 64,
        "build_source_snapshot": {
            "record_path": "fixture-record.json",
            "inventory_sha256": "a" * 64,
            "source_root": str(tmp_path / "source"),
        },
    }
    if mutation == "inventory":
        manifest["build_source_snapshot"]["inventory_sha256"] = "c" * 64
    elif mutation == "backend":
        manifest["backend_source_sha256"] = "c" * 64
    elif mutation == "missing-backend":
        del manifest["backend_source_sha256"]
    # Match the producer's schema: the backend digest is a top-level field.
    payload = json.dumps(manifest).replace("'", "''")
    probe = tmp_path / "handoff.ps1"
    probe.write_text(
        "$ErrorActionPreference = 'Stop'\n"
        "$BuildMode = 'false'\n$ExpectedBuildId = ''\n"
        f"$existingFrozenManifest = '{payload}' | ConvertFrom-Json\n"
        "function Read-BuildSnapshot { param($RecordPath)\n"
        "  [pscustomobject]@{ inventory_sha256 = ('a' * 64); backend_source_sha256 = ('b' * 64); source_root = 'fixture-source' }\n}\n"
        "try {\n" + handoff + "\n  Write-Output 'ACCEPTED'\n}\n"
        "catch { Write-Output ('REJECTED: ' + $_.Exception.Message) }\n",
        encoding="utf-8",
    )
    result = subprocess.run(
        [powershell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(probe)],
        capture_output=True, text=True, check=True, timeout=30,
    )
    if accepted:
        assert result.stdout.strip() == "ACCEPTED", result.stdout + result.stderr
    else:
        assert "REJECTED: Build manifest does not match its frozen sources" in result.stdout
