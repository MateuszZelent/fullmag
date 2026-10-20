[CmdletBinding()]
param(
  [Parameter()][string]$MsiPath,
  [Parameter()][string]$StageManifestPath,
  [Parameter()][string]$MsiSha256,
  [Parameter()][string]$StageManifestSha256,
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$LicenseFile,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$LicenseFileSha256,
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$NoticeFile,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$NoticeFileSha256,
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$BootstrapperApplicationDll,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$BootstrapperApplicationSha256,
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$SetupBuildEnvironmentScript,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$SetupBuildEnvironmentScriptSha256,
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$BuildRequirementsManifest,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$BuildRequirementsManifestSha256,
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$InstallerBuildRequirementsManifest,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$InstallerBuildRequirementsManifestSha256,
  [Parameter()][string]$CompilerInputMirrorRecord,
  [Parameter()][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$CompilerInputMirrorSha256,
  [Parameter()][string]$SetupUiProjectPath,
  [Parameter(Mandatory = $true)][guid]$BundleUpgradeCode,
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$WixRoot,
  [Parameter()][ValidateSet('release', 'source-first')][string]$Route = 'release',
  [Parameter()][string]$EnvironmentBootstrapExe,
  [Parameter()][string]$EnvironmentBootstrapSha256,
  [Parameter()][string]$EnvironmentBootstrapVersion,
  [Parameter()][ValidateSet('setup-only', 'initial-build')][string]$BootstrapMode = 'initial-build',
  [Parameter()][string]$ProductVersion,
  [Parameter()][string]$SourceCommit,
  [Parameter()][string]$SourceSnapshotSha256,
  [Parameter()][bool]$SourceSnapshotDirty = $false,
  [Parameter()][string]$FrozenSourceRecord,
  [Parameter()][string]$OutputPath,
  [Parameter()][string]$RepoRoot,
  [Parameter()][ValidateSet('windows-native-fdm-cpu', 'windows-native-fem-cpu', 'windows-native-fem-gpu', 'windows-installer-source')][string]$StorageProfile = 'windows-native-fdm-cpu',
  [Parameter()][ValidateSet('windows-setup')][string]$InstallerStorageProfile = 'windows-setup'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Public installers use the source-first all-backends preparation route.
# A legacy MSI stage manifest has no four-component capability proofs.
if ($Route -ne 'source-first') {
  throw 'The legacy MSI Burn route has no all-backends capability package. Use build_installer_from_source.ps1 or just windows-installer-build.'
}

function Convert-ToFullmagAbsolutePath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if ([string]::IsNullOrWhiteSpace($Path)) {
    throw "$Label must not be empty"
  }
  if (-not [System.IO.Path]::IsPathRooted($Path)) {
    throw "$Label must be an absolute path: $Path"
  }
  if ($Path -match '(^|[\\/])\.\.([\\/]|$)') {
    throw "$Label must not contain parent traversal: $Path"
  }
  try {
    $full = [System.IO.Path]::GetFullPath($Path)
    $root = [System.IO.Path]::GetPathRoot($full)
    if ($full -eq $root) { return $root }
    return $full.TrimEnd('\', '/')
  }
  catch {
    throw "$Label is not a valid path: $Path"
  }
}

function Test-ReparseItem {
  param([Parameter(Mandatory = $true)]$Item)
  if (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    return $true
  }
  return ($Item.PSObject.Properties.Name -contains 'LinkType' -and
    -not [string]::IsNullOrWhiteSpace([string]$Item.LinkType))
}

function Assert-NoReparseAncestors {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $probe = $Path
  while ($true) {
    if (Test-Path -LiteralPath $probe) {
      $item = Get-Item -LiteralPath $probe -Force
      if (Test-ReparseItem -Item $item) {
        throw "$Label traverses a symlink or reparse point: $probe"
      }
    }
    # DirectoryInfo preserves drive and UNC roots; trimming C:\ to C:
    # makes Split-Path resolve an invalid drive-relative ancestor in PS 5.1.
    $parent = [System.IO.Directory]::GetParent($probe)
    if ($null -eq $parent) { break }
    $probe = $parent.FullName
  }
}

function Assert-RegularFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter()][string]$Extension
  )
  $full = Convert-ToFullmagAbsolutePath -Path $Path -Label $Label
  if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
    throw "$Label is missing or is not a regular file: $full"
  }
  $item = Get-Item -LiteralPath $full -Force
  if (Test-ReparseItem -Item $item) {
    throw "$Label must not be a symlink or reparse point: $full"
  }
  Assert-NoReparseAncestors -Path $full -Label $Label
  if ($item.Length -le 0) {
    throw "$Label must be nonempty: $full"
  }
  if ($Extension -and $item.Extension -ine $Extension) {
    throw "$Label must use the $Extension extension: $full"
  }
  return $item.FullName
}

function Assert-BoundedBurnPeImage {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $full = Assert-RegularFile -Path $Path -Label $Label -Extension '.exe'
  $stream = $null
  $reader = $null
  try {
    $stream = [IO.File]::Open(
      $full,
      [IO.FileMode]::Open,
      [IO.FileAccess]::Read,
      [IO.FileShare]::Read)
    if ($stream.Length -lt 64) {
      throw "$Label is too short to contain a DOS header"
    }
    $reader = New-Object IO.BinaryReader($stream)
    $dosHeader = $reader.ReadBytes(64)
    if ($dosHeader.Length -ne 64 -or $dosHeader[0] -ne 0x4d -or $dosHeader[1] -ne 0x5a) {
      throw "$Label does not have an MZ DOS header"
    }
    $peOffset = [BitConverter]::ToInt32($dosHeader, 0x3c)
    if ($peOffset -lt 64 -or [int64]$peOffset -gt $stream.Length - 24) {
      throw "$Label has an out-of-bounds PE header offset"
    }
    $stream.Position = $peOffset
    $signature = $reader.ReadBytes(4)
    if ($signature.Length -ne 4 -or $signature[0] -ne 0x50 -or
        $signature[1] -ne 0x45 -or $signature[2] -ne 0 -or $signature[3] -ne 0) {
      throw "$Label does not have a bounded PE signature"
    }
    if ($stream.Length - [int64]$stream.Position -lt 20) {
      throw "$Label is truncated before the COFF header"
    }
    $machine = $reader.ReadUInt16()
    $sectionCount = $reader.ReadUInt16()
    $null = $reader.ReadUInt32()
    $null = $reader.ReadUInt32()
    $null = $reader.ReadUInt32()
    $optionalSize = $reader.ReadUInt16()
    $characteristics = $reader.ReadUInt16()
    if ($sectionCount -eq 0 -or $optionalSize -lt 70) {
      throw "$Label has an invalid section or optional-header size"
    }
    $optionalEnd = [int64]$stream.Position + [int64]$optionalSize
    if ($optionalEnd -gt $stream.Length) {
      throw "$Label is truncated before the optional header ends"
    }
    $optionalHeader = $reader.ReadBytes($optionalSize)
    if ($optionalHeader.Length -ne $optionalSize) {
      throw "$Label has a truncated optional header"
    }
    $optionalMagic = [BitConverter]::ToUInt16($optionalHeader, 0)
    $subsystem = [BitConverter]::ToUInt16($optionalHeader, 68)
    if ($machine -ne 0x014c -or $optionalMagic -ne 0x010b -or $subsystem -ne 2) {
      throw "$Label is not the expected x86 PE32 GUI executable"
    }
    if (($characteristics -band 0x0002) -eq 0 -or ($characteristics -band 0x2000) -ne 0) {
      throw "$Label is not an executable image or is marked as a DLL"
    }
    $sectionTableEnd = [int64]$stream.Position + ([int64]$sectionCount * 40)
    if ($sectionTableEnd -gt $stream.Length) {
      throw "$Label has a section table outside the file bounds"
    }
    $hasWixBurnSection = $false
    for ($index = 0; $index -lt $sectionCount; $index++) {
      $section = $reader.ReadBytes(40)
      if ($section.Length -ne 40) {
        throw "$Label has a truncated section table"
      }
      $sectionName = [Text.Encoding]::ASCII.GetString($section, 0, 8).Trim([char]0)
      $rawSize = [BitConverter]::ToUInt32($section, 16)
      $rawOffset = [BitConverter]::ToUInt32($section, 20)
      if ([int64]$rawOffset -gt $stream.Length -or
          [int64]$rawSize -gt ($stream.Length - [int64]$rawOffset)) {
        throw "$Label has a section outside the file bounds"
      }
      if ([string]::Equals($sectionName, '.wixburn', [StringComparison]::OrdinalIgnoreCase)) {
        $hasWixBurnSection = $true
      }
    }
    if (-not $hasWixBurnSection) {
      throw "$Label does not contain the expected WiX Burn section"
    }
    return [ordered]@{
      format = 'PE'
      machine = 'x86'
      optional_header = 'PE32'
      subsystem = 'GUI'
      executable_image = $true
      dll = $false
      required_section = '.wixburn'
      section_count = [int]$sectionCount
      file_size_bytes = [int64]$stream.Length
      e_lfanew = [int64]$peOffset
    }
  }
  finally {
    if ($null -ne $reader) { $reader.Dispose() }
    elseif ($null -ne $stream) { $stream.Dispose() }
  }
}

function Assert-Directory {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $full = Convert-ToFullmagAbsolutePath -Path $Path -Label $Label
  if (-not (Test-Path -LiteralPath $full -PathType Container)) {
    throw "$Label is missing: $full"
  }
  Assert-NoReparseAncestors -Path $full -Label $Label
  return $full
}

function Assert-Inside {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $candidate = Convert-ToFullmagAbsolutePath -Path $Path -Label $Label
  $base = Convert-ToFullmagAbsolutePath -Path $Root -Label "$Label root"
  if (-not ([string]::Equals($candidate, $base, [System.StringComparison]::OrdinalIgnoreCase) -or
      $candidate.StartsWith($base + '\', [System.StringComparison]::OrdinalIgnoreCase))) {
    throw "${Label} must remain inside ${base}: $candidate"
  }
  return $candidate
}

function Get-Sha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-Sha512 {
  param([Parameter(Mandatory = $true)][string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA512).Hash.ToLowerInvariant()
}

function Get-Sha512Base64 {
  param([Parameter(Mandatory = $true)][string]$Path)
  $sha = [Security.Cryptography.SHA512]::Create()
  $stream = $null
  try {
    $stream = [IO.File]::OpenRead($Path)
    return [Convert]::ToBase64String($sha.ComputeHash($stream))
  }
  finally {
    if ($null -ne $stream) { $stream.Dispose() }
    $sha.Dispose()
  }
}

function Get-TextSha256 {
  param([Parameter(Mandatory = $true)][string]$Text)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Text)
    return (([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant())
  }
  finally { $sha.Dispose() }
}

function Convert-DotnetTreeEntriesToJson {
  param([Parameter()][object[]]$Entries = @())
  $normalized = New-Object System.Collections.Generic.List[object]
  $seen = @{}
  foreach ($entry in @($Entries)) {
    $relative = ([string]$entry.path).Replace('\', '/')
    $kind = [string]$entry.kind
    if ([string]::IsNullOrWhiteSpace($relative) -or
        $relative -match '(^/|/$|(^|/)\.\.(/|$)|^[A-Za-z]:|//)' -or
        $kind -notin @('file', 'directory')) {
      throw 'Managed .NET SDK extracted-tree manifest contains an unsafe entry'
    }
    if ($seen.ContainsKey($relative)) {
      throw "Managed .NET SDK extracted-tree manifest repeats: $relative"
    }
    $seen[$relative] = $true
    if ($kind -eq 'directory') {
      if ([int64]$entry.size_bytes -ne 0 -or -not [string]::IsNullOrEmpty([string]$entry.sha256)) {
        throw "Managed .NET SDK extracted-tree directory entry is malformed: $relative"
      }
      [void]$normalized.Add([ordered]@{ path = $relative; kind = 'directory'; size_bytes = [int64]0; sha256 = '' })
      continue
    }
    $sha256 = ([string]$entry.sha256).ToLowerInvariant()
    if ([int64]$entry.size_bytes -lt 0 -or $sha256 -notmatch '^[0-9a-f]{64}$') {
      throw "Managed .NET SDK extracted-tree file entry is malformed: $relative"
    }
    [void]$normalized.Add([ordered]@{ path = $relative; kind = 'file'; size_bytes = [int64]$entry.size_bytes; sha256 = $sha256 })
  }
  $sorted = @($normalized.ToArray() | Sort-Object { [string]$_.path })
  $json = ConvertTo-Json -InputObject ([array]$sorted) -Depth 10 -Compress
  return [pscustomobject]@{
    entries = $sorted
    canonical_json = $json
    inventory_sha256 = Get-TextSha256 -Text $json
    file_count = @($sorted | Where-Object { $_.kind -eq 'file' }).Count
    directory_count = @($sorted | Where-Object { $_.kind -eq 'directory' }).Count
  }
}

function Get-DotnetTreeInventory {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter()][string[]]$MetadataNames = @()
  )
  $rootFull = Assert-Directory -Path $Root -Label 'managed .NET SDK tree root'
  $metadata = @{}
  foreach ($name in @($MetadataNames)) {
    if ([string]::IsNullOrWhiteSpace($name) -or $name -match '[\\/]') {
      throw 'Managed .NET SDK tree metadata name must be a root-level filename'
    }
    $metadata[$name] = $true
  }
  $prefix = $rootFull.TrimEnd('\', '/') + '\'
  $entries = New-Object System.Collections.Generic.List[object]
  foreach ($item in @(Get-ChildItem -LiteralPath $rootFull -Force -Recurse -ErrorAction Stop)) {
    if (Test-ReparseItem -Item $item) {
      throw "Managed .NET SDK tree contains a symlink or reparse point: $($item.FullName)"
    }
    $relative = $item.FullName.Substring($prefix.Length).Replace('\', '/')
    if ([string]::IsNullOrWhiteSpace($relative) -or
        $relative -match '(^/|/$|(^|/)\.\.(/|$)|^[A-Za-z]:|//)') {
      throw "Managed .NET SDK tree contains an unsafe relative path: $relative"
    }
    if ([string]::Equals($relative, 'metadata', [StringComparison]::OrdinalIgnoreCase)) {
      if (-not $item.PSIsContainer) {
        throw 'Managed .NET SDK tree metadata state must be an empty root-level directory'
      }
      $metadataChildren = @(Get-ChildItem -LiteralPath $item.FullName -Force -ErrorAction Stop)
      if ($metadataChildren.Count -ne 0) {
        throw 'Managed .NET SDK tree metadata state must remain an empty root-level directory'
      }
      # .NET may create this empty root-level state directory during first use;
      # it is not part of the immutable SDK archive inventory.
      continue
    }
    if ($relative -notmatch '/' -and $metadata.ContainsKey($relative)) { continue }
    if ($item.PSIsContainer) {
      [void]$entries.Add([ordered]@{ path = $relative; kind = 'directory'; size_bytes = [int64]0; sha256 = '' })
    } else {
      [void]$entries.Add([ordered]@{ path = $relative; kind = 'file'; size_bytes = [int64]$item.Length; sha256 = Get-Sha256 -Path $item.FullName })
    }
  }
  return Convert-DotnetTreeEntriesToJson -Entries $entries.ToArray()
}

function Assert-DotnetTreeManifest {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)]$Tool,
    [Parameter(Mandatory = $true)]$Receipt,
    [Parameter(Mandatory = $true)][string]$ExpectedArchiveSha512
  )
  $treeName = [string]$Tool.tree_manifest_name
  if ([string]::IsNullOrWhiteSpace($treeName) -or $treeName -match '[\\/]') {
    throw 'Managed .NET SDK manifest does not define a safe extracted-tree receipt name'
  }
  $treePath = Assert-RegularFile -Path (Join-Path $Root $treeName) -Label 'managed .NET SDK extracted-tree receipt' -Extension '.json'
  $treeHash = Get-Sha256 -Path $treePath
  if (([string]$Receipt.tree_manifest_name) -cne $treeName -or
      ([string]$Receipt.tree_manifest_sha256).ToLowerInvariant() -ne $treeHash) {
    throw 'Managed .NET SDK receipt does not bind the extracted-tree receipt'
  }
  $tree = Read-JsonFile -Path $treePath -Label 'managed .NET SDK extracted-tree receipt'
  if ([string]$tree.schema -ne 'fullmag.windows-installer-dotnet-sdk-tree.v1' -or
      ([string]$tree.archive_sha512).ToLowerInvariant() -ne $ExpectedArchiveSha512 -or
      $null -eq $tree.inventory) {
    throw 'Managed .NET SDK extracted-tree receipt does not match the pinned archive'
  }
  $expected = Convert-DotnetTreeEntriesToJson -Entries @($tree.inventory)
  if (([string]$tree.inventory_sha256).ToLowerInvariant() -ne $expected.inventory_sha256 -or
      [int64]$tree.file_count -ne [int64]$expected.file_count -or
      [int64]$tree.directory_count -ne [int64]$expected.directory_count) {
    throw 'Managed .NET SDK extracted-tree receipt inventory is internally inconsistent'
  }
  $actual = Get-DotnetTreeInventory -Root $Root -MetadataNames @([string]$Tool.archive_receipt, [string]$Tool.receipt_name, $treeName)
  if ($actual.inventory_sha256 -ne $expected.inventory_sha256 -or
      $actual.canonical_json -cne $expected.canonical_json) {
    throw 'Managed .NET SDK extracted tree differs from its immutable receipt'
  }
  if (([string]$Receipt.tree_inventory_sha256).ToLowerInvariant() -ne $actual.inventory_sha256 -or
      [int64]$Receipt.tree_file_count -ne [int64]$actual.file_count -or
      [int64]$Receipt.tree_directory_count -ne [int64]$actual.directory_count) {
    throw 'Managed .NET SDK receipt tree counts or inventory hash do not match the extracted tree'
  }
  return [pscustomobject]@{
    manifest = $treePath
    manifest_sha256 = $treeHash
    inventory_sha256 = $actual.inventory_sha256
    file_count = $actual.file_count
    directory_count = $actual.directory_count
  }
}

function Assert-VerifiedDotnetSdk {
  param(
    [Parameter(Mandatory = $true)]$Tool,
    [Parameter(Mandatory = $true)]$StorageLayout,
    [Parameter(Mandatory = $true)][string]$Root
  )
  $expectedHash = ([string]$Tool.sha512).ToLowerInvariant()
  if ($expectedHash -notmatch '^[0-9a-f]{128}$') {
    throw 'Managed .NET SDK manifest SHA-512 is invalid'
  }
  $rootFull = Convert-ToFullmagAbsolutePath -Path $Root -Label 'managed .NET SDK root'
  $expectedRoot = Convert-ToFullmagAbsolutePath -Path ([string]$Tool.storage_path.Replace('{build_root}', [string]$StorageLayout.build_root)) -Label 'expected managed .NET SDK root'
  if (-not [string]::Equals($rootFull, $expectedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Managed .NET SDK root is outside the resolver-owned path: $expectedRoot"
  }
  $rootFull = Assert-Directory -Path $rootFull -Label 'verified managed .NET SDK root'
  $receiptPath = Assert-RegularFile -Path (Join-Path $rootFull ([string]$Tool.receipt_name)) -Label 'managed .NET SDK receipt' -Extension '.json'
  $receipt = Read-JsonFile -Path $receiptPath -Label 'managed .NET SDK receipt'
  if ([string]$receipt.schema -ne 'fullmag.windows-installer-dotnet-sdk-receipt.v1' -or
      [string]$receipt.version -ne [string]$Tool.version -or
      [string]$receipt.url -ne [string]$Tool.url -or
      ([string]$receipt.archive_sha512).ToLowerInvariant() -ne $expectedHash -or
      [string]$receipt.command -ne [string]$Tool.command -or
      [string]$receipt.runtime_identifier -ne [string]$Tool.runtime_identifier -or
      -not [string]::Equals([string]$receipt.tool_root, $rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Managed .NET SDK receipt does not match the pinned requirements'
  }
  $archive = Assert-RegularFile -Path (Join-Path $rootFull ([string]$Tool.archive_receipt)) -Label 'managed .NET SDK source archive' -Extension '.zip'
  $null = Assert-NoReparseAncestors -Path $archive -Label 'managed .NET SDK source archive'
  if ((Get-Sha512 -Path $archive) -ne $expectedHash) {
    throw 'Managed .NET SDK source archive SHA-512 does not match the pinned requirements'
  }
  $tree = Assert-DotnetTreeManifest -Root $rootFull -Tool $Tool -Receipt $receipt -ExpectedArchiveSha512 $expectedHash
  $dotnet = Assert-RegularFile -Path (Join-Path $rootFull ([string]$Tool.command)) -Label 'managed .NET SDK executable' -Extension '.exe'
  $sdk = Assert-Directory -Path (Join-Path $rootFull ("sdk\" + [string]$Tool.version)) -Label 'managed .NET SDK version directory'
  $oldRoot = [Environment]::GetEnvironmentVariable('DOTNET_ROOT', 'Process')
  $oldPath = [Environment]::GetEnvironmentVariable('PATH', 'Process')
  try {
    [Environment]::SetEnvironmentVariable('DOTNET_ROOT', $rootFull, 'Process')
    [Environment]::SetEnvironmentVariable('PATH', $rootFull + [IO.Path]::PathSeparator + [string]$oldPath, 'Process')
    $previous = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      $versionOutput = (& $dotnet '--version' 2>&1 | Out-String).Trim()
      $versionExitCode = $LASTEXITCODE
    }
    finally {
      $ErrorActionPreference = $previous
    }
  }
  finally {
    if ($null -eq $oldRoot) { Remove-Item -LiteralPath 'Env:DOTNET_ROOT' -ErrorAction SilentlyContinue } else { Set-Item -LiteralPath 'Env:DOTNET_ROOT' -Value $oldRoot }
    if ($null -eq $oldPath) { Remove-Item -LiteralPath 'Env:PATH' -ErrorAction SilentlyContinue } else { Set-Item -LiteralPath 'Env:PATH' -Value $oldPath }
  }
  if ($versionExitCode -ne 0 -or $versionOutput -notmatch "(?m)^\s*$([regex]::Escape([string]$Tool.version))\s*$") {
    throw "Managed .NET SDK reported an unexpected version: $versionOutput"
  }
  return [pscustomobject]@{
    root = $rootFull
    dotnet = $dotnet
    sdk = $sdk
    version = [string]$Tool.version
    archive_sha512 = $expectedHash
    tree_manifest_sha256 = [string]$tree.manifest_sha256
    tree_inventory_sha256 = [string]$tree.inventory_sha256
    tree_file_count = [int64]$tree.file_count
    tree_directory_count = [int64]$tree.directory_count
    receipt = $receiptPath
  }
}

function Assert-SetupUiProject {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectPath,
    [Parameter(Mandatory = $true)]$Gui,
    [Parameter(Mandatory = $true)]$Nuget
  )
  $source = [IO.File]::ReadAllText($ProjectPath)
  $assemblyName = [regex]::Escape([string]$Gui.assembly_name)
  $assemblyPattern = '<AssemblyName>\s*' + $assemblyName + '\s*</AssemblyName>'
  if ($source -notmatch $assemblyPattern) {
    throw "Avalonia UI project assembly does not match the producer manifest: $($Gui.assembly_name)"
  }
  $globalJsonPath = Join-Path (Split-Path -Parent $ProjectPath) 'global.json'
  $globalJson = Read-JsonFile -Path $globalJsonPath -Label 'Avalonia UI SDK policy'
  if ([string]$globalJson.sdk.version -ne [string]$Gui.sdk_version -or
      [string]$globalJson.sdk.rollForward -ne 'disable' -or
      $globalJson.sdk.allowPrerelease -isnot [bool] -or [bool]$globalJson.sdk.allowPrerelease) {
    throw 'Avalonia UI global.json must pin the producer SDK without roll-forward or prerelease use'
  }
  $target = [regex]::Escape([string]$Gui.target_framework)
  if ($source -notmatch "<TargetFramework>\s*$target\s*</TargetFramework>") {
    throw "Avalonia UI project target framework does not match the producer manifest: $($Gui.target_framework)"
  }
  if ($source -notmatch '<RuntimeIdentifier>\s*win-x64\s*</RuntimeIdentifier>' -or
      $source -notmatch '<SelfContained>\s*true\s*</SelfContained>' -or
      $source -notmatch '<PublishSingleFile>\s*true\s*</PublishSingleFile>') {
    throw 'Avalonia UI project must declare self-contained win-x64 single-file publishing'
  }
  foreach ($package in @($Nuget.direct_packages)) {
    $packageId = [string]$package.id
    $packageVersion = [string]$package.version
    if ($packageId -notmatch '^[A-Za-z0-9_.-]+$' -or $packageVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') {
      throw 'NuGet direct package manifest contains an invalid package identity'
    }
    $escaped = [regex]::Escape($packageId)
    $version = [regex]::Escape($packageVersion)
    $pattern = '<PackageReference\s+Include="' + $escaped + '"\s+Version="' + $version + '"\s*/>'
    if ($source -notmatch $pattern) {
      throw "Avalonia UI project package $packageId is not pinned to $packageVersion"
    }
  }
}

function Get-SdkRuntimePackInventory {
  param(
    [Parameter(Mandatory = $true)]$Assets,
    [Parameter(Mandatory = $true)]$Gui,
    [Parameter(Mandatory = $true)]$Nuget,
    [Parameter(Mandatory = $true)]$Dotnet,
    [Parameter(Mandatory = $true)][string]$NugetRoot
  )
  $policy = $Nuget.runtime_pack_inventory
  if ($null -eq $policy -or
      [string]$policy.schema -ne 'fullmag.windows-installer-runtime-pack-provenance.v1' -or
      [string]$policy.source -ne 'sdk-download-dependencies' -or
      [string]$policy.target_framework -ne [string]$Gui.target_framework -or
      [string]$policy.runtime_identifier -ne [string]$Gui.runtime_identifier -or
      [string]$policy.sdk_version -ne [string]$Dotnet.version) {
    throw 'NuGet producer manifest has no matching SDK runtime-pack provenance contract'
  }
  $runtimeIdentifier = [string]$policy.runtime_identifier
  $targetFramework = [string]$policy.target_framework
  $sdkVersion = [string]$policy.sdk_version
  $propsRelative = ([string]$policy.bundled_versions_props_relative_path).Replace('/', '\')
  if ([string]::IsNullOrWhiteSpace($propsRelative) -or
      [IO.Path]::IsPathRooted($propsRelative) -or
      $propsRelative -match '(^|[\\])\.\.([\\]|$)' -or
      $propsRelative -notmatch ('^sdk[\\]' + [regex]::Escape($sdkVersion) + '[\\]Microsoft\.NETCoreSdk\.BundledVersions\.props$')) {
    throw 'SDK BundledVersions.props path is not a safe versioned SDK-relative path'
  }
  if ([string]$policy.bundled_versions_props_sha256 -notmatch '^[0-9a-fA-F]{64}$') {
    throw 'SDK BundledVersions.props SHA-256 is invalid'
  }
  $propsPath = Assert-Inside -Path (Join-Path ([string]$Dotnet.root) $propsRelative) -Root ([string]$Dotnet.root) -Label 'SDK BundledVersions.props'
  $propsPath = Assert-RegularFile -Path $propsPath -Label 'SDK BundledVersions.props' -Extension '.props'
  $propsSha256 = Get-Sha256 -Path $propsPath
  if (-not [string]::Equals($propsSha256, ([string]$policy.bundled_versions_props_sha256).ToLowerInvariant(), [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'SDK BundledVersions.props SHA-256 does not match the producer manifest'
  }
  try {
    [xml]$bundledVersions = [IO.File]::ReadAllText($propsPath)
  }
  catch {
    throw 'SDK BundledVersions.props is not valid XML'
  }

  $expectedPackages = @($policy.packages)
  if ($expectedPackages.Count -ne 3) {
    throw 'SDK runtime-pack provenance must contain exactly three explicit packages'
  }
  $expectedById = @{}
  foreach ($package in $expectedPackages) {
    $packageId = [string]$package.id
    $packageVersion = [string]$package.version
    if ($packageId -notmatch '^[A-Za-z0-9_.-]+\.Runtime\.' + [regex]::Escape($runtimeIdentifier) + '$' -or
        $packageVersion -notmatch '^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.-]+)?$' -or
        $expectedById.ContainsKey($packageId.ToLowerInvariant())) {
      throw 'SDK runtime-pack provenance contains an invalid or duplicate package identity'
    }
    $expectedById[$packageId.ToLowerInvariant()] = [pscustomobject]@{ id = $packageId; version = $packageVersion }
  }

  $frameworkProperty = $null
  if ($null -ne $Assets.project -and $null -ne $Assets.project.frameworks) {
    $frameworkProperty = $Assets.project.frameworks.PSObject.Properties[[string]$targetFramework]
  }
  if ($null -eq $frameworkProperty -or $null -eq $frameworkProperty.Value.downloadDependencies) {
    throw "NuGet assets file has no SDK downloadDependencies for $targetFramework"
  }
  $downloadDependencies = @($frameworkProperty.Value.downloadDependencies)
  if ($downloadDependencies.Count -ne $expectedById.Count) {
    throw 'NuGet SDK downloadDependencies count does not match the explicit runtime-pack contract'
  }
  $downloadsById = @{}
  foreach ($dependency in $downloadDependencies) {
    $dependencyId = [string]$dependency.name
    $dependencyRange = [string]$dependency.version
    $key = $dependencyId.ToLowerInvariant()
    if (-not $expectedById.ContainsKey($key) -or $downloadsById.ContainsKey($key)) {
      throw "NuGet SDK downloadDependencies contains an unadmitted or duplicate runtime pack: $dependencyId"
    }
    $expectedVersion = [string]$expectedById[$key].version
    if ($dependencyRange -cne ('[' + $expectedVersion + ', ' + $expectedVersion + ']')) {
      throw "NuGet SDK runtime-pack range is not exact for $dependencyId"
    }
    $downloadsById[$key] = $true
  }
  foreach ($key in $expectedById.Keys) {
    if (-not $downloadsById.ContainsKey($key)) {
      throw "NuGet SDK downloadDependencies is missing runtime pack: $($expectedById[$key].id)"
    }
  }

  $frameworkNodes = @()
  foreach ($itemGroup in @($bundledVersions.Project.ItemGroup)) {
    foreach ($node in @($itemGroup.KnownFrameworkReference)) {
      if ([string]$node.TargetFramework -eq $targetFramework) {
        $frameworkNodes += $node
      }
    }
  }
  $inventory = @()
  foreach ($expected in @($expectedById.Values | Sort-Object -Property id)) {
    $packageId = [string]$expected.id
    $packageVersion = [string]$expected.version
    $suffix = '.Runtime.' + $runtimeIdentifier
    $frameworkName = $packageId.Substring(0, $packageId.Length - $suffix.Length)
    $matchingNodes = @($frameworkNodes | Where-Object {
        [string]$_.Include -eq $frameworkName -and
        [string]$_.LatestRuntimeFrameworkVersion -eq $packageVersion -and
        [string]$_.TargetingPackVersion -eq $packageVersion -and
        [string]$_.RuntimePackNamePatterns.Replace('**RID**', $runtimeIdentifier) -eq $packageId -and
        @(([string]$_.RuntimePackRuntimeIdentifiers).Split(';') | Where-Object {
            [string]::Equals([string]$_, $runtimeIdentifier, [System.StringComparison]::OrdinalIgnoreCase)
          }).Count -eq 1
      })
    if ($matchingNodes.Count -eq 0) {
      throw "SDK BundledVersions.props does not authorize runtime pack $packageId $packageVersion for $runtimeIdentifier"
    }

    $packageRoot = Assert-Inside -Path (Join-Path $NugetRoot ($packageId.ToLowerInvariant() + '\' + $packageVersion.ToLowerInvariant())) -Root $NugetRoot -Label "SDK runtime-pack cache entry $packageId"
    $packageRoot = Assert-Directory -Path $packageRoot -Label "SDK runtime-pack cache entry $packageId"
    $archiveCandidates = @(Get-ChildItem -LiteralPath $packageRoot -File -Force | Where-Object {
        [string]::Equals($_.Name, ($packageId + '.' + $packageVersion + '.nupkg'), [System.StringComparison]::OrdinalIgnoreCase)
      })
    if ($archiveCandidates.Count -ne 1) {
      throw "SDK runtime-pack archive is missing or ambiguous: $packageId/$packageVersion"
    }
    $archive = Assert-RegularFile -Path $archiveCandidates[0].FullName -Label "SDK runtime-pack archive $packageId" -Extension '.nupkg'
    $archiveHashPath = Assert-RegularFile -Path ($archive + '.sha512') -Label "SDK runtime-pack archive hash $packageId" -Extension '.sha512'
    $archiveHashBase64 = ([IO.File]::ReadAllText($archiveHashPath)).Trim()
    try { [Convert]::FromBase64String($archiveHashBase64) | Out-Null } catch { throw "SDK runtime-pack archive hash is not base64: $packageId" }
    $computedArchiveHashBase64 = Get-Sha512Base64 -Path $archive
    if ($archiveHashBase64 -ne $computedArchiveHashBase64) {
      throw "SDK runtime-pack archive hash file does not match the package bytes: $packageId"
    }
    $metadataPath = Assert-RegularFile -Path (Join-Path $packageRoot '.nupkg.metadata') -Label "SDK runtime-pack metadata $packageId" -Extension '.metadata'
    $metadata = Read-JsonFile -Path $metadataPath -Label "SDK runtime-pack metadata $packageId"
    if ([int]$metadata.version -ne 2 -or
        [string]$metadata.source -ne [string]$Nuget.source -or
        [string]$metadata.version -eq '' -or
        [string]::IsNullOrWhiteSpace([string]$metadata.contentHash)) {
      throw "SDK runtime-pack metadata is incomplete or uses an unapproved source: $packageId"
    }
    try { [Convert]::FromBase64String([string]$metadata.contentHash) | Out-Null } catch { throw "SDK runtime-pack metadata hash is not base64: $packageId" }
    $cachePrefix = $NugetRoot.TrimEnd('\', '/') + '\'
    $relativeCachePath = $packageRoot.Substring($cachePrefix.Length).Replace('\', '/')
    $inventory += [ordered]@{
      id = $packageId
      version = $packageVersion
      target_framework = $targetFramework
      runtime_identifier = $runtimeIdentifier
      source = [string]$metadata.source
      content_hash = [string]$metadata.contentHash
      nupkg_sha512_base64 = $computedArchiveHashBase64
      nupkg_sha512 = Get-Sha512 -Path $archive
      nupkg_sha256 = Get-Sha256 -Path $archive
      size_bytes = [int64](Get-Item -LiteralPath $archive -Force).Length
      relative_cache_path = $relativeCachePath
    }
  }
  return [pscustomobject]@{
    schema = [string]$policy.schema
    source = [string]$policy.source
    target_framework = $targetFramework
    runtime_identifier = $runtimeIdentifier
    sdk_version = $sdkVersion
    sdk_archive_sha512 = [string]$Dotnet.archive_sha512
    sdk_tree_manifest_sha256 = [string]$Dotnet.tree_manifest_sha256
    sdk_tree_inventory_sha256 = [string]$Dotnet.tree_inventory_sha256
    bundled_versions_props_relative_path = $propsRelative.Replace('\', '/')
    bundled_versions_props_sha256 = $propsSha256
    runtime_pack_inventory = @($inventory)
  }
}

function Get-NugetRestoreProvenance {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectPath,
    [Parameter(Mandatory = $true)]$Gui,
    [Parameter(Mandatory = $true)]$Nuget,
    [Parameter(Mandatory = $true)][string]$NugetRoot,
    [Parameter(Mandatory = $true)]$Dotnet
  )
  if ([string]$Nuget.schema -ne 'fullmag.windows-installer-nuget-provenance.v1' -or
      [string]$Nuget.lock_mode -ne 'locked' -or
      [string]$Nuget.source -notmatch '^https://api\.nuget\.org/v3/index\.json$') {
    throw 'NuGet producer manifest does not define the admitted official source and lock policy'
  }
  $projectFull = Assert-RegularFile -Path $ProjectPath -Label 'Avalonia UI project' -Extension '.csproj'
  $projectRoot = Convert-ToFullmagAbsolutePath -Path (Split-Path -Parent $projectFull) -Label 'Avalonia UI project root'
  $assetsRelative = ([string]$Nuget.assets_relative_path).Replace('\\', '/')
  $lockRelative = ([string]$Nuget.lock_relative_path).Replace('\\', '/')
  foreach ($artifact in @(@{ name = 'assets'; relative = $assetsRelative }, @{ name = 'lock'; relative = $lockRelative })) {
    if ([string]::IsNullOrWhiteSpace([string]$artifact.relative) -or
        [System.IO.Path]::IsPathRooted([string]$artifact.relative) -or
        [string]$artifact.relative -match '(^|/)\.\.(/|$)') {
      throw "NuGet $($artifact.name) path is not a safe project-relative path"
    }
  }
  $assetsPath = Assert-Inside -Path (Join-Path $projectRoot ($assetsRelative -replace '/', '\\')) -Root $projectRoot -Label 'NuGet assets file'
  $lockPath = Assert-Inside -Path (Join-Path $projectRoot ($lockRelative -replace '/', '\\')) -Root $projectRoot -Label 'NuGet lock file'
  $assets = Read-JsonFile -Path (Assert-RegularFile -Path $assetsPath -Label 'NuGet assets file' -Extension '.json') -Label 'NuGet assets file'
  $lock = Read-JsonFile -Path (Assert-RegularFile -Path $lockPath -Label 'NuGet lock file' -Extension '.json') -Label 'NuGet lock file'
  $target = ([string]$Gui.target_framework) + '/' + ([string]$Gui.runtime_identifier)
  if ($null -eq $assets.targets.PSObject.Properties[$target]) {
    throw "NuGet assets file has no admitted target $target"
  }
  if ($null -eq $assets.project -or $null -eq $assets.project.restore) {
    throw 'NuGet assets file has no restore provenance'
  }
  $restoredProject = Convert-ToFullmagAbsolutePath -Path ([string]$assets.project.restore.projectPath) -Label 'NuGet restore project path'
  if (-not [string]::Equals($restoredProject, $projectFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'NuGet restore project path does not match the mutable UI mirror'
  }
  $sources = @($assets.project.restore.sources.PSObject.Properties | ForEach-Object { [string]$_.Name })
  if ($sources.Count -ne 1 -or -not [string]::Equals($sources[0], [string]$Nuget.source, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'NuGet restore did not use the single admitted official package source'
  }
  if ([int]$lock.version -ne 1 -or $null -eq $lock.dependencies) {
    throw 'NuGet lock file schema is not supported'
  }
  $lockTargetNames = New-Object System.Collections.Generic.List[string]
  foreach ($candidate in @($target, [string]$Gui.target_framework)) {
    if ([string]::IsNullOrWhiteSpace([string]$candidate) -or $lockTargetNames.Contains([string]$candidate)) { continue }
    if ($null -ne $lock.dependencies.PSObject.Properties[[string]$candidate]) {
      [void]$lockTargetNames.Add([string]$candidate)
    }
  }
  if ($lockTargetNames.Count -eq 0) {
    throw "NuGet lock file has no admitted target $target or $($Gui.target_framework)"
  }
  $lockTargetName = [string]$lockTargetNames[0]
  $inventory = @{}
  foreach ($library in @($assets.libraries.PSObject.Properties)) {
    $libraryValue = $library.Value
    if ([string]$libraryValue.type -ne 'package') { continue }
    $parts = ([string]$library.Name).Split('/', 2)
    if ($parts.Count -ne 2 -or $parts[0] -notmatch '^[A-Za-z0-9_.-]+$' -or $parts[1] -notmatch '^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.-]+)?$') {
      throw "NuGet assets file contains an invalid package identity: $($library.Name)"
    }
    $packageId = [string]$parts[0]
    $packageVersion = [string]$parts[1]
    $contentHash = [string]$libraryValue.sha512
    if ([string]::IsNullOrWhiteSpace($contentHash)) { throw "NuGet package has no content hash: $($library.Name)" }
    try { [Convert]::FromBase64String($contentHash) | Out-Null } catch { throw "NuGet package content hash is not base64: $($library.Name)" }
    $packageRoot = Join-Path $NugetRoot ($packageId.ToLowerInvariant() + '\' + $packageVersion.ToLowerInvariant())
    if (-not (Test-Path -LiteralPath $packageRoot -PathType Container)) {
      throw "NuGet package cache entry is missing: $($library.Name)"
    }
    $nupkgCandidates = @(Get-ChildItem -LiteralPath $packageRoot -File -Force | Where-Object {
        [string]::Equals($_.Name, ($packageId + '.' + $packageVersion + '.nupkg'), [System.StringComparison]::OrdinalIgnoreCase)
      })
    if ($nupkgCandidates.Count -ne 1) { throw "NuGet package archive is missing or ambiguous: $($library.Name)" }
    $nupkg = Assert-RegularFile -Path $nupkgCandidates[0].FullName -Label "NuGet package archive $($library.Name)" -Extension '.nupkg'
    $contentHashFile = Assert-RegularFile -Path ($nupkg + '.sha512') -Label "NuGet package content hash $($library.Name)" -Extension '.sha512'
    $recordedArchiveHash = ([IO.File]::ReadAllText($contentHashFile)).Trim()
    try { [Convert]::FromBase64String($recordedArchiveHash) | Out-Null } catch { throw "NuGet package archive hash is not base64: $($library.Name)" }
    $computedArchiveHash = Get-Sha512Base64 -Path $nupkg
    if ($recordedArchiveHash -ne $computedArchiveHash) { throw "NuGet package archive hash file does not match the package bytes: $($library.Name)" }
    $metadataPath = Assert-RegularFile -Path (Join-Path $packageRoot '.nupkg.metadata') -Label "NuGet package metadata $($library.Name)" -Extension '.metadata'
    $metadata = Read-JsonFile -Path $metadataPath -Label "NuGet package metadata $($library.Name)"
    if ([int]$metadata.version -ne 2 -or
        [string]$metadata.source -ne [string]$Nuget.source -or
        [string]::IsNullOrWhiteSpace([string]$metadata.contentHash)) {
      throw "NuGet package metadata is incomplete or uses an unapproved source: $($library.Name)"
    }
    try { [Convert]::FromBase64String([string]$metadata.contentHash) | Out-Null } catch { throw "NuGet package metadata hash is not base64: $($library.Name)" }
    if ([string]$metadata.contentHash -ne $contentHash) {
      throw "NuGet package metadata content hash does not match assets: $($library.Name)"
    }
    $key = ($packageId + '/' + $packageVersion).ToLowerInvariant()
    if ($inventory.ContainsKey($key)) { throw "NuGet assets file repeats package identity: $($library.Name)" }
    $inventory[$key] = [ordered]@{
      id = $packageId
      version = $packageVersion
      content_hash = $contentHash
      nupkg_sha512_base64 = $computedArchiveHash
      nupkg_sha512 = Get-Sha512 -Path $nupkg
      nupkg_sha256 = Get-Sha256 -Path $nupkg
    }
  }
  $locked = @{}
  foreach ($lockTargetNameCurrent in @($lockTargetNames)) {
    $lockTargetCurrent = $lock.dependencies.PSObject.Properties[[string]$lockTargetNameCurrent]
    foreach ($packageProperty in @($lockTargetCurrent.Value.PSObject.Properties)) {
      $packageId = [string]$packageProperty.Name
      $packageValue = $packageProperty.Value
      $packageVersion = [string]$packageValue.resolved
      $contentHash = [string]$packageValue.contentHash
      if ($packageId -notmatch '^[A-Za-z0-9_.-]+$' -or $packageVersion -notmatch '^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.-]+)?$' -or [string]::IsNullOrWhiteSpace($contentHash)) {
        throw "NuGet lock file contains an incomplete package entry: $packageId"
      }
      try { [Convert]::FromBase64String($contentHash) | Out-Null } catch { throw "NuGet lock content hash is not base64: $packageId" }
      $key = ($packageId + '/' + $packageVersion).ToLowerInvariant()
      if ($locked.ContainsKey($key) -and [string]$locked[$key] -ne $contentHash) { throw "NuGet lock file repeats package with conflicting hash: $key" }
      $locked[$key] = $contentHash
    }
  }
  if ($locked.Count -ne $inventory.Count) { throw 'NuGet lock and assets package inventories have different sizes' }
  foreach ($key in $inventory.Keys) {
    if (-not $locked.ContainsKey($key) -or [string]$locked[$key] -ne [string]$inventory[$key].content_hash) {
      throw "NuGet lock and assets content hashes differ: $key"
    }
  }
  foreach ($direct in @($Nuget.direct_packages)) {
    $key = (([string]$direct.id) + '/' + ([string]$direct.version)).ToLowerInvariant()
    if (-not $inventory.ContainsKey($key)) { throw "NuGet direct package is absent from the restored inventory: $key" }
  }
  $runtimePackProvenance = Get-SdkRuntimePackInventory -Assets $assets -Gui $Gui -Nuget $Nuget -Dotnet $Dotnet -NugetRoot $NugetRoot
  return [pscustomobject]@{
    source = [string]$Nuget.source
    lock_mode = [string]$Nuget.lock_mode
    target = $target
    assets_relative_path = $assetsRelative
    assets_sha256 = Get-Sha256 -Path $assetsPath
    lock_relative_path = $lockRelative
    lock_sha256 = Get-Sha256 -Path $lockPath
    lock_target = $lockTargetName
    lock_targets = @($lockTargetNames)
    package_inventory = @($inventory.Values | Sort-Object -Property id, version)
    runtime_pack_source = [string]$runtimePackProvenance.source
    runtime_pack_target_framework = [string]$runtimePackProvenance.target_framework
    runtime_pack_runtime_identifier = [string]$runtimePackProvenance.runtime_identifier
    runtime_pack_sdk_version = [string]$runtimePackProvenance.sdk_version
    runtime_pack_sdk_archive_sha512 = [string]$runtimePackProvenance.sdk_archive_sha512
    runtime_pack_sdk_tree_manifest_sha256 = [string]$runtimePackProvenance.sdk_tree_manifest_sha256
    runtime_pack_sdk_tree_inventory_sha256 = [string]$runtimePackProvenance.sdk_tree_inventory_sha256
    runtime_pack_bundled_versions_props_relative_path = [string]$runtimePackProvenance.bundled_versions_props_relative_path
    runtime_pack_bundled_versions_props_sha256 = [string]$runtimePackProvenance.bundled_versions_props_sha256
    runtime_pack_inventory = @($runtimePackProvenance.runtime_pack_inventory)
  }
}

function Publish-SetupUi {
  param(
    [Parameter(Mandatory = $true)]$Dotnet,
    [Parameter(Mandatory = $true)]$Gui,
    [Parameter(Mandatory = $true)]$Nuget,
    [Parameter(Mandatory = $true)][string]$ProjectPath,
    [Parameter(Mandatory = $true)][string]$OutputRoot,
    [Parameter(Mandatory = $true)]$StorageLayout
  )
  Assert-SetupUiProject -ProjectPath $ProjectPath -Gui $Gui -Nuget $Nuget
  $null = Assert-FullmagStoragePath -Layout $StorageLayout -Path $OutputRoot -Label 'Avalonia UI publish root' -Parent ([string]$StorageLayout.runs_root)
  if (Test-Path -LiteralPath $OutputRoot) {
    throw "Avalonia UI publish root already exists: $OutputRoot"
  }
  [IO.Directory]::CreateDirectory($OutputRoot) | Out-Null
  $cliHome = Join-Path ([string]$StorageLayout.build_root) 'installer-dotnet-home'
  $nugetRoot = Join-Path ([string]$StorageLayout.cache_root) 'installer-dotnet-nuget'
  $null = Assert-FullmagStoragePath -Layout $StorageLayout -Path $cliHome -Label 'managed .NET CLI home' -Parent ([string]$StorageLayout.build_root)
  $null = Assert-FullmagStoragePath -Layout $StorageLayout -Path $nugetRoot -Label 'managed NuGet cache' -Parent ([string]$StorageLayout.cache_root)
  [IO.Directory]::CreateDirectory($cliHome) | Out-Null
  [IO.Directory]::CreateDirectory($nugetRoot) | Out-Null
  $projectRoot = Convert-ToFullmagAbsolutePath -Path (Split-Path -Parent $ProjectPath) -Label 'Avalonia UI project root'
  $lockRelative = ([string]$Nuget.lock_relative_path).Replace('\\', '/')
  $lockPath = Assert-Inside -Path (Join-Path $projectRoot ($lockRelative -replace '/', '\\')) -Root $projectRoot -Label 'NuGet lock file'
  [IO.Directory]::CreateDirectory((Split-Path -Parent $lockPath)) | Out-Null
  $baseOutputRoot = Assert-Inside -Path (Join-Path $projectRoot 'obj\\build') -Root $projectRoot -Label 'Avalonia UI private build output root'
  [IO.Directory]::CreateDirectory($baseOutputRoot) | Out-Null
  $oldValues = @{}
  foreach ($name in @('DOTNET_ROOT', 'DOTNET_ROOT(x86)', 'DOTNET_CLI_HOME', 'NUGET_PACKAGES', 'PATH')) {
    $oldValues[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  }
  try {
    [Environment]::SetEnvironmentVariable('DOTNET_ROOT', [string]$Dotnet.root, 'Process')
    [Environment]::SetEnvironmentVariable('DOTNET_ROOT(x86)', $null, 'Process')
    [Environment]::SetEnvironmentVariable('DOTNET_CLI_HOME', $cliHome, 'Process')
    [Environment]::SetEnvironmentVariable('NUGET_PACKAGES', $nugetRoot, 'Process')
    [Environment]::SetEnvironmentVariable('PATH', [string]$Dotnet.root + [IO.Path]::PathSeparator + [string]$oldValues['PATH'], 'Process')
    $payloadName = [string]$Gui.payload_name
    $assemblyName = [string]$Gui.assembly_name
    if ([IO.Path]::GetFileNameWithoutExtension($payloadName) -cne $assemblyName) {
      throw 'Avalonia UI assembly name must match the private payload filename stem'
    }
    $restoreArguments = @(
      'restore', $ProjectPath,
      '--runtime', [string]$Gui.runtime_identifier,
      '--use-lock-file',
      '--locked-mode',
      '--lock-file-path', $lockPath,
      '--packages', $nugetRoot,
      '--source', [string]$Nuget.source
    )
    $previous = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      $restoreOutput = (& $Dotnet.dotnet @restoreArguments 2>&1 | Out-String).Trim()
      $restoreExitCode = $LASTEXITCODE
    }
    finally {
      $ErrorActionPreference = $previous
    }
    if ($restoreExitCode -ne 0) {
      throw "Avalonia NuGet restore failed with exit code ${restoreExitCode}: $restoreOutput"
    }
    $nugetRestore = Get-NugetRestoreProvenance -ProjectPath $ProjectPath -Gui $Gui -Nuget $Nuget -NugetRoot $nugetRoot -Dotnet $Dotnet
    $arguments = @(
      'publish', $ProjectPath,
      '--configuration', 'Release',
      '--runtime', [string]$Gui.runtime_identifier,
      '--no-restore',
      '--self-contained', 'true',
      '-p:PublishSingleFile=true',
      '-p:IncludeNativeLibrariesForSelfExtract=true',
      '-p:PublishTrimmed=false',
      '-p:DebugType=None',
      '-p:DebugSymbols=false',
      '-p:CopyOutputSymbolsToPublishDirectory=false',
      '-p:FullmagExcludeNativePackageSymbols=true',
      ("-p:BaseOutputPath=" + $baseOutputRoot.TrimEnd('\', '/') + '\'),
      "-p:AssemblyName=$assemblyName",
      '--output', $OutputRoot
    )
    $previous = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      $output = (& $Dotnet.dotnet @arguments 2>&1 | Out-String).Trim()
      $exitCode = $LASTEXITCODE
    }
    finally {
      $ErrorActionPreference = $previous
    }
    if ($exitCode -ne 0) {
      throw "Avalonia self-contained publish failed with exit code ${exitCode}: $output"
    }
  }
  finally {
    foreach ($name in @('DOTNET_ROOT', 'DOTNET_ROOT(x86)', 'DOTNET_CLI_HOME', 'NUGET_PACKAGES', 'PATH')) {
      if ($null -eq $oldValues[$name]) { Remove-Item -LiteralPath ('Env:' + $name) -ErrorAction SilentlyContinue } else { Set-Item -LiteralPath ('Env:' + $name) -Value $oldValues[$name] }
    }
  }
  $payload = Assert-RegularFile -Path (Join-Path $OutputRoot ([string]$Gui.payload_name)) -Label 'Avalonia UI private Burn payload' -Extension '.exe'
  $bytes = [IO.File]::ReadAllBytes($payload)
  if ($bytes.Length -lt 2 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) {
    throw 'Avalonia UI publish output is not a Windows PE executable'
  }
  $outputPrefix = $OutputRoot.TrimEnd('\', '/') + '\'
  $payloadInventory = @()
  foreach ($file in @(Get-ChildItem -LiteralPath $OutputRoot -File -Recurse -Force)) {
    $relative = $file.FullName.Substring($outputPrefix.Length).Replace('\', '/')
    if ($relative -cne [string]$Gui.payload_name) {
      throw "Avalonia UI publish produced an unadmitted private payload file: $relative"
    }
    $payloadInventory += [ordered]@{
      relative_path = $relative
      size_bytes = [int64]$file.Length
      sha256 = Get-Sha256 -Path $file.FullName
    }
  }
  if ($payloadInventory.Count -ne 1) {
    throw 'Avalonia UI publish must produce exactly one private single-file payload'
  }
  return [pscustomobject]@{
    project_relative_path = [string]$Gui.project_path
    payload_name = [string]$Gui.payload_name
    payload = $payload
    payload_sha256 = Get-Sha256 -Path $payload
    payload_size_bytes = [int64](Get-Item -LiteralPath $payload -Force).Length
    payload_inventory = @($payloadInventory)
    runtime_identifier = [string]$Gui.runtime_identifier
    self_contained = [bool]$Gui.self_contained
    single_file = [bool]$Gui.single_file
    sdk_version = [string]$Dotnet.version
    sdk_archive_sha512 = [string]$Dotnet.archive_sha512
    sdk_tree_manifest_sha256 = [string]$Dotnet.tree_manifest_sha256
    sdk_tree_inventory_sha256 = [string]$Dotnet.tree_inventory_sha256
    nuget_restore = $nugetRestore
    nuget_cache_root = $nugetRoot
  }
}

function Assert-InstallerStageTree {
  param(
    [Parameter(Mandatory = $true)][string]$Root
  )
  $rootFull = Assert-Directory -Path $Root -Label 'installer staging tree'
  $rootItem = Get-Item -LiteralPath $rootFull -Force
  if (Test-ReparseItem -Item $rootItem) {
    throw 'Installer staging tree root must not be a symlink or reparse point'
  }
  $allowedFiles = @(
    'fullmag.exe',
    'fullmag-installer-provenance.json',
    'fullmag-installer-receipt.json',
    'NOTICE',
    'THIRD_PARTY_NOTICES',
    'THIRD_PARTY_NOTICES.json',
    'Fullmag.Bundle.wixobj',
    'fullmag.wixpdb',
    'FullmagInstallerUi/FullmagInstallerUi.exe'
  )
  $allowedDirectories = @('FullmagInstallerUi')
  $rootPrefix = $rootFull.TrimEnd('\', '/') + '\'
  foreach ($item in @(Get-ChildItem -LiteralPath $rootFull -Force -Recurse -ErrorAction Stop)) {
    if (Test-ReparseItem -Item $item) {
      throw "Installer staging tree contains a symlink or reparse point: $($item.FullName)"
    }
    $relative = $item.FullName.Substring($rootPrefix.Length).Replace('\', '/')
    if ($item.PSIsContainer) {
      $directoryAllowed = @($allowedDirectories | Where-Object {
          [string]::Equals([string]$_, $relative, [System.StringComparison]::OrdinalIgnoreCase)
        }).Count -eq 1
      if (-not $directoryAllowed) {
        throw "Installer staging tree contains an unadmitted directory: $relative"
      }
    } else {
      $fileAllowed = @($allowedFiles | Where-Object {
          [string]::Equals([string]$_, $relative, [System.StringComparison]::OrdinalIgnoreCase)
        }).Count -eq 1
      if (-not $fileAllowed) {
        throw "Installer staging tree contains an unadmitted file: $relative"
      }
    }
  }
  foreach ($relative in $allowedFiles) {
    $null = Assert-RegularFile -Path (Join-Path $rootFull ($relative -replace '/', '\')) -Label "staged installer file $relative"
  }
  return $true
}

function Assert-ExpectedHash {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Expected,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $actual = Get-Sha256 -Path $Path
  if (-not [string]::Equals($actual, $Expected.ToLowerInvariant(), [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label SHA-256 mismatch: expected $Expected, got $actual"
  }
  return $actual
}

function Assert-Sha256Value {
  param(
    [Parameter(Mandatory = $true)][string]$Value,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if ($Value -notmatch '^[0-9a-fA-F]{64}$') {
    throw "$Label must be a 64-character SHA-256 value"
  }
  return $Value.ToLowerInvariant()
}

function Read-JsonFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )
  try {
    return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -ErrorAction Stop)
  }
  catch {
    throw "$Label is not valid JSON: $Path"
  }
}

function Assert-VerifiedWixRoot {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)]$StorageLayout,
    [Parameter(Mandatory = $true)][string]$RepoRoot
  )
  $manifestPath = Join-Path $RepoRoot 'windows_installer_build_requirements.json'
  $manifest = Read-JsonFile -Path $manifestPath -Label 'installer producer requirements manifest'
  $tool = $manifest.tools.wix3
  if ($null -eq $tool -or [string]::IsNullOrWhiteSpace([string]$tool.receipt_name)) {
    throw 'Installer producer requirements have no WiX 3 receipt contract'
  }
  $rootFull = Convert-ToFullmagAbsolutePath -Path $Root -Label 'WixRoot'
  $expectedRoot = Convert-ToFullmagAbsolutePath -Path ([string]$tool.storage_path.Replace('{build_root}', [string]$StorageLayout.build_root)) -Label 'expected project WiX root'
  if (-not [string]::Equals($rootFull, $expectedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "WixRoot must be the resolver-owned WiX root: $expectedRoot"
  }
  $null = Assert-Directory -Path $rootFull -Label 'verified WiX root'
  $receiptPath = Assert-RegularFile -Path (Join-Path $rootFull ([string]$tool.receipt_name)) -Label 'WiX provenance receipt'
  $receipt = Read-JsonFile -Path $receiptPath -Label 'WiX provenance receipt'
  if ([string]$receipt.schema -ne 'fullmag.windows-installer-wix3-receipt.v1' -or
      [string]$receipt.version -ne [string]$tool.version -or
      [string]$receipt.url -ne [string]$tool.url -or
      [string]$receipt.archive_sha256 -ne [string]$tool.sha256 -or
      -not [string]::Equals([string]$receipt.tool_root, $rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'WiX provenance receipt does not match the versioned requirements'
  }
  $archive = Assert-RegularFile -Path (Join-Path $rootFull ([string]$tool.archive_receipt)) -Label 'WiX source archive'
  $null = Assert-ExpectedHash -Path $archive -Expected ([string]$tool.sha256) -Label 'WiX source archive'
  $paths = [ordered]@{}
  foreach ($binary in @($tool.binaries)) {
    $path = Assert-RegularFile -Path (Join-Path $rootFull ([string]$binary.path)) -Label "WiX $($binary.id)"
    $entry = @($receipt.binaries | Where-Object { [string]$_.id -eq [string]$binary.id }) | Select-Object -First 1
    if ($null -eq $entry -or [string]$entry.relative_path -ne [string]$binary.path) {
      throw "WiX receipt has no matching $($binary.id) entry"
    }
    $null = Assert-ExpectedHash -Path $path -Expected ([string]$entry.sha256) -Label "WiX $($binary.id)"
    $paths[[string]$binary.id] = $path
  }
  foreach ($extension in @($tool.extensions)) {
    $path = Assert-RegularFile -Path (Join-Path $rootFull ([string]$extension.path)) -Label "WiX $($extension.id) extension"
    $entry = @($receipt.extensions | Where-Object { [string]$_.id -eq [string]$extension.id }) | Select-Object -First 1
    if ($null -eq $entry -or [string]$entry.relative_path -ne [string]$extension.path) {
      throw "WiX receipt has no matching $($extension.id) entry"
    }
    $null = Assert-ExpectedHash -Path $path -Expected ([string]$entry.sha256) -Label "WiX $($extension.id) extension"
    $paths[[string]$extension.id] = $path
  }
  $licensePath = Assert-RegularFile -Path (Join-Path $rootFull 'LICENSE.TXT') -Label 'WiX license payload' -Extension '.TXT'
  return [pscustomobject]@{
    root = $rootFull
    candle = [string]$paths['candle']
    light = [string]$paths['light']
    bal_extension = [string]$paths['bal']
    ui_extension = [string]$paths['ui']
    version = [string]$tool.version
    archive = $archive
    archive_sha256 = Get-Sha256 -Path $archive
    license_file = $licensePath
    license_sha256 = Get-Sha256 -Path $licensePath
    source_url = [string]$tool.url
  }
}

function Assert-SourceIdentity {
  param(
    [Parameter(Mandatory = $true)]$Manifest,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $identity = $Manifest.source_identity
  if ($null -eq $identity -or
      [string]$identity.head_commit_full -notmatch '^[0-9a-f]{40}$' -or
      [string]$identity.source_snapshot_sha256 -notmatch '^[0-9a-f]{64}$' -or
      $identity.source_snapshot_dirty -isnot [bool]) {
    throw "$Label has incomplete source_identity provenance"
  }
  return $identity
}

function Assert-CompilerInputMirrorRecord {
  param(
    [Parameter(Mandatory = $true)][string]$RecordPath,
    [Parameter(Mandatory = $true)][string]$BuildRoot,
    [Parameter(Mandatory = $true)][string]$ExpectedSha256,
    [Parameter(Mandatory = $true)][string]$ExpectedSnapshotId,
    [Parameter(Mandatory = $true)][string]$ExpectedSnapshotSha256
  )
  $record = Assert-RegularFile -Path $RecordPath -Label 'compiler input mirror record' -Extension '.json'
  $record = Assert-Inside -Path $record -Root $BuildRoot -Label 'compiler input mirror record'
  $recordHash = Assert-ExpectedHash -Path $record -Expected $ExpectedSha256 -Label 'compiler input mirror record'
  $value = Read-JsonFile -Path $record -Label 'compiler input mirror record'
  $generatedRoots = @($value.generated_output_policy.roots | ForEach-Object {
      ([string]$_).Replace('\','/')
    })
  if ($ExpectedSnapshotId -notmatch '^[0-9a-fA-F]{64}$' -or
      [string]$value.schema -ne 'fullmag.windows-installer-compiler-input-mirror.v1' -or
      [string]$value.snapshot_id -ne $ExpectedSnapshotId -or
      [string]$value.source_snapshot_sha256 -ne $ExpectedSnapshotSha256 -or
      [string]$value.inventory_sha256 -notmatch '^[0-9a-fA-F]{64}$' -or
      $null -eq $value.inventory -or
      [string]$value.ui_project_path -notmatch '^s/ui/[^/]+\.csproj$' -or
      $null -eq $value.generated_output_policy -or
      $generatedRoots.Count -ne 3 -or
      @('b', 'h', 's/ui/obj' | Where-Object { $generatedRoots -notcontains $_ }).Count -ne 0 -or
      [string]$value.generated_output_policy.purpose -cne 'dotnet restore and publish intermediate output only') {
    throw 'Compiler input mirror record does not match the admitted frozen source'
  }
  $entries = @($value.inventory | Sort-Object -Property path)
  if ((Get-TextSha256 (($entries | ConvertTo-Json -Depth 10 -Compress))) -ne [string]$value.inventory_sha256) {
    throw 'Compiler input mirror inventory hash changed'
  }
  $productionRoot = Assert-Directory -Path ([IO.Path]::GetDirectoryName($record)) -Label 'compiler input mirror root'
  $expected = @{}
  foreach ($entry in $entries) {
    $relative = [string]$entry.path
    if ($relative -notmatch '^(s/b|s/h|s/ui|b|h)/|^run_installer_environment\.ps1$') {
      throw "Compiler input mirror contains an unsafe path: $relative"
    }
    if ($expected.ContainsKey($relative)) {
      throw "Compiler input mirror repeats a path: $relative"
    }
    $expected[$relative] = $entry
    $file = Assert-RegularFile -Path (Join-Path $productionRoot ($relative -replace '/', '\')) -Label "compiler input mirror file $relative"
    $item = Get-Item -LiteralPath $file -Force
    if ([int64]$item.Length -ne [int64]$entry.size -or
        (Get-Sha256 -Path $file) -ne ([string]$entry.sha256).ToLowerInvariant()) {
      throw "Compiler input mirror bytes changed: $relative"
    }
  }
  $uiProjectRelative = [string]$value.ui_project_path
  if (-not $expected.ContainsKey($uiProjectRelative)) {
    throw 'Compiler input mirror inventory does not contain the GUI project'
  }
  $productionPrefix = $productionRoot.TrimEnd('\', '/') + '\'
  foreach ($item in @(Get-ChildItem -LiteralPath $productionRoot -Force -Recurse -ErrorAction Stop)) {
    if (Test-ReparseItem -Item $item) {
      throw "Compiler input mirror contains a symlink or reparse point: $($item.FullName)"
    }
    if (-not $item.PSIsContainer) {
      $relative = $item.FullName.Substring($productionPrefix.Length).Replace('\', '/')
      if ($relative -eq 'source-mirror.json' -or $relative -eq 'execution.json') { continue }
      $generated = $false
      foreach ($root in $generatedRoots) {
        if ($relative -eq $root -or $relative.StartsWith($root + '/', [StringComparison]::OrdinalIgnoreCase)) {
          $generated = $true
          break
        }
      }
      if (-not $generated -and -not $expected.ContainsKey($relative)) {
        throw "Compiler input mirror contains an unknown file: $relative"
      }
    }
  }
  return [pscustomobject]@{
    path = $record
    sha256 = $recordHash
    inventory_sha256 = [string]$value.inventory_sha256
    snapshot_id = [string]$value.snapshot_id
    production_root = [IO.Path]::GetDirectoryName($record)
    ui_project_path = [string]$value.ui_project_path
    generated_output_roots = @($value.generated_output_policy.roots | ForEach-Object { ([string]$_).Replace('\','/') })
  }
}

function Get-PythonExecutable {
  foreach ($name in @('python.exe', 'python')) {
    $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $command -and -not [string]::IsNullOrWhiteSpace([string]$command.Source)) {
      return [string]$command.Source
    }
  }
  throw 'Python is required to verify a frozen installer source record'
}

function Read-ThirdPartyLicenseFallbackManifest {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Root
  )
  $manifestPath = Assert-RegularFile -Path $Path -Label 'third-party license fallback manifest' -Extension '.json'
  $manifestPath = Assert-Inside -Path $manifestPath -Root $Root -Label 'third-party license fallback manifest'
  $manifest = Read-JsonFile -Path $manifestPath -Label 'third-party license fallback manifest'
  if ([string]$manifest.schema -ne 'fullmag.windows-installer-license-fallbacks.v1') {
    throw 'Third-party license fallback manifest has an unsupported schema'
  }
  $entries = @{}
  $rawEntries = @($manifest.entries)
  if ($rawEntries.Count -eq 0) {
    throw 'Third-party license fallback manifest has no entries'
  }
  foreach ($entry in $rawEntries) {
    $kind = [string]$entry.kind
    $packageId = [string]$entry.id
    $packageVersion = [string]$entry.version
    if ($kind -ne 'nuget' -or $packageId -notmatch '^[A-Za-z0-9_.-]+$' -or
        $packageVersion -notmatch '^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.-]+)?$') {
      throw "Third-party license fallback manifest contains an invalid package identity: $kind/$packageId/$packageVersion"
    }
    $key = ('{0}|{1}|{2}' -f $kind.ToLowerInvariant(), $packageId.ToLowerInvariant(), $packageVersion.ToLowerInvariant())
    if ($entries.ContainsKey($key)) {
      throw "Third-party license fallback manifest repeats package identity: $key"
    }
    $relativePath = ([string]$entry.relative_path).Replace('/', '\')
    if ([string]::IsNullOrWhiteSpace($relativePath) -or [IO.Path]::IsPathRooted($relativePath) -or
        $relativePath -match '(^|[\\])\.\.([\\]|$)') {
      throw "Third-party license fallback path is not a safe relative source path: $packageId/$packageVersion"
    }
    $licensePath = Assert-Inside -Path (Join-Path $Root $relativePath) -Root $Root `
      -Label "third-party license fallback $packageId $packageVersion"
    $licensePath = Assert-RegularFile -Path $licensePath -Label "third-party license fallback $packageId $packageVersion"
    $sha256 = Assert-Sha256Value -Value ([string]$entry.sha256) -Label "third-party license fallback hash $packageId"
    $null = Assert-ExpectedHash -Path $licensePath -Expected $sha256 -Label "third-party license fallback $packageId $packageVersion"
    $repository = [string]$entry.repository
    $commit = [string]$entry.commit
    $sourceFile = ([string]$entry.source_file).Replace('\', '/')
    $sourceUrl = [string]$entry.source_url
    $licenseExpression = [string]$entry.license_expression
    if ($repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or
        $commit -notmatch '^[0-9a-fA-F]{40}$' -or
        [string]::IsNullOrWhiteSpace($sourceFile) -or [IO.Path]::IsPathRooted($sourceFile) -or
        $sourceFile -match '(^|/)\.\.(/|$)' -or $sourceFile -match '(^|/)/(?:/|$)' -or
        $sourceUrl -notmatch '^https://\S+$' -or
        $licenseExpression -notmatch '^[A-Za-z0-9][A-Za-z0-9.+()|&\- ]*$') {
      throw "Third-party license fallback source mapping is invalid: $packageId/$packageVersion"
    }
    $entries[$key] = [ordered]@{
      kind = $kind.ToLowerInvariant()
      id = $packageId
      version = $packageVersion
      path = $licensePath
      sha256 = $sha256
      repository = $repository
      commit = $commit.ToLowerInvariant()
      source_file = $sourceFile
      source_url = $sourceUrl
      license_expression = $licenseExpression
    }
  }
  return [pscustomobject]@{
    path = $manifestPath
    sha256 = Get-Sha256 -Path $manifestPath
    filename = $manifestPath.Substring($Root.TrimEnd('\','/').Length + 1).Replace('\','/')
    schema = [string]$manifest.schema
    entries = $entries
  }
}

function New-ThirdPartyLegalArtifacts {
  param(
    [Parameter(Mandatory = $true)]$Gui,
    [Parameter(Mandatory = $true)][string]$Notice,
    [Parameter(Mandatory = $true)]$Wix,
    [Parameter(Mandatory = $true)][string]$StagingRoot,
    [Parameter(Mandatory = $true)]$FallbackManifest
  )
  $nugetRoot = Convert-ToFullmagAbsolutePath -Path ([string]$Gui.nuget_cache_root) -Label 'managed NuGet cache root'
  $null = Assert-Directory -Path $nugetRoot -Label 'managed NuGet cache root'
  $archives = New-Object System.Collections.Generic.List[object]
  $fallbackUsed = @{}
  foreach ($package in @($Gui.nuget_restore.package_inventory)) {
    $packageId = [string]$package.id
    $packageVersion = [string]$package.version
    if ($packageId -notmatch '^[A-Za-z0-9_.-]+$' -or
        $packageVersion -notmatch '^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.-]+)?$') {
      throw "NuGet legal inventory contains an invalid package identity: $packageId/$packageVersion"
    }
    $packageRoot = Assert-Inside -Path (Join-Path $nugetRoot ($packageId.ToLowerInvariant() + '\' + $packageVersion.ToLowerInvariant())) `
      -Root $nugetRoot -Label "NuGet legal archive root $packageId"
    $archive = Assert-RegularFile -Path (Join-Path $packageRoot ($packageId + '.' + $packageVersion + '.nupkg')) `
      -Label "NuGet legal archive $packageId $packageVersion" -Extension '.nupkg'
    $expected = Assert-Sha256Value -Value ([string]$package.nupkg_sha256) -Label "NuGet legal archive hash $packageId"
    $actual = Assert-ExpectedHash -Path $archive -Expected $expected -Label "NuGet legal archive $packageId"
    $key = ('nuget|{0}|{1}' -f $packageId.ToLowerInvariant(), $packageVersion.ToLowerInvariant())
    $archiveRecord = [ordered]@{
        kind = 'nuget'
        id = $packageId
        version = $packageVersion
        path = $archive
        sha256 = $actual
      }
    if ($FallbackManifest.entries.ContainsKey($key)) {
      $fallback = $FallbackManifest.entries[$key]
      $fallbackUsed[$key] = $true
      $archiveRecord['fallback_license'] = [ordered]@{
        path = [string]$fallback.path
        sha256 = [string]$fallback.sha256
        repository = [string]$fallback.repository
        commit = [string]$fallback.commit
        source_file = [string]$fallback.source_file
        source_url = [string]$fallback.source_url
        license_expression = [string]$fallback.license_expression
      }
    }
    [void]$archives.Add($archiveRecord)
  }
  foreach ($runtime in @($Gui.nuget_restore.runtime_pack_inventory)) {
    $packageId = [string]$runtime.id
    $packageVersion = [string]$runtime.version
    $relativeCachePath = ([string]$runtime.relative_cache_path).Replace('/', '\')
    if ($packageId -notmatch '^[A-Za-z0-9_.-]+$' -or
        $packageVersion -notmatch '^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.-]+)?$' -or
        [string]::IsNullOrWhiteSpace($relativeCachePath) -or
        [IO.Path]::IsPathRooted($relativeCachePath) -or
        $relativeCachePath -match '(^|[\\])\.\.([\\]|$)') {
      throw "SDK runtime-pack legal inventory contains an invalid package identity: $packageId/$packageVersion"
    }
    $packageRoot = Assert-Inside -Path (Join-Path $nugetRoot $relativeCachePath) -Root $nugetRoot `
      -Label "SDK runtime-pack legal archive root $packageId"
    $archive = Assert-RegularFile -Path (Join-Path $packageRoot ($packageId + '.' + $packageVersion + '.nupkg')) `
      -Label "SDK runtime-pack legal archive $packageId $packageVersion" -Extension '.nupkg'
    $expected = Assert-Sha256Value -Value ([string]$runtime.nupkg_sha256) -Label "SDK runtime-pack legal archive hash $packageId"
    $actual = Assert-ExpectedHash -Path $archive -Expected $expected -Label "SDK runtime-pack legal archive $packageId"
    [void]$archives.Add([ordered]@{
        kind = 'runtime_pack'
        id = $packageId
        version = $packageVersion
        path = $archive
        sha256 = $actual
      })
  }
  foreach ($fallbackKey in $FallbackManifest.entries.Keys) {
    if (-not $fallbackUsed.ContainsKey([string]$fallbackKey)) {
      throw "Third-party license fallback manifest contains an unused package identity: $fallbackKey"
    }
  }
  $wixArchive = Assert-RegularFile -Path ([string]$Wix.archive) -Label 'WiX legal source archive' -Extension '.zip'
  $wixArchiveSha256 = Assert-Sha256Value -Value ([string]$Wix.archive_sha256) -Label 'WiX legal source archive hash'
  $wixArchiveSha256 = Assert-ExpectedHash -Path $wixArchive -Expected $wixArchiveSha256 -Label 'WiX legal source archive'
  [void]$archives.Add([ordered]@{
      kind = 'wix'
      id = 'WiXToolset.WiX'
      version = [string]$Wix.version
      path = $wixArchive
      sha256 = $wixArchiveSha256
      required_member_sha256 = [string]$Wix.license_sha256
    })

  $requestPath = Join-Path $StagingRoot '.fullmag-third-party-legal-input.json'
  $noticesPath = Join-Path $StagingRoot 'THIRD_PARTY_NOTICES'
  $inventoryPath = Join-Path $StagingRoot 'THIRD_PARTY_NOTICES.json'
  # The Python helper validates fallback mappings against each NuGet .nuspec.
  $request = [ordered]@{
    schema = 'fullmag.windows-installer-legal-input.v1'
    root_notice = [ordered]@{ path = $Notice; sha256 = Get-Sha256 -Path $Notice }
    fallback_manifest = [ordered]@{
      schema = [string]$FallbackManifest.schema
      filename = [string]$FallbackManifest.filename
      sha256 = [string]$FallbackManifest.sha256
    }
    archives = @($archives)
  }
  $helper = Assert-RegularFile -Path (Join-Path $PSScriptRoot 'installer\generate_third_party_notices.py') `
    -Label 'third-party notices generator' -Extension '.py'
  $python = Get-PythonExecutable
  try {
    Write-AtomicUtf8NoBom -Path $requestPath -Text ($request | ConvertTo-Json -Depth 20)
    $inputManifestSha256 = Get-Sha256 -Path $requestPath
    $previous = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      $helperOutput = (& $python -B $helper --request $requestPath --notices-output $noticesPath --inventory-output $inventoryPath `
        --input-manifest-sha256 $inputManifestSha256 2>&1 | Out-String).Trim()
      $helperExitCode = $LASTEXITCODE
    }
    finally {
      $ErrorActionPreference = $previous
    }
    if ($helperExitCode -ne 0) {
      throw "Third-party notices generator failed with exit code ${helperExitCode}: $helperOutput"
    }
  }
  finally {
    if (Test-Path -LiteralPath $requestPath) {
      Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
    }
  }
  $noticesPath = Assert-RegularFile -Path $noticesPath -Label 'generated third-party notices'
  $inventoryPath = Assert-RegularFile -Path $inventoryPath -Label 'generated third-party notices inventory' -Extension '.json'
  $inventory = Read-JsonFile -Path $inventoryPath -Label 'generated third-party notices inventory'
  if ([string]$inventory.schema -ne 'fullmag.windows-installer-third-party-inventory.v1' -or
      [string]$inventory.inventory_scope -ne 'restored_dependency_superset+runtime_packs' -or
      [string]$inventory.input_manifest_sha256 -ne $inputManifestSha256 -or
      [string]$inventory.fallback_manifest.schema -ne [string]$FallbackManifest.schema -or
      [string]$inventory.fallback_manifest.filename -ne [string]$FallbackManifest.filename -or
      [string]$inventory.fallback_manifest.sha256 -ne [string]$FallbackManifest.sha256 -or
      [string]$inventory.third_party_notices_filename -ne 'THIRD_PARTY_NOTICES' -or
      [string]$inventory.third_party_notices_sha256 -ne (Get-Sha256 -Path $noticesPath) -or
      [string]$inventory.root_notice.sha256 -ne (Get-Sha256 -Path $Notice) -or
      [int]$inventory.archive_count -ne @($archives).Count -or
      @($inventory.archives).Count -ne @($archives).Count) {
    throw 'Generated third-party notices inventory is incomplete or not hash-bound to its outputs'
  }
  $expectedByIdentity = @{}
  foreach ($expectedArchive in $archives) {
    $expectedKey = ('{0}|{1}|{2}' -f ([string]$expectedArchive.kind).ToLowerInvariant(),
      ([string]$expectedArchive.id).ToLowerInvariant(), ([string]$expectedArchive.version).ToLowerInvariant())
    if ($expectedByIdentity.ContainsKey($expectedKey)) {
      throw "Duplicate expected third-party archive identity: $expectedKey"
    }
    $expectedByIdentity[$expectedKey] = $expectedArchive
  }
  $actualByIdentity = @{}
  foreach ($actualArchive in @($inventory.archives)) {
    $actualKind = [string]$actualArchive.kind
    $actualId = [string]$actualArchive.id
    $actualVersion = [string]$actualArchive.version
    $actualHash = Assert-Sha256Value -Value ([string]$actualArchive.archive_sha256) -Label 'generated third-party archive hash'
    $actualKey = ('{0}|{1}|{2}' -f $actualKind.ToLowerInvariant(), $actualId.ToLowerInvariant(), $actualVersion.ToLowerInvariant())
    if ([string]::IsNullOrWhiteSpace($actualKind) -or [string]::IsNullOrWhiteSpace($actualId) -or
        [string]::IsNullOrWhiteSpace($actualVersion) -or $actualByIdentity.ContainsKey($actualKey)) {
      throw "Generated third-party inventory has an invalid or duplicate archive identity: $actualKey"
    }
    if (-not $expectedByIdentity.ContainsKey($actualKey)) {
      throw "Generated third-party inventory contains an unexpected archive: $actualKey"
    }
    $expectedArchive = $expectedByIdentity[$actualKey]
    if (-not [string]::Equals($actualKind, [string]$expectedArchive.kind, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals($actualId, [string]$expectedArchive.id, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals($actualVersion, [string]$expectedArchive.version, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals($actualHash, [string]$expectedArchive.sha256, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Generated third-party archive does not match its expected input: $actualKey"
    }
    $actualByIdentity[$actualKey] = $actualArchive
  }
  if ($actualByIdentity.Count -ne $expectedByIdentity.Count) {
    throw 'Generated third-party inventory is missing an expected archive'
  }
  return [pscustomobject]@{
    notices_path = $noticesPath
    inventory_path = $inventoryPath
    inventory = $inventory
  }
}

function Get-VerifiedFrozenSource {
  param(
    [Parameter(Mandatory = $true)][string]$RecordPath,
    [Parameter(Mandatory = $true)][string]$BuildRoot,
    [Parameter(Mandatory = $true)][string]$LiveRepoRoot,
    [Parameter(Mandatory = $true)][string]$ExpectedCommit,
    [Parameter(Mandatory = $true)][string]$ExpectedSnapshotSha256,
    [Parameter(Mandatory = $true)][bool]$ExpectedDirty
  )
  $record = Assert-RegularFile -Path $RecordPath -Label 'frozen source snapshot record' -Extension '.json'
  $record = Assert-Inside -Path $record -Root $BuildRoot -Label 'frozen source snapshot record'
  $snapshotTool = Assert-RegularFile -Path (Join-Path $PSScriptRoot 'build_snapshot.py') -Label 'frozen source verifier' -Extension '.py'
  $python = Get-PythonExecutable
  $raw = (& $python -B $snapshotTool verify --record $record --build-root $BuildRoot 2>&1 | Out-String)
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw "Frozen source snapshot verification failed with exit code ${exitCode}: $raw"
  }
  try {
    $metadata = $raw | ConvertFrom-Json -ErrorAction Stop
  }
  catch {
    throw "Frozen source snapshot verifier returned invalid JSON: $raw"
  }
  $reportedRecord = Convert-ToFullmagAbsolutePath -Path ([string]$metadata.record_path) -Label 'verified snapshot record'
  if (-not [string]::Equals($reportedRecord, $record, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Frozen source verifier returned a different record path'
  }
  $origin = Convert-ToFullmagAbsolutePath -Path ([string]$metadata.origin_repo_root) -Label 'snapshot origin checkout'
  $live = Convert-ToFullmagAbsolutePath -Path $LiveRepoRoot -Label 'live repository root'
  if (-not [string]::Equals($origin, $live, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Frozen source snapshot origin does not match the live Git/storage checkout'
  }
  $identity = $metadata.source_identity
  if ($null -eq $identity -or
      -not [string]::Equals([string]$identity.head_commit_full, $ExpectedCommit, [System.StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals([string]$identity.source_snapshot_sha256, $ExpectedSnapshotSha256, [System.StringComparison]::OrdinalIgnoreCase) -or
      $identity.source_snapshot_dirty -isnot [bool] -or
      [bool]$identity.source_snapshot_dirty -ne $ExpectedDirty -or
      [string]$metadata.snapshot_id -notmatch '^[0-9a-fA-F]{64}$') {
    throw 'Frozen source snapshot identity does not match the installer authoring inputs'
  }
  $sourceRoot = Assert-Directory -Path ([string]$metadata.source_root) -Label 'verified frozen source root'
  $null = Assert-Inside -Path $sourceRoot -Root $BuildRoot -Label 'verified frozen source root'
  return [pscustomobject]@{
    metadata = $metadata
    source_root = $sourceRoot
    snapshot_id = [string]$metadata.snapshot_id
  }
}

function Resolve-InstallerToolLayoutReadOnly {
  param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][string]$Profile,
    [Parameter(Mandatory = $true)][string]$ExpectedStorageRoot
  )
  $resolver = Assert-RegularFile -Path (Join-Path $RepoRoot 'scripts\fullmag_storage.py') -Label 'storage resolver' -Extension '.py'
  $python = Get-PythonExecutable
  # The producer lock and derived paths belong to the source profile. Resolve
  # the packaging profile without inheriting them, while retaining the same
  # operator-selected storage root and restoring every process variable.
  $names = @(
    'FULLMAG_STORAGE_MANAGED_ENTRY', 'FULLMAG_STORAGE_PROFILE',
    'FULLMAG_STORAGE_LOCK_TOKEN', 'FULLMAG_STORAGE_LOCK_KEY',
    'FULLMAG_BUILD_STORAGE_ROOT', 'FULLMAG_STORAGE_USE_MANAGED_EXT4',
    'FULLMAG_NATIVE_STORAGE_PROFILE', 'FULLMAG_NATIVE_BUILD_IMAGE',
    'FULLMAG_NATIVE_MOUNT_VIEW', 'FULLMAG_MANAGED_NATIVE_ROOT',
    'FULLMAG_WINDOWS_VOLATILE_ROOT', 'FULLMAG_BUILD_ROOT',
    'FULLMAG_CACHE_ROOT', 'FULLMAG_TEMP_ROOT', 'FULLMAG_WINDOWS_BUILD_ROOT',
    'FULLMAG_WINDOWS_CACHE_ROOT', 'FULLMAG_WINDOWS_TEMP_ROOT',
    'FULLMAG_WINDOWS_TARGET_DIR', 'FULLMAG_CARGO_TARGET_DIR',
    'FULLMAG_CARGO_TARGET_ROOT', 'CARGO_TARGET_DIR', 'CARGO_TARGET_ROOT',
    'FULLMAG_FDM_NATIVE_BUILD_ROOT', 'FULLMAG_FRONTEND_ROOT',
    'FULLMAG_WINDOWS_STATE_ROOT', 'FULLMAG_WINDOWS_FRONTEND_ROOT',
    'FULLMAG_WINDOWS_NODE_MODULES_ROOT', 'FULLMAG_WINDOWS_CONTROL_ROOM_NODE_MODULES_ROOT',
    'FULLMAG_WINDOWS_CARGO_HOME', 'FULLMAG_WINDOWS_RUSTUP_HOME',
    'FULLMAG_WINDOWS_PNPM_ROOT'
  )
  $oldStorage = [Environment]::GetEnvironmentVariable('FULLMAG_PROJECT_STORAGE_ROOT', 'Process')
  $oldValues = @{}
  try {
    [Environment]::SetEnvironmentVariable('FULLMAG_PROJECT_STORAGE_ROOT', $ExpectedStorageRoot, 'Process')
    foreach ($name in $names) {
      $oldValues[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
      Remove-Item -LiteralPath ('Env:' + $name) -ErrorAction SilentlyContinue
    }
    $raw = (& $python $resolver resolve --repo-root $RepoRoot --profile $Profile --format json 2>&1 | Out-String)
    $exitCode = $LASTEXITCODE
  }
  finally {
    if ($null -eq $oldStorage) {
      Remove-Item -LiteralPath 'Env:FULLMAG_PROJECT_STORAGE_ROOT' -ErrorAction SilentlyContinue
    } else {
      Set-Item -LiteralPath 'Env:FULLMAG_PROJECT_STORAGE_ROOT' -Value $oldStorage
    }
    foreach ($name in $names) {
      if ($null -eq $oldValues[$name]) {
        Remove-Item -LiteralPath ('Env:' + $name) -ErrorAction SilentlyContinue
      } else {
        Set-Item -LiteralPath ('Env:' + $name) -Value $oldValues[$name]
      }
    }
  }
  if ($exitCode -ne 0) {
    throw "Installer tool storage resolution failed with exit code ${exitCode}: $raw"
  }
  try {
    $layout = $raw | ConvertFrom-Json -ErrorAction Stop
  }
  catch {
    throw "Installer tool storage resolver returned invalid JSON: $raw"
  }
  foreach ($field in @('storage_root', 'build_root', 'cache_root', 'temp_root', 'runtime_root', 'runs_root', 'profile')) {
    if ($null -eq $layout.$field -or [string]::IsNullOrWhiteSpace([string]$layout.$field)) {
      throw "Installer tool storage layout omitted required field: $field"
    }
  }
  if (-not [string]::Equals([string]$layout.profile, $Profile, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Installer tool storage resolver returned a different profile'
  }
  if (-not [string]::Equals((Convert-ToFullmagAbsolutePath -Path ([string]$layout.storage_root) -Label 'installer tool storage root'),
      (Convert-ToFullmagAbsolutePath -Path $ExpectedStorageRoot -Label 'expected storage root'),
      [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Installer tool storage resolver returned a different operator storage root'
  }
  return $layout
}

function Assert-StageManifest {
  param(
    [Parameter(Mandatory = $true)]$Manifest,
    [Parameter(Mandatory = $true)]$StorageLayout,
    [Parameter(Mandatory = $true)][string]$ManifestPath
  )
  if ([int]$Manifest.schema_version -ne 2) {
    throw "Stage manifest schema_version must be 2"
  }
  if ([string]$Manifest.product_version -notmatch '^\d+\.\d+\.\d+$') {
    throw "Stage manifest product_version must be numeric x.y.z"
  }
  $identity = Assert-SourceIdentity -Manifest $Manifest -Label 'Stage manifest'
  $stageRoot = Assert-Directory -Path ([string]$Manifest.stage_root) -Label 'MSI stage root'
  $null = Assert-FullmagStoragePath -Layout $StorageLayout -Path $stageRoot -Label 'MSI stage root' -Parent ([string]$StorageLayout.runs_root)
  $manifestDirectory = [System.IO.Path]::GetDirectoryName(
    (Convert-ToFullmagAbsolutePath -Path $ManifestPath -Label 'MSI stage manifest'))
  if (-not ([string]::Equals($stageRoot, $manifestDirectory, [System.StringComparison]::OrdinalIgnoreCase) -or
      $stageRoot.StartsWith($manifestDirectory + '\', [System.StringComparison]::OrdinalIgnoreCase))) {
    throw 'MSI stage root must belong to the same run directory as the stage manifest.'
  }

  $required = @('bin/fullmag.exe', 'bin/fullmag-ui.exe', 'bin/fullmag-bin.exe')
  foreach ($relative in $required) {
    if ($relative -notin @($Manifest.bin)) {
      throw "Stage manifest is missing required payload entry: $relative"
    }
    if ($relative -match '(^|[\\/])\.\.([\\/]|$)' -or [System.IO.Path]::IsPathRooted($relative)) {
      throw "Stage manifest contains an unsafe payload path: $relative"
    }
    $payload = Join-Path $stageRoot ($relative -replace '/', '\')
    $null = Assert-RegularFile -Path $payload -Label "staged payload $relative"
  }
  return $identity
}

function Write-AtomicUtf8NoBom {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Text
  )
  $parent = Split-Path -Parent $Path
  $temporary = Join-Path $parent ('.' + [System.IO.Path]::GetFileName($Path) + '.' + [guid]::NewGuid().ToString('N') + '.tmp')
  try {
    [System.IO.File]::WriteAllText($temporary, $Text, [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::Move($temporary, $Path)
  }
  finally {
    if (Test-Path -LiteralPath $temporary) {
      Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
  }
}

function Add-GitHubOutput {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Value
  )
  if ($env:GITHUB_OUTPUT) {
    Add-Content -LiteralPath $env:GITHUB_OUTPUT -Encoding UTF8 -Value ("$Name=$Value")
  }
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'The Windows Burn authoring route is Windows-only; WSL/Linux fallback is not supported.'
}
if ($BundleUpgradeCode -eq [guid]::Empty) {
  throw 'BundleUpgradeCode must be a stable non-empty GUID; no random default is allowed.'
}

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
} else {
  $RepoRoot = (Resolve-Path -LiteralPath (Convert-ToFullmagAbsolutePath -Path $RepoRoot -Label 'RepoRoot')).Path
}
$RepoRoot = Assert-Directory -Path $RepoRoot -Label 'RepoRoot'

$isSourceFirst = $Route -eq 'source-first'
$authoringRoot = $RepoRoot
$ba = Assert-RegularFile -Path $BootstrapperApplicationDll -Label 'external BootstrapperApplication DLL' -Extension '.dll'

. (Join-Path $PSScriptRoot 'fullmag_storage.ps1')
$StorageLayout = Resolve-FullmagStorageLayout -RepoRoot $RepoRoot -Profile $StorageProfile

$msi = $null
$stageManifestPath = $null
$stageManifest = $null
$sourceIdentity = $null
$frozenSnapshotId = $null
$productVersionValue = $null
$environmentBootstrap = $null
$environmentBootstrapSha256Value = ('0' * 64)
$environmentBootstrapVersionValue = '0.0.0'
$compilerInputMirror = $null
$gui = $null

if ($isSourceFirst) {
  if ([string]::IsNullOrWhiteSpace($EnvironmentBootstrapExe) -or
      [string]::IsNullOrWhiteSpace($EnvironmentBootstrapSha256) -or
      [string]::IsNullOrWhiteSpace($EnvironmentBootstrapVersion) -or
      [string]::IsNullOrWhiteSpace($ProductVersion) -or
      [string]::IsNullOrWhiteSpace($SourceCommit) -or
      [string]::IsNullOrWhiteSpace($SourceSnapshotSha256) -or
      [string]::IsNullOrWhiteSpace($FrozenSourceRecord) -or
      [string]::IsNullOrWhiteSpace($CompilerInputMirrorRecord) -or
      [string]::IsNullOrWhiteSpace($CompilerInputMirrorSha256) -or
      [string]::IsNullOrWhiteSpace($SetupUiProjectPath)) {
    throw 'source-first route requires EnvironmentBootstrapExe/hash/version, source identity, FrozenSourceRecord, compiler input mirror provenance and a mutable SetupUiProjectPath'
  }
  if ($EnvironmentBootstrapVersion -notmatch '^\d+\.\d+\.\d+$') {
    throw 'EnvironmentBootstrapVersion must be numeric x.y.z'
  }
  if ($ProductVersion -notmatch '^\d+\.\d+\.\d+$') {
    throw 'ProductVersion must be numeric x.y.z'
  }
  if ($SourceCommit -notmatch '^[0-9a-fA-F]{40}$') {
    throw 'SourceCommit must be a full 40-character commit id'
  }
  $environmentBootstrap = Assert-RegularFile -Path $EnvironmentBootstrapExe -Label 'source-first environment bootstrap helper' -Extension '.exe'
  $null = Assert-FullmagStoragePath -Layout $StorageLayout -Path $environmentBootstrap -Label 'source-first environment bootstrap helper' -Parent ([string]$StorageLayout.storage_root)
  $environmentBootstrapSha256Value = Assert-Sha256Value -Value $EnvironmentBootstrapSha256 -Label 'EnvironmentBootstrapSha256'
  $null = Assert-Sha256Value -Value $SourceSnapshotSha256 -Label 'SourceSnapshotSha256'
  $frozen = Get-VerifiedFrozenSource -RecordPath $FrozenSourceRecord -BuildRoot ([string]$StorageLayout.build_root) `
    -LiveRepoRoot $RepoRoot -ExpectedCommit $SourceCommit -ExpectedSnapshotSha256 $SourceSnapshotSha256 `
    -ExpectedDirty ([bool]$SourceSnapshotDirty)
  $authoringRoot = [string]$frozen.source_root
  $frozenSnapshotId = [string]$frozen.snapshot_id
  $sourceIdentity = [pscustomobject]@{
    head_commit_full = $SourceCommit.ToLowerInvariant()
    source_snapshot_sha256 = $SourceSnapshotSha256.ToLowerInvariant()
    source_snapshot_dirty = [bool]$SourceSnapshotDirty
  }
  $productVersionValue = $ProductVersion
  $environmentBootstrapVersionValue = $EnvironmentBootstrapVersion
  $compilerInputMirror = Assert-CompilerInputMirrorRecord -RecordPath $CompilerInputMirrorRecord `
    -BuildRoot ([string]$StorageLayout.build_root) -ExpectedSha256 $CompilerInputMirrorSha256 `
    -ExpectedSnapshotId ([string]$frozen.snapshot_id) -ExpectedSnapshotSha256 $SourceSnapshotSha256
} else {
  if ([string]::IsNullOrWhiteSpace($MsiPath) -or [string]::IsNullOrWhiteSpace($StageManifestPath) -or
      [string]::IsNullOrWhiteSpace($MsiSha256) -or [string]::IsNullOrWhiteSpace($StageManifestSha256)) {
    throw 'release route requires MsiPath, StageManifestPath and both payload hashes'
  }
  $msi = Assert-RegularFile -Path $MsiPath -Label 'existing MSI payload' -Extension '.msi'
  $stageManifestPath = Assert-RegularFile -Path $StageManifestPath -Label 'MSI stage manifest' -Extension '.json'
  $null = Assert-FullmagStoragePath -Layout $StorageLayout -Path $msi -Label 'existing MSI payload' -Parent ([string]$StorageLayout.runs_root)
  $null = Assert-FullmagStoragePath -Layout $StorageLayout -Path $stageManifestPath -Label 'MSI stage manifest' -Parent ([string]$StorageLayout.runs_root)
  $null = Assert-Sha256Value -Value $MsiSha256 -Label 'MsiSha256'
  $null = Assert-Sha256Value -Value $StageManifestSha256 -Label 'StageManifestSha256'
  $null = Assert-ExpectedHash -Path $stageManifestPath -Expected $StageManifestSha256 -Label 'MSI stage manifest'
  $stageManifest = Read-JsonFile -Path $stageManifestPath -Label 'MSI stage manifest'
  $sourceIdentity = Assert-StageManifest -Manifest $stageManifest -StorageLayout $StorageLayout -ManifestPath $stageManifestPath
  if ([string]::IsNullOrWhiteSpace($FrozenSourceRecord)) {
    throw 'release route requires a verified FrozenSourceRecord matching the MSI source_identity'
  }
  $frozen = Get-VerifiedFrozenSource -RecordPath $FrozenSourceRecord -BuildRoot ([string]$StorageLayout.build_root) `
    -LiveRepoRoot $RepoRoot -ExpectedCommit ([string]$sourceIdentity.head_commit_full) `
    -ExpectedSnapshotSha256 ([string]$sourceIdentity.source_snapshot_sha256) `
    -ExpectedDirty ([bool]$sourceIdentity.source_snapshot_dirty)
  $authoringRoot = [string]$frozen.source_root
  $frozenSnapshotId = [string]$frozen.snapshot_id
  if ((-not [string]::IsNullOrWhiteSpace($SourceCommit) -and
        -not [string]::Equals($SourceCommit, [string]$sourceIdentity.head_commit_full, [System.StringComparison]::OrdinalIgnoreCase)) -or
      (-not [string]::IsNullOrWhiteSpace($SourceSnapshotSha256) -and
        -not [string]::Equals($SourceSnapshotSha256, [string]$sourceIdentity.source_snapshot_sha256, [System.StringComparison]::OrdinalIgnoreCase))) {
    throw 'release route source identity arguments do not match the MSI stage source_identity'
  }
  $null = Assert-ExpectedHash -Path $msi -Expected $MsiSha256 -Label 'existing MSI payload'
  $productVersionValue = [string]$stageManifest.product_version
  $msiDirectory = [System.IO.Path]::GetDirectoryName($msi)
  $manifestDirectory = [System.IO.Path]::GetDirectoryName($stageManifestPath)
  if (-not [string]::Equals($msiDirectory, $manifestDirectory, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Existing MSI payload and stage manifest must come from the same MSI run directory.'
  }
}

$bundleSource = Assert-RegularFile -Path (Join-Path $authoringRoot 'scripts\windows\installer\Fullmag.Bundle.wxs') -Label 'Burn authoring source' -Extension '.wxs'
$installerEnvModule = Assert-RegularFile -Path (Join-Path $authoringRoot 'scripts\windows\installer_env.ps1') -Label 'installer environment module' -Extension '.ps1'
$setupBuildEnvironmentScript = Assert-RegularFile -Path $SetupBuildEnvironmentScript -Label 'setup build environment script' -Extension '.ps1'
$runtimeBuildRequirementsManifest = Assert-RegularFile -Path $BuildRequirementsManifest -Label 'runtime build requirements manifest' -Extension '.json'
$producerBuildRequirementsManifest = Assert-RegularFile -Path $InstallerBuildRequirementsManifest -Label 'installer producer requirements manifest' -Extension '.json'
$setupBuildEnvironmentScript = Assert-Inside -Path $setupBuildEnvironmentScript -Root $authoringRoot -Label 'setup build environment script'
$runtimeBuildRequirementsManifest = Assert-Inside -Path $runtimeBuildRequirementsManifest -Root $authoringRoot -Label 'runtime build requirements manifest'
$producerBuildRequirementsManifest = Assert-Inside -Path $producerBuildRequirementsManifest -Root $authoringRoot -Label 'installer producer requirements manifest'
if (-not [string]::Equals($setupBuildEnvironmentScript,
    (Convert-ToFullmagAbsolutePath -Path (Join-Path $authoringRoot 'scripts\windows\setup_build_environment.ps1') -Label 'canonical setup build environment script'),
    [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'setup build environment script must be the frozen canonical source payload'
}
if (-not [string]::Equals($runtimeBuildRequirementsManifest,
    (Convert-ToFullmagAbsolutePath -Path (Join-Path $authoringRoot 'windows_build_requirements.json') -Label 'canonical runtime build requirements manifest'),
    [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'runtime build requirements manifest must be the frozen canonical source payload'
}
if (-not [string]::Equals($producerBuildRequirementsManifest,
    (Convert-ToFullmagAbsolutePath -Path (Join-Path $authoringRoot 'windows_installer_build_requirements.json') -Label 'canonical installer producer requirements manifest'),
    [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'installer producer requirements manifest must be the frozen canonical source input'
}
$fallbackManifest = Read-ThirdPartyLicenseFallbackManifest `
  -Path (Join-Path $authoringRoot 'scripts\windows\installer\third_party_license_fallbacks.json') `
  -Root $authoringRoot
$null = Assert-ExpectedHash -Path $setupBuildEnvironmentScript -Expected $SetupBuildEnvironmentScriptSha256 -Label 'setup build environment script'
$null = Assert-ExpectedHash -Path $runtimeBuildRequirementsManifest -Expected $BuildRequirementsManifestSha256 -Label 'runtime build requirements manifest'
$null = Assert-ExpectedHash -Path $producerBuildRequirementsManifest -Expected $InstallerBuildRequirementsManifestSha256 -Label 'installer producer requirements manifest'
$buildRequirements = Read-JsonFile -Path $producerBuildRequirementsManifest -Label 'installer producer requirements manifest'
$dotnetTool = $buildRequirements.tools.dotnet_sdk
$guiRequirements = $buildRequirements.gui
$nugetRequirements = $buildRequirements.nuget
if ($null -eq $dotnetTool -or $null -eq $guiRequirements -or $null -eq $nugetRequirements) {
  throw 'Build requirements manifest must contain the managed .NET SDK, Avalonia UI and NuGet producer contracts'
}
if ([string]$guiRequirements.kind -ne 'avalonia' -or
    [string]$guiRequirements.project_path -notmatch '\.csproj$' -or
    [string]$guiRequirements.payload_name -notmatch '^[A-Za-z0-9_.-]+\.exe$' -or
    [string]$guiRequirements.assembly_name -notmatch '^[A-Za-z0-9_.-]+$' -or
    [string]$guiRequirements.sdk_version -ne [string]$dotnetTool.version -or
    [string]$guiRequirements.runtime_identifier -ne 'win-x64' -or
    $guiRequirements.self_contained -isnot [bool] -or -not [bool]$guiRequirements.self_contained -or
    $guiRequirements.single_file -isnot [bool] -or -not [bool]$guiRequirements.single_file -or
    $guiRequirements.private_burn_payload -isnot [bool] -or -not [bool]$guiRequirements.private_burn_payload) {
  throw 'Avalonia UI producer contract is incomplete or permits a non-self-contained payload'
}
if ([string]$nugetRequirements.schema -ne 'fullmag.windows-installer-nuget-provenance.v1' -or
    [string]$nugetRequirements.source -ne 'https://api.nuget.org/v3/index.json' -or
    [string]$nugetRequirements.lock_mode -ne 'locked' -or
    [string]$nugetRequirements.assets_relative_path -ne 'obj/project.assets.json' -or
    [string]$nugetRequirements.lock_relative_path -ne 'packages.lock.json' -or
    [string]$nugetRequirements.package_cache -ne '{cache_root}\installer-dotnet-nuget' -or
    @($nugetRequirements.direct_packages).Count -ne 3) {
  throw 'NuGet producer contract is incomplete or permits an unpinned source/cache policy'
}
$runtimePackRequirements = $nugetRequirements.runtime_pack_inventory
if ($null -eq $runtimePackRequirements -or
    [string]$runtimePackRequirements.schema -ne 'fullmag.windows-installer-runtime-pack-provenance.v1' -or
    [string]$runtimePackRequirements.source -ne 'sdk-download-dependencies' -or
    [string]$runtimePackRequirements.target_framework -ne [string]$guiRequirements.target_framework -or
    [string]$runtimePackRequirements.runtime_identifier -ne [string]$guiRequirements.runtime_identifier -or
    [string]$runtimePackRequirements.sdk_version -ne [string]$dotnetTool.version -or
    [string]$runtimePackRequirements.bundled_versions_props_relative_path -notmatch '^sdk\\[0-9]+\.[0-9]+\.[0-9]+\\Microsoft\.NETCoreSdk\.BundledVersions\.props$' -or
    [string]$runtimePackRequirements.bundled_versions_props_sha256 -notmatch '^[0-9a-fA-F]{64}$' -or
    @($runtimePackRequirements.packages).Count -ne 3) {
  throw 'NuGet producer contract is missing the exact SDK runtime-pack inventory policy'
}
$directPackageIds = @{}
foreach ($package in @($nugetRequirements.direct_packages)) {
  $packageId = [string]$package.id
  $packageVersion = [string]$package.version
  if ($packageId -notmatch '^[A-Za-z0-9_.-]+$' -or $packageVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$' -or $directPackageIds.ContainsKey($packageId.ToLowerInvariant())) {
    throw 'NuGet producer contract contains an invalid or duplicate direct package'
  }
  $directPackageIds[$packageId.ToLowerInvariant()] = $packageVersion
}
$license = Assert-RegularFile -Path $LicenseFile -Label 'approved LicenseFile'
$license = Assert-Inside -Path $license -Root $authoringRoot -Label 'approved LicenseFile'
$null = Assert-ExpectedHash -Path $license -Expected $LicenseFileSha256 -Label 'approved LicenseFile'
$notice = Assert-RegularFile -Path $NoticeFile -Label 'approved NoticeFile'
$notice = Assert-Inside -Path $notice -Root $authoringRoot -Label 'approved NoticeFile'
$null = Assert-ExpectedHash -Path $notice -Expected $NoticeFileSha256 -Label 'approved NoticeFile'
if ($frozenSnapshotId -notmatch '^[0-9a-fA-F]{64}$') {
  throw 'Installer route did not retain a verified frozen snapshot identity'
}

$InstallerStorageLayout = if ($InstallerStorageProfile -eq $StorageProfile) {
  $StorageLayout
} else {
  Resolve-InstallerToolLayoutReadOnly -RepoRoot $RepoRoot -Profile $InstallerStorageProfile `
    -ExpectedStorageRoot ([string]$StorageLayout.storage_root)
}
$wix = Assert-VerifiedWixRoot -Root $WixRoot -StorageLayout $InstallerStorageLayout -RepoRoot $authoringRoot
$wixLicense = Assert-RegularFile -Path ([string]$wix.license_file) -Label 'WiX license payload' -Extension '.TXT'
$wixLicenseSha256 = Assert-ExpectedHash -Path $wixLicense -Expected ([string]$wix.license_sha256) -Label 'WiX license payload'
$dotnetRoot = Convert-ToFullmagAbsolutePath -Path ([string]$dotnetTool.storage_path.Replace('{build_root}', [string]$InstallerStorageLayout.build_root)) -Label 'managed .NET SDK root'
$dotnet = Assert-VerifiedDotnetSdk -Tool $dotnetTool -StorageLayout $InstallerStorageLayout -Root $dotnetRoot

$guiProjectRelativePath = ([string]$guiRequirements.project_path).Replace('/', '\')
if ([System.IO.Path]::IsPathRooted($guiProjectRelativePath) -or $guiProjectRelativePath -match '(^|[\\])\.\.([\\]|$)') {
  throw 'Avalonia UI project path must be a relative path without parent traversal'
}
if ($isSourceFirst) {
  $expectedMirrorProject = Convert-ToFullmagAbsolutePath -Path (
    Join-Path ([string]$compilerInputMirror.production_root) ($compilerInputMirror.ui_project_path -replace '/', '\')) -Label 'expected mutable Avalonia UI project'
  $guiProjectPath = Assert-RegularFile -Path $SetupUiProjectPath -Label 'mutable Avalonia UI project' -Extension '.csproj'
  if (-not [string]::Equals($guiProjectPath, $expectedMirrorProject, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Source-first Avalonia UI project is not the verified compiler mirror project'
  }
  $guiProjectPath = Assert-Inside -Path $guiProjectPath -Root ([string]$compilerInputMirror.production_root) -Label 'mutable Avalonia UI project'
} else {
  $guiProjectPath = Assert-RegularFile -Path (Join-Path $authoringRoot $guiProjectRelativePath) -Label 'Avalonia UI project' -Extension '.csproj'
  $guiProjectPath = Assert-Inside -Path $guiProjectPath -Root $authoringRoot -Label 'Avalonia UI project'
}
$null = Assert-SetupUiProject -ProjectPath $guiProjectPath -Gui $guiRequirements -Nuget $nugetRequirements

$null = Assert-FullmagStoragePath -Layout $StorageLayout -Path $ba -Label 'external BootstrapperApplication DLL' -Parent ([string]$StorageLayout.storage_root)
$null = Assert-ExpectedHash -Path $ba -Expected $BootstrapperApplicationSha256 -Label 'external BootstrapperApplication DLL'

$distRoot = if ($OutputPath) {
  $requestedOutput = Convert-ToFullmagAbsolutePath -Path $OutputPath -Label 'OutputPath'
  if ([System.IO.Path]::GetFileName($requestedOutput) -cne 'fullmag.exe') {
    throw 'Public Burn output must be named fullmag.exe'
  }
  $parent = [System.IO.Path]::GetDirectoryName($requestedOutput)
  $null = Assert-FullmagStoragePath -Layout $StorageLayout -Path $requestedOutput -Label 'public Burn output' -Parent ([string]$StorageLayout.runs_root)
  $parent
} else {
  Join-Path ([string]$StorageLayout.runs_root) ('windows-installer-exe-' + [guid]::NewGuid().ToString('N'))
}
$distRoot = Convert-ToFullmagAbsolutePath -Path $distRoot -Label 'installer output directory'
$null = Assert-FullmagStoragePath -Layout $StorageLayout -Path $distRoot -Label 'installer output directory' -Parent ([string]$StorageLayout.runs_root)
if (Test-Path -LiteralPath $distRoot) {
  if (@(Get-ChildItem -LiteralPath $distRoot -Force).Count -gt 0) {
    throw "Installer output directory is not empty: $distRoot"
  }
  throw "Installer output directory already exists; refusing to publish over it: $distRoot"
} else {
  # The final directory is published only after the staged bundle and receipt
  # have passed validation. Do not create it before authoring begins.
}
$stagingRoot = Convert-ToFullmagAbsolutePath -Path (Join-Path ([string]$StorageLayout.runs_root) ('.fullmag-installer-exe-stage-' + [guid]::NewGuid().ToString('N'))) -Label 'installer staging directory'
$null = Assert-FullmagStoragePath -Layout $StorageLayout -Path $stagingRoot -Label 'installer staging directory' -Parent ([string]$StorageLayout.runs_root)
$output = $null
$provenancePath = $null
try {
  [IO.Directory]::CreateDirectory($stagingRoot) | Out-Null
  $output = Join-Path $stagingRoot 'fullmag.exe'
  $provenancePath = Join-Path $stagingRoot 'fullmag-installer-provenance.json'
  $wixObjPath = Join-Path $stagingRoot 'Fullmag.Bundle.wixobj'
  $guiOutputRoot = Join-Path $stagingRoot 'FullmagInstallerUi'
  $gui = Publish-SetupUi -Dotnet $dotnet -Gui $guiRequirements -Nuget $nugetRequirements -ProjectPath $guiProjectPath -OutputRoot $guiOutputRoot -StorageLayout $StorageLayout
  $stagedNotice = Join-Path $stagingRoot 'NOTICE'
  [IO.File]::Copy($notice, $stagedNotice, $false)
  $stagedNotice = Assert-RegularFile -Path $stagedNotice -Label 'staged product notice'
  $null = Assert-ExpectedHash -Path $stagedNotice -Expected $NoticeFileSha256 -Label 'staged product notice'
  $legal = New-ThirdPartyLegalArtifacts -Gui $gui -Notice $stagedNotice -Wix $wix `
    -StagingRoot $stagingRoot -FallbackManifest $fallbackManifest
  $legalInventory = $legal.inventory

  $provenance = [ordered]@{
    schema = 'fullmag.windows-installer-provenance.v1'
    artifact = 'fullmag-windows-x86_64-burn'
    public_filename = 'fullmag.exe'
    route = [string]$Route
    product_version = [string]$productVersionValue
    bundle_upgrade_code = $BundleUpgradeCode.ToString('B').ToUpperInvariant()
    storage_profile = [string]$StorageLayout.profile
    installer_tool_profile = [string]$InstallerStorageLayout.profile
    worktree_id = [string]$StorageLayout.worktree_id
    source = [ordered]@{
      head_commit_full = [string]$sourceIdentity.head_commit_full
      source_snapshot_sha256 = [string]$sourceIdentity.source_snapshot_sha256
      source_snapshot_dirty = [bool]$sourceIdentity.source_snapshot_dirty
      snapshot_id = $frozenSnapshotId.ToLowerInvariant()
    }
    bootstrapper_application = [ordered]@{ filename = [System.IO.Path]::GetFileName($ba); sha256 = (Get-Sha256 -Path $ba) }
    license = [ordered]@{ filename = [System.IO.Path]::GetFileName($license); sha256 = (Get-Sha256 -Path $license) }
    legal = [ordered]@{
      root_notice = [ordered]@{ filename = 'NOTICE'; sha256 = Get-Sha256 -Path $stagedNotice }
      third_party_notices = [ordered]@{ filename = 'THIRD_PARTY_NOTICES'; sha256 = Get-Sha256 -Path ([string]$legal.notices_path) }
      third_party_inventory = [ordered]@{
        filename = 'THIRD_PARTY_NOTICES.json'
        sha256 = Get-Sha256 -Path ([string]$legal.inventory_path)
        schema = [string]$legalInventory.schema
        scope = [string]$legalInventory.inventory_scope
        input_manifest_sha256 = [string]$legalInventory.input_manifest_sha256
        fallback_manifest = [ordered]@{
          schema = [string]$legalInventory.fallback_manifest.schema
          filename = [string]$legalInventory.fallback_manifest.filename
          sha256 = [string]$legalInventory.fallback_manifest.sha256
        }
        archive_count = [int]$legalInventory.archive_count
        legal_file_count = [int]$legalInventory.legal_file_count
      }
    }
    installer_env_module = [ordered]@{ filename = 'installer_env.ps1'; sha256 = (Get-Sha256 -Path $installerEnvModule) }
    prerequisite_setup = [ordered]@{ filename = 'scripts/windows/setup_build_environment.ps1'; sha256 = (Get-Sha256 -Path $setupBuildEnvironmentScript) }
    prerequisite_manifest = [ordered]@{ filename = 'windows_build_requirements.json'; sha256 = (Get-Sha256 -Path $runtimeBuildRequirementsManifest) }
    producer_manifest = [ordered]@{ filename = 'windows_installer_build_requirements.json'; sha256 = (Get-Sha256 -Path $producerBuildRequirementsManifest) }
    avalonia_ui = [ordered]@{
      project_relative_path = [string]$gui.project_relative_path
      payload_filename = [string]$gui.payload_name
      payload_sha256 = [string]$gui.payload_sha256
      payload_size_bytes = [int64]$gui.payload_size_bytes
      payload_inventory = @($gui.payload_inventory)
      runtime_identifier = [string]$gui.runtime_identifier
      self_contained = [bool]$gui.self_contained
      single_file = [bool]$gui.single_file
      sdk_version = [string]$gui.sdk_version
      sdk_archive_sha512 = [string]$gui.sdk_archive_sha512
      sdk_tree_manifest_sha256 = [string]$gui.sdk_tree_manifest_sha256
      sdk_tree_inventory_sha256 = [string]$gui.sdk_tree_inventory_sha256
      nuget_restore = $gui.nuget_restore
    }
    wix = [ordered]@{
      version = [string]$wix.version
      archive_filename = [System.IO.Path]::GetFileName([string]$wix.archive)
      archive_sha256 = [string]$wix.archive_sha256
      license_filename = 'WiX-3.14.1-LICENSE.TXT'
      license_sha256 = $wixLicenseSha256
      source_url = [string]$wix.source_url
    }
    pe_contract = [ordered]@{
      format = 'PE'
      machine = 'x86'
      optional_header = 'PE32'
      subsystem = 'GUI'
      required_section = '.wixburn'
    }
  }
  if ($compilerInputMirror) {
    $provenance.compiler_input_mirror = [ordered]@{
      record_filename = 'source-mirror.json'
      record_sha256 = [string]$compilerInputMirror.sha256
      inventory_sha256 = [string]$compilerInputMirror.inventory_sha256
      snapshot_id = [string]$compilerInputMirror.snapshot_id
      ui_project_path = [string]$compilerInputMirror.ui_project_path
      generated_output_roots = @($compilerInputMirror.generated_output_roots)
    }
  }
  if ($isSourceFirst) {
    $provenance.source_first = [ordered]@{
      mode = [string]$BootstrapMode
      helper_filename = [System.IO.Path]::GetFileName($environmentBootstrap)
      helper_sha256 = [string]$environmentBootstrapSha256Value
      helper_version = [string]$environmentBootstrapVersionValue
    }
  } else {
    $provenance.msi = [ordered]@{ filename = [System.IO.Path]::GetFileName($msi); sha256 = (Get-Sha256 -Path $msi) }
    $provenance.stage_manifest = [ordered]@{ filename = [System.IO.Path]::GetFileName($stageManifestPath); sha256 = (Get-Sha256 -Path $stageManifestPath); schema_version = [int]$stageManifest.schema_version }
  }
  Write-AtomicUtf8NoBom -Path $provenancePath -Text ($provenance | ConvertTo-Json -Depth 10)

  $bundleCode = $BundleUpgradeCode.ToString('B').ToUpperInvariant()
  $bundleMsiPath = if ($msi) { $msi } else { $bundleSource }
  $bundleStageManifestPath = if ($stageManifestPath) { $stageManifestPath } else { $bundleSource }
  $bundleEnvironmentBootstrap = if ($environmentBootstrap) { $environmentBootstrap } else { $bundleSource }
  $candleArguments = @(
    '-nologo', '-ext', $wix.bal_extension,
    "-dSourceFirst=$([int]$isSourceFirst)",
    "-dProductVersion=$productVersionValue",
    "-dBundleUpgradeCode=$bundleCode",
    "-dMsiPath=$bundleMsiPath",
    "-dStageManifestPath=$bundleStageManifestPath",
    "-dBootstrapperApplicationDll=$ba",
    "-dLicenseFile=$license",
    "-dLicenseFileName=$([System.IO.Path]::GetFileName($license))",
    "-dProductNoticeFile=$stagedNotice",
    "-dThirdPartyNoticesFile=$($legal.notices_path)",
    "-dThirdPartyInventoryFile=$($legal.inventory_path)",
    "-dInstallerEnvModule=$installerEnvModule",
    "-dSetupBuildEnvironmentScript=$setupBuildEnvironmentScript",
    "-dBuildRequirementsManifest=$runtimeBuildRequirementsManifest",
    "-dWixLicenseFile=$wixLicense",
    "-dEnvironmentBootstrapExe=$bundleEnvironmentBootstrap",
    "-dEnvironmentBootstrapSha256=$environmentBootstrapSha256Value",
    "-dEnvironmentBootstrapVersion=$environmentBootstrapVersionValue",
    "-dFullmagSetupUiPayload=$($gui.payload)",
    "-dInstallerProvenancePath=$provenancePath",
    '-out', $wixObjPath,
    $bundleSource
  )
  & $wix.candle @candleArguments
  if ($LASTEXITCODE -ne 0) {
    throw "WiX 3 candle.exe failed with exit code $LASTEXITCODE"
  }

  $lightArguments = @('-nologo', '-ext', $wix.bal_extension, '-out', $output, $wixObjPath)
  & $wix.light @lightArguments
  if ($LASTEXITCODE -ne 0) {
    throw "WiX 3 light.exe failed with exit code $LASTEXITCODE"
  }
  $peEvidence = Assert-BoundedBurnPeImage -Path $output -Label 'staged public Burn output'
  $null = Assert-RegularFile -Path $provenancePath -Label 'staged installer provenance' -Extension '.json'

  $receiptPath = Join-Path $stagingRoot 'fullmag-installer-receipt.json'
  $receipt = [ordered]@{
    schema = 'fullmag.windows-installer-receipt.v1'
    artifact = 'fullmag-windows-x86_64-burn'
    public_filename = 'fullmag.exe'
    route = [string]$Route
    product_version = [string]$productVersionValue
    source_first_mode = if ($isSourceFirst) { [string]$BootstrapMode } else { $null }
    output_sha256 = Get-Sha256 -Path $output
    provenance_sha256 = Get-Sha256 -Path $provenancePath
    source = $provenance.source
    wix_version = [string]$wix.version
    installer_tool_profile = [string]$InstallerStorageLayout.profile
    license_sha256 = Get-Sha256 -Path $license
    legal = $provenance.legal
    avalonia_ui = $provenance.avalonia_ui
    pe_validation = $peEvidence
  }
  Write-AtomicUtf8NoBom -Path $receiptPath -Text ($receipt | ConvertTo-Json -Depth 10)
  $verifiedReceipt = Read-JsonFile -Path $receiptPath -Label 'installer receipt'
  $verifiedUi = $verifiedReceipt.avalonia_ui
  $verifiedPe = $verifiedReceipt.pe_validation
  $verifiedUiInventory = @($verifiedUi.payload_inventory)
  $expectedUiInventory = @($gui.payload_inventory)
  $verifiedNuget = $verifiedUi.nuget_restore
  $expectedNuget = $gui.nuget_restore
  $verifiedLegal = $verifiedReceipt.legal
  $expectedLegal = $provenance.legal
  $verifiedLegalInventory = Read-JsonFile -Path ([string]$legal.inventory_path) -Label 'verified third-party notices inventory'
  if ([string]$verifiedReceipt.schema -ne 'fullmag.windows-installer-receipt.v1' -or
      [string]$verifiedReceipt.output_sha256 -ne (Get-Sha256 -Path $output) -or
      [string]$verifiedReceipt.provenance_sha256 -ne (Get-Sha256 -Path $provenancePath) -or
      $null -eq $verifiedLegal -or
      (ConvertTo-Json -InputObject $verifiedLegal -Depth 20 -Compress) -ne
        (ConvertTo-Json -InputObject $expectedLegal -Depth 20 -Compress) -or
      [string]$verifiedLegal.root_notice.sha256 -ne (Get-Sha256 -Path $stagedNotice) -or
      [string]$verifiedLegal.third_party_notices.sha256 -ne (Get-Sha256 -Path ([string]$legal.notices_path)) -or
      [string]$verifiedLegal.third_party_inventory.sha256 -ne (Get-Sha256 -Path ([string]$legal.inventory_path)) -or
      [string]$verifiedLegalInventory.schema -ne 'fullmag.windows-installer-third-party-inventory.v1' -or
      [string]$verifiedLegalInventory.inventory_scope -ne 'restored_dependency_superset+runtime_packs' -or
      [string]$verifiedLegalInventory.input_manifest_sha256 -ne [string]$legalInventory.input_manifest_sha256 -or
      [string]$verifiedLegalInventory.fallback_manifest.schema -ne [string]$legalInventory.fallback_manifest.schema -or
      [string]$verifiedLegalInventory.fallback_manifest.filename -ne [string]$legalInventory.fallback_manifest.filename -or
      [string]$verifiedLegalInventory.fallback_manifest.sha256 -ne [string]$legalInventory.fallback_manifest.sha256 -or
      [string]$verifiedLegalInventory.third_party_notices_sha256 -ne (Get-Sha256 -Path ([string]$legal.notices_path)) -or
      [int]$verifiedLegalInventory.archive_count -ne [int]$legalInventory.archive_count -or
      [int]$verifiedLegalInventory.legal_file_count -ne [int]$legalInventory.legal_file_count -or
      $null -eq $verifiedPe -or
      [string]$verifiedPe.format -ne 'PE' -or
      [string]$verifiedPe.machine -ne 'x86' -or
      [string]$verifiedPe.optional_header -ne 'PE32' -or
      [string]$verifiedPe.subsystem -ne 'GUI' -or
      [string]$verifiedPe.required_section -ne '.wixburn' -or
      [bool]$verifiedPe.executable_image -ne $true -or
      [bool]$verifiedPe.dll -ne $false -or
      [int]$verifiedPe.section_count -ne [int]$peEvidence.section_count -or
      [int64]$verifiedPe.file_size_bytes -ne [int64]$peEvidence.file_size_bytes -or
      [int64]$verifiedPe.e_lfanew -ne [int64]$peEvidence.e_lfanew -or
      $null -eq $verifiedUi -or
      [string]$verifiedUi.payload_filename -ne [string]$gui.payload_name -or
      [int64]$verifiedUi.payload_size_bytes -ne [int64]$gui.payload_size_bytes -or
      $verifiedUiInventory.Count -ne $expectedUiInventory.Count -or
      $verifiedUiInventory.Count -ne 1 -or
      [string]$verifiedUiInventory[0].relative_path -ne [string]$expectedUiInventory[0].relative_path -or
      [int64]$verifiedUiInventory[0].size_bytes -ne [int64]$expectedUiInventory[0].size_bytes -or
      [string]$verifiedUiInventory[0].sha256 -ne [string]$expectedUiInventory[0].sha256 -or
      $null -eq $verifiedNuget -or
      [string]$verifiedNuget.source -ne [string]$expectedNuget.source -or
      [string]$verifiedNuget.target -ne [string]$expectedNuget.target -or
      [string]$verifiedNuget.lock_target -ne [string]$expectedNuget.lock_target -or
      (ConvertTo-Json -InputObject @($verifiedNuget.lock_targets) -Compress) -ne
        (ConvertTo-Json -InputObject @($expectedNuget.lock_targets) -Compress) -or
      [string]$verifiedNuget.assets_sha256 -ne [string]$expectedNuget.assets_sha256 -or
      [string]$verifiedNuget.lock_sha256 -ne [string]$expectedNuget.lock_sha256 -or
      [string]$verifiedNuget.runtime_pack_source -ne [string]$expectedNuget.runtime_pack_source -or
      [string]$verifiedNuget.runtime_pack_target_framework -ne [string]$expectedNuget.runtime_pack_target_framework -or
      [string]$verifiedNuget.runtime_pack_runtime_identifier -ne [string]$expectedNuget.runtime_pack_runtime_identifier -or
      [string]$verifiedNuget.runtime_pack_sdk_version -ne [string]$expectedNuget.runtime_pack_sdk_version -or
      [string]$verifiedNuget.runtime_pack_sdk_archive_sha512 -ne [string]$expectedNuget.runtime_pack_sdk_archive_sha512 -or
      [string]$verifiedNuget.runtime_pack_sdk_tree_manifest_sha256 -ne [string]$expectedNuget.runtime_pack_sdk_tree_manifest_sha256 -or
      [string]$verifiedNuget.runtime_pack_sdk_tree_inventory_sha256 -ne [string]$expectedNuget.runtime_pack_sdk_tree_inventory_sha256 -or
      [string]$verifiedNuget.runtime_pack_bundled_versions_props_relative_path -ne [string]$expectedNuget.runtime_pack_bundled_versions_props_relative_path -or
      [string]$verifiedNuget.runtime_pack_bundled_versions_props_sha256 -ne [string]$expectedNuget.runtime_pack_bundled_versions_props_sha256 -or
      (ConvertTo-Json -InputObject @($verifiedNuget.package_inventory) -Depth 20 -Compress) -ne
        (ConvertTo-Json -InputObject @($expectedNuget.package_inventory) -Depth 20 -Compress) -or
      (ConvertTo-Json -InputObject @($verifiedNuget.runtime_pack_inventory) -Depth 20 -Compress) -ne
        (ConvertTo-Json -InputObject @($expectedNuget.runtime_pack_inventory) -Depth 20 -Compress)) {
    throw 'Installer receipt failed staged artifact validation'
  }

  $null = Assert-InstallerStageTree -Root $stagingRoot
  [System.IO.Directory]::Move($stagingRoot, $distRoot)
  $stagingRoot = $null
  $output = Join-Path $distRoot 'fullmag.exe'
  $provenancePath = Join-Path $distRoot 'fullmag-installer-provenance.json'
  $receiptPath = Join-Path $distRoot 'fullmag-installer-receipt.json'
  $null = Assert-RegularFile -Path $output -Label 'public Burn output' -Extension '.exe'
  $null = Assert-RegularFile -Path $provenancePath -Label 'installer provenance' -Extension '.json'
  $null = Assert-RegularFile -Path $receiptPath -Label 'installer receipt' -Extension '.json'
  $null = Assert-InstallerStageTree -Root $distRoot
}
finally {
  if ($stagingRoot -and (Test-Path -LiteralPath $stagingRoot)) {
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Add-GitHubOutput -Name 'installer_path' -Value $output
Add-GitHubOutput -Name 'installer_provenance_path' -Value $provenancePath
Write-Host "Created Fullmag Burn bootstrapper: $output"
Write-Host "Installer provenance: $provenancePath"
