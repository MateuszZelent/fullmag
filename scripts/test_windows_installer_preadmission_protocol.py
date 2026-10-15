"""Execute the embedded Windows installer pre-admission protocol.

This is an interpreted native-Windows regression for the protocol boundary
between the Burn BA and ``setup_build_environment.ps1``.  It extracts the
actual PowerShell chunks from the production C++ source, executes an isolated
synthetic fixture, and checks the public response.  It deliberately does not
build the BA, invoke Burn, run the full setup route, or install dependencies.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
CPP = ROOT / "scripts/windows/installer/FullmagBootstrapperApplication/FullmagBootstrapperApplication.cpp"
SETUP = ROOT / "scripts/windows/setup_build_environment.ps1"
INSTALLER_ENV = ROOT / "scripts/windows/installer_env.ps1"
REQUIREMENTS = ROOT / "windows_build_requirements.json"


def _powershell() -> str | None:
    if os.name != "nt":
        return None
    return shutil.which("powershell.exe") or shutil.which("powershell")


def _windows_path(path: Path) -> str:
    if os.name == "nt":
        return str(path)
    wslpath = shutil.which("wslpath")
    if wslpath is None:
        raise unittest.SkipTest("wslpath is required for native Windows PowerShell")
    result = subprocess.run(
        [wslpath, "-w", str(path)],
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
    return result.stdout.strip()


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _extract_protocol(source: str) -> str:
    """Join every raw string chunk used by the real ProtocolScript builder."""

    chunks = re.findall(r'script\s*\+=\s*LR"PS\((.*?)\)PS";', source, re.DOTALL)
    if len(chunks) < 2:
        raise AssertionError(f"ProtocolScript raw chunks missing: {len(chunks)}")
    protocol = "".join(chunks)
    if "'bootstrap_preadmission'" not in protocol:
        raise AssertionError("extracted protocol has no pre-admission operation")
    return protocol


def _version_tuple(value: str) -> tuple[int, ...] | None:
    match = re.search(r"\d+(?:\.\d+){1,3}", value)
    if match is None:
        return None
    return tuple(int(part) for part in match.group(0).split("."))


def _version_at_least(actual: str, minimum: str) -> bool:
    actual_tuple = _version_tuple(actual)
    minimum_tuple = _version_tuple(minimum)
    if actual_tuple is None or minimum_tuple is None:
        return False
    width = max(len(actual_tuple), len(minimum_tuple))
    return actual_tuple + (0,) * (width - len(actual_tuple)) >= minimum_tuple + (0,) * (
        width - len(minimum_tuple)
    )


def _native_toolchain(
    powershell: str,
    environment: dict[str, str],
    requirements: dict[str, object],
) -> dict[str, str] | None:
    """Return verified existing tool paths and versions; never install tools."""

    probe = (
        "$ErrorActionPreference='Stop'; "
        "$g=Get-Command git.exe -ErrorAction SilentlyContinue; "
        "$p=Get-Command python.exe -ErrorAction SilentlyContinue; "
        "if($null -eq $g -or $null -eq $p){exit 3}; "
        "$gv=(& $g.Source --version 2>$null | Select-Object -First 1); "
        "$pv=(& $p.Source --version 2>&1 | Select-Object -First 1); "
        "[ordered]@{git_path=[string]$g.Source;git_version=[string]$gv;"
        "python_path=[string]$p.Source;python_version=[string]$pv} | "
        "ConvertTo-Json -Compress"
    )
    result = subprocess.run(
        [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", probe],
        capture_output=True,
        timeout=20,
        env=environment,
    )
    if result.returncode != 0:
        return None
    try:
        info = json.loads(result.stdout.strip())
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    if not isinstance(info, dict):
        return None
    tools = requirements.get("tools")
    if not isinstance(tools, dict):
        return None
    git_requirement = tools.get("git")
    python_requirement = tools.get("python")
    if not isinstance(git_requirement, dict) or not isinstance(python_requirement, dict):
        return None
    git_minimum = str(git_requirement.get("minimum", ""))
    python_minimum = str(python_requirement.get("minimum", ""))
    if not _version_at_least(str(info.get("git_version", "")), git_minimum):
        return None
    if not _version_at_least(str(info.get("python_version", "")), python_minimum):
        return None
    if not info.get("git_path") or not info.get("python_path"):
        return None
    return {str(key): str(value) for key, value in info.items()}


def _resolve_installer_runs_root(
    native_python: str,
    environment: dict[str, str],
) -> str | None:
    """Resolve the configured canonical installer runs root without creating it."""

    result = subprocess.run(
        [
            native_python,
            "-B",
            str(ROOT / "scripts/fullmag_storage.py"),
            "resolve",
            "--repo-root",
            str(ROOT),
            "--profile",
            "windows-installer-source",
        ],
        capture_output=True,
        timeout=30,
        env=environment,
    )
    if result.returncode != 0:
        return None
    try:
        layout = json.loads(result.stdout)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    if not isinstance(layout, dict) or layout.get("profile") != "windows-installer-source":
        return None
    runs_root = layout.get("runs_root")
    if not isinstance(runs_root, str) or not runs_root or not Path(runs_root).is_dir():
        return None
    return runs_root


def _write_protocol_host(path: Path, protocol: str) -> None:
    encoded = base64.b64encode(protocol.encode("utf-16le")).decode("ascii")
    path.write_text(
        "$ErrorActionPreference = 'Stop'\n"
        f"$encoded = '{encoded}'\n"
        "$script = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($encoded))\n"
        "& ([ScriptBlock]::Create($script))\n",
        encoding="utf-8",
        newline="\r\n",
    )


def _run_protocol(
    powershell: str,
    host: Path,
    request: dict[str, object],
    environment: dict[str, str],
) -> tuple[int, list[dict[str, object]], str]:
    request_line = (json.dumps(request, separators=(",", ":")) + "\n").encode("utf-8")
    result = subprocess.run(
        [
            powershell,
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            _windows_path(host),
        ],
        input=request_line,
        capture_output=True,
        timeout=120,
        env=environment,
    )
    stdout = result.stdout.decode("utf-8-sig", errors="replace")
    stderr = result.stderr.decode("utf-8-sig", errors="replace")
    responses: list[dict[str, object]] = []
    for line in stdout.splitlines():
        candidate = line.strip()
        if not candidate.startswith("{"):
            continue
        try:
            value = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            responses.append(value)
    diagnostics = "stdout_json_count=" + str(len(responses))
    if stderr.strip():
        diagnostics += "; stderr_present=true"
    return result.returncode, responses, diagnostics


class NativeInstallerPreadmissionProtocol(unittest.TestCase):
    @unittest.skipUnless(
        os.name == "nt",
        "native Windows PowerShell is required for this interpreted protocol check",
    )
    def test_old_separator_is_blocked_and_current_protocol_completes(self) -> None:
        powershell = _powershell()
        if powershell is None:
            self.skipTest("Windows PowerShell is required for the native protocol check")

        environment = os.environ.copy()
        environment["PATHEXT"] = ".COM;.EXE;.BAT;.CMD"
        requirements = json.loads(REQUIREMENTS.read_text(encoding="utf-8"))
        toolchain = _native_toolchain(powershell, environment, requirements)
        if toolchain is None:
            self.skipTest("native Git/Python do not satisfy the pinned minima; refusing installer fallback")
        runs_root = _resolve_installer_runs_root(toolchain["python_path"], environment)
        if runs_root is None:
            self.skipTest("configured windows-installer-source runs_root is unavailable; no storage fallback")

        protocol = _extract_protocol(CPP.read_text(encoding="utf-8"))
        single_separator = r"TrimEnd('\', '/')"
        doubled_separator = r"TrimEnd('\\', '/')"
        self.assertEqual(protocol.count(single_separator), 1)
        self.assertEqual(protocol.count(doubled_separator), 0)
        old_protocol = protocol.replace(single_separator, doubled_separator, 1)
        self.assertEqual(old_protocol.count(doubled_separator), 1)

        # Keep the fixture under the resolver-owned runs namespace.  The
        # production preflight rejects UNC paths and source-tree temp files
        # could be captured by a concurrent source snapshot.
        with tempfile.TemporaryDirectory(prefix="fullmag-preadmission-", dir=runs_root) as temporary:
            fixture = Path(temporary)
            (fixture / "scripts/windows").mkdir(parents=True)
            (fixture / "storage").mkdir()
            shutil.copyfile(SETUP, fixture / "scripts/windows/setup_build_environment.ps1")
            shutil.copyfile(INSTALLER_ENV, fixture / "scripts/windows/installer_env.ps1")
            shutil.copyfile(REQUIREMENTS, fixture / "windows_build_requirements.json")
            env_path = fixture / ".env"
            env_path.write_bytes(
                b"POSTGRES_PASSWORD=synthetic-secret-do-not-print\r\n"
                b"RUST_LOG=info\r\n"
            )
            before_env_hash = _sha256(env_path)

            setup_path = fixture / "scripts/windows/setup_build_environment.ps1"
            manifest_path = fixture / "windows_build_requirements.json"
            helper_path = fixture / "scripts/windows/installer_env.ps1"
            request: dict[str, object] = {
                "op": "bootstrap_preadmission",
                "helper_path": _windows_path(helper_path),
                "checkout_path": _windows_path(fixture),
                "setup_path": _windows_path(setup_path),
                "setup_hash": _sha256(setup_path),
                "manifest_path": _windows_path(manifest_path),
                "manifest_hash": _sha256(manifest_path),
                "storage_root": _windows_path(fixture / "storage"),
                "lane": "all",
            }

            old_host = fixture / "old-protocol.ps1"
            _write_protocol_host(old_host, old_protocol)
            old_code, old_responses, old_diagnostics = _run_protocol(
                powershell, old_host, request, environment
            )
            self.assertEqual(old_code, 0, old_diagnostics)
            self.assertTrue(old_responses, old_diagnostics)
            old_response = old_responses[-1]
            self.assertEqual(old_response.get("schema"), "fullmag.windows-installer-bridge.v1")
            self.assertEqual(old_response.get("state"), "blocked")
            self.assertEqual(old_response.get("valid"), False)
            self.assertEqual(_sha256(env_path), before_env_hash)

            current_host = fixture / "current-protocol.ps1"
            _write_protocol_host(current_host, protocol)
            current_code, current_responses, current_diagnostics = _run_protocol(
                powershell, current_host, request, environment
            )
            self.assertEqual(current_code, 0, current_diagnostics)
            self.assertTrue(current_responses, current_diagnostics)
            current_response = current_responses[-1]
            self.assertEqual(
                current_response.get("schema"),
                "fullmag.windows-installer-preadmission.v1",
            )
            self.assertEqual(current_response.get("state"), "complete")
            self.assertEqual(current_response.get("readiness"), "prerequisites_ready")
            self.assertEqual(current_response.get("lane"), "all")
            self.assertEqual(current_response.get("source_admitted"), False)
            self.assertEqual(current_response.get("env_write"), False)
            self.assertEqual(current_response.get("project_owned_writes"), False)
            self.assertEqual(current_response.get("storage_resolver"), "not_run")
            blockers = [str(value) for value in current_response.get("blockers", []) if str(value)]
            self.assertEqual(blockers, [])
            self.assertTrue(current_response.get("tools", {}).get("git", {}).get("path"))
            self.assertTrue(current_response.get("tools", {}).get("python", {}).get("path"))
            installation = current_response.get("installation")
            if isinstance(installation, dict):
                self.assertEqual(installation.get("attempted", []), [])
            self.assertEqual(_sha256(env_path), before_env_hash)


if __name__ == "__main__":
    unittest.main()
