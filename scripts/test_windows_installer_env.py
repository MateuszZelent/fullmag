"""Native PowerShell contract checks for the transactional installer .env editor.

The fixture deliberately exercises only PowerShell, Git and the read-only
Fullmag storage resolver.  It does not build Rust, CMake, Cargo, or any
product/runtime target.
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
        [wslpath, "-w", str(path)],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def _ps_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


class NativeInstallerEnvContract(unittest.TestCase):
    def _write_windows_temp_script(self, powershell: str, content: str) -> str:
        writer = r"""
$ErrorActionPreference = 'Stop'
$path = Join-Path ([System.IO.Path]::GetTempPath()) ('fullmag-installer-test-' + [guid]::NewGuid().ToString('N') + '.ps1')
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
        self.assertEqual(completed.returncode, 0, "could not create native temporary PowerShell script")
        paths = [line.strip() for line in completed.stdout.splitlines() if line.strip()]
        self.assertTrue(paths, "native temporary PowerShell script path was not returned")
        return paths[-1]

    def _remove_windows_path(self, powershell: str, path: str) -> None:
        command = f"Remove-Item -LiteralPath {_ps_literal(path)} -Recurse -Force -ErrorAction SilentlyContinue"
        subprocess.run(
            [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )

    def test_embedded_helper_discover_with_hardlinked_tools(self) -> None:
        """Run the embedded ProtocolScript discover branch in Windows PowerShell."""
        powershell = _powershell()
        if powershell is None:
            self.skipTest("Windows PowerShell is required for this native interpreted check")

        module = _windows_path(MODULE)
        resolver = _windows_path(ROOT / "scripts" / "fullmag_storage.py")
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
$sourceResolver = {_ps_literal(resolver)}
$root = Join-Path ([System.IO.Path]::GetTempPath()) ('fullmag helper discover ' + [guid]::NewGuid().ToString('N'))
$repo = Join-Path $root 'main'
$storage = Join-Path $root 'storage'
New-Item -ItemType Directory -Path $repo, $storage, (Join-Path $repo 'scripts') -Force | Out-Null
& $git init --quiet $repo
if ($LASTEXITCODE -ne 0) {{ throw 'git init failed' }}
Copy-Item -LiteralPath $sourceResolver -Destination (Join-Path $repo 'scripts/fullmag_storage.py')
[System.IO.File]::WriteAllText(
  (Join-Path $repo '.env.example'),
  "POSTGRES_PASSWORD=change-me`r`nRUST_LOG=info`r`nFULLMAG_PROJECT_STORAGE_ROOT=`r`nFULLMAG_WINDOWS_VOLATILE_ROOT=`r`nMAIN_TEMPLATE_ONLY=main`r`n",
  [System.Text.UTF8Encoding]::new($false)
)
[System.IO.File]::WriteAllText(
  (Join-Path $repo 'windows_build_requirements.json'),
  '{{"storage":{{"env_key":"FULLMAG_PROJECT_STORAGE_ROOT","setup_profile":"windows-setup"}},"env_keys":["MAIN_MANIFEST_ONLY"]}}',
  [System.Text.UTF8Encoding]::new($false)
)
[System.IO.File]::WriteAllText(
  (Join-Path $repo '.env'),
  "# preserve helper fixture`r`nPOSTGRES_PASSWORD=helper-discover-secret`r`nRUST_LOG=info`r`nFULLMAG_PROJECT_STORAGE_ROOT=$storage`r`nUNTOUCHED=keep`r`n",
  [System.Text.UTF8Encoding]::new($false)
)
& $git -C $repo add .env.example windows_build_requirements.json scripts/fullmag_storage.py
if ($LASTEXITCODE -ne 0) {{ throw 'git add failed' }}
& $git -c user.name='Fullmag fixture' -c user.email='fixture@example.invalid' -C $repo commit --quiet -m fixture
if ($LASTEXITCODE -ne 0) {{ throw 'git commit failed' }}
[ordered]@{{
  root = $root
  repo = $repo
  git = (Get-Command git.exe -ErrorAction Stop).Source
  python = (Get-Command python.exe -ErrorAction Stop).Source
}} | ConvertTo-Json -Compress
"""
        setup_path = self._write_windows_temp_script(powershell, setup_script)
        fixture_root = None
        helper = None
        try:
            setup = subprocess.run(
                [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", setup_path],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                check=False,
            )
            self.assertEqual(setup.returncode, 0, "native discover fixture setup failed")
            lines = [line.strip() for line in setup.stdout.splitlines() if line.strip()]
            self.assertTrue(lines, "native discover fixture did not return metadata")
            self.assertNotIn("helper-discover-secret", setup.stdout + setup.stderr)
            fixture = json.loads(lines[-1])
            fixture_root = str(fixture["root"])
            request = {
                "op": "discover",
                "helper_path": module,
                "checkout_path": str(fixture["repo"]),
                "git_path": str(fixture["git"]),
                "python_path": str(fixture["python"]),
            }
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

            transcript: list[str] = []

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
            response = request_response(request)
            self.assertEqual(response.get("schema"), "fullmag.windows-installer-env-session.v1")
            self.assertTrue(response.get("session_id"), "embedded helper discover returned no session id")
            self.assertEqual(len(response.get("fields", [])), 6, "embedded helper discover returned an incomplete field list")
            for field in response["fields"]:
                if field.get("secret"):
                    self.assertEqual(field.get("current_value"), "<redacted>")

            session_id = str(response["session_id"])
            preview = request_response({
                "op": "preview",
                "session_id": session_id,
                "values": {"RUST_LOG": "debug"},
            })
            self.assertTrue(preview.get("valid") and preview.get("can_commit"))
            self.assertEqual(preview.get("changed_fields"), ["RUST_LOG"])
            self.assertNotIn("helper-discover-secret", json.dumps(preview, sort_keys=True))

            committed = request_response({
                "op": "commit",
                "session_id": session_id,
                "values": {"RUST_LOG": "debug"},
            })
            self.assertEqual(committed.get("state"), "committed")
            self.assertTrue(committed.get("valid") and committed.get("wrote"))
            self.assertEqual(committed.get("changed_fields"), ["RUST_LOG"])
            self.assertTrue(committed.get("session_id"), "commit did not return a rebound session")
            self.assertNotIn("helper-discover-secret", json.dumps(committed, sort_keys=True))

            # The protocol keeps a rebound session after commit, so verify its
            # supported no-op commit does not create another backup or write.
            unchanged = request_response({
                "op": "commit",
                "session_id": str(committed["session_id"]),
                "values": {},
            })
            self.assertEqual(unchanged.get("state"), "unchanged")
            self.assertTrue(unchanged.get("valid"))
            self.assertFalse(unchanged.get("wrote"))
            self.assertEqual(unchanged.get("changed_fields"), [])
            self.assertNotIn("helper-discover-secret", json.dumps(unchanged, sort_keys=True))

            fixture_storage = str(fixture_root) + "\\storage"
            verify_script = f"""
$ErrorActionPreference = 'Stop'
function Require([bool]$Condition, [string]$Message) {{
  if (-not $Condition) {{ throw $Message }}
}}
$repo = {_ps_literal(str(fixture["repo"]))}
$storage = {_ps_literal(fixture_storage)}
$envPath = Join-Path $repo '.env'
$backupRoot = Join-Path (Join-Path $storage 'tmp') 'host-config-backups'
$originalText = "# preserve helper fixture`r`nPOSTGRES_PASSWORD=helper-discover-secret`r`nRUST_LOG=info`r`nFULLMAG_PROJECT_STORAGE_ROOT=$storage`r`nUNTOUCHED=keep`r`n"
$expectedText = "# preserve helper fixture`r`nPOSTGRES_PASSWORD=helper-discover-secret`r`nRUST_LOG=debug`r`nFULLMAG_PROJECT_STORAGE_ROOT=$storage`r`nUNTOUCHED=keep`r`n"
$utf8 = [System.Text.UTF8Encoding]::new($false)
$originalBytes = $utf8.GetBytes($originalText)
$expectedBytes = $utf8.GetBytes($expectedText)
$envBytes = [System.IO.File]::ReadAllBytes($envPath)
$backups = @()
if (Test-Path -LiteralPath $backupRoot) {{
  $backups = @(Get-ChildItem -LiteralPath $backupRoot -File -Filter '.env.backup.*' -Force)
}}
Require ($backups.Count -eq 1) 'commit/no-op cycle did not leave exactly one backup'
$backupBytes = [System.IO.File]::ReadAllBytes($backups[0].FullName)
$envExact = [Convert]::ToBase64String($envBytes) -eq [Convert]::ToBase64String($expectedBytes)
$backupExact = [Convert]::ToBase64String($backupBytes) -eq [Convert]::ToBase64String($originalBytes)
Require $envExact 'commit changed fields beyond RUST_LOG or altered formatting'
Require $backupExact 'backup does not match the original .env bytes'
[ordered]@{{ env_exact = $envExact; backup_exact = $backupExact; backup_count = $backups.Count }} | ConvertTo-Json -Compress
"""
            verify_path = self._write_windows_temp_script(powershell, verify_script)
            try:
                verify = subprocess.run(
                    [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", verify_path],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    check=False,
                )
                self.assertEqual(verify.returncode, 0, "native commit verification failed")
                self.assertNotIn("helper-discover-secret", verify.stdout + verify.stderr)
                verification_lines = [line.strip() for line in verify.stdout.splitlines() if line.strip()]
                self.assertTrue(verification_lines, "native commit verification returned no result")
                verification = json.loads(verification_lines[-1])
                self.assertTrue(verification.get("env_exact") and verification.get("backup_exact"))
                self.assertEqual(verification.get("backup_count"), 1)
            finally:
                self._remove_windows_path(powershell, verify_path)
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
                if helper.stdout is not None:
                    helper.stdout.close()
                if helper.stderr is not None:
                    helper.stderr.close()
                self.assertEqual(helper.returncode, 0, "embedded helper protocol process failed")
                self.assertNotIn("helper-discover-secret", "".join(transcript) + helper_stdout + helper_stderr,
                                 "embedded helper leaked the synthetic secret")
            if fixture_root:
                self._remove_windows_path(powershell, fixture_root)
            self._remove_windows_path(powershell, setup_path)
            self._remove_windows_path(powershell, protocol_path)

    def test_transactional_env_editor(self) -> None:
        powershell = _powershell()
        if powershell is None:
            self.skipTest("Windows PowerShell is required for this native interpreted check")

        module = _windows_path(MODULE)
        source_resolver = _windows_path(ROOT / "scripts" / "fullmag_storage.py")
        script = f"""
$ErrorActionPreference = 'Stop'
$env:PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL'
. {_ps_literal(module)}

function Require([bool]$Condition, [string]$Message) {{
  if (-not $Condition) {{ throw $Message }}
}}
function BytesHash([byte[]]$Bytes) {{
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {{ return ([System.BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }}
  finally {{ $sha.Dispose() }}
}}
  function RequirePrivateAcl([string]$Path, [string]$Label) {{
    $acl = Get-Acl -LiteralPath $Path
    Require $acl.AreAccessRulesProtected ($Label + ' ACL is inherited')
    $allowed = @([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')
    $seen = @{{}}
    $full = [System.Security.AccessControl.FileSystemRights]::FullControl
    foreach ($rule in @($acl.Access)) {{
      $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
      Require ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
        -not $rule.IsInherited -and $rule.InheritanceFlags -eq [System.Security.AccessControl.InheritanceFlags]::None -and
        $rule.PropagationFlags -eq [System.Security.AccessControl.PropagationFlags]::None -and
        ($allowed -contains $sid) -and (([int]$rule.FileSystemRights -band [int]$full) -eq [int]$full)) ($Label + ' ACL is not private')
      $seen[$sid] = $true
    }}
    foreach ($sid in $allowed) {{
      Require $seen.ContainsKey($sid) ($Label + ' ACL is missing an approved owner')
    }}
  }}

$root = Join-Path ([System.IO.Path]::GetTempPath()) ('fullmag installer env ' + [guid]::NewGuid().ToString('N'))
$repo = Join-Path $root 'main'
$storage = Join-Path $root 'storage'
$volatile = Join-Path ([System.IO.Path]::GetTempPath()) ('fullmag-volatile-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $repo, $storage -Force | Out-Null
try {{
  # Windows PowerShell reports ordinary hard-linked executables through
  # LinkType=HardLink.  They must pass the no-reparse guard, while a junction
  # (an actual reparse point) must remain rejected.
  $hardlinkTarget = Join-Path $root 'hardlink-target.bin'
  [System.IO.File]::WriteAllBytes($hardlinkTarget, [byte[]](0x46, 0x4D))
  $hardlinkPath = Join-Path $root 'hardlink.bin'
  New-Item -ItemType HardLink -Path $hardlinkPath -Target $hardlinkTarget | Out-Null
  $hardlinkItem = Get-Item -LiteralPath $hardlinkPath -Force
  Require ([string]::Equals([string]$hardlinkItem.LinkType, 'HardLink', [System.StringComparison]::OrdinalIgnoreCase)) 'hardlink fixture was not created as a hardlink'
  Require (-not (Test-FullmagInstallerEnvReparseItem $hardlinkItem)) 'ordinary hardlink was classified as a reparse point'
  Assert-FullmagInstallerEnvNoReparse -Path $hardlinkPath -Label 'hardlink fixture'

  $reparseTarget = Join-Path $root 'reparse-target'
  New-Item -ItemType Directory -Path $reparseTarget -Force | Out-Null
  $junctionPath = Join-Path $root 'reparse-junction'
  New-Item -ItemType Junction -Path $junctionPath -Target $reparseTarget | Out-Null
  $junctionItem = Get-Item -LiteralPath $junctionPath -Force
  Require (($junctionItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) 'junction fixture was not a reparse point'
  $junctionRejected = $false
  try {{ Assert-FullmagInstallerEnvNoReparse -Path $junctionPath -Label 'junction fixture' }}
  catch {{ $junctionRejected = $_.Exception.Message -match 'reparse point' }}
  Require $junctionRejected 'junction reparse point was accepted'

  $actualGit = Get-Command git.exe -ErrorAction Stop
  $actualGitItem = Get-Item -LiteralPath $actualGit.Source -Force
  if ([string]::Equals([string]$actualGitItem.LinkType, 'HardLink', [System.StringComparison]::OrdinalIgnoreCase)) {{
    Require (-not (Test-FullmagInstallerEnvReparseItem $actualGitItem)) 'actual Git hardlink was classified as a reparse point'
    Assert-FullmagInstallerEnvNoReparse -Path $actualGit.Source -Label 'actual Git hardlink'
  }}

  & git.exe init --quiet $repo
  if ($LASTEXITCODE -ne 0) {{ throw 'git init failed' }}
  New-Item -ItemType Directory -Path (Join-Path $repo 'scripts') -Force | Out-Null
  Copy-Item -LiteralPath {_ps_literal(source_resolver)} -Destination (Join-Path $repo 'scripts/fullmag_storage.py')
  [System.IO.File]::WriteAllText(
    (Join-Path $repo '.env.example'),
    "POSTGRES_PASSWORD=change-me`r`nRUST_LOG=info`r`nFULLMAG_PROJECT_STORAGE_ROOT=`r`nFULLMAG_WINDOWS_VOLATILE_ROOT=`r`nMAIN_TEMPLATE_ONLY=main`r`n",
    [System.Text.UTF8Encoding]::new($false)
  )
  [System.IO.File]::WriteAllText(
    (Join-Path $repo 'windows_build_requirements.json'),
    '{{"storage":{{"env_key":"FULLMAG_PROJECT_STORAGE_ROOT","setup_profile":"windows-setup"}},"env_keys":["MAIN_MANIFEST_ONLY"]}}',
    [System.Text.UTF8Encoding]::new($false)
  )
  $oldText = "# preserve this comment`r`nPOSTGRES_PASSWORD=supersecret`r`nRUST_LOG=info`r`nUNKNOWN_KEEP=retain-me`r`nFULLMAG_PROJECT_STORAGE_ROOT=$storage`r`n# preserve trailing comment`r`n"
  $utf8Bom = [System.Text.UTF8Encoding]::new($true)
  [System.IO.File]::WriteAllText((Join-Path $repo '.env'), $oldText, $utf8Bom)
  & git.exe -C $repo add .env.example windows_build_requirements.json scripts/fullmag_storage.py
  if ($LASTEXITCODE -ne 0) {{ throw 'git add failed' }}
  & git.exe -c user.name='Fullmag fixture' -c user.email='fixture@example.invalid' -C $repo commit --quiet -m fixture
  if ($LASTEXITCODE -ne 0) {{ throw 'git commit failed' }}
  $envPath = Join-Path $repo '.env'
  $beforeBytes = [System.IO.File]::ReadAllBytes($envPath)
  $beforeHash = BytesHash $beforeBytes
  $beforeProcess = [Environment]::GetEnvironmentVariable('FULLMAG_PROJECT_STORAGE_ROOT', 'Process')
  $beforePath = [Environment]::GetEnvironmentVariable('PATH', 'Process')
  $beforeUser = [Environment]::GetEnvironmentVariable('FULLMAG_PROJECT_STORAGE_ROOT', 'User')
  $beforeMachine = [Environment]::GetEnvironmentVariable('FULLMAG_PROJECT_STORAGE_ROOT', 'Machine')

  $probe = Join-Path $repo 'probe_env.py'
  [System.IO.File]::WriteAllText($probe, "import os`nprint(os.environ.get('FULLMAG_FAKE_API_KEY', ''))`n")
  $env:FULLMAG_FAKE_API_KEY = 'must-not-reach-resolver'
  $probePythonCommand = Get-Command python.exe -ErrorAction Stop
  $probeResult = Invoke-FullmagInstallerEnvProcess -FilePath $probePythonCommand.Source -WorkingDirectory $repo `
    -Arguments @($probe) -RemoveEnvironment (Get-FullmagInstallerEnvInheritedSecretNames)
  Remove-Item Env:FULLMAG_FAKE_API_KEY -ErrorAction SilentlyContinue
  Require ($probeResult.exit_code -eq 0 -and [string]::IsNullOrWhiteSpace($probeResult.stdout)) 'secret environment variables reached the resolver child'

  $session = Get-FullmagInstallerEnvSession -CheckoutPath $repo
  Require ($session.main_checkout -eq $repo) 'editor did not select the Git main checkout'
  Require ($session.allowed_fields -contains 'FULLMAG_PROJECT_STORAGE_ROOT') 'manifest storage field missing'
  $publicIdentity = Get-FullmagInstallerEnvPublicIdentity -Session $session
  Require ($publicIdentity.main_checkout -eq $repo -and $publicIdentity.requested_checkout -eq $repo) 'public identity changed checkout binding'
  Require ($publicIdentity.template_hash -match '^[0-9a-f]{{64}}$' -and
    $publicIdentity.manifest_hash -match '^[0-9a-f]{{64}}$' -and
    $publicIdentity.resolver_hash -match '^[0-9a-f]{{64}}$' -and
    $publicIdentity.requested_git_head -match '^[0-9a-f]{{40}}$') 'public identity omitted source hashes or Git identity'
  Require (-not ($publicIdentity.Keys -contains 'session_signature') -and -not ($publicIdentity.Keys -contains 'secret_fields')) 'public identity exposed private session data'
  $secretField = @($session.fields | Where-Object {{ $_.key -eq 'POSTGRES_PASSWORD' }})[0]
  Require ($secretField.current_value -eq '<redacted>') 'secret was exposed in session fields'
  $publicFields = @($session.fields | ForEach-Object {{
    [ordered]@{{
      key = [string]$_.key
      secret = [bool]$_.secret
      present = [bool]$_.present
      current_value = [string]$_.current_value
    }}
  }})
  $publicDiscover = [ordered]@{{
    schema = 'fullmag.windows-installer-env-session.v1'
    session_id = [string]$session.session_id
    requested_checkout = [string]$publicIdentity.requested_checkout
    main_checkout = [string]$publicIdentity.main_checkout
    template_hash = [string]$publicIdentity.template_hash
    manifest_hash = [string]$publicIdentity.manifest_hash
    resolver_hash = [string]$publicIdentity.resolver_hash
    git_head = [string]$publicIdentity.git_head
    requested_git_head = [string]$publicIdentity.requested_git_head
    fields = $publicFields
  }}
  $publicDiscoverRoundTrip = $publicDiscover | ConvertTo-Json -Depth 8 -Compress | ConvertFrom-Json
  Require (@($publicDiscoverRoundTrip.fields).Count -eq 6) 'public discover did not expose all six managed fields'
  Require ([string]$publicDiscoverRoundTrip.git_head -match '^[0-9a-f]{{40}}$' -and
    [string]$publicDiscoverRoundTrip.requested_git_head -match '^[0-9a-f]{{40}}$') 'public discover omitted Git identity'
  $publicSecret = @($publicDiscoverRoundTrip.fields | Where-Object {{ $_.key -eq 'POSTGRES_PASSWORD' }})[0]
  Require ($publicSecret.secret -and $publicSecret.current_value -eq '<redacted>') 'public discover did not redact the secret field'
  Require (-not (($publicDiscoverRoundTrip.fields | ForEach-Object {{ [string]$_.current_value }}) -contains 'supersecret') -and
    ([string]($publicDiscover | ConvertTo-Json -Depth 8 -Compress) -notmatch 'supersecret')) 'public discover leaked a secret value'

  # An already matching .env is still an admissible transaction.  It must
  # report a valid proposal without asking the writer to create a backup or
  # replace bytes.
  $unchangedPreview = Get-FullmagInstallerEnvPreview -Session $session -Values @{{}}
  Require ($unchangedPreview.valid -and $unchangedPreview.can_commit) 'valid unchanged proposal was not admissible'
  Require (-not $unchangedPreview.write_required) 'unchanged proposal incorrectly required a write'
  Require (@($unchangedPreview.changed_fields).Count -eq 0) 'unchanged proposal reported changed fields'
  $unchangedBeforeBytes = [System.IO.File]::ReadAllBytes($envPath)
  $unchangedBeforeHash = BytesHash $unchangedBeforeBytes
  $unchangedBackupRoot = Join-Path (Join-Path $storage 'tmp') 'host-config-backups'
  $unchangedBeforeBackups = if (Test-Path -LiteralPath $unchangedBackupRoot) {{
    @((Get-ChildItem -LiteralPath $unchangedBackupRoot -File -Filter '.env.backup.*' -Force)).Count
  }} else {{ 0 }}
  $unchangedCommit = Commit-FullmagInstallerEnvProposal -Session $session -Values @{{}}
  Require ($unchangedCommit.valid -and $unchangedCommit.state -eq 'unchanged' -and -not $unchangedCommit.wrote) 'valid unchanged commit was not accepted without a write'
  Require (-not $unchangedCommit.can_commit -and -not $unchangedCommit.write_required) 'terminal unchanged commit exposed an active write gate'
  Require ([string]::IsNullOrWhiteSpace([string]$unchangedCommit.backup_path)) 'unchanged commit unexpectedly created a backup'
  Require ((BytesHash ([System.IO.File]::ReadAllBytes($envPath))) -eq $unchangedBeforeHash) 'unchanged commit modified .env bytes'
  $unchangedAfterBackups = if (Test-Path -LiteralPath $unchangedBackupRoot) {{
    @((Get-ChildItem -LiteralPath $unchangedBackupRoot -File -Filter '.env.backup.*' -Force)).Count
  }} else {{ 0 }}
  Require ($unchangedAfterBackups -eq $unchangedBeforeBackups) 'unchanged commit created a backup'

  # Invalid input remains fail-closed even when the caller supplies no edits.
  # Use a non-registered storage root in the fixture, then restore the exact
  # original bytes before the ordinary changed-path transaction below.
  $invalidUnchangedStorage = Join-Path $root 'invalid-unchanged-storage'
  try {{
    $invalidText = $oldText.Replace([string]$storage, [string]$invalidUnchangedStorage)
    [System.IO.File]::WriteAllText($envPath, $invalidText, $utf8Bom)
    $invalidUnchangedSession = Get-FullmagInstallerEnvSession -CheckoutPath $repo
    $invalidUnchanged = Get-FullmagInstallerEnvPreview -Session $invalidUnchangedSession -Values @{{}}
    Require (-not $invalidUnchanged.valid -and -not $invalidUnchanged.can_commit -and -not $invalidUnchanged.write_required) 'invalid unchanged proposal was not refused'
  }}
  finally {{
    [System.IO.File]::WriteAllBytes($envPath, $beforeBytes)
  }}

  $localCheckout = Join-Path $root 'worktree'
  & git.exe -C $repo worktree add --quiet --detach $localCheckout HEAD
  if ($LASTEXITCODE -ne 0) {{ throw 'git worktree add failed' }}
  [System.IO.File]::WriteAllText((Join-Path $localCheckout '.env'), 'LOCAL_ONLY=1')
  $localRejected = $false
  $localError = ''
  try {{ Get-FullmagInstallerEnvSession -CheckoutPath $localCheckout | Out-Null }}
  catch {{ $localError = $_.Exception.Message; $localRejected = $localError -match 'worktree-local' }}
  Require $localRejected ('worktree-local .env was not rejected: ' + $localError)
  & git.exe -C $repo worktree remove --force $localCheckout
  if ($LASTEXITCODE -ne 0) {{ throw 'git worktree remove failed' }}

  # The selected source checkout may be a worktree whose versioned template,
  # manifest and resolver differ from the main checkout.  Only .env remains
  # bound to the main checkout; the admitted source definitions must come from
  # the selected worktree and be covered by the session identity.
  $sourceCheckout = Join-Path $root 'source-worktree'
  & git.exe -C $repo worktree add --quiet --detach $sourceCheckout HEAD
  if ($LASTEXITCODE -ne 0) {{ throw 'source worktree add failed' }}
  [System.IO.File]::WriteAllText(
    (Join-Path $sourceCheckout '.env.example'),
    "POSTGRES_PASSWORD=change-me`r`nRUST_LOG=info`r`nFULLMAG_PROJECT_STORAGE_ROOT=`r`nFULLMAG_WINDOWS_VOLATILE_ROOT=`r`nBRANCH_TEMPLATE_ONLY=branch`r`n",
    [System.Text.UTF8Encoding]::new($false)
  )
  [System.IO.File]::WriteAllText(
    (Join-Path $sourceCheckout 'windows_build_requirements.json'),
    '{{"storage":{{"env_key":"FULLMAG_PROJECT_STORAGE_ROOT","setup_profile":"windows-setup"}},"env_keys":["BRANCH_MANIFEST_ONLY"]}}',
    [System.Text.UTF8Encoding]::new($false)
  )
  $sourceSession = Get-FullmagInstallerEnvSession -CheckoutPath $sourceCheckout
  Require ($sourceSession.main_checkout -eq $repo) 'source session did not bind .env to the main checkout'
  Require ($sourceSession.requested_checkout -eq $sourceCheckout) 'source session did not retain the selected worktree'
  Require ($sourceSession.template_path -like ($sourceCheckout + '\*')) 'source template was read from the main checkout'
  Require ($sourceSession.manifest_path -like ($sourceCheckout + '\*')) 'source manifest was read from the main checkout'
  Require ($sourceSession.resolver_script -like ($sourceCheckout + '\*')) 'source resolver was read from the main checkout'
  Require ($sourceSession.allowed_fields -contains 'BRANCH_TEMPLATE_ONLY') 'selected template definition was ignored'
  Require ($sourceSession.allowed_fields -contains 'BRANCH_MANIFEST_ONLY') 'selected manifest definition was ignored'
  Require (-not ($sourceSession.allowed_fields -contains 'MAIN_TEMPLATE_ONLY')) 'main template definition leaked into source session'
  Require (-not ($sourceSession.allowed_fields -contains 'MAIN_MANIFEST_ONLY')) 'main manifest definition leaked into source session'
  Cancel-FullmagInstallerEnvProposal -Session $sourceSession | Out-Null
  & git.exe -C $repo worktree remove --force $sourceCheckout
  if ($LASTEXITCODE -ne 0) {{ throw 'source worktree remove failed' }}

  $changes = [ordered]@{{
    RUST_LOG = 'debug'
    FULLMAG_WINDOWS_VOLATILE_ROOT = $volatile
  }}
  $preview = Get-FullmagInstallerEnvPreview -Session $session -Values $changes
  Require $preview.valid 'valid proposal was rejected: ' + ($preview.errors -join '; ')
  Require (-not [string]::IsNullOrWhiteSpace([string]$preview.runs_root)) 'preview omitted resolver runs_root'
  Require ([string]$preview.runs_root -like ((Join-Path $storage 'runs') + '\\*')) 'preview runs_root escaped canonical storage'
  Require ($preview.redacted_diff -notmatch 'supersecret') 'secret leaked into the redacted diff'
  Require ($preview.redacted_diff -match 'RUST_LOG=debug') 'preview omitted the ordinary field change'

  $cancel = Cancel-FullmagInstallerEnvProposal -Session $session
  Require ($cancel.state -eq 'canceled' -and -not $cancel.wrote) 'cancel returned an invalid state'
  Require ((BytesHash ([System.IO.File]::ReadAllBytes($envPath))) -eq $beforeHash) 'cancel changed .env'

  $commit = Commit-FullmagInstallerEnvProposal -Session $session -Values $changes
  Require ($commit.state -eq 'committed' -and $commit.wrote) 'transaction did not commit'
  Require (-not [string]::IsNullOrWhiteSpace([string]$commit.runs_root)) 'commit omitted resolver runs_root'
  Require ([string]$commit.runs_root -like ((Join-Path $storage 'runs') + '\\*')) 'commit runs_root escaped canonical storage'
  Require (Test-Path -LiteralPath $commit.backup_path -PathType Leaf) 'transaction did not create a backup'
  $backupRoot = Join-Path (Join-Path $storage 'tmp') 'host-config-backups'
  Require ($commit.backup_path -like ($backupRoot + '\*')) 'backup was written inside the checkout or an unapproved root'
  Require ($commit.backup_path -notlike ($repo + '\*')) 'backup path is inside the Git checkout'
  RequirePrivateAcl $backupRoot 'backup directory'
  RequirePrivateAcl $commit.backup_path 'backup file'
  $afterBytes = [System.IO.File]::ReadAllBytes($envPath)
  Require ($afterBytes[0] -eq 0xEF -and $afterBytes[1] -eq 0xBB -and $afterBytes[2] -eq 0xBF) 'UTF-8 BOM was not preserved'
  $afterText = [System.Text.UTF8Encoding]::new($false, $true).GetString($afterBytes, 3, $afterBytes.Length - 3)
  Require ($afterText -match '# preserve this comment') 'comment was not preserved'
  Require ($afterText -match 'UNKNOWN_KEEP=retain-me') 'unknown field was not preserved'
  Require ($afterText -match 'POSTGRES_PASSWORD=supersecret') 'unchanged secret was not preserved'
  Require ($afterText -match 'RUST_LOG=debug') 'ordinary change was not written'
  Require ($afterText -match [regex]::Escape("FULLMAG_WINDOWS_VOLATILE_ROOT=$volatile")) 'volatile root was not written'
  Require ($afterText -match "`r`n") 'CRLF newline style was not preserved'
  $backupText = [System.Text.UTF8Encoding]::new($false, $true).GetString([System.IO.File]::ReadAllBytes($commit.backup_path), 3, ([System.IO.File]::ReadAllBytes($commit.backup_path)).Length - 3)
  Require ($backupText -match 'POSTGRES_PASSWORD=supersecret' -and $backupText -match 'RUST_LOG=info') 'backup does not contain the original file'
  Require ([Environment]::GetEnvironmentVariable('FULLMAG_PROJECT_STORAGE_ROOT', 'Process') -eq $beforeProcess) 'process environment was changed'
  Require ([Environment]::GetEnvironmentVariable('PATH', 'Process') -eq $beforePath) 'process PATH was changed'
  Require ([Environment]::GetEnvironmentVariable('FULLMAG_PROJECT_STORAGE_ROOT', 'User') -eq $beforeUser) 'User environment was changed'
  Require ([Environment]::GetEnvironmentVariable('FULLMAG_PROJECT_STORAGE_ROOT', 'Machine') -eq $beforeMachine) 'Machine environment was changed'

  $conflictSession = Get-FullmagInstallerEnvSession -CheckoutPath $repo
  $alternate = Join-Path $root 'alternate-storage'
  $conflictHash = BytesHash ([System.IO.File]::ReadAllBytes($envPath))
  $conflict = Get-FullmagInstallerEnvPreview -Session $conflictSession -Values @{{ FULLMAG_PROJECT_STORAGE_ROOT = $alternate }}
  Require (-not $conflict.valid -and ($conflict.errors -join ' ') -match 'conflicts') 'existing storage conflict was not fail-closed'
  Require ($conflictHash -eq (BytesHash ([System.IO.File]::ReadAllBytes($envPath)))) 'conflict check changed .env'

  $forgedSession = Get-FullmagInstallerEnvSession -CheckoutPath $repo
  $forgedSession.env_path = Join-Path $root 'forged.env'
  $forged = Get-FullmagInstallerEnvPreview -Session $forgedSession -Values @{{ RUST_LOG = 'forged' }}
  Require (-not $forged.valid -and ($forged.errors -join ' ') -match 'identity|session') 'forged session path was accepted'

  $lockSession = Get-FullmagInstallerEnvSession -CheckoutPath $repo
  $lockPath = $envPath + '.fullmag-installer.lock'
  $heldLock = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate,
    [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  $lockFailed = $false
  try {{ Commit-FullmagInstallerEnvProposal -Session $lockSession -Values @{{ RUST_LOG = 'blocked' }} | Out-Null }}
  catch {{ $lockFailed = $true }}
  Require $lockFailed 'commit unexpectedly acquired a foreign lock'
  Require (Test-Path -LiteralPath $lockPath -PathType Leaf) 'failed lock admission deleted another process lock'
  $heldLock.Dispose()
  Remove-Item -LiteralPath $lockPath -Force

  $boundarySession = Get-FullmagInstallerEnvSession -CheckoutPath $repo
  $script:FullmagInstallerEnvBeforeReplaceHook = {{
    param($path)
    Add-Content -LiteralPath $path -Value "`r`nBOUNDARY_CHANGE=1" -NoNewline
  }}
  $boundaryFailed = $false
  $boundaryMessage = ''
  try {{ Commit-FullmagInstallerEnvProposal -Session $boundarySession -Values @{{ RUST_LOG = 'boundary' }} | Out-Null }}
  catch {{ $boundaryMessage = $_.Exception.Message; $boundaryFailed = $true }}
  Remove-Variable -Name FullmagInstallerEnvBeforeReplaceHook -Scope Script -ErrorAction SilentlyContinue
  Require $boundaryFailed 'replace-boundary mutation was not rejected'
  Require ($boundaryMessage -match 'latest content was preserved' -and $boundaryMessage -match 'recovery was skipped') ('replace-boundary recovery was not reported accurately: ' + $boundaryMessage)
  Require ((Get-Content -LiteralPath $envPath -Raw) -match 'BOUNDARY_CHANGE=1') 'replace-boundary content was lost'

  $postReplaceSession = Get-FullmagInstallerEnvSession -CheckoutPath $repo
  $script:FullmagInstallerEnvAfterReplaceHook = {{
    param($path)
    Add-Content -LiteralPath $path -Value "`r`nPOST_REPLACE_EXTERNAL=1" -NoNewline
  }}
  $postReplaceFailed = $false
  $postReplaceMessage = ''
  try {{ Commit-FullmagInstallerEnvProposal -Session $postReplaceSession -Values @{{ RUST_LOG = 'post-race' }} | Out-Null }}
  catch {{ $postReplaceMessage = $_.Exception.Message; $postReplaceFailed = $true }}
  Remove-Variable -Name FullmagInstallerEnvAfterReplaceHook -Scope Script -ErrorAction SilentlyContinue
  Require $postReplaceFailed 'post-replace mutation was not rejected'
  Require ($postReplaceMessage -match 'latest content was preserved' -and $postReplaceMessage -match 'recovery was skipped') ('post-replace recovery was not reported accurately: ' + $postReplaceMessage)
  Require ((Get-Content -LiteralPath $envPath -Raw) -match 'POST_REPLACE_EXTERNAL=1') 'post-replace content was lost'
  $backupFiles = @(Get-ChildItem -LiteralPath $backupRoot -File -Filter '.env.backup.*' -Force)
  Require ($backupFiles.Count -ge 2) 'post-replace failure did not retain the verified backup'

  $raceSession = Get-FullmagInstallerEnvSession -CheckoutPath $repo
  Add-Content -LiteralPath $envPath -Value "`r`nEXTERNAL_CHANGE=1" -NoNewline
  $raceFailed = $false
  try {{ Commit-FullmagInstallerEnvProposal -Session $raceSession -Values @{{ RUST_LOG = 'trace' }} | Out-Null }}
  catch {{ $raceFailed = $true }}
  Require $raceFailed 'optimistic concurrency did not reject a changed .env'
  Require ((Get-Content -LiteralPath $envPath -Raw) -match 'EXTERNAL_CHANGE=1') 'concurrent content was lost'

  $invalidSession = Get-FullmagInstallerEnvSession -CheckoutPath $repo
  $invalid = Get-FullmagInstallerEnvPreview -Session $invalidSession -Values @{{ FULLMAG_WINDOWS_VOLATILE_ROOT = 'relative-path' }}
  Require (-not $invalid.valid) 'relative volatile path was accepted'
  $unknown = Get-FullmagInstallerEnvPreview -Session $invalidSession -Values @{{ NOT_FROM_TEMPLATE = 'x' }}
  Require (-not $unknown.valid) 'field outside template/manifest was accepted'
  Write-Output 'native installer env contract passed'
}}
finally {{
  if ($sourceCheckout -and (Test-Path -LiteralPath $sourceCheckout)) {{ & git.exe -C $repo worktree remove --force $sourceCheckout 2>$null }}
  if ($localCheckout -and (Test-Path -LiteralPath $localCheckout)) {{ & git.exe -C $repo worktree remove --force $localCheckout 2>$null }}
  if (Test-Path -LiteralPath $root) {{ Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }}
  if (Test-Path -LiteralPath $volatile) {{ Remove-Item -LiteralPath $volatile -Recurse -Force -ErrorAction SilentlyContinue }}
}}
"""
        completed = subprocess.run(
            [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
        self.assertEqual(
            completed.returncode,
            0,
            f"native PowerShell contract failed\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
        )
        self.assertIn("native installer env contract passed", completed.stdout)


if __name__ == "__main__":
    unittest.main()
