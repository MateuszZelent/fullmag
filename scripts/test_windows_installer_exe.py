"""Source-only contract checks for the WiX 3 Fullmag Burn authoring."""

import re
import json
from pathlib import Path
import shutil
import subprocess
import textwrap
import xml.etree.ElementTree as ET

import pytest


ROOT = Path(__file__).resolve().parents[1]
BUNDLE = ROOT / "scripts/windows/installer/Fullmag.Bundle.wxs"
BUILDER = ROOT / "scripts/windows/build_windows_installer_exe.ps1"
SETUP = ROOT / "scripts/windows/setup_installer_build_environment.ps1"
REQUIREMENTS = ROOT / "windows_installer_build_requirements.json"
SETUP_UI_PROJECT = ROOT / "scripts/windows/installer/Fullmag.Setup.UI/Fullmag.Setup.UI.csproj"
RELEASE_WORKFLOW = ROOT / ".github/workflows/release.yml"


POWERSHELL = shutil.which("powershell.exe") or shutil.which("powershell") or shutil.which("pwsh")


def _native_windows_path(path: Path) -> str:
    """Convert a WSL-mounted path to the native path consumed by WinPS 5.1."""
    value = str(path.resolve())
    if value.startswith("/mnt/") and len(value) > len("/mnt/x/"):
        drive = value[5].upper()
        return drive + ":\\" + value[7:].replace("/", "\\")
    return value


def test_bundle_is_wix3_burn_and_has_no_placeholder_ba():
    source = BUNDLE.read_text(encoding="utf-8")
    root = ET.fromstring(source)
    assert root.tag == "{http://schemas.microsoft.com/wix/2006/wi}Wix"
    bundle = root.find("{http://schemas.microsoft.com/wix/2006/wi}Bundle")
    assert bundle is not None
    assert bundle.attrib["Version"] == "$(var.ProductVersion)"
    assert bundle.attrib["UpgradeCode"] == "$(var.BundleUpgradeCode)"
    ba = bundle.find("{http://schemas.microsoft.com/wix/2006/wi}BootstrapperApplication")
    assert ba is not None
    assert ba.attrib["SourceFile"] == "$(var.BootstrapperApplicationDll)"
    assert "ba.dll" not in source.lower()
    assert "WixStandardBootstrapperApplication" not in source


def test_bundle_carries_license_env_module_and_stage_provenance():
    source = BUNDLE.read_text(encoding="utf-8")
    assert '<Payload SourceFile="$(var.LicenseFile)" Name="$(var.LicenseFileName)" />' in source
    assert '<Payload SourceFile="$(var.InstallerEnvModule)" Name="installer_env.ps1" />' in source
    assert '<Payload SourceFile="$(var.SetupBuildEnvironmentScript)" Name="scripts\\windows\\setup_build_environment.ps1" />' in source
    assert '<Payload SourceFile="$(var.BuildRequirementsManifest)" Name="windows_build_requirements.json" />' in source
    assert '<Payload SourceFile="$(var.WixLicenseFile)" Name="WiX-3.14.1-LICENSE.TXT" />' in source
    assert '<Payload SourceFile="$(var.StageManifestPath)" Name="fullmag-msi-stage-manifest.json" />' in source
    assert '<Payload SourceFile="$(var.InstallerProvenancePath)" Name="fullmag-installer-provenance.json" />' in source
    assert 'SourceFile="$(var.MsiPath)"' in source
    assert '<MsiPackage' in source
    assert '<ExePackage' in source
    assert 'FullmagEnvironmentBootstrap' in source
    assert '[FullmagSourceCheckout]' in source
    assert '[FullmagBootstrapMode]' in source


def test_bundle_carries_private_self_contained_avalonia_payload():
    source = BUNDLE.read_text(encoding="utf-8")
    assert '<Payload SourceFile="$(var.FullmagSetupUiPayload)" Name="FullmagInstallerUi.exe" />' in source
    assert '<ExePackage Id="FullmagSetupUi"' not in source
    assert "hash-bound broker" in source


def test_avalonia_producer_contract_is_pinned_and_matches_project_shape():
    requirements = json.loads(REQUIREMENTS.read_text(encoding="utf-8"))
    dotnet = requirements["tools"]["dotnet_sdk"]
    assert dotnet["version"] == "10.0.402"
    assert dotnet["runtime_identifier"] == "win-x64"
    assert dotnet["tree_manifest_name"] == ".dotnet-sdk-tree.json"
    assert dotnet["url"].endswith("dotnet-sdk-10.0.402-win-x64.zip")
    assert dotnet["sha512"] == "ae4fd528cb7e9f6af6aaf7de36715a69f761f183744f1bb3025d19f5a92447090ec561410e46266c1d10a63781ed6f3de771760bc76c876d87daabc367b898cd"
    assert dotnet["checksum_url"].endswith("/10.0/releases.json")
    gui = requirements["gui"]
    assert gui == {
        "kind": "avalonia",
        "project_path": "scripts/windows/installer/Fullmag.Setup.UI/Fullmag.Setup.UI.csproj",
        "assembly_name": "FullmagInstallerUi",
        "payload_name": "FullmagInstallerUi.exe",
        "sdk_version": "10.0.402",
        "target_framework": "net10.0",
        "avalonia_version": "12.1.4",
        "runtime_identifier": "win-x64",
        "self_contained": True,
        "single_file": True,
        "private_burn_payload": True,
    }
    project = SETUP_UI_PROJECT.read_text(encoding="utf-8")
    # The frontend owns the project version and package edits. The producer
    # binds it by this canonical path and rejects a stale project at publish
    # time; this test keeps the ownership boundary source-only.
    assert '<AssemblyName>FullmagInstallerUi</AssemblyName>' in project
    assert "PublishSingleFile" in project
    assert requirements["nuget"] == {
        "schema": "fullmag.windows-installer-nuget-provenance.v1",
        "source": "https://api.nuget.org/v3/index.json",
        "lock_mode": "locked",
        "assets_relative_path": "obj/project.assets.json",
        "lock_relative_path": "packages.lock.json",
        "package_cache": "{cache_root}\\installer-dotnet-nuget",
        "runtime_pack_inventory": {
            "schema": "fullmag.windows-installer-runtime-pack-provenance.v1",
            "source": "sdk-download-dependencies",
            "target_framework": "net10.0",
            "runtime_identifier": "win-x64",
            "sdk_version": "10.0.402",
            "bundled_versions_props_relative_path": "sdk\\10.0.402\\Microsoft.NETCoreSdk.BundledVersions.props",
            "bundled_versions_props_sha256": "41630e11d6384b52e4abccbb2f8fbcb4023099ba987d5886d183790986eed201",
            "packages": [
                {"id": "Microsoft.AspNetCore.App.Runtime.win-x64", "version": "10.0.13"},
                {"id": "Microsoft.NETCore.App.Runtime.win-x64", "version": "10.0.13"},
                {"id": "Microsoft.WindowsDesktop.App.Runtime.win-x64", "version": "10.0.13"},
            ],
        },
        "direct_packages": [
            {"id": "Avalonia", "version": "12.1.4"},
            {"id": "Avalonia.Desktop", "version": "12.1.4"},
            {"id": "Avalonia.Themes.Fluent", "version": "12.1.4"},
        ],
    }
    lock_path = SETUP_UI_PROJECT.parent / "packages.lock.json"
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    assert lock["version"] == 1
    assert set(lock["dependencies"]) == {"net10.0", "net10.0/win-x64"}
    assert len(lock["dependencies"]["net10.0"]) == 26
    assert len(lock["dependencies"]["net10.0/win-x64"]) == 8


def test_installer_setup_bootstraps_only_the_pinned_project_dotnet_sdk():
    source = SETUP.read_text(encoding="utf-8")
    for marker in (
        'function Get-DotnetStatus',
        'function Install-DotnetSdk',
        'Get-Sha512Hash',
        'Get-Sha256Hash',
        'function Convert-DotnetTreeEntriesToJson',
        'function Get-DotnetTreeInventory',
        'metadata state must be an empty root-level directory',
        'function Get-DotnetArchiveTreeInventory',
        'function Get-DotnetLegacyReceipt',
        'function Upgrade-LegacyDotnetSdkMetadata',
        'metadata upgrade is required',
        '[IO.File]::Replace($receiptTemp, $legacy.receipt_path, $backupPath',
        'without replacing the retained SDK',
        'refusing overwrite: $root',
        'function Assert-DotnetTreeManifest',
        'tree_manifest_name',
        'tree_inventory_sha256',
        'fullmag.windows-installer-dotnet-sdk-receipt.v1',
        'archive_sha512',
        'receipt.command',
        'DOTNET_ROOT',
        'DOTNET_ROOT(x86)',
        'DOTNET_CLI_HOME',
        'NUGET_PACKAGES',
        'dotnet_sdk',
        'Expand-Archive',
        'archive_sha512',
        '[IO.Directory]::Move($stagingRoot, $root)',
    ):
        assert marker in source
    assert 'winget install dotnet' not in source.lower()
    assert 'EnvironmentVariableTarget]::User' not in source
    assert 'EnvironmentVariableTarget]::Machine' not in source
    status_start = source.index('function Get-DotnetStatus')
    status = source[status_start:source.index('function Assert-LayoutPath', status_start)]
    assert status.index('metadata upgrade is required') < status.index('Assert-DotnetTreeManifest -Root $root')
    assert status.index('Assert-DotnetTreeManifest -Root $root') < status.index('Invoke-NativeOutput $dotnet')


@pytest.mark.skipif(POWERSHELL is None, reason="PowerShell is unavailable")
def test_dotnet_status_scopes_first_use_environment_to_storage_and_restores_process_env(tmp_path: Path):
    source = SETUP.read_text(encoding="utf-8")
    status_start = source.index("function Get-DotnetStatus")
    status_end = source.index("function Assert-LayoutPath", status_start)
    status_function = source[status_start:status_end].strip()
    fixture = tmp_path / "dotnet-status-environment-fixture.ps1"
    fixture.write_text(
        "\n".join(
            [
                "$ErrorActionPreference = 'Stop'",
                status_function,
                "function Assert-LayoutPath {",
                "  param([Parameter(Mandatory=$true)][string]$Path,[Parameter(Mandatory=$true)][string]$Label,[Parameter()][ValidateSet('build','cache','temp')][string]$RootKind='build')",
                "  return [IO.Path]::GetFullPath($Path)",
                "}",
                "function Get-Requirement { param([string]$Id); return $script:Tool }",
                "function Get-DotnetRoot { return $script:DotnetRoot }",
                "function Get-DotnetReceiptPath { param([string]$Root); return (Join-Path $Root $script:Tool.receipt_name) }",
                "function Get-DotnetLegacyReceipt { return $null }",
                "function Get-Sha512Hash { param([string]$Path); return $script:Tool.sha512 }",
                "function Assert-DotnetTreeManifest { return [pscustomobject]@{ manifest='tree'; manifest_sha256='b'; inventory_sha256='c'; file_count=1; directory_count=1 } }",
                "function Invoke-NativeOutput {",
                "  param([string]$Command,[string[]]$Arguments)",
                "  $currentPath = [Environment]::GetEnvironmentVariable('PATH','Process')",
                "  $observed = [ordered]@{ cli_home=[Environment]::GetEnvironmentVariable('DOTNET_CLI_HOME','Process'); nuget=[Environment]::GetEnvironmentVariable('NUGET_PACKAGES','Process'); dotnet_root=[Environment]::GetEnvironmentVariable('DOTNET_ROOT','Process'); x86=[Environment]::GetEnvironmentVariable('DOTNET_ROOT(x86)','Process'); path_prefix=$currentPath.Split([char][IO.Path]::PathSeparator)[0] }",
                "  [IO.File]::WriteAllText($env:OBSERVED_PATH, ($observed | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))",
                "  return [pscustomobject]@{ output='10.0.402'; exit_code=0 }",
                "}",
                "$script:Layout = [pscustomobject]@{ build_root=(Join-Path $PSScriptRoot 'build'); cache_root=(Join-Path $PSScriptRoot 'cache') }",
                "$script:Tool = [pscustomobject]@{ version='10.0.402'; url='https://example.invalid/dotnet.zip'; sha512=(('a' * 128) -join ''); command='dotnet.exe'; runtime_identifier='win-x64'; archive_receipt='.dotnet-sdk-source.zip'; receipt_name='.dotnet-sdk-receipt.json' }",
                "$script:Requirements = [pscustomobject]@{ tools=[pscustomobject]@{ dotnet_sdk=$script:Tool } }",
                "$script:DotnetRoot = Join-Path $script:Layout.build_root 'dotnet'",
                "$null = [IO.Directory]::CreateDirectory((Join-Path $script:DotnetRoot 'sdk\\10.0.402'))",
                "Set-Content -LiteralPath (Join-Path $script:DotnetRoot 'dotnet.exe') -Value 'dotnet' -NoNewline",
                "Set-Content -LiteralPath (Join-Path $script:DotnetRoot $script:Tool.archive_receipt) -Value 'archive' -NoNewline",
                "$receipt = [ordered]@{ schema='fullmag.windows-installer-dotnet-sdk-receipt.v1'; version=$script:Tool.version; url=$script:Tool.url; archive_sha512=$script:Tool.sha512; command=$script:Tool.command; runtime_identifier=$script:Tool.runtime_identifier; tool_root=$script:DotnetRoot }",
                "[IO.File]::WriteAllText((Join-Path $script:DotnetRoot $script:Tool.receipt_name), ($receipt | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))",
                "$outsideRoot = Join-Path $PSScriptRoot 'outside-root'",
                "$outsideCli = Join-Path $outsideRoot 'cli'",
                "$outsideNuget = Join-Path $outsideRoot 'nuget'",
                "$outsidePath = Join-Path $outsideRoot 'path'",
                "[Environment]::SetEnvironmentVariable('DOTNET_ROOT',$outsideRoot,'Process')",
                "[Environment]::SetEnvironmentVariable('DOTNET_ROOT(x86)',($outsideRoot + '\\x86'),'Process')",
                "[Environment]::SetEnvironmentVariable('DOTNET_CLI_HOME',$outsideCli,'Process')",
                "[Environment]::SetEnvironmentVariable('NUGET_PACKAGES',$outsideNuget,'Process')",
                "[Environment]::SetEnvironmentVariable('PATH',$outsidePath,'Process')",
                "$status = Get-DotnetStatus",
                "if ([string]$status.status -ne 'pass') { throw ('status=' + ($status | ConvertTo-Json -Compress)) }",
                "$observed = Get-Content -LiteralPath $env:OBSERVED_PATH -Raw | ConvertFrom-Json",
                "if ([string]$observed.cli_home -ne (Join-Path $script:Layout.build_root 'installer-dotnet-home')) { throw 'CLI home was not storage-scoped' }",
                "if ([string]$observed.nuget -ne (Join-Path $script:Layout.cache_root 'installer-dotnet-nuget')) { throw 'NuGet cache was not storage-scoped' }",
                "if ([string]$observed.dotnet_root -ne $script:DotnetRoot) { throw 'DOTNET_ROOT was not scoped' }",
                "if (-not [string]::IsNullOrEmpty([string]$observed.x86)) { throw 'DOTNET_ROOT(x86) was not cleared' }",
                "if ([string]$observed.path_prefix -ne $script:DotnetRoot) { throw 'managed SDK was not first on PATH' }",
                "foreach ($pair in @(@('DOTNET_ROOT',$outsideRoot),@('DOTNET_ROOT(x86)',($outsideRoot + '\\x86')),@('DOTNET_CLI_HOME',$outsideCli),@('NUGET_PACKAGES',$outsideNuget),@('PATH',$outsidePath))) { if ([Environment]::GetEnvironmentVariable($pair[0],'Process') -ne $pair[1]) { throw ('environment was not restored: ' + $pair[0]) } }",
                "Write-Output 'dotnet-status-environment-verified'",
            ]
        ),
        encoding="utf-8",
    )
    observed = tmp_path / "observed.json"
    env = dict(__import__("os").environ)
    env["OBSERVED_PATH"] = str(observed)
    result = subprocess.run(
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-File", str(fixture)],
        capture_output=True,
        text=True,
        timeout=30,
        env=env,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "dotnet-status-environment-verified"


def test_builder_verifies_sdk_receipt_and_publishes_a_private_self_contained_payload():
    source = BUILDER.read_text(encoding="utf-8")
    for marker in (
        'function Assert-VerifiedDotnetSdk',
        'function Assert-SetupUiProject',
        'function Get-NugetRestoreProvenance',
        'function Get-SdkRuntimePackInventory',
        'function Publish-SetupUi',
        'fullmag.windows-installer-dotnet-sdk-receipt.v1',
        'Get-Sha512 -Path $archive',
        'function Convert-DotnetTreeEntriesToJson',
        'function Get-DotnetTreeInventory',
        'function Assert-DotnetTreeManifest',
        'tree_manifest_name',
        'tree_inventory_sha256',
        'guiRequirements.sdk_version',
        'global.json',
        'rollForward',
        'receipt.command',
        "'--self-contained', 'true'",
        "'-p:PublishSingleFile=true'",
        "'-p:IncludeNativeLibrariesForSelfExtract=true'",
        "'-p:PublishTrimmed=false'",
        'BaseOutputPath=',
        'FullmagSetupUiPayload',
        'avalonia_ui = [ordered]@{',
        'sdk_archive_sha512',
        'nuget_restore',
        'lock_target',
        'package_inventory',
        'nupkg_sha256',
        'nupkg_sha512_base64',
        'content_hash',
        'runtime_pack_inventory',
        'downloadDependencies',
        'BundledVersions.props',
        'restore.sources.PSObject.Properties',
        'lockTargetName',
        "'--use-lock-file'",
        "'--locked-mode'",
        "'--lock-file-path'",
        "'--no-restore'",
        'payload_inventory',
        'payload_size_bytes',
        'Get-ChildItem -LiteralPath $OutputRoot -File -Recurse -Force',
        'verifiedUiInventory',
        'Installer receipt failed staged artifact validation',
        'fullmag-installer-receipt.json',
        'function Assert-InstallerStageTree',
        'Get-ChildItem -LiteralPath $rootFull -Force -Recurse',
        'Fullmag.Bundle.wixobj',
        'fullmag.wixpdb',
        'Test-ReparseItem -Item $item',
        'Assert-InstallerStageTree -Root $stagingRoot',
        'function Assert-CompilerInputMirrorRecord',
        'Compiler input mirror bytes changed',
        'Compiler input mirror contains an unknown file',
    ):
        assert marker in source
    assert "'--force-evaluate'" not in source
    assert 'EnvironmentVariableTarget]::User' not in source
    assert 'EnvironmentVariableTarget]::Machine' not in source


@pytest.mark.skipif(POWERSHELL is None, reason="PowerShell is unavailable")
def test_sdk_tree_receipt_executes_actual_guard_and_rejects_tamper(tmp_path: Path):
    source = BUILDER.read_text(encoding="utf-8")

    def block(start: str, end: str) -> str:
        return source[source.index(start) : source.index(end, source.index(start))]

    helper = "\n".join(
        [
            block("function Convert-ToFullmagAbsolutePath", "function Assert-VerifiedDotnetSdk"),
            block("function Read-JsonFile", "function Assert-VerifiedWixRoot"),
        ]
    )
    fixture = tmp_path / "dotnet-tree-fixture.ps1"
    fixture.write_text(
        "\n".join(
            [
                "$ErrorActionPreference = 'Stop'",
                helper,
                "$root = Join-Path $PSScriptRoot 'sdk-root'",
                "$null = [IO.Directory]::CreateDirectory((Join-Path $root 'sdk\\10.0.402'))",
                "Set-Content -LiteralPath (Join-Path $root 'dotnet.exe') -Value 'dotnet' -NoNewline",
                "Set-Content -LiteralPath (Join-Path $root 'sdk\\10.0.402\\sdk.txt') -Value 'sdk' -NoNewline",
                "Set-Content -LiteralPath (Join-Path $root '.dotnet-sdk-source.zip') -Value 'archive' -NoNewline",
                "$tool = [pscustomobject]@{ archive_receipt='.dotnet-sdk-source.zip'; receipt_name='.dotnet-sdk-receipt.json'; tree_manifest_name='.dotnet-sdk-tree.json' }",
                "$archiveHash = 'a' * 128",
                "$metadataPath = Join-Path $root 'metadata'",
                "$null = [IO.Directory]::CreateDirectory($metadataPath)",
                "$inventory = Get-DotnetTreeInventory -Root $root -MetadataNames @($tool.archive_receipt, $tool.receipt_name, $tool.tree_manifest_name)",
                "if (@($inventory.entries | Where-Object { $_.path -eq 'metadata' }).Count -ne 0) { throw 'empty SDK metadata state leaked into immutable inventory' }",
                "Set-Content -LiteralPath (Join-Path $metadataPath 'state') -Value 'unexpected' -NoNewline",
                "try { Get-DotnetTreeInventory -Root $root -MetadataNames @($tool.archive_receipt, $tool.receipt_name, $tool.tree_manifest_name) | Out-Null; throw 'nonempty SDK metadata state was accepted' } catch { if ($_.Exception.Message -notmatch 'remain an empty root-level directory') { throw } }",
                "Remove-Item -LiteralPath $metadataPath -Recurse -Force",
                "$metadataTarget = Join-Path $PSScriptRoot 'metadata-target'",
                "$null = [IO.Directory]::CreateDirectory($metadataTarget)",
                "$null = New-Item -ItemType Junction -Path $metadataPath -Target $metadataTarget",
                "if (-not (Test-Path -LiteralPath $metadataPath -PathType Container)) { throw 'metadata reparse fixture was not created' }",
                "try { Get-DotnetTreeInventory -Root $root -MetadataNames @($tool.archive_receipt, $tool.receipt_name, $tool.tree_manifest_name) | Out-Null; throw 'reparse SDK metadata state was accepted' } catch { if ($_.Exception.Message -notmatch 'symlink or reparse point') { throw } }",
                "Remove-Item -LiteralPath $metadataPath -Force",
                "$null = [IO.Directory]::CreateDirectory($metadataPath)",
                "$inventory = Get-DotnetTreeInventory -Root $root -MetadataNames @($tool.archive_receipt, $tool.receipt_name, $tool.tree_manifest_name)",
                "$tree = [ordered]@{ schema='fullmag.windows-installer-dotnet-sdk-tree.v1'; archive_sha512=$archiveHash; inventory_sha256=$inventory.inventory_sha256; file_count=$inventory.file_count; directory_count=$inventory.directory_count; inventory=@($inventory.entries) }",
                "$treePath = Join-Path $root $tool.tree_manifest_name",
                "[IO.File]::WriteAllText($treePath, ($tree | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))",
                "$receipt = [ordered]@{ tree_manifest_name=$tool.tree_manifest_name; tree_manifest_sha256=(Get-Sha256 -Path $treePath); tree_inventory_sha256=$inventory.inventory_sha256; tree_file_count=$inventory.file_count; tree_directory_count=$inventory.directory_count }",
                "[IO.File]::WriteAllText((Join-Path $root $tool.receipt_name), ($receipt | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))",
                "$null = Assert-DotnetTreeManifest -Root $root -Tool $tool -Receipt ($receipt | ConvertTo-Json | ConvertFrom-Json) -ExpectedArchiveSha512 $archiveHash",
                "Set-Content -LiteralPath (Join-Path $root 'dotnet.exe') -Value 'tampered' -NoNewline",
                "try { $null = Assert-DotnetTreeManifest -Root $root -Tool $tool -Receipt ($receipt | ConvertTo-Json | ConvertFrom-Json) -ExpectedArchiveSha512 $archiveHash; throw 'tampered SDK tree was accepted' } catch { if ($_.Exception.Message -notmatch 'differs from its immutable receipt') { throw } }",
                "Write-Output 'dotnet-tree-verified'",
            ]
        ),
        encoding="utf-8",
    )
    result = subprocess.run(
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-File", str(fixture)],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "dotnet-tree-verified"
    assert source.index("Assert-DotnetTreeManifest -Root $rootFull") < source.index("(& $dotnet '--version'")


@pytest.mark.skipif(POWERSHELL is None, reason="PowerShell is unavailable")
def test_legacy_dotnet_metadata_upgrade_compares_archive_and_preserves_receipt(tmp_path: Path):
    source = SETUP.read_text(encoding="utf-8")

    def block(start: str, end: str) -> str:
        return source[source.index(start) : source.index(end, source.index(start))]

    helper = "\n".join(
        [
            block("function Get-Requirement", "function Invoke-NativeOutput"),
            block("function Get-DotnetRoot", "function Get-WixRoot"),
        ]
    )
    fixture = tmp_path / "legacy-dotnet-metadata-fixture.ps1"
    fixture.write_text(
        "\n".join(
            [
                "$ErrorActionPreference = 'Stop'",
                helper,
                "$base = [IO.Path]::GetFullPath($PSScriptRoot)",
                "$script:Layout = [pscustomobject]@{ build_root=$base; temp_root=$base }",
                "$script:Requirements = [pscustomobject]@{ tools=[pscustomobject]@{ dotnet_sdk=[pscustomobject]@{ version='10.0.402'; url='https://example.invalid/dotnet.zip'; command='dotnet.exe'; runtime_identifier='win-x64'; archive_receipt='.dotnet-sdk-source.zip'; receipt_name='.dotnet-sdk-receipt.json'; tree_manifest_name='.dotnet-sdk-tree.json'; sha512='' } } }",
                "$tool = Get-Requirement 'dotnet_sdk'",
                "Add-Type -AssemblyName System.IO.Compression; Add-Type -AssemblyName System.IO.Compression.FileSystem",
                "$zipSource = Join-Path $base 'pinned.zip'",
                "$zipStream = [IO.File]::Create($zipSource)",
                "$zip = [IO.Compression.ZipArchive]::new($zipStream, [IO.Compression.ZipArchiveMode]::Create, $false)",
                "foreach ($pair in @(@('dotnet.exe','dotnet'), @('sdk/10.0.402/sdk.txt','sdk-bytes'))) { $entry=$zip.CreateEntry($pair[0]); $writer=New-Object IO.StreamWriter($entry.Open(), [Text.UTF8Encoding]::new($false)); $writer.Write($pair[1]); $writer.Dispose() }",
                "$zip.Dispose(); $zipStream.Dispose()",
                "$tool.sha512 = (Get-Sha512Hash -Path $zipSource)",
                "function New-LegacyRoot([string]$Name) { $root=Join-Path $base $Name; [IO.Directory]::CreateDirectory((Join-Path $root 'sdk\\10.0.402')) | Out-Null; [IO.File]::WriteAllText((Join-Path $root 'dotnet.exe'),'dotnet',[Text.UTF8Encoding]::new($false)); [IO.File]::WriteAllText((Join-Path $root 'sdk\\10.0.402\\sdk.txt'),'sdk-bytes',[Text.UTF8Encoding]::new($false)); Copy-Item -LiteralPath $zipSource -Destination (Join-Path $root $tool.archive_receipt); $receipt=[ordered]@{ schema='fullmag.windows-installer-dotnet-sdk-receipt.v1'; version=$tool.version; url=$tool.url; archive_sha512=$tool.sha512; tool_root=$root; command=$tool.command; runtime_identifier=$tool.runtime_identifier }; [IO.File]::WriteAllText((Join-Path $root $tool.receipt_name),($receipt | ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false)); return $root }",
                "$valid = New-LegacyRoot 'valid'; $upgrade = Upgrade-LegacyDotnetSdkMetadata -Tool $tool -Root $valid -ExpectedArchiveSha512 $tool.sha512; if ($upgrade.status -ne 'pass' -or -not (Test-Path -LiteralPath $upgrade.backup -PathType Leaf)) { throw 'valid legacy metadata upgrade did not publish a backup' }",
                "$changed = New-LegacyRoot 'changed'; Set-Content -LiteralPath (Join-Path $changed 'sdk\\10.0.402\\sdk.txt') -Value 'changed' -NoNewline; try { Upgrade-LegacyDotnetSdkMetadata -Tool $tool -Root $changed -ExpectedArchiveSha512 $tool.sha512 | Out-Null; throw 'changed SDK bytes were accepted' } catch { if ($_.Exception.Message -notmatch 'differs from the pinned archive') { throw } }",
                "$unknown = New-LegacyRoot 'unknown'; Set-Content -LiteralPath (Join-Path $unknown 'unexpected.txt') -Value 'unknown' -NoNewline; try { Upgrade-LegacyDotnetSdkMetadata -Tool $tool -Root $unknown -ExpectedArchiveSha512 $tool.sha512 | Out-Null; throw 'unknown SDK file was accepted' } catch { if ($_.Exception.Message -notmatch 'differs from the pinned archive') { throw } }",
                "$cas = New-LegacyRoot 'record-cas-reject'; $casReceipt = Join-Path $cas $tool.receipt_name; $casJson = Get-Content -LiteralPath $casReceipt -Raw | ConvertFrom-Json; $casJson.archive_sha512 = ('b' * 128); [IO.File]::WriteAllText($casReceipt,($casJson | ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false)); try { Upgrade-LegacyDotnetSdkMetadata -Tool $tool -Root $cas -ExpectedArchiveSha512 $tool.sha512 | Out-Null; throw 'mutated legacy receipt was accepted' } catch { if ($_.Exception.Message -notmatch 'legacy receipt') { throw } }",
                "Write-Output 'legacy-dotnet-metadata-verified'",
            ]
        ),
        encoding="utf-8",
    )
    result = subprocess.run(
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-File", str(fixture)],
        capture_output=True,
        text=True,
        timeout=45,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "legacy-dotnet-metadata-verified"


@pytest.mark.skipif(POWERSHELL is None, reason="PowerShell is unavailable")
def test_stage_tree_guard_executes_actual_helper_and_rejects_empty_unadmitted_directory(tmp_path: Path):
    source = BUILDER.read_text(encoding="utf-8")
    dependency_start = source.index("function Convert-ToFullmagAbsolutePath")
    dependency_end = source.index("function Assert-VerifiedDotnetSdk", dependency_start)
    dependencies = source[dependency_start:dependency_end]
    helper_start = source.index("function Assert-InstallerStageTree")
    helper_end = source.index("function Assert-ExpectedHash", helper_start)
    helper = source[helper_start:helper_end]
    fixture = tmp_path / "stage-tree-fixture.ps1"
    fixture.write_text(
        "\n".join(
            [
                "$ErrorActionPreference = 'Stop'",
                dependencies,
                helper,
                "$root = Join-Path $PSScriptRoot 'stage'",
                "[IO.Directory]::CreateDirectory((Join-Path $root 'FullmagInstallerUi')) | Out-Null",
                "@('fullmag.exe','fullmag-installer-provenance.json','fullmag-installer-receipt.json','Fullmag.Bundle.wixobj','fullmag.wixpdb') | ForEach-Object { Set-Content -LiteralPath (Join-Path $root $_) -Value $_ -NoNewline }",
                "Set-Content -LiteralPath (Join-Path $root 'FullmagInstallerUi\\FullmagInstallerUi.exe') -Value 'MZ' -NoNewline",
                "$null = Assert-InstallerStageTree -Root $root",
                "[IO.Directory]::CreateDirectory((Join-Path $root 'empty-unadmitted')) | Out-Null",
                "try { $null = Assert-InstallerStageTree -Root $root; throw 'empty unadmitted directory was accepted' } catch { if ($_.Exception.Message -notmatch 'unadmitted directory') { throw } }",
                "Write-Output 'stage-tree-verified'",
            ]
        ),
        encoding="utf-8",
    )
    result = subprocess.run(
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-File", str(fixture)],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "stage-tree-verified"


@pytest.mark.skipif(POWERSHELL is None, reason="PowerShell is unavailable")
def test_wrapper_mirror_admission_executes_actual_byte_and_inventory_checks(tmp_path: Path):
    source = BUILDER.read_text(encoding="utf-8")

    def block(start: str, end: str) -> str:
        return source[source.index(start) : source.index(end, source.index(start))]

    helper = "\n".join(
        [
            block("function Convert-ToFullmagAbsolutePath", "function Assert-VerifiedDotnetSdk"),
            block("function Assert-ExpectedHash", "function Assert-VerifiedWixRoot"),
            block("function Assert-CompilerInputMirrorRecord", "function Get-PythonExecutable"),
        ]
    )
    fixture = tmp_path / "wrapper-mirror-fixture.ps1"
    fixture.write_text(
        "\n".join(
            [
                "$ErrorActionPreference = 'Stop'",
                helper,
                "$build = Join-Path $PSScriptRoot 'build'",
                "$production = Join-Path $build 'i\\abcdef123456'",
                "$null = [IO.Directory]::CreateDirectory((Join-Path $production 's\\b'))",
                "$null = [IO.Directory]::CreateDirectory((Join-Path $production 's\\h'))",
                "$null = [IO.Directory]::CreateDirectory((Join-Path $production 's\\ui\\obj'))",
                "$null = [IO.Directory]::CreateDirectory((Join-Path $production 'b'))",
                "$null = [IO.Directory]::CreateDirectory((Join-Path $production 'h'))",
                "Set-Content -LiteralPath (Join-Path $production 's\\b\\a.cpp') -Value 'a' -NoNewline",
                "Set-Content -LiteralPath (Join-Path $production 's\\h\\a.cpp') -Value 'h' -NoNewline",
                "Set-Content -LiteralPath (Join-Path $production 's\\ui\\Test.csproj') -Value '<Project />' -NoNewline",
                "Set-Content -LiteralPath (Join-Path $production 's\\ui\\obj\\generated.assets.json') -Value '{}' -NoNewline",
                "Set-Content -LiteralPath (Join-Path $production 'b\\ALL_BUILD.vcxproj') -Value 'b' -NoNewline",
                "Set-Content -LiteralPath (Join-Path $production 'h\\host.vcxproj') -Value 'h' -NoNewline",
                "$entries = @(",
                "  [pscustomobject]@{ path='s/b/a.cpp'; size=(Get-Item (Join-Path $production 's\\b\\a.cpp')).Length; sha256=(Get-Sha256 (Join-Path $production 's\\b\\a.cpp')) },",
                "  [pscustomobject]@{ path='s/h/a.cpp'; size=(Get-Item (Join-Path $production 's\\h\\a.cpp')).Length; sha256=(Get-Sha256 (Join-Path $production 's\\h\\a.cpp')) },",
                "  [pscustomobject]@{ path='s/ui/Test.csproj'; size=(Get-Item (Join-Path $production 's\\ui\\Test.csproj')).Length; sha256=(Get-Sha256 (Join-Path $production 's\\ui\\Test.csproj')) },",
                "  [pscustomobject]@{ path='b/ALL_BUILD.vcxproj'; size=(Get-Item (Join-Path $production 'b\\ALL_BUILD.vcxproj')).Length; sha256=(Get-Sha256 (Join-Path $production 'b\\ALL_BUILD.vcxproj')) },",
                "  [pscustomobject]@{ path='h/host.vcxproj'; size=(Get-Item (Join-Path $production 'h\\host.vcxproj')).Length; sha256=(Get-Sha256 (Join-Path $production 'h\\host.vcxproj')) }",
                ")",
                "$inventoryJson = @($entries | Sort-Object -Property path) | ConvertTo-Json -Depth 10 -Compress",
                "$snapshot = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'",
                "$recordObject = [ordered]@{ schema='fullmag.windows-installer-compiler-input-mirror.v1'; snapshot_id=$snapshot; source_snapshot_sha256=$snapshot; inventory_sha256=(Get-TextSha256 $inventoryJson); inventory=$entries; ui_project_path='s/ui/Test.csproj'; generated_output_policy=[ordered]@{ roots=@('s/ui/obj','b','h'); purpose='dotnet restore and publish intermediate output only' } }",
                "$record = Join-Path $production 'source-mirror.json'",
                "[IO.File]::WriteAllText($record, ($recordObject | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))",
                "$recordHash = Get-Sha256 $record",
                "$null = Assert-CompilerInputMirrorRecord -RecordPath $record -BuildRoot $build -ExpectedSha256 $recordHash -ExpectedSnapshotId $snapshot -ExpectedSnapshotSha256 $snapshot",
                "$null = New-Item -ItemType Junction -Path (Join-Path $production 'b\\reparse-output') -Target (Join-Path $production 'h')",
                "try { $null = Assert-CompilerInputMirrorRecord -RecordPath $record -BuildRoot $build -ExpectedSha256 $recordHash -ExpectedSnapshotId $snapshot -ExpectedSnapshotSha256 $snapshot; throw 'reparse generated output was accepted' } catch { if ($_.Exception.Message -notmatch 'reparse') { throw } }",
                "[IO.Directory]::Delete((Join-Path $production 'b\\reparse-output'), $true)",
                "Set-Content -LiteralPath (Join-Path $production 's\\b\\unexpected.txt') -Value 'unexpected' -NoNewline",
                "try { $null = Assert-CompilerInputMirrorRecord -RecordPath $record -BuildRoot $build -ExpectedSha256 $recordHash -ExpectedSnapshotId $snapshot -ExpectedSnapshotSha256 $snapshot; throw 'unknown mirror file was accepted' } catch { if ($_.Exception.Message -notmatch 'unknown file') { throw } }",
                "Write-Output 'wrapper-mirror-verified'",
            ]
        ),
        encoding="utf-8",
    )
    result = subprocess.run(
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-File", str(fixture)],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "wrapper-mirror-verified"


@pytest.mark.skipif(POWERSHELL is None, reason="PowerShell is unavailable")
def test_nuget_provenance_parser_accepts_assets_sources_map_and_lock_target(tmp_path: Path):
    source = BUILDER.read_text(encoding="utf-8")

    def block(start: str, end: str) -> str:
        return source[source.index(start) : source.index(end, source.index(start))]

    helper = "\n".join(
        [
            block("function Convert-ToFullmagAbsolutePath", "function Assert-VerifiedDotnetSdk"),
            block("function Assert-ExpectedHash", "function Assert-VerifiedWixRoot"),
            block("function Get-SdkRuntimePackInventory", "function Get-NugetRestoreProvenance"),
            block("function Get-NugetRestoreProvenance", "function Publish-SetupUi"),
        ]
    )
    fixture = tmp_path / "nuget-provenance-fixture.ps1"
    fixture.write_text(
        "\n".join(
            [
                "$ErrorActionPreference = 'Stop'",
                helper,
                "$root = Join-Path $PSScriptRoot 'project'",
                "$obj = Join-Path $root 'obj'",
                "$cache = Join-Path $PSScriptRoot 'packages'",
                "$null = [IO.Directory]::CreateDirectory($obj)",
                "$project = Join-Path $root 'Fullmag.Setup.UI.csproj'",
                "Set-Content -LiteralPath $project -Value '<Project />' -NoNewline",
                "$sdkRoot = Join-Path $PSScriptRoot 'sdk'",
                "$propsPath = Join-Path $sdkRoot 'sdk\\10.0.402\\Microsoft.NETCoreSdk.BundledVersions.props'",
                "$null = [IO.Directory]::CreateDirectory((Split-Path -Parent $propsPath))",
                "$propsXml = '<Project><ItemGroup><KnownFrameworkReference Include=\"Microsoft.AspNetCore.App\" TargetFramework=\"net10.0\" LatestRuntimeFrameworkVersion=\"10.0.13\" TargetingPackVersion=\"10.0.13\" RuntimePackNamePatterns=\"Microsoft.AspNetCore.App.Runtime.**RID**\" RuntimePackRuntimeIdentifiers=\"win-x64\" /><KnownFrameworkReference Include=\"Microsoft.NETCore.App\" TargetFramework=\"net10.0\" LatestRuntimeFrameworkVersion=\"10.0.13\" TargetingPackVersion=\"10.0.13\" RuntimePackNamePatterns=\"Microsoft.NETCore.App.Runtime.**RID**\" RuntimePackRuntimeIdentifiers=\"win-x64\" /><KnownFrameworkReference Include=\"Microsoft.WindowsDesktop.App\" TargetFramework=\"net10.0\" LatestRuntimeFrameworkVersion=\"10.0.13\" TargetingPackVersion=\"10.0.13\" RuntimePackNamePatterns=\"Microsoft.WindowsDesktop.App.Runtime.**RID**\" RuntimePackRuntimeIdentifiers=\"win-x64\" /></ItemGroup></Project>'",
                "[IO.File]::WriteAllText($propsPath, $propsXml, [Text.UTF8Encoding]::new($false))",
                "$propsHash = Get-Sha256 -Path $propsPath",
                "function New-FixturePackage {",
                "  param([string]$Id,[string]$Version,[string]$Content)",
                "  $packageRoot = Join-Path $cache ($Id.ToLowerInvariant() + '\\' + $Version.ToLowerInvariant())",
                "  $null = [IO.Directory]::CreateDirectory($packageRoot)",
                "  $nupkg = Join-Path $packageRoot ($Id + '.' + $Version + '.nupkg')",
                "  [IO.File]::WriteAllBytes($nupkg, [Text.Encoding]::ASCII.GetBytes($Content))",
                "  $archiveHash = Get-Sha512Base64 -Path $nupkg",
                "  [IO.File]::WriteAllText(($nupkg + '.sha512'), $archiveHash, [Text.UTF8Encoding]::new($false))",
                "  $sha = [Security.Cryptography.SHA512]::Create()",
                "  try { $contentHash = [Convert]::ToBase64String($sha.ComputeHash([Text.Encoding]::ASCII.GetBytes('metadata-' + $Content))) } finally { $sha.Dispose() }",
                "  $metadata = [ordered]@{ version=2; contentHash=$contentHash; source='https://api.nuget.org/v3/index.json' }",
                "  [IO.File]::WriteAllText((Join-Path $packageRoot '.nupkg.metadata'), ($metadata | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))",
                "  return [pscustomobject]@{ id=$Id; version=$Version; key=($Id + '/' + $Version); content_hash=$contentHash; archive_hash=$archiveHash }",
                "}",
                "$avalonia = New-FixturePackage -Id 'Avalonia' -Version '12.1.4' -Content 'fixture-package'",
                "$runtimeOnly = New-FixturePackage -Id 'RuntimeOnly' -Version '1.0.0.1' -Content 'runtime-package'",
                "$aspRuntime = New-FixturePackage -Id 'Microsoft.AspNetCore.App.Runtime.win-x64' -Version '10.0.13' -Content 'asp-runtime-package'",
                "$coreRuntime = New-FixturePackage -Id 'Microsoft.NETCore.App.Runtime.win-x64' -Version '10.0.13' -Content 'core-runtime-package'",
                "$desktopRuntime = New-FixturePackage -Id 'Microsoft.WindowsDesktop.App.Runtime.win-x64' -Version '10.0.13' -Content 'desktop-runtime-package'",
                "$runtimeDownloads = @([ordered]@{ name=$aspRuntime.id; version='[10.0.13, 10.0.13]' }, [ordered]@{ name=$coreRuntime.id; version='[10.0.13, 10.0.13]' }, [ordered]@{ name=$desktopRuntime.id; version='[10.0.13, 10.0.13]' })",
                "$assetsLibraries = [ordered]@{",
                "  $avalonia.key = [ordered]@{ type='package'; sha512=$avalonia.content_hash }",
                "  $runtimeOnly.key = [ordered]@{ type='package'; sha512=$runtimeOnly.content_hash }",
                "}",
                "$assetsTargets = [ordered]@{ 'net10.0/win-x64'=[ordered]@{ 'Avalonia/12.1.4'=[ordered]@{ type='package' }; 'RuntimeOnly/1.0.0.1'=[ordered]@{ type='package' } } }",
                "$assets = [ordered]@{ version=3; targets=$assetsTargets; libraries=$assetsLibraries; project=[ordered]@{ restore=[ordered]@{ projectPath=$project; sources=[ordered]@{ 'https://api.nuget.org/v3/index.json'=[ordered]@{} } }; frameworks=[ordered]@{ 'net10.0'=[ordered]@{ downloadDependencies=$runtimeDownloads } } } }",
                "$frameworkTarget = [ordered]@{ Avalonia=[ordered]@{ type='Direct'; requested='[12.1.4, )'; resolved='12.1.4'; contentHash=$avalonia.content_hash } }",
                "$runtimeTarget = [ordered]@{ Avalonia=[ordered]@{ type='Direct'; requested='[12.1.4, )'; resolved='12.1.4'; contentHash=$avalonia.content_hash }; RuntimeOnly=[ordered]@{ type='Direct'; requested='[1.0.0.1, )'; resolved='1.0.0.1'; contentHash=$runtimeOnly.content_hash } }",
                "$lock = [ordered]@{ version=1; dependencies=[ordered]@{ 'net10.0'=$frameworkTarget; 'net10.0/win-x64'=$runtimeTarget } }",
                "[IO.File]::WriteAllText((Join-Path $obj 'project.assets.json'), ($assets | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))",
                "[IO.File]::WriteAllText((Join-Path $obj 'packages.lock.json'), ($lock | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))",
                "$gui = [pscustomobject]@{ target_framework='net10.0'; runtime_identifier='win-x64' }",
                "$runtimePolicy = [pscustomobject]@{ schema='fullmag.windows-installer-runtime-pack-provenance.v1'; source='sdk-download-dependencies'; target_framework='net10.0'; runtime_identifier='win-x64'; sdk_version='10.0.402'; bundled_versions_props_relative_path='sdk\\10.0.402\\Microsoft.NETCoreSdk.BundledVersions.props'; bundled_versions_props_sha256=$propsHash; packages=@([pscustomobject]@{ id=$aspRuntime.id; version='10.0.13' }, [pscustomobject]@{ id=$coreRuntime.id; version='10.0.13' }, [pscustomobject]@{ id=$desktopRuntime.id; version='10.0.13' }) }",
                "$nuget = [pscustomobject]@{ schema='fullmag.windows-installer-nuget-provenance.v1'; lock_mode='locked'; source='https://api.nuget.org/v3/index.json'; assets_relative_path='obj/project.assets.json'; lock_relative_path='obj/packages.lock.json'; runtime_pack_inventory=$runtimePolicy; direct_packages=@([pscustomobject]@{ id='Avalonia'; version='12.1.4' }) }",
                "$dotnet = [pscustomobject]@{ root=$sdkRoot; version='10.0.402'; archive_sha512=('a' * 128); tree_manifest_sha256=('b' * 64); tree_inventory_sha256=('c' * 64) }",
                "$result = Get-NugetRestoreProvenance -ProjectPath $project -Gui $gui -Nuget $nuget -Dotnet $dotnet -NugetRoot $cache",
                "if ($result.target -ne 'net10.0/win-x64' -or $result.lock_target -ne 'net10.0/win-x64' -or @($result.lock_targets).Count -ne 2 -or @($result.package_inventory).Count -ne 2 -or @($result.runtime_pack_inventory).Count -ne 3) { throw 'NuGet provenance result was incomplete' }",
                "if ($result.runtime_pack_source -ne 'sdk-download-dependencies' -or $result.runtime_pack_bundled_versions_props_sha256 -ne $propsHash) { throw 'SDK runtime-pack provenance was not bound to the props file' }",
                "if (@($result.package_inventory | Where-Object { $_.id -like '*.Runtime.*' }).Count -ne 0) { throw 'SDK runtime packs leaked into the normal NuGet inventory' }",
                "$inventory = @($result.package_inventory)",
                "if ([string]$inventory[0].content_hash -eq [string]$inventory[0].nupkg_sha512_base64) { throw 'NuGet metadata and raw archive hashes were conflated' }",
                "[IO.File]::WriteAllText((Join-Path $cache 'avalonia\\12.1.4\\Avalonia.12.1.4.nupkg.sha512'), $avalonia.content_hash, [Text.UTF8Encoding]::new($false))",
                "try { $null = Get-NugetRestoreProvenance -ProjectPath $project -Gui $gui -Nuget $nuget -Dotnet $dotnet -NugetRoot $cache; throw 'invalid raw archive hash was accepted' } catch { if ($_.Exception.Message -notmatch 'archive hash file') { throw } }",
                "[IO.File]::WriteAllText((Join-Path $cache 'avalonia\\12.1.4\\Avalonia.12.1.4.nupkg.sha512'), $avalonia.archive_hash, [Text.UTF8Encoding]::new($false))",
                "[IO.File]::WriteAllText((Join-Path $cache 'microsoft.aspnetcore.app.runtime.win-x64\\10.0.13\\Microsoft.AspNetCore.App.Runtime.win-x64.10.0.13.nupkg.sha512'), $aspRuntime.content_hash, [Text.UTF8Encoding]::new($false))",
                "try { $null = Get-NugetRestoreProvenance -ProjectPath $project -Gui $gui -Nuget $nuget -Dotnet $dotnet -NugetRoot $cache; throw 'invalid runtime-pack archive hash was accepted' } catch { if ($_.Exception.Message -notmatch 'SDK runtime-pack archive hash file') { throw } }",
                "[IO.File]::WriteAllText((Join-Path $cache 'microsoft.aspnetcore.app.runtime.win-x64\\10.0.13\\Microsoft.AspNetCore.App.Runtime.win-x64.10.0.13.nupkg.sha512'), $aspRuntime.archive_hash, [Text.UTF8Encoding]::new($false))",
                "Write-Output 'nuget-provenance-verified'",
            ]
        ),
        encoding="utf-8",
    )
    result = subprocess.run(
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-File", str(fixture)],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "nuget-provenance-verified"


def test_bootstrapper_cmake_compiles_the_hash_bound_ui_broker_sources():
    cmake = (ROOT / "scripts/windows/installer/FullmagBootstrapperApplication/CMakeLists.txt").read_text(
        encoding="utf-8"
    )
    library = cmake[cmake.index("add_library("):cmake.index("target_include_directories(")]
    assert "FullmagInstallerUiBroker.cpp" in library
    assert "FullmagInstallerUiBroker.h" in library
    assert "CMAKE_SIZEOF_VOID_P EQUAL 4" in cmake
    broker = (ROOT / "scripts/windows/installer/FullmagBootstrapperApplication/FullmagInstallerUiBroker.cpp").read_text(
        encoding="utf-8"
    )
    assert "expectedSha256" in broker
    assert "Sha256Handle" in broker
    assert "CreateProcessW" in broker
    assert "CreateJobObjectW" in broker
    assert "FullmagInstallerUi.exe" not in broker
    assert "fullmag-installer-ui.exe" not in broker


def test_source_first_passes_private_admission_to_environment_helper():
    source = BUNDLE.read_text(encoding="utf-8")
    assert '<Variable Name="FullmagSourceAdmissionPath" Type="string" Value="" Persisted="yes" />' in source
    assert '<Variable Name="FullmagSourceAdmissionSha256" Type="string" Value="" Persisted="yes" />' in source
    assert '--admission-path &quot;[FullmagSourceAdmissionPath]&quot;' in source
    assert '--admission-sha256 &quot;[FullmagSourceAdmissionSha256]&quot;' in source


def test_burn_variables_are_wix3_legal_empty_strings_and_payload_names_are_windows_paths():
    root = ET.fromstring(BUNDLE.read_text(encoding="utf-8"))
    ns = "{http://schemas.microsoft.com/wix/2006/wi}"
    bundle = root.find(f"{ns}Bundle")
    assert bundle is not None
    variables = {
        variable.attrib["Name"]: variable.attrib
        for variable in bundle.findall(f"{ns}Variable")
    }
    for name in (
        "FullmagSourceCheckout",
        "FullmagStorageRoot",
        "FullmagStorageProfile",
        "FullmagBootstrapMode",
        "FullmagReceiptPath",
        "FullmagSourceAdmissionPath",
        "FullmagSourceAdmissionSha256",
    ):
        assert variables[name]["Type"] == "string"
        assert variables[name]["Value"] == ""
        assert variables[name]["Persisted"] == "yes"

    payload_names = [
        payload.attrib["Name"]
        for payload in bundle.findall(f"{ns}BootstrapperApplication/{ns}Payload")
    ]
    assert "scripts\\windows\\setup_build_environment.ps1" in payload_names
    assert "scripts/windows/setup_build_environment.ps1" not in payload_names


def test_bundle_has_no_global_environment_authoring_or_webview_placeholder():
    source = BUNDLE.read_text(encoding="utf-8")
    assert "<Environment" not in source
    assert "WriteEnvironmentStrings" not in source
    assert "FULLMAG_PROJECT_STORAGE_ROOT" not in source
    # WebView2 is not yet a pinned payload. The custom BA owns the detection
    # boundary; this WXS must not invent an unverified ExePackage.
    assert "WebView2" not in source


def test_builder_requires_verified_payload_license_and_external_ba():
    source = BUILDER.read_text(encoding="utf-8")
    # Stop before the first function body. Parameter attributes contain their
    # own parentheses, so splitting at the first closing parenthesis truncates
    # the declaration after the first [Parameter(...)] attribute.
    parameter_block = source.split("$ErrorActionPreference", 1)[0]
    for name in (
        "$MsiPath", "$StageManifestPath", "$MsiSha256", "$StageManifestSha256", "$LicenseFile",
        "$LicenseFileSha256", "$BootstrapperApplicationDll",
        "$BootstrapperApplicationSha256", "$BundleUpgradeCode", "$WixRoot",
        "$InstallerStorageProfile", "$FrozenSourceRecord", "$SetupBuildEnvironmentScript",
        "$SetupBuildEnvironmentScriptSha256", "$BuildRequirementsManifest",
        "$BuildRequirementsManifestSha256", "$InstallerBuildRequirementsManifest",
        "$InstallerBuildRequirementsManifestSha256", "$CompilerInputMirrorRecord", "$CompilerInputMirrorSha256",
        "$SetupUiProjectPath",
    ):
        assert name in parameter_block
    assert "ValidatePattern('^[0-9a-fA-F]{64}$')" in parameter_block
    assert "BundleUpgradeCode must be a stable non-empty GUID" in source
    assert "approved LicenseFile" in source
    assert "external BootstrapperApplication DLL" in source
    assert "Assert-ExpectedHash" in source
    assert "StageManifestSha256" in source
    assert "Assert-VerifiedWixRoot" in source
    assert "ValidateSet('windows-setup')" in source
    assert "InstallerStorageProfile" in source
    assert "canonical runtime build requirements manifest" in source
    assert "canonical installer producer requirements manifest" in source


def test_builder_has_source_first_route_without_an_msi_shortcut():
    source = BUILDER.read_text(encoding="utf-8")
    assert "ValidateSet('release', 'source-first')" in source
    assert "windows-installer-source" in source
    assert "$isSourceFirst = $Route -eq 'source-first'" in source
    assert "source-first route requires EnvironmentBootstrapExe/hash/version" in source
    assert "FrozenSourceRecord" in source
    assert "Frozen source snapshot verification failed" in source
    assert "release route requires a verified FrozenSourceRecord matching the MSI source_identity" in source
    assert "-ExpectedSnapshotId ([string]$frozen.snapshot_id)" in source
    assert "release route source identity arguments do not match the MSI stage source_identity" in source
    assert "-dSourceFirst=$([int]$isSourceFirst)" in source
    assert "EnvironmentBootstrapExe" in source
    assert "MsiPath" in source


def test_release_route_uses_the_stage_identity_for_frozen_authoring_inputs():
    source = BUILDER.read_text(encoding="utf-8")
    release_start = source.index("  if ([string]::IsNullOrWhiteSpace($MsiPath)")
    release_end = source.index("$bundleSource =", release_start)
    release = source[release_start:release_end]
    assert "FrozenSourceRecord matching the MSI source_identity" in release
    assert "Get-VerifiedFrozenSource -RecordPath $FrozenSourceRecord" in release
    assert "-ExpectedCommit ([string]$sourceIdentity.head_commit_full)" in release
    assert "-ExpectedSnapshotSha256 ([string]$sourceIdentity.source_snapshot_sha256)" in release
    assert "$authoringRoot = [string]$frozen.source_root" in release
    assert "release route source identity arguments do not match the MSI stage source_identity" in release


def test_builder_packages_the_real_installer_env_helper():
    source = BUILDER.read_text(encoding="utf-8")
    assert "scripts\\windows\\installer_env.ps1" in source
    assert "installer environment module" in source
    assert "installer_env.ps1" in BUNDLE.read_text(encoding="utf-8")


def test_builder_uses_existing_msi_manifest_and_storage_resolver():
    source = BUILDER.read_text(encoding="utf-8")
    assert "Resolve-FullmagStorageLayout" in source
    assert "scripts/fullmag_storage.py" in (ROOT / "scripts/windows/fullmag_storage.ps1").read_text(encoding="utf-8")
    assert "Stage manifest schema_version must be 2" in source
    assert "source_identity" in source
    assert "source_snapshot_sha256" in source
    assert "MSI stage root must belong to the same run directory" in source
    assert "Existing MSI payload and stage manifest must come from the same MSI run directory" in source
    assert "build_windows_msi.ps1" not in source
    assert "WixRoot" in source
    assert "bal_extension" in source
    assert "WixBalExtension.dll" in (ROOT / "windows_installer_build_requirements.json").read_text(encoding="utf-8")
    assert "Resolve-FullmagStorageLayout -RepoRoot $RepoRoot -Profile $StorageProfile" in source
    assert "Resolve-InstallerToolLayoutReadOnly -RepoRoot $RepoRoot" in source
    assert "Resolve-FullmagStorageLayout -RepoRoot $RepoRoot -Profile $InstallerStorageProfile" not in source


def test_builder_binds_runtime_and_installer_producer_manifests_separately():
    source = BUILDER.read_text(encoding="utf-8")
    assert "$runtimeBuildRequirementsManifest = Assert-RegularFile -Path $BuildRequirementsManifest" in source
    assert "$producerBuildRequirementsManifest = Assert-RegularFile -Path $InstallerBuildRequirementsManifest" in source
    assert "windows_build_requirements.json" in source
    assert "windows_installer_build_requirements.json" in source
    assert "Read-JsonFile -Path $producerBuildRequirementsManifest" in source
    assert '"-dBuildRequirementsManifest=$runtimeBuildRequirementsManifest"' in source
    assert "producer_manifest = [ordered]@" in source


@pytest.mark.skipif(POWERSHELL is None, reason="PowerShell is unavailable")
def test_builder_manifest_validation_executes_against_both_real_manifests(tmp_path: Path):
    """Run the wrapper's manifest-read/validation block against both JSON roles."""
    source = BUILDER.read_text(encoding="utf-8")
    reader_start = source.index("function Read-JsonFile")
    reader_end = source.index("function Assert-VerifiedWixRoot", reader_start)
    reader = source[reader_start:reader_end].strip()
    validation_start = source.index(
        "$buildRequirements = Read-JsonFile -Path $producerBuildRequirementsManifest"
    )
    validation_end = source.index("$license = Assert-RegularFile", validation_start)
    validation = source[validation_start:validation_end].strip()
    runtime_manifest = _native_windows_path(ROOT / "windows_build_requirements.json")
    producer_manifest = _native_windows_path(REQUIREMENTS)

    def ps_literal(value: str) -> str:
        return "'" + value.replace("'", "''") + "'"

    fixture = tmp_path / "manifest-role-fixture.ps1"
    fixture.write_text(
        "\n".join(
            [
                "$ErrorActionPreference = 'Stop'",
                reader,
                f"$runtimeBuildRequirementsManifest = {ps_literal(runtime_manifest)}",
                f"$producerBuildRequirementsManifest = {ps_literal(producer_manifest)}",
                "$runtimeRequirements = Read-JsonFile -Path $runtimeBuildRequirementsManifest -Label 'runtime build requirements manifest'",
                "if ([string]$runtimeRequirements.schema_version -ne 'fullmag.windows-build-requirements.v1') { throw 'runtime manifest role changed' }",
                "if ($null -ne $runtimeRequirements.tools.dotnet_sdk -or $null -ne $runtimeRequirements.gui -or $null -ne $runtimeRequirements.nuget) { throw 'runtime manifest unexpectedly carries producer-only fields' }",
                validation,
                "if ([string]$buildRequirements.schema -ne 'fullmag.windows-installer-build-requirements.v1') { throw 'producer manifest role changed' }",
                "Write-Output 'producer-manifest-verified'",
                "$producerBuildRequirementsManifest = $runtimeBuildRequirementsManifest",
                "try {",
                validation,
                "  throw 'runtime manifest was accepted as producer manifest'",
                "} catch {",
                "  if ($_.Exception.Message -notmatch 'Build requirements manifest must contain') { throw }",
                "}",
                "Write-Output 'runtime-manifest-rejected'",
            ]
        ),
        encoding="utf-8",
    )
    result = subprocess.run(
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-File", str(fixture)],
        capture_output=True,
        text=True,
        timeout=20,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == ["producer-manifest-verified", "runtime-manifest-rejected"]


def test_source_producer_uses_the_admitted_python_interpreter_path():
    source = (ROOT / "scripts/windows/build_installer_from_source.ps1").read_text(encoding="utf-8")
    managed = source.split("if (-not $ManagedBuild)", 1)[1]
    assert "function Get-VerifiedPythonPath" in source
    assert "$python = Get-VerifiedPythonPath $tools" in managed
    assert "Invoke-InstallerTool $python" in managed
    assert managed.count("& $python -B") == 3
    assert "& python.exe" not in managed


def test_source_producer_final_manifest_uses_validated_unique_backup_path():
    source = (ROOT / "scripts/windows/build_installer_from_source.ps1").read_text(encoding="utf-8")
    assert "$manifestDirectory = Assert-ProducerPath ([IO.Path]::GetDirectoryName($manifestPath)) $buildRoot" in source
    assert "[IO.Directory]::CreateDirectory($manifestDirectory)" in source
    assert "$backupManifest = Assert-ProducerPath ($manifestPath + '.' + $runId + '.bak') $buildRoot" in source
    assert "foreach ($candidate in @($tempManifest, $backupManifest))" in source
    assert "[IO.File]::Replace($tempManifest,$manifestPath,$backupManifest,$false)" in source
    assert "[IO.File]::Replace($tempManifest,$manifestPath,$null)" not in source


def test_builder_records_private_ui_payload_size_from_file_metadata():
    source = BUILDER.read_text(encoding="utf-8")
    assert "payload_size_bytes = [int64](Get-Item -LiteralPath $payload -Force).Length" in source
    assert "payload_size_bytes = [int64]$payload.Length" not in source

def test_source_producer_uses_short_collision_checked_execution_layout():
    source = (ROOT / "scripts/windows/build_installer_from_source.ps1").read_text(encoding="utf-8")
    assert "function Get-ProducerExecutionLayout" in source
    assert "Substring(0, 12)" in source
    assert "CMakeFiles\\CMakeScratch\\TryCompile-" in source
    assert "Join-Path $productionRoot 'b'" in source
    assert "Join-Path $productionRoot 'h'" in source
    assert "path budget exceeded" in source
    assert "refusing overwrite" in source
    assert "execution_directory = 'i\\' + $shortRunId" in source
    assert "run_id=$runId; execution_directory=$execution.execution_directory" in source
    assert "execution.json" in source
    assert "installer-source\\executions\\" not in source


def test_source_producer_mirrors_frozen_compiler_inputs_under_short_root():
    source = (ROOT / "scripts/windows/build_installer_from_source.ps1").read_text(encoding="utf-8")
    assert "function Copy-CompilerInputMirror" in source
    assert "function Assert-CompilerInputMirror" in source
    assert "fullmag.windows-installer-compiler-input-mirror.v1" in source
    assert "[IO.File]::Copy($sourceFile, $destinationFile, $false)" in source
    assert "Get-FileHash -LiteralPath $destinationFile -Algorithm SHA256" in source
    assert "source-mirror.json" in source
    assert "-S',$target.source" in source
    assert "$mirror = Assert-CompilerInputMirror" in source
    assert "-CompilerInputMirrorRecord" in source
    assert "run_installer_environment.ps1" in source
    assert "-ExpectedRecordSha256" in source
    assert "-ExpectedSnapshotId" in source
    assert "record bytes changed during compilation" in source
    assert "FullmagInstallerUiBroker.cpp" in source
    assert "FullmagInstallerUiBroker.h" in source
    assert "ui_project_path" in source
    assert "generated_output_policy" in source
    assert "locked_file = $guiLockedFileRelative" in source
    assert "versioned UI packages.lock.json" in source
    assert "packages.lock.json" in source
    assert "runtimeBuildRequirementsManifest = Join-Path $source 'windows_build_requirements.json'" in source
    assert "installerBuildRequirementsManifest = Join-Path $source 'windows_installer_build_requirements.json'" in source
    assert "-InstallerBuildRequirementsManifest $installerBuildRequirementsManifest" in source
    assert "s/ui/obj" in source
    assert "@('s/ui/obj', 'b', 'h')" in source
    assert "-SetupUiProjectPath" in source


@pytest.mark.skipif(POWERSHELL is None, reason="PowerShell is unavailable")
def test_source_producer_mirror_round_trip_rejects_changed_bytes(tmp_path: Path):
    source = (ROOT / "scripts/windows/build_installer_from_source.ps1").read_text(encoding="utf-8")
    helper_start = source.index("function Assert-ProducerPath")
    helper_end = source.index("function Get-ProducerEnvironment", helper_start)
    helper = source[helper_start:helper_end]
    fixture = tmp_path / "mirror-fixture.ps1"
    fixture.write_text(
        "\n".join(
            [
                "$ErrorActionPreference = 'Stop'",
                helper,
                "$build = Join-Path $PSScriptRoot 'build'",
                "$frozen = Join-Path $build 'frozen'",
                "$production = Join-Path $build 'i\\0123456789ab'",
                "[IO.Directory]::CreateDirectory((Join-Path $frozen 'scripts\\windows\\installer\\FullmagBootstrapperApplication')) | Out-Null",
                "[IO.Directory]::CreateDirectory((Join-Path $frozen 'scripts\\windows\\installer\\Fullmag.Setup.UI')) | Out-Null",
                "[IO.Directory]::CreateDirectory((Join-Path $frozen 'scripts\\windows\\installer\\FullmagEnvironmentBootstrap')) | Out-Null",
                "[IO.Directory]::CreateDirectory((Join-Path $frozen 'scripts\\windows')) | Out-Null",
                "@('CMakeLists.txt','FullmagBootstrapperApplication.cpp','FullmagBootstrapperApplication.h','FullmagBootstrapperApplication.def','FullmagBootstrapperApplication.manifest','FullmagBootstrapperApplication.rc','FullmagInstallerUiBroker.cpp','FullmagInstallerUiBroker.h') | ForEach-Object { Set-Content -LiteralPath (Join-Path $frozen ('scripts\\windows\\installer\\FullmagBootstrapperApplication\\' + $_)) -Value $_ -NoNewline }",
                "Set-Content -LiteralPath (Join-Path $frozen 'scripts\\windows\\installer\\Fullmag.Setup.UI\\Fullmag.Setup.UI.csproj') -Value '<Project />' -NoNewline",
                "@('CMakeLists.txt','FullmagEnvironmentBootstrap.cpp','FullmagEnvironmentBootstrap.manifest','FullmagEnvironmentBootstrap.rc','resource.h') | ForEach-Object { Set-Content -LiteralPath (Join-Path $frozen ('scripts\\windows\\installer\\FullmagEnvironmentBootstrap\\' + $_)) -Value $_ -NoNewline }",
                "Set-Content -LiteralPath (Join-Path $frozen 'scripts\\windows\\run_installer_environment.ps1') -Value 'workflow' -NoNewline",
                "Set-Content -LiteralPath (Join-Path $frozen 'windows_installer_build_requirements.json') -Value '{\"gui\":{\"project_path\":\"scripts/windows/installer/Fullmag.Setup.UI/Fullmag.Setup.UI.csproj\"},\"nuget\":{\"lock_relative_path\":\"packages.lock.json\"}}' -NoNewline",
                "Set-Content -LiteralPath (Join-Path $frozen 'scripts\\windows\\installer\\Fullmag.Setup.UI\\packages.lock.json') -Value '{\"version\":1}' -NoNewline",
                "$snapshot = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'",
                "$mirror = Copy-CompilerInputMirror -FrozenSourceRoot $frozen -ProductionRoot $production -BuildRoot $build -SnapshotId $snapshot -SnapshotSha256 $snapshot",
                "$verified = Assert-CompilerInputMirror -RecordPath $mirror.record_path -BuildRoot $build -ProductionRoot $production -ExpectedRecordSha256 $mirror.record_sha256 -ExpectedSnapshotId $snapshot -ExpectedSnapshotSha256 $snapshot",
                "if ($verified.record_sha256 -ne $mirror.record_sha256) { throw 'mirror record hash changed unexpectedly' }",
                "[IO.Directory]::CreateDirectory((Join-Path $production 's\\ui\\obj')) | Out-Null",
                "Set-Content -LiteralPath (Join-Path $production 's\\ui\\obj\\project.assets.json') -Value '{}' -NoNewline",
                "$verifiedGenerated = Assert-CompilerInputMirror -RecordPath $mirror.record_path -BuildRoot $build -ProductionRoot $production -ExpectedRecordSha256 $mirror.record_sha256 -ExpectedSnapshotId $snapshot -ExpectedSnapshotSha256 $snapshot",
                "if ($verifiedGenerated.ui_project -ne $mirror.ui_project) { throw 'verified UI project path changed unexpectedly' }",
                "[IO.Directory]::CreateDirectory((Join-Path $production 's\\ui\\bin')) | Out-Null",
                "Set-Content -LiteralPath (Join-Path $production 's\\ui\\bin\\unexpected.txt') -Value 'unexpected' -NoNewline",
                "try { Assert-CompilerInputMirror -RecordPath $mirror.record_path -BuildRoot $build -ProductionRoot $production -ExpectedRecordSha256 $mirror.record_sha256 -ExpectedSnapshotId $snapshot -ExpectedSnapshotSha256 $snapshot | Out-Null; throw 'unknown UI output was accepted' }",
                "catch { if ($_.Exception.Message -notmatch 'unknown file') { throw } }",
                "Remove-Item -LiteralPath (Join-Path $production 's\\ui\\bin') -Recurse -Force",
                "Add-Content -LiteralPath (Join-Path $production 's\\b\\FullmagBootstrapperApplication.cpp') -Value 'changed' -NoNewline",
                "try { Assert-CompilerInputMirror -RecordPath $mirror.record_path -BuildRoot $build -ProductionRoot $production -ExpectedRecordSha256 $mirror.record_sha256 -ExpectedSnapshotId $snapshot -ExpectedSnapshotSha256 $snapshot | Out-Null; throw 'changed mirror bytes were accepted' }",
                "catch { if ($_.Exception.Message -notmatch 'bytes changed') { throw } }",
                "Write-Output 'mirror-verified'",
            ]
        ),
        encoding="utf-8",
    )
    result = subprocess.run(
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-File", str(fixture)],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "mirror-verified"


def test_builder_records_verified_prerequisite_and_wix_license_payloads():
    source = BUILDER.read_text(encoding="utf-8")
    for field in (
        "SetupBuildEnvironmentScript",
        "SetupBuildEnvironmentScriptSha256",
        "BuildRequirementsManifest",
        "BuildRequirementsManifestSha256",
        "InstallerBuildRequirementsManifest",
        "InstallerBuildRequirementsManifestSha256",
        "WixLicenseFile",
        "WiX-3.14.1-LICENSE.TXT",
        "prerequisite_setup",
        "prerequisite_manifest",
        "producer_manifest",
        "license_sha256",
    ):
        assert field in source


@pytest.mark.skipif(POWERSHELL is None, reason="PowerShell is unavailable")
def test_source_producer_rejects_a_python_launcher_path(tmp_path: Path):
    source = (ROOT / "scripts/windows/build_installer_from_source.ps1").read_text(encoding="utf-8")
    helper_start = source.index("function Get-VerifiedPythonPath")
    helper_end = source.index("function Get-ProducerEnvironment", helper_start)
    helper = source[helper_start:helper_end]
    fixture = tmp_path / "verified-python-fixture.ps1"
    fixture.write_text(
        "\n".join(
            [
                "$ErrorActionPreference = 'Stop'",
                helper,
                "$good = Join-Path $PSScriptRoot 'python.exe'",
                "$launcher = Join-Path $PSScriptRoot 'py.exe'",
                "Set-Content -LiteralPath $good -Value 'fixture'",
                "Set-Content -LiteralPath $launcher -Value 'fixture'",
                "$goodReport = [pscustomobject]@{ checks = @([pscustomobject]@{ id = 'python'; path = $good }) }",
                "$resolved = Get-VerifiedPythonPath $goodReport",
                "if ([IO.Path]::GetFileName($resolved) -ne 'python.exe') { throw 'resolved interpreter was not returned' }",
                "$launcherReport = [pscustomobject]@{ checks = @([pscustomobject]@{ id = 'python'; path = $launcher }) }",
                "try { Get-VerifiedPythonPath $launcherReport | Out-Null; throw 'launcher path was accepted' }",
                "catch { if ($_.Exception.Message -notmatch 'launcher') { throw } }",
                "Write-Output 'verified'",
            ]
        ),
        encoding="utf-8",
    )
    result = subprocess.run(
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-File", str(fixture)],
        capture_output=True,
        text=True,
        timeout=20,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "verified"


@pytest.mark.skipif(POWERSHELL is None, reason="PowerShell is unavailable")
def test_source_producer_path_budget_rejects_long_build_root(tmp_path: Path):
    source = (ROOT / "scripts/windows/build_installer_from_source.ps1").read_text(encoding="utf-8")
    helper_start = source.index("function Get-ProducerExecutionLayout")
    helper_end = source.index("function Get-ProducerEnvironment", helper_start)
    helper = source[helper_start:helper_end]
    fixture = tmp_path / "execution-layout-fixture.ps1"
    fixture.write_text(
        "\n".join(
            [
                "$ErrorActionPreference = 'Stop'",
                helper,
                "$shortRoot = [IO.Path]::GetPathRoot($PSScriptRoot)",
                "$short = Get-ProducerExecutionLayout -BuildRoot $shortRoot -RunId '0123456789abcdef0123456789abcdef'",
                "if ($short.short_run_id -ne '0123456789ab') { throw 'short execution id was not derived' }",
                "if ($short.execution_directory -ne 'i\\0123456789ab') { throw 'execution directory is not canonical' }",
                "if ([int]$short.worst_path_length -ge 260) { throw 'short execution layout exceeds MAX_PATH' }",
                "$longRoot = Join-Path $PSScriptRoot ('long-' + ('x' * 240))",
                "try { Get-ProducerExecutionLayout -BuildRoot $longRoot -RunId 'fedcba9876543210fedcba9876543210' | Out-Null; throw 'long build root was accepted' }",
                "catch { if ($_.Exception.Message -notmatch 'path budget exceeded') { throw } }",
                "Write-Output 'budget-verified'",
            ]
        ),
        encoding="utf-8",
    )
    result = subprocess.run(
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-File", str(fixture)],
        capture_output=True,
        text=True,
        timeout=20,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "budget-verified"


def test_producer_setup_report_exposes_verified_wix_tool_paths():
    source = SETUP.read_text(encoding="utf-8")
    for field in (
        "producer_tools", "verified_wix_root", "tool_paths", "candle",
        "light", "heat", "bal_extension", "ui_extension",
    ):
        assert field in source
    assert "wixStatus.tool_paths" in source
    assert "fullmag.windows-installer-build-environment-report.v1" in source


def test_builder_requires_exact_public_filename_and_does_not_overwrite_output():
    source = BUILDER.read_text(encoding="utf-8")
    assert "Public Burn output must be named fullmag.exe" in source
    assert "Installer output directory is not empty" in source
    assert "Move-Item" not in source
    assert "fullmag-installer-receipt.json" in source
    assert "Directory]::Move($stagingRoot, $distRoot)" in source
    assert "Remove-Item -LiteralPath $distRoot" not in source


def test_builder_creates_staging_directory_with_windows_powershell_compatible_api():
    source = BUILDER.read_text(encoding="utf-8")
    assert "[IO.Directory]::CreateDirectory($stagingRoot)" in source
    assert "New-Item -ItemType Directory -LiteralPath" not in source


def test_publish_setup_ui_uses_single_windows_separator_for_base_output_path():
    source = BUILDER.read_text(encoding="utf-8")
    publish = source[source.index("function Publish-SetupUi") : source.index("function Assert-InstallerStageTree")]
    assert "$baseOutputRoot.TrimEnd('\\\\', '/') + '\\\\'" not in publish
    assert "TrimEnd('\\', '/') + '\\'" in publish


@pytest.mark.skipif(POWERSHELL is None, reason="PowerShell is unavailable")
def test_release_asset_staging_fragment_runs_in_native_powershell(tmp_path: Path):
    source = RELEASE_WORKFLOW.read_text(encoding="utf-8")
    staging_start = source.index("          $assetDir = Join-Path")
    staging_end = source.index("          $tag = [string]$env:FULLMAG_RELEASE_TAG", staging_start)
    staging_block = textwrap.dedent(source[staging_start:staging_end]).strip()
    guard = next(line.strip() for line in staging_block.splitlines() if line.strip().startswith("if (Test-Path -LiteralPath $assetDir)"))
    assert "[IO.Directory]::CreateDirectory($assetDir) | Out-Null" in staging_block
    assert "New-Item -ItemType Directory -LiteralPath $assetDir" not in staging_block

    fixture = tmp_path / "release-staging-fixture.ps1"
    fixture.write_text(
        "\n".join(
            [
                "$ErrorActionPreference = 'Stop'",
                staging_block.replace(
                    "$env:RUNNER_TEMP",
                    "$PSScriptRoot",
                ).replace(
                    "'fullmag-release-source-first-' + $env:GITHUB_RUN_ID",
                    "'asset-staging'",
                ),
                "if (-not (Test-Path -LiteralPath $assetDir -PathType Container)) { throw 'asset staging directory was not created' }",
                "try {",
                "  " + guard,
                "  throw 'reuse guard did not reject existing directory'",
                "} catch {",
                "  if ($_.Exception.Message -notmatch 'Refusing to reuse release staging directory') { throw }",
                "}",
                "Write-Output 'release-staging-verified'",
            ]
        ),
        encoding="utf-8",
    )
    result = subprocess.run(
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-File", str(fixture)],
        capture_output=True,
        text=True,
        timeout=20,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "release-staging-verified"


@pytest.mark.skipif(POWERSHELL is None, reason="PowerShell is unavailable")
def test_release_path_normalization_and_containment_run_in_native_powershell(tmp_path: Path):
    source = RELEASE_WORKFLOW.read_text(encoding="utf-8")
    one_backslash = "\\"
    two_backslashes = one_backslash * 2
    new_trim = "TrimEnd('" + one_backslash + "', '/')"
    old_trim = "TrimEnd('" + two_backslashes + "', '/')"
    new_containment = "$candidate.StartsWith($base + '" + one_backslash + "', [StringComparison]::OrdinalIgnoreCase)"
    old_containment = "$candidate.StartsWith($base + '" + two_backslashes + "', [StringComparison]::OrdinalIgnoreCase)"
    assert old_trim not in source
    assert old_containment not in source
    assert source.count(new_trim) == 4
    assert source.count(new_containment) == 1

    block_start = source.index("          function Get-FullPath {")
    block_end = source.index("          $repo = Get-FullPath", block_start)
    workflow_functions = textwrap.dedent(source[block_start:block_end]).rstrip()
    assert "function Get-FullPath {" in workflow_functions
    assert "function Assert-Contained {" in workflow_functions

    fixture = tmp_path / "release-path-fixture.ps1"
    fixture.write_text(
        "\n".join(
            [
                "$ErrorActionPreference = 'Stop'",
                workflow_functions,
                "$root = Join-Path $PSScriptRoot 'storage'",
                "$child = Join-Path $root 'runs\\one'",
                "$resolved = Assert-Contained $child $root 'normal child'",
                "if (-not $resolved.StartsWith((Get-FullPath $root) + '" + one_backslash + "', [StringComparison]::OrdinalIgnoreCase)) { throw 'normal child was not contained' }",
                "try { Assert-Contained (Join-Path (Split-Path -Parent $root) 'storage-other\\x') $root 'outside child' | Out-Null; throw 'outside path was accepted' }",
                "catch { if ($_.Exception.Message -notmatch 'escapes its admitted root') { throw } }",
                "Write-Output 'release-path-verified'",
            ]
        ),
        encoding="utf-8",
    )
    result = subprocess.run(
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-File", str(fixture)],
        capture_output=True,
        text=True,
        timeout=20,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "release-path-verified"


def test_builder_provenance_has_no_host_absolute_path_fields():
    source = BUILDER.read_text(encoding="utf-8")
    provenance_start = source.index("$provenance = [ordered]@{")
    provenance_end = source.index("Write-AtomicUtf8NoBom", provenance_start)
    provenance = source[provenance_start:provenance_end]
    assert "repo_root" not in provenance
    assert "storage_root" not in provenance
    assert "MsiPath" not in provenance
    assert "StageManifestPath" not in provenance
    assert "installer_tool_profile" in provenance


def test_builder_does_not_set_global_user_or_machine_environment():
    source = BUILDER.read_text(encoding="utf-8")
    forbidden = (
        "[EnvironmentVariableTarget]::User",
        "[EnvironmentVariableTarget]::Machine",
        ",'User'",
        ",'Machine'",
        ',"User"',
        ',"Machine"',
        "System=\"yes\"",
        "User=\"yes\"",
    )
    assert not any(token in source for token in forbidden)
    assert "'Process'" in source


def test_builder_freezes_authoring_inputs_and_restores_process_environment():
    source = BUILDER.read_text(encoding="utf-8")
    assert "Get-VerifiedFrozenSource" in source
    assert "-Root $authoringRoot -Label 'approved LicenseFile'" in source
    assert "Join-Path $authoringRoot 'scripts\\windows\\installer\\Fullmag.Bundle.wxs'" in source
    assert "Join-Path $authoringRoot 'scripts\\windows\\installer_env.ps1'" in source

    helper_start = source.index("function Resolve-InstallerToolLayoutReadOnly")
    helper_end = source.index("function Assert-StageManifest", helper_start)
    helper = source[helper_start:helper_end]
    assert "--format json" in helper
    assert "--create" not in helper
    assert "FULLMAG_STORAGE_MANAGED_ENTRY" in helper
    assert "FULLMAG_STORAGE_LOCK_TOKEN" in helper
    assert "$oldValues = @{}" in helper
    assert "finally" in helper
    assert "Set-Item -LiteralPath ('Env:' + $name) -Value $oldValues[$name]" in helper
    assert "FULLMAG_PROJECT_STORAGE_ROOT" in helper


@pytest.mark.skipif(POWERSHELL is None, reason="PowerShell is unavailable")
def test_readonly_tool_layout_restores_process_environment(tmp_path: Path):
    source = BUILDER.read_text(encoding="utf-8")
    helper_start = source.index("function Resolve-InstallerToolLayoutReadOnly")
    helper_end = source.index("function Assert-StageManifest", helper_start)
    helper = source[helper_start:helper_end]

    repo = tmp_path / "repo"
    (repo / "scripts").mkdir(parents=True)
    (repo / "scripts/fullmag_storage.py").write_text("# resolver fixture\n", encoding="utf-8")
    expected_storage = tmp_path / "expected-storage"
    layout = {
        "storage_root": str(expected_storage),
        "build_root": str(expected_storage / "builds"),
        "cache_root": str(expected_storage / "cache"),
        "temp_root": str(expected_storage / "tmp"),
        "runtime_root": str(expected_storage / "runtime"),
        "runs_root": str(expected_storage / "runs"),
        "profile": "windows-setup",
    }
    (tmp_path / "python.cmd").write_text(
        "@echo off\n" + "echo " + json.dumps(layout) + "\n", encoding="utf-8"
    )

    fixture = tmp_path / "readonly-layout-fixture.ps1"
    fixture.write_text(
        "\n".join(
            [
                "$ErrorActionPreference = 'Stop'",
                "function Assert-RegularFile { param([string]$Path,[string]$Label,[string]$Extension) return $Path }",
                "function Convert-ToFullmagAbsolutePath { param([string]$Path,[string]$Label) return [IO.Path]::GetFullPath($Path).TrimEnd('\\','/') }",
                "function Get-PythonExecutable { return (Join-Path $PSScriptRoot 'python.cmd') }",
                helper,
                "$repo = Join-Path $PSScriptRoot 'repo'",
                "$expected = Join-Path $PSScriptRoot 'expected-storage'",
                "$env:FULLMAG_PROJECT_STORAGE_ROOT = 'C:\\original-storage'",
                "$env:FULLMAG_STORAGE_MANAGED_ENTRY = 'sentinel-entry'",
                "$env:FULLMAG_STORAGE_PROFILE = 'sentinel-profile'",
                "$env:FULLMAG_STORAGE_LOCK_TOKEN = 'sentinel-token'",
                "$env:FULLMAG_STORAGE_LOCK_KEY = 'sentinel-key'",
                "$env:FULLMAG_BUILD_ROOT = 'C:\\sentinel-build'",
                "$layout = Resolve-InstallerToolLayoutReadOnly -RepoRoot $repo -Profile 'windows-setup' -ExpectedStorageRoot $expected",
                "if ($layout.profile -ne 'windows-setup') { throw 'layout profile was not returned' }",
                "if ($env:FULLMAG_PROJECT_STORAGE_ROOT -ne 'C:\\original-storage') { throw 'storage root was not restored' }",
                "if ($env:FULLMAG_STORAGE_MANAGED_ENTRY -ne 'sentinel-entry') { throw 'managed sentinel was not restored' }",
                "if ($env:FULLMAG_STORAGE_PROFILE -ne 'sentinel-profile') { throw 'profile was not restored' }",
                "if ($env:FULLMAG_STORAGE_LOCK_TOKEN -ne 'sentinel-token' -or $env:FULLMAG_STORAGE_LOCK_KEY -ne 'sentinel-key') { throw 'lock variables were not restored' }",
                "if ($env:FULLMAG_BUILD_ROOT -ne 'C:\\sentinel-build') { throw 'derived path was not restored' }",
                "Write-Output 'restored'",
            ]
        ),
        encoding="utf-8",
    )
    result = subprocess.run(
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-File", str(fixture)],
        capture_output=True,
        text=True,
        timeout=20,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "restored"


def test_bundle_variables_are_all_supplied_by_builder():
    bundle = BUNDLE.read_text(encoding="utf-8")
    variables = set(re.findall(r"\$\(var\.([A-Za-z0-9_]+)\)", bundle))
    builder = BUILDER.read_text(encoding="utf-8")
    supplied = {
        "SourceFirst", "ProductVersion", "BundleUpgradeCode", "MsiPath", "StageManifestPath",
        "BootstrapperApplicationDll", "LicenseFile", "LicenseFileName",
        "InstallerEnvModule", "SetupBuildEnvironmentScript", "BuildRequirementsManifest",
        "WixLicenseFile", "EnvironmentBootstrapExe", "FullmagSetupUiPayload", "InstallerProvenancePath",
    }
    assert variables == supplied
    for variable in supplied:
        assert f"-d{variable}=" in builder


@pytest.mark.skipif(POWERSHELL is None, reason="PowerShell is unavailable")
def test_builder_is_accepted_by_the_native_powershell_parser(tmp_path: Path):
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
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-File", str(probe), str(BUILDER)],
        capture_output=True,
        text=True,
        timeout=20,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "parsed"



@pytest.mark.skipif(POWERSHELL is None, reason="PowerShell is unavailable")
def test_builder_ancestor_walk_preserves_windows_volume_root(tmp_path: Path):
    source = BUILDER.read_text(encoding="utf-8")
    helpers = source[source.index("function Convert-ToFullmagAbsolutePath"):source.index("function Assert-Inside")]
    fixture = tmp_path / "ancestor-root.ps1"
    fixture.write_bytes(("$ErrorActionPreference = 'Stop'\n" + helpers + r"""
$volume = [IO.Path]::GetPathRoot($PSScriptRoot)
$normalized = Convert-ToFullmagAbsolutePath -Path $volume -Label 'volume'
if ($normalized -ne $volume) { throw 'volume root was made drive-relative' }
Assert-NoReparseAncestors -Path $volume -Label 'volume'
$nested = Join-Path $PSScriptRoot 'nested directory with spaces'
[IO.Directory]::CreateDirectory($nested) | Out-Null
$file = Join-Path $nested 'payload.txt'
[IO.File]::WriteAllText($file, 'payload')
$null = Assert-RegularFile -Path $file -Label 'payload'
Assert-NoReparseAncestors -Path (Join-Path $nested 'missing/child') -Label 'future payload'
$junction = Join-Path $PSScriptRoot 'junction'
New-Item -ItemType Junction -Path $junction -Target $nested | Out-Null
try {
  Assert-RegularFile -Path (Join-Path $junction 'payload.txt') -Label 'linked payload' | Out-Null
  throw 'junction ancestor was accepted'
} catch {
  if ($_.Exception.Message -notmatch 'reparse') { throw }
}
Write-Output 'ancestor-root-verified'
""").encode("utf-8"))
    result = subprocess.run(
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-File", str(fixture)],
        capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.strip() == "ancestor-root-verified"
