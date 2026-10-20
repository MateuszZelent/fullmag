"""Native embedded-helper regression for committed Windows storage layout admission.

The check runs the actual PowerShell protocol embedded in the native Burn BA and
the versioned installer helper.  It never builds Rust/C++, launches a product,
or uses a host-side storage creator outside the managed resolver.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading
import unittest


ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / "scripts" / "windows" / "installer_env.ps1"
RESOLVER = ROOT / "scripts" / "fullmag_storage.py"
EMBEDDED_HELPER = ROOT / "scripts" / "windows" / "installer" / "FullmagBootstrapperApplication" / "FullmagBootstrapperApplication.cpp"


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
        raise unittest.SkipTest("wslpath is required to invoke native Windows PowerShell")
    result = subprocess.run(
        [wslpath, "-w", str(path)], check=True, capture_output=True, text=True
    )
    return result.stdout.strip()


def _ps_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


class NativeInstallerStorageLayoutContract(unittest.TestCase):
    def _write_windows_temp_script(self, powershell: str, content: str) -> str:
        writer = r"""
$ErrorActionPreference = 'Stop'
$path = Join-Path ([System.IO.Path]::GetTempPath()) ('fullmag-installer-layout-' + [guid]::NewGuid().ToString('N') + '.ps1')
[System.IO.File]::WriteAllText($path, [Console]::In.ReadToEnd(), [System.Text.UTF8Encoding]::new($false))
Write-Output $path
"""
        completed = subprocess.run(
            [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", writer],
            input=content,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        paths = [line.strip() for line in completed.stdout.splitlines() if line.strip()]
        self.assertTrue(paths, "native temporary PowerShell script path was not returned")
        return paths[-1]

    def _remove_windows_path(self, powershell: str, path: str) -> None:
        subprocess.run(
            [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
             "-Command", f"Remove-Item -LiteralPath {_ps_literal(path)} -Recurse -Force -ErrorAction SilentlyContinue"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )

    def test_layout_creation_requires_commit_and_rejects_identity_drift(self) -> None:
        powershell = _powershell()
        if powershell is None:
            self.skipTest("Windows PowerShell is required for this native interpreted check")

        module = _windows_path(MODULE)
        resolver = _windows_path(RESOLVER)
        source = EMBEDDED_HELPER.read_text(encoding="utf-8")
        start = source.index("    static std::wstring ProtocolScript() {")
        end = source.index("\n    std::mutex lock_", start)
        chunks = re.findall(r'LR"PS\((.*?)\)PS"', source[start:end], flags=re.DOTALL)
        self.assertEqual(len(chunks), 5, "embedded helper protocol chunk count changed")
        protocol_path = self._write_windows_temp_script(powershell, "".join(chunks))

        setup_script = f"""
$ErrorActionPreference = 'Stop'
$env:PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL'
$git = (Get-Command git.exe -ErrorAction Stop).Source
$python = (Get-Command python.exe -ErrorAction Stop).Source
$sourceResolver = {_ps_literal(resolver)}
$root = Join-Path ([System.IO.Path]::GetTempPath()) ('fullmag storage layout ' + [guid]::NewGuid().ToString('N'))
$repo = Join-Path $root 'main'
$storage = Join-Path $root 'storage'
New-Item -ItemType Directory -Path $repo, $storage, (Join-Path $repo 'scripts') -Force | Out-Null
& $git init --quiet $repo
if ($LASTEXITCODE -ne 0) {{ throw 'git init failed' }}
Copy-Item -LiteralPath $sourceResolver -Destination (Join-Path $repo 'scripts/fullmag_storage.py')
[System.IO.File]::WriteAllText(
  (Join-Path $repo '.env.example'),
  "RUST_LOG=info`r`nFULLMAG_PROJECT_STORAGE_ROOT=`r`n",
  [System.Text.UTF8Encoding]::new($false)
)
[System.IO.File]::WriteAllText(
  (Join-Path $repo 'windows_build_requirements.json'),
  '{{"storage":{{"env_key":"FULLMAG_PROJECT_STORAGE_ROOT","setup_profile":"windows-setup"}}}}',
  [System.Text.UTF8Encoding]::new($false)
)
[System.IO.File]::WriteAllText(
  (Join-Path $repo '.env'),
  "RUST_LOG=info`r`nFULLMAG_PROJECT_STORAGE_ROOT=$storage`r`n",
  [System.Text.UTF8Encoding]::new($false)
)
& $git -C $repo add .env.example windows_build_requirements.json scripts/fullmag_storage.py
if ($LASTEXITCODE -ne 0) {{ throw 'git add failed' }}
& $git -c user.name='Fullmag fixture' -c user.email='fixture@example.invalid' -C $repo commit --quiet -m fixture
if ($LASTEXITCODE -ne 0) {{ throw 'git commit failed' }}
[ordered]@{{ root = $root; repo = $repo; storage = $storage; git = $git; python = $python }} | ConvertTo-Json -Compress
"""
        setup_path = self._write_windows_temp_script(powershell, setup_script)
        fixture_root: str | None = None
        helper: subprocess.Popen[str] | None = None
        transcript: list[str] = []
        try:
            setup = subprocess.run(
                [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", setup_path],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                check=False,
            )
            self.assertEqual(setup.returncode, 0, setup.stderr)
            lines = [line.strip() for line in setup.stdout.splitlines() if line.strip()]
            self.assertTrue(lines, "storage layout fixture did not return metadata")
            fixture = json.loads(lines[-1])
            fixture_root = str(fixture["root"])
            repo = str(fixture["repo"])
            storage = str(fixture["storage"])

            helper = subprocess.Popen(
                [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", protocol_path],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
            )

            def read_line(timeout: float = 30.0) -> str:
                result: list[str] = []

                def read() -> None:
                    assert helper is not None and helper.stdout is not None
                    result.append(helper.stdout.readline())

                reader = threading.Thread(target=read, daemon=True)
                reader.start()
                reader.join(timeout)
                self.assertFalse(reader.is_alive(), "embedded helper did not return a response")
                self.assertTrue(result and result[0], "embedded helper closed stdout before returning a response")
                transcript.append(result[0])
                return result[0].strip()

            def request_response(payload: dict[str, object]) -> dict[str, object]:
                assert helper is not None and helper.stdin is not None
                helper.stdin.write(json.dumps(payload) + "\n")
                helper.stdin.flush()
                return json.loads(read_line())

            self.assertEqual(read_line(), "fullmag.windows-installer-helper-ready.v1")
            discovered = request_response({
                "op": "discover",
                "helper_path": module,
                "checkout_path": repo,
                "git_path": str(fixture["git"]),
                "python_path": str(fixture["python"]),
            })
            self.assertEqual(discovered.get("schema"), "fullmag.windows-installer-env-session.v1")
            session_id = str(discovered["session_id"])
            source_identity = {
                "checkout_path": repo,
                "source_checkout": repo,
                "main_checkout": repo,
                "source_git_head": discovered["requested_git_head"],
                "source_git_worktrees_hash": discovered["requested_git_worktrees_hash"],
                "main_git_head": discovered["git_head"],
                "main_git_worktrees_hash": discovered["git_worktrees_hash"],
                "template_hash": discovered["template_hash"],
                "manifest_hash": discovered["manifest_hash"],
                "resolver_hash": discovered["resolver_hash"],
                "storage_root": storage,
                "storage_profile": "windows-setup",
            }

            before_commit = request_response({
                **source_identity,
                "op": "prepare_storage_layout",
                "session_id": session_id,
                "environment_hash": discovered["original_hash"],
            })
            self.assertEqual(before_commit.get("state"), "blocked")
            self.assertFalse(before_commit.get("valid", True))

            committed = request_response({
                "op": "commit",
                "session_id": session_id,
                "values": {},
            })
            self.assertEqual(committed.get("state"), "unchanged")
            self.assertTrue(committed.get("valid"))
            rebound = str(committed["session_id"])
            source_identity["session_id"] = rebound
            source_identity["environment_hash"] = committed["proposed_hash"]

            prepared = request_response({**source_identity, "op": "prepare_storage_layout"})
            self.assertEqual(prepared.get("schema"), "fullmag.windows-installer-storage-layout.v1")
            self.assertEqual(prepared.get("state"), "complete")
            self.assertEqual(prepared.get("storage_root", "").lower(), storage.lower())
            self.assertEqual(prepared.get("storage_profile"), "windows-setup")
            runs_root = str(prepared.get("runs_root"))
            self.assertTrue(runs_root.lower().startswith((storage + "\\runs\\").lower()))

            mismatch_cases = (
                ("storage_profile", "wrong-profile", "profile drift"),
                ("environment_hash", "0" * 64, "environment hash drift"),
                ("storage_root", storage + "\\alternate", "storage root drift"),
            )
            for key, value, label in mismatch_cases:
                request = dict(source_identity)
                request["op"] = "prepare_storage_layout"
                request[key] = value
                rejected = request_response(request)
                self.assertEqual(rejected.get("state"), "blocked", label)
                self.assertFalse(rejected.get("valid", True), label)

            verify_script = f"""
$ErrorActionPreference = 'Stop'
function Require([bool]$Condition, [string]$Message) {{ if (-not $Condition) {{ throw $Message }} }}
$storage = {_ps_literal(storage)}
$runs = {_ps_literal(runs_root)}
Require (Test-Path -LiteralPath (Join-Path $storage '.fullmag-storage.json') -PathType Leaf) 'storage marker was not created by resolver --create'
Require (Test-Path -LiteralPath $runs -PathType Container) 'runs root was not created by resolver --create'
Require (-not (Test-Path -LiteralPath (Join-Path $storage 'alternate'))) 'mismatched storage root was created'
[ordered]@{{ marker = $true; runs = $true; alternate = $false }} | ConvertTo-Json -Compress
"""
            verify_path = self._write_windows_temp_script(powershell, verify_script)
            try:
                verified = subprocess.run(
                    [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", verify_path],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    check=False,
                )
                self.assertEqual(verified.returncode, 0, verified.stderr)
                self.assertTrue(json.loads([line for line in verified.stdout.splitlines() if line.strip()][-1])["marker"])
            finally:
                self._remove_windows_path(powershell, verify_path)

            mutation_script = f"""
$ErrorActionPreference = 'Stop'
function Require([bool]$Condition, [string]$Message) {{ if (-not $Condition) {{ throw $Message }} }}
. {_ps_literal(module)}
$repo = {_ps_literal(repo)}
$storage = {_ps_literal(storage)}
$python = {_ps_literal(str(fixture["python"]))}
$session = Get-FullmagInstallerEnvSession -CheckoutPath $repo -PythonCommand $python
$committed = Commit-FullmagInstallerEnvProposal -Session $session -Values @{{}}
Require ($committed.state -eq 'unchanged' -and $committed.valid) 'fixture environment was not committed unchanged'
$session.environment_committed = $true
$session.committed_environment_hash = [string]$committed.proposed_hash
$session.session_signature = Get-FullmagInstallerEnvSessionSignature -Session $session
$envPath = [string]$session.env_path
$beforeHash = Get-FullmagInstallerEnvSha256 -Bytes ([System.IO.File]::ReadAllBytes($envPath))
$script:FullmagInstallerEnvBeforeStorageResolveHook = {{
  param($path)
  $lockPath = [string]$path + '.fullmag-installer.lock'
  Require (Test-Path -LiteralPath $lockPath -PathType Leaf) 'storage layout did not hold the .env lock'
  $text = [System.IO.File]::ReadAllText($path)
  $text = [regex]::Replace($text, '(?m)^RUST_LOG=.*$', 'RUST_LOG=mutated')
  [System.IO.File]::WriteAllText($path, $text, [System.Text.UTF8Encoding]::new($false))
}}
$failed = $false
$message = ''
try {{
  Prepare-FullmagInstallerStorageLayout -Session $session -StorageRoot $storage `
    -ExpectedEnvironmentHash ([string]$committed.proposed_hash) -ExpectedStorageProfile 'windows-setup' | Out-Null
}}
catch {{ $failed = $true; $message = [string]$_.Exception.Message }}
finally {{ Remove-Variable -Name FullmagInstallerEnvBeforeStorageResolveHook -Scope Script -ErrorAction SilentlyContinue }}
$afterBytes = [System.IO.File]::ReadAllBytes($envPath)
$afterText = [System.Text.UTF8Encoding]::new($false).GetString($afterBytes)
$afterHash = Get-FullmagInstallerEnvSha256 -Bytes $afterBytes
Require $failed 'storage layout accepted a .env mutation between preview and create'
Require ($message -match '\\.env changed') ('TOCTOU rejection was not reported: ' + $message)
Require ($afterText -match '(?m)^RUST_LOG=mutated$') 'TOCTOU mutation was overwritten'
Require ($afterHash -ne $beforeHash) 'TOCTOU mutation did not reach the fixture'
[ordered]@{{ lock_held = $true; mutation_rejected = $failed; env_preserved = ($afterText -match '(?m)^RUST_LOG=mutated$'); before_hash = $beforeHash; after_hash = $afterHash }} | ConvertTo-Json -Compress
"""
            mutation_path = self._write_windows_temp_script(powershell, mutation_script)
            try:
                mutated = subprocess.run(
                    [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", mutation_path],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    check=False,
                )
                self.assertEqual(mutated.returncode, 0, mutated.stderr or mutated.stdout)
                mutation_result = json.loads(
                    [line for line in mutated.stdout.splitlines() if line.strip()][-1]
                )
                self.assertTrue(mutation_result["lock_held"])
                self.assertTrue(mutation_result["mutation_rejected"])
                self.assertTrue(mutation_result["env_preserved"])
                self.assertNotEqual(mutation_result["before_hash"], mutation_result["after_hash"])
            finally:
                self._remove_windows_path(powershell, mutation_path)
        finally:
            if helper is not None:
                if helper.stdin is not None:
                    try:
                        helper.stdin.close()
                    except OSError:
                        pass
                try:
                    helper.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    helper.kill()
                    helper.wait(timeout=30)
                helper_stdout = helper.stdout.read() if helper.stdout is not None else ""
                helper_stderr = helper.stderr.read() if helper.stderr is not None else ""
                self.assertEqual(helper.returncode, 0, helper_stderr or helper_stdout)
                if helper.stdout is not None:
                    helper.stdout.close()
                if helper.stderr is not None:
                    helper.stderr.close()
            if fixture_root:
                self._remove_windows_path(powershell, fixture_root)
            self._remove_windows_path(powershell, setup_path)
            self._remove_windows_path(powershell, protocol_path)


if __name__ == "__main__":
    unittest.main()
