"""Regression checks for the closed native Windows FEM operation."""

import base64
import hashlib
import json
import os
from contextlib import contextmanager
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import fullmag_storage as storage  # noqa: E402
from _native_fem_test_fixtures import manifest_bytes


class NativeFemContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        project = Path(self.temp.name).resolve()
        self.repo = project / "fullmag"
        self.repo.mkdir(parents=True)
        subprocess.run(["git", "init", "--quiet", str(self.repo)], check=True)
        (self.repo / "scripts/windows").mkdir(parents=True)
        (self.repo / "scripts/windows/run_fullmag.ps1").write_text(
            "# fixture native FEM launcher\n", encoding="utf-8"
        )
        (self.repo / "examples").mkdir()
        self.script = self.repo / "examples/problem.py"
        self.script.write_text("print('fixture')\n", encoding="utf-8")
        self.layout = storage.resolve_layout(
            self.repo, profile="windows-native-fem-gpu", environ={}
        )

    @staticmethod
    def _unlocked(*_args, **_kwargs):
        @contextmanager
        def scope():
            yield
        return scope()

    def test_native_fem_build_and_receipt_are_closed_and_manifest_bound(self):
        calls = []
        manifest = (
            Path(self.layout["build_root"])
            / "windows-fem-runtime"
            / "build-manifest.json"
        )
        manifest_raw = None

        def fake_git(_repo, *args):
            if args == ("rev-parse", "HEAD"):
                return "0" * 40
            if args == ("status", "--porcelain", "--untracked-files=normal"):
                return ""
            raise AssertionError(args)

        def fake_build(command, _repo, child_env, *_args, **_kwargs):
            nonlocal manifest_raw
            manifest_raw = manifest_bytes(self.layout, child_env)
            calls.append(command)
            manifest.parent.mkdir(parents=True, exist_ok=True)
            manifest.write_bytes(manifest_raw)
            return subprocess.CompletedProcess(command, 0)

        with patch.object(storage, "_is_native_windows", return_value=True), \
             patch.object(storage, "file_lock", self._unlocked), \
             patch.object(storage, "git", side_effect=fake_git), \
             patch.object(storage, "_run_logged_command", side_effect=fake_build):
            result = storage.run_windows_fem(
                self.layout,
                frontend="dev",
                device="gpu",
                run_mode="headless",
                script_path="examples/problem.py",
                web_port=0,
                build_mode="true",
                build_only=True,
            )

        self.assertEqual(result, 0)
        self.assertEqual(len(calls), 1)
        command = calls[0]
        self.assertEqual(command[0:6], [
            "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive",
            "-ExecutionPolicy", "Bypass",
        ])
        self.assertEqual(command[command.index("-Backend") + 1], "fem")
        self.assertEqual(command[command.index("-Device") + 1], "gpu")
        self.assertIn("-BuildOnly", command)
        self.assertEqual(command[command.index("-WebPort") + 1], "0")
        receipt = json.loads(
            (Path(self.layout["runtime_root"]) / "native-fem-receipt.json")
            .read_text(encoding="utf-8")
        )
        self.assertEqual(receipt["schema"], storage.WINDOWS_NATIVE_FEM_RECEIPT_SCHEMA)
        self.assertEqual(receipt["profile"], "windows-native-fem-gpu")
        self.assertEqual(receipt["requested_device"], "gpu")
        self.assertEqual(receipt["resolved_device"], "gpu")
        self.assertEqual(receipt["state"], "completed")
        self.assertEqual(
            receipt["build_manifest_sha256"], hashlib.sha256(manifest_raw).hexdigest()
        )

    def test_native_fem_auto_intent_reaches_child_without_losing_gpu_resolution(self):
        environments = []

        def fake_build(command, _repo, child_env, _log, **_kwargs):
            environments.append(child_env)
            self.assertEqual(command[command.index("-Device") + 1], "gpu")
            manifest = Path(self.layout["build_root"]) / "windows-fem-runtime/build-manifest.json"
            manifest.parent.mkdir(parents=True, exist_ok=True)
            manifest.write_bytes(manifest_bytes(self.layout, child_env))
            return subprocess.CompletedProcess(command, 0)

        with patch.object(storage, "_is_native_windows", return_value=True), \
             patch.object(storage, "_resolve_windows_fem_device", return_value="gpu"), \
             patch.object(storage, "file_lock", self._unlocked), \
             patch.object(storage, "git", return_value="0" * 40), \
             patch.object(storage, "_run_logged_command", side_effect=fake_build), \
             patch.dict(os.environ, {"FULLMAG_FEM_REQUESTED_DEVICE": "cpu"}):
            result = storage.run_windows_fem(
                self.layout, frontend="dev", device="auto", run_mode="headless",
                script_path="examples/problem.py", web_port=0,
                build_mode="true", build_only=True,
            )
        self.assertEqual(result, 0)
        self.assertEqual(environments[0]["FULLMAG_FEM_REQUESTED_DEVICE"], "auto")

    def test_native_fem_rejects_non_windows_before_mutating_storage(self):
        with patch.object(storage, "_is_native_windows", return_value=False), \
             self.assertRaisesRegex(storage.StorageError, "requires native Windows"):
            storage.run_windows_fem(
                self.layout,
                frontend="dev",
                device="gpu",
                run_mode="headless",
                script_path="examples/problem.py",
                web_port=0,
                build_mode="true",
                build_only=True,
            )
        self.assertFalse(Path(self.layout["storage_root"]).exists())

    def test_native_fem_declares_pinned_boost_headers_and_binds_cmake(self):
        manifest = json.loads(
            (ROOT / "windows_build_requirements.json").read_text(encoding="utf-8")
        )
        boost = manifest["tools"]["boost_headers"]
        self.assertEqual(boost["kind"], "project_managed_header_provider")
        self.assertEqual(boost["version"], "1.89.0")
        self.assertEqual(
            boost["url"],
            "https://archives.boost.io/release/1.89.0/source/boost_1_89_0.zip",
        )
        self.assertEqual(
            boost["archive_sha256"],
            "77bee48e32cabab96a3fd2589ec3ab9a17798d330220fdd8bde6ff5611b4ccde",
        )
        self.assertEqual(
            boost["required_headers"],
            ["boost/multiprecision/cpp_int.hpp", "boost/rational.hpp"],
        )
        self.assertEqual(boost["license_file"], "LICENSE_1_0.txt")
        self.assertEqual(
            boost["provider_path"],
            r"{build_root}\fem-dependencies\installed\providers\b-77bee48e32ca",
        )
        self.assertEqual(boost["max_selected_files"], 50000)
        self.assertEqual(boost["max_selected_file_bytes"], 33554432)
        self.assertEqual(boost["max_selected_uncompressed_bytes"], 536870912)
        self.assertIn("boost_headers", manifest["provider_bootstrap"]["required_for"])
        helper = (ROOT / "scripts/windows/native_fem_dependencies.ps1").read_text(
            encoding="utf-8-sig"
        )
        cmake = (ROOT / "backends/fem/CMakeLists.txt").read_text(encoding="utf-8")
        for token in (
            "Get-FullmagNativeFemBoostRequirement",
            "Install-FullmagNativeFemBoostHeaders",
            "Get-FullmagPinnedDownload -Url ([string]$Requirement.url)",
            "boost/multiprecision/cpp_int.hpp",
            "boost/rational.hpp",
            "header_providers",
            "boost=$boostReceipt",
            "Get-FullmagNativeFemTreeInventory",
            "Get-FullmagNativeFemBoostArchiveInventory",
            "New-FullmagNativeFemBoostReceipt",
            "Assert-FullmagNativeFemBoostReceipt",
            "Test-FullmagNativeFemBoostReceipt",
            "Assert-FullmagNativeFemBoostPathBudget",
            '"s-" + ([Guid]::NewGuid().ToString("N").Substring(0, 16))',
            "include_tree",
        ):
            self.assertIn(token, helper)
        self.assertIn(
            "providers/b-77bee48e32ca/include", cmake.replace("\\", "/")
        )
        self.assertIn("add_library(fullmag_fem_boost_headers INTERFACE", cmake)
        self.assertIn(
            "target_link_libraries(fem_conservative_constraint_rank_contract PRIVATE",
            cmake,
        )
        self.assertIn(
            "target_link_libraries(fem_conservative_current_view_contract PRIVATE",
            cmake,
        )
        self.assertIn("boost/multiprecision/cpp_int.hpp", cmake)
        self.assertIn("boost/rational.hpp", cmake)
        self.assertIn("providers/b-77bee48e32ca/include", cmake.replace("\\", "/"))
        self.assertNotIn("find_package(Boost", cmake)

    def test_native_fem_ps_accepts_committed_boost_manifest(self):
        """Run the real manifest getter under Windows PowerShell 5.1."""
        powershell = Path(
            "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
        )
        if not powershell.exists():
            powershell = Path(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe")
        if not powershell.exists():
            self.skipTest("Windows PowerShell 5.1 is unavailable")

        provider = ROOT / "scripts/windows/native_fem_dependencies.ps1"
        source_root = ROOT

        def windows_path(path):
            value = str(path)
            if value.startswith("/mnt/c/"):
                value = "C:\\" + value[len("/mnt/c/") :].replace("/", "\\")
            return value.replace("'", "''")

        fixture = r'''
$ErrorActionPreference = "Stop"
. '__PROVIDER__'
$requirement = Get-FullmagNativeFemBoostRequirement -SourceRoot '__SOURCE_ROOT__'
$headers = @($requirement.required_headers | ForEach-Object { [string]$_ })
if ($headers.Count -ne 2 -or
    $headers[0] -ne "boost/multiprecision/cpp_int.hpp" -or
    $headers[1] -ne "boost/rational.hpp") {
  throw ("Committed Boost manifest returned an unexpected header set: " + ($headers -join "|"))
}
Write-Output "REAL BOOST MANIFEST GETTER PASS"
'''.replace("__PROVIDER__", windows_path(provider)).replace(
            "__SOURCE_ROOT__", windows_path(source_root)
        )
        encoded = base64.b64encode(fixture.encode("utf-16le")).decode("ascii")
        result = subprocess.run(
            [
                str(powershell),
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-EncodedCommand",
                encoded,
            ],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("REAL BOOST MANIFEST GETTER PASS", result.stdout)

    def test_native_fem_boost_selective_extract_and_receipt_validator(self):
        """Exercise the real provider against a tiny synthetic archive on Windows."""
        powershell = Path(
            "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
        )
        if not powershell.exists():
            powershell = Path(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe")
        if not powershell.exists():
            self.skipTest("Windows PowerShell 5.1 is unavailable")

        provider = ROOT / "scripts/windows/native_fem_dependencies.ps1"
        provider_win = str(provider)
        if provider_win.startswith("/mnt/c/"):
            provider_win = "C:\\" + provider_win[len("/mnt/c/") :].replace("/", "\\")
        provider_win = provider_win.replace("'", "''")
        fixture = r'''
$ErrorActionPreference = "Stop"
function Assert-FullmagStoragePath {
  param([object]$Layout, [string]$Path, [string]$Label, [string]$Parent)
  return $Path
}
. '__PROVIDER__'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = Join-Path $env:TEMP ("fullmag-boost-fixture-" + [Guid]::NewGuid().ToString("N"))
$providerRoot = Join-Path $root "fem-dependencies"
$downloads = Join-Path $providerRoot "downloads"
New-Item -ItemType Directory -Force -Path $downloads | Out-Null
$archive = Join-Path $downloads "boost_1_89_0.zip"
$zip = [IO.Compression.ZipFile]::Open($archive, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($pair in @(
    [pscustomobject]@{ name="boost_1_89_0/boost/multiprecision/cpp_int.hpp"; text="cpp_int" },
    [pscustomobject]@{ name="boost_1_89_0/boost/rational.hpp"; text="rational" },
    [pscustomobject]@{ name="boost_1_89_0/LICENSE_1_0.txt"; text="license" },
    [pscustomobject]@{ name="boost_1_89_0/ignored.txt"; text="ignored" }
  )) {
    $entry = $zip.CreateEntry($pair.name)
    $writer = New-Object IO.StreamWriter($entry.Open(), [Text.Encoding]::UTF8)
    try { $writer.Write($pair.text) } finally { $writer.Dispose() }
  }
}
finally { $zip.Dispose() }
$sha = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
$layout = [pscustomobject]@{ build_root=$root }
$plan = [pscustomobject]@{ root=$providerRoot; prefix=(Join-Path $providerRoot "installed") }
$requirement = [pscustomobject]@{
  name="boost_headers"; kind="project_managed_header_provider"; version="1.89.0"
  url="https://archives.boost.io/release/1.89.0/source/boost_1_89_0.zip"
  archive="boost_1_89_0.zip"; archive_sha256=$sha; root_directory="boost_1_89_0"
  include_directory="boost"; license_file="LICENSE_1_0.txt"
  required_headers=@("boost/multiprecision/cpp_int.hpp", "boost/rational.hpp")
  max_selected_files=50000; max_selected_file_bytes=33554432
  max_selected_uncompressed_bytes=536870912
}
try {
  $boost = Install-FullmagNativeFemBoostHeaders -Plan $plan -Requirement $requirement -Layout $layout
  $receipt = [pscustomobject]@{ schema="fixture"; boost=$boost }
  $null = Assert-FullmagNativeFemBoostReceipt -Receipt $receipt -Requirement $requirement -ProviderRoot $providerRoot
  if (Test-Path -LiteralPath (Join-Path $boost.install_root "ignored.txt")) {
    throw "unselected archive file was published"
  }
  if (-not (Test-Path -LiteralPath $boost.installed_rational_header -PathType Leaf)) {
    throw "rational header was not published"
  }
  $rootFull = [IO.Path]::GetFullPath($root)
  $acceptedLength = 250
  $acceptedChildLength = $acceptedLength - $rootFull.Length - 1
  if ($acceptedChildLength -lt 1) { throw "synthetic provider root is too long for the in-budget path fixture" }
  $acceptedPath = Join-Path $root ("w" * $acceptedChildLength)
  $acceptedResolved = Assert-FullmagNativeFemBoostPathBudget `
    -Path $acceptedPath -Label "synthetic in-budget destination" -FileDestination
  if ($acceptedResolved.Length -ne $acceptedLength) {
    throw "in-budget destination was normalized unexpectedly: $($acceptedResolved.Length) != $acceptedLength"
  }
  $payload = [byte[]](65, 66, 67, 68)
  [IO.File]::WriteAllBytes($acceptedPath, $payload)
  $validatedAcceptedPath = Assert-FullmagNativeFemRegularFile `
    -Path $acceptedPath -Root $root -Label "synthetic in-budget file"
  $roundTrip = [IO.File]::ReadAllBytes($validatedAcceptedPath)
  if (($roundTrip -join ",") -ne ($payload -join ",")) {
    throw "in-budget file did not round-trip through the native file APIs"
  }
  $rejectedLength = 259
  $rejectedChildLength = $rejectedLength - $rootFull.Length - 1
  if ($rejectedChildLength -lt 1) { throw "synthetic provider root is too long for the MAX_PATH fixture" }
  $longPathFailed = $false
  try {
    $null = Assert-FullmagNativeFemBoostPathBudget `
      -Path (Join-Path $root ("x" * $rejectedChildLength)) `
      -Label "synthetic MAX_PATH destination" -FileDestination
  }
  catch { $longPathFailed = $true }
  if (-not $longPathFailed) { throw "MAX_PATH destination was not rejected" }
  $parentLength = 248
  $parentChildLength = $parentLength - $rootFull.Length - 1
  if ($parentChildLength -lt 1) { throw "synthetic provider root is too long for the directory fixture" }
  $longParent = Join-Path $root ("p" * $parentChildLength)
  $shortLeaf = Join-Path $longParent "x"
  if ($shortLeaf.Length -ge $rejectedLength) { throw "directory fixture is not below the total path limit" }
  $parentPathFailed = $false
  try {
    $null = Assert-FullmagNativeFemBoostPathBudget `
      -Path $shortLeaf -Label "synthetic long directory parent" -FileDestination
  }
  catch { $parentPathFailed = $true }
  if (-not $parentPathFailed) { throw "long directory parent was not rejected" }
  if (Test-Path -LiteralPath $longParent) { throw "directory-parent rejection wrote before validation" }
  $originalHeaderBytes = [IO.File]::ReadAllBytes($boost.installed_header)
  [IO.File]::WriteAllText($boost.installed_header, "forged")
  $forged = ($receipt | ConvertTo-Json -Depth 12 | ConvertFrom-Json)
  $forgedHeader = @($forged.boost.include_tree | Where-Object {
    [string]$_.path -eq "include/boost/multiprecision/cpp_int.hpp"
  })[0]
  $forgedHash = (Get-FileHash -LiteralPath $boost.installed_header -Algorithm SHA256).Hash.ToLowerInvariant()
  $forgedHeader.sha256 = $forgedHash
  $forged.boost.installed_header_sha256 = $forgedHash
  if (Test-FullmagNativeFemBoostReceipt -Receipt $forged -Requirement $requirement -ProviderRoot $providerRoot) {
    throw "forged archive/tree receipt unexpectedly validated"
  }
  [IO.File]::WriteAllBytes($boost.installed_header, $originalHeaderBytes)
  $recovered = Install-FullmagNativeFemBoostHeaders -Plan $plan -Requirement $requirement -Layout $layout
  if ([string]$recovered.install_root -ne [string]$boost.install_root) {
    throw "exact immutable tree was not recovered without a full receipt"
  }
  $stale = Join-Path $boost.include_root "boost\stale.hpp"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $stale) | Out-Null
  [IO.File]::WriteAllText($stale, "stale")
  if (Test-FullmagNativeFemBoostReceipt -Receipt $receipt -Requirement $requirement -ProviderRoot $providerRoot) {
    throw "stale tree unexpectedly validated"
  }
  $receiptPath = Join-Path $providerRoot "provider-receipt.json"
  [IO.File]::WriteAllText($receiptPath, ($receipt | ConvertTo-Json -Depth 12))
  $failedClosed = $false
  try {
    $null = Install-FullmagNativeFemBoostHeaders -Plan $plan -Requirement $requirement -Layout $layout
  }
  catch { $failedClosed = $true }
  if (-not $failedClosed) { throw "mismatching immutable tree was accepted" }
  if (-not (Test-Path -LiteralPath $stale -PathType Leaf)) {
    throw "mismatching existing tree was removed"
  }
  Write-Output "BOOST FIXTURE PASS"
}
finally {
  if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
'''.replace("__PROVIDER__", provider_win)
        encoded = base64.b64encode(fixture.encode("utf-16le")).decode("ascii")
        result = subprocess.run(
            [
                str(powershell),
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-EncodedCommand",
                encoded,
            ],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("BOOST FIXTURE PASS", result.stdout)

    def test_native_fem_tool_cache_reuses_receipt_and_preserves_mismatch(self):
        """Exercise the immutable extracted-tool cache with a synthetic ZIP."""
        powershell = Path(
            "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
        )
        if not powershell.exists():
            powershell = Path(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe")
        if not powershell.exists():
            self.skipTest("Windows PowerShell 5.1 is unavailable")

        provider = ROOT / "scripts/windows/native_fem_dependencies.ps1"
        provider_win = str(provider)
        if provider_win.startswith("/mnt/c/"):
            provider_win = "C:\\" + provider_win[len("/mnt/c/") :].replace("/", "\\")
        provider_win = provider_win.replace("'", "''")
        fixture = r'''
$ErrorActionPreference = "Stop"
. '__PROVIDER__'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = Join-Path $env:TEMP ("fullmag-tool-cache-fixture-" + [Guid]::NewGuid().ToString("N"))
$providerRoot = Join-Path $root "fem-dependencies"
$downloads = Join-Path $providerRoot "downloads"
$toolRoot = Join-Path $providerRoot "tools\ninja-1.13.2"
$plan = [pscustomobject]@{ root = $providerRoot }
New-Item -ItemType Directory -Force -Path $downloads | Out-Null
$archive = Join-Path $downloads "ninja-1.13.2.zip"
$zip = [IO.Compression.ZipFile]::Open($archive, [IO.Compression.ZipArchiveMode]::Create)
try {
  $entry = $zip.CreateEntry("ninja.exe")
  $stream = $entry.Open()
  try { $stream.Write([byte[]](78, 73, 78, 74), 0, 4) } finally { $stream.Dispose() }
}
finally { $zip.Dispose() }
$archiveSha = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
try {
  $spaceInventory = @([pscustomobject]@{
    path = "PFiles/Microsoft SDKs/MPI/Include/mpi.h"
    size_bytes = 4
    sha256 = ("0" * 64)
  })
  $spaceRequired = @(Get-FullmagNativeFemToolRequiredRecords -Inventory $spaceInventory `
    -RequiredRelativePaths @("PFiles\Microsoft SDKs\MPI\Include\mpi.h"))
  if ($spaceRequired.Count -ne 1 -or [string]$spaceRequired[0].path -ne "PFiles/Microsoft SDKs/MPI/Include/mpi.h") {
    throw "tool cache required-file validation rejected a valid Windows path containing spaces"
  }
  $miss = Get-FullmagNativeFemToolCache -Plan $plan -ToolName "ninja-1.13.2" `
    -ArchivePath $archive -ArchiveSha256 $archiveSha -Root $toolRoot `
    -RequiredRelativePaths @("ninja.exe")
  if ($null -ne $miss) { throw "missing tool tree unexpectedly returned a cache" }
  New-Item -ItemType Directory -Path $toolRoot | Out-Null
  [IO.File]::WriteAllBytes((Join-Path $toolRoot "ninja.exe"), [byte[]](78, 73, 78, 74))
  $inventory = @(Get-FullmagNativeFemTreeInventory -Root $toolRoot -Label "fixture tool tree")
  $required = @(Get-FullmagNativeFemToolRequiredRecords -Inventory $inventory -RequiredRelativePaths @("ninja.exe"))
  $written = Write-FullmagNativeFemToolCache -Plan $plan -ToolName "ninja-1.13.2" `
    -ArchivePath $archive -ArchiveSha256 $archiveSha -Root $toolRoot `
    -Inventory $inventory -RequiredFiles $required
  $hit = Get-FullmagNativeFemToolCache -Plan $plan -ToolName "ninja-1.13.2" `
    -ArchivePath $archive -ArchiveSha256 $archiveSha -Root $toolRoot `
    -RequiredRelativePaths @("ninja.exe")
  if ($null -eq $hit -or [string]$hit.schema -ne "fullmag.windows.fem-tool-cache.v1") {
    throw "valid extracted tool cache was not reused"
  }
  $cachePath = Get-FullmagNativeFemToolCachePath -Plan $plan -ToolName "ninja-1.13.2"
  if (-not (Test-Path -LiteralPath $cachePath -PathType Leaf)) { throw "tool cache receipt was not written" }
  [IO.File]::WriteAllText((Join-Path $toolRoot "ninja.exe"), "forged")
  $mismatchFailed = $false
  try {
    $null = Get-FullmagNativeFemToolCache -Plan $plan -ToolName "ninja-1.13.2" `
      -ArchivePath $archive -ArchiveSha256 $archiveSha -Root $toolRoot `
      -RequiredRelativePaths @("ninja.exe")
  }
  catch { $mismatchFailed = $true }
  if (-not $mismatchFailed) { throw "modified cached tool tree was accepted" }
  if (-not (Test-Path -LiteralPath (Join-Path $toolRoot "ninja.exe") -PathType Leaf)) {
    throw "cache mismatch removed the existing tool tree"
  }
  [IO.File]::WriteAllBytes((Join-Path $toolRoot "ninja.exe"), [byte[]](78, 73, 78, 74))
  Remove-Item -LiteralPath $cachePath -Force
  $providerReceipt = [pscustomobject]@{
    schema = "fullmag.windows.fem-providers.v1"
    plan = [pscustomobject]@{ root = $providerRoot }
    tools = @([pscustomobject]@{
      path = (Join-Path $toolRoot "ninja.exe")
      sha256 = (Get-FileHash -LiteralPath (Join-Path $toolRoot "ninja.exe") -Algorithm SHA256).Hash.ToLowerInvariant()
    })
  }
  New-Item -ItemType Directory -Force -Path $providerRoot | Out-Null
  [IO.File]::WriteAllText((Join-Path $providerRoot "provider-receipt.json"), ($providerReceipt | ConvertTo-Json -Depth 8))
  $recovered = Get-FullmagNativeFemToolCache -Plan $plan -ToolName "ninja-1.13.2" `
    -ArchivePath $archive -ArchiveSha256 $archiveSha -Root $toolRoot `
    -RequiredRelativePaths @("ninja.exe")
  if ([string]$recovered.recovered_from -ne "provider-receipt") {
    throw "provider receipt did not recover an existing tool tree"
  }
  Write-Output "TOOL CACHE FIXTURE PASS"
}
finally {
  if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
'''.replace("__PROVIDER__", provider_win)
        encoded = base64.b64encode(fixture.encode("utf-16le")).decode("ascii")
        result = subprocess.run(
            [
                str(powershell),
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-EncodedCommand",
                encoded,
            ],
            capture_output=True,
            text=True,
            timeout=45,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("TOOL CACHE FIXTURE PASS", result.stdout)

        helper = (ROOT / "scripts/windows/native_fem_dependencies.ps1").read_text(
            encoding="utf-8-sig"
        )
        self.assertIn('Get-FullmagNativeFemToolCache -Plan $plan -ToolName "ninja-1.13.2"', helper)
        self.assertIn('if ($null -eq $mpiCache)', helper)
        self.assertIn('if ($null -eq $zstdCache)', helper)
        self.assertIn('if ($null -eq $llvmCache)', helper)
        self.assertIn("tool_cache=$toolCacheInventory", helper)
        self.assertNotIn('Expand-Archive -LiteralPath $ninjaZip -DestinationPath $ninjaRoot -Force', helper)
        self.assertNotIn('Expand-Archive -LiteralPath $zstdArchive -DestinationPath $zstdRoot -Force', helper)

    def test_native_fem_ps_entry_defaults_to_managed_native_route(self):
        launcher = (ROOT / "scripts/windows/run_fullmag_fem.ps1").read_text(
            encoding="utf-8-sig"
        )
        native = (ROOT / "scripts/windows/run_fullmag.ps1").read_text(
            encoding="utf-8-sig"
        )
        helper = (ROOT / "scripts/windows/native_fem_dependencies.ps1").read_text(
            encoding="utf-8-sig"
        )
        storage_source = (ROOT / "scripts/fullmag_storage.py").read_text(
            encoding="utf-8"
        )
        self.assertIn('if ($env:FULLMAG_FORCE_WINDOWS_FEM_DOCKER -ne "1")', launcher)
        docker_build_id_guard = (
            'if ($ExpectedBuildId -and $env:FULLMAG_FORCE_WINDOWS_FEM_DOCKER -eq "1")'
        )
        self.assertIn(docker_build_id_guard, launcher)
        docker_guard_start = launcher.index(docker_build_id_guard)
        native_dispatch_start = launcher.index(
            'if ($env:FULLMAG_FORCE_WINDOWS_FEM_DOCKER -ne "1")'
        )
        self.assertLess(docker_guard_start, native_dispatch_start)
        self.assertIn(
            "Docker compatibility route cannot attest the pinned build",
            launcher[docker_guard_start:native_dispatch_start],
        )
        self.assertNotIn('$env:FULLMAG_STORAGE_MANAGED_ENTRY = "1"', launcher)
        self.assertIn('child_env["FULLMAG_STORAGE_MANAGED_ENTRY"] = "1"', storage_source)
        self.assertIn("native_fem_dependencies.ps1", native)
        self.assertIn("Invoke-FullmagNativeFemDependencies", native)
        self.assertIn('FULLMAG_CUDA_ARCHITECTURES must be a numeric semicolon-separated list', native)
        self.assertIn('--query-gpu=compute_cap', native)
        self.assertIn('--format=csv,noheader', native)
        self.assertIn('FULLMAG_FEM_WITH_SLEPC = "OFF"', launcher)
        self.assertIn('"run-windows-fem"', storage_source)
        self.assertIn("native-fem-receipt.json", storage_source)
        self.assertIn("--allow-cuda-driver", native)
        self.assertIn('Join-Path $nativeFdmBuildRoot "backends\\fdm\\Release"', native)
        self.assertIn('Join-Path $BuildSourceRoot "backends\\fdm"', native)
        self.assertIn('$toolchain = "stable-x86_64-pc-windows-msvc"', native)
        self.assertNotIn('nightly-x86_64-pc-windows-msvc', native)
        self.assertIn("run scripts/windows/setup_build_environment.ps1 -Install", native)
        self.assertIn("Get-FullmagNativeFemDependencyPlan", helper)

    def test_snapshot_contract_uses_msvc_counter_read_without_unportable_builtin(self):
        source = (ROOT / "backends/fem/tests/snapshot_contract.cpp").read_text(
            encoding="utf-8"
        )
        self.assertIn("snapshot_pool_counter_load(", source)
        self.assertIn("#if defined(_MSC_VER)", source)
        self.assertIn("_InterlockedCompareExchange", source)
        self.assertIn("return __atomic_load_n(value, __ATOMIC_ACQUIRE);", source)
        self.assertNotIn(
            "__atomic_load_n(\n            &ctx.gpu_state.cuda.snapshot_pool->leased_slots",
            source,
        )


if __name__ == "__main__":
    unittest.main()
