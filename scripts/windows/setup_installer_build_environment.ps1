[CmdletBinding()]
param(
  [switch]$Install,
  [Parameter()][string]$StorageRoot,
  [switch]$Json
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$script:RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
$script:ManifestPath = Join-Path $script:RepoRoot "windows_installer_build_requirements.json"
$script:Requirements = $null
$script:PythonCommand = $null
$script:Session = $null
$script:Layout = $null
$script:StorageRootValue = $null
$script:Results = [System.Collections.Generic.List[object]]::new()
$script:InstallAttempted = [System.Collections.Generic.HashSet[string]]::new()

function Add-Result {
  param(
    [Parameter(Mandatory = $true)][string]$Id,
    [Parameter(Mandatory = $true)][ValidateSet("pass", "missing", "not_verified", "blocked")][string]$Status,
    [Parameter()][string]$Version = "",
    [Parameter()][string]$Path = "",
    [Parameter()][string]$Detail = "",
    [Parameter()][string]$Scope = "bootstrap",
    [Parameter()][AllowNull()][object]$ToolPaths = $null
  )
  $record = [ordered]@{
    id = $Id
    status = $Status
    version = $Version
    path = $Path
    detail = $Detail
    scope = $Scope
    install_attempted = $script:InstallAttempted.Contains($Id)
  }
  if ($null -ne $ToolPaths) { $record.tool_paths = $ToolPaths }
  [void]$script:Results.Add([pscustomobject]$record)
}

function Read-Requirements {
  if (-not (Test-Path -LiteralPath $script:ManifestPath -PathType Leaf)) {
    throw "Installer producer requirements manifest is missing: $script:ManifestPath"
  }
  try {
    return (Get-Content -LiteralPath $script:ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop)
  }
  catch {
    throw "Installer producer requirements manifest is invalid: $script:ManifestPath; $($_.Exception.Message)"
  }
}

function Get-Requirement {
  param([Parameter(Mandatory = $true)][string]$Id)
  $property = $script:Requirements.tools.PSObject.Properties[$Id]
  if ($null -eq $property) {
    throw "Installer producer requirements manifest has no tool '$Id'"
  }
  return $property.Value
}

function Invoke-NativeOutput {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter()][string[]]$Arguments = @()
  )
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $output = (& $Command @Arguments 2>&1 | Out-String).Trim()
    $exitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previous
  }
  return [pscustomobject]@{ output = $output; exit_code = $exitCode }
}

function Get-VersionObject {
  param([Parameter()][string]$Text)
  $match = [regex]::Match([string]$Text, '(?<!\d)(\d+)\.(\d+)(?:\.(\d+))?')
  if (-not $match.Success) { return $null }
  $patch = if ($match.Groups[3].Success) { $match.Groups[3].Value } else { "0" }
  return [version]::new([int]$match.Groups[1].Value, [int]$match.Groups[2].Value, [int]$patch)
}

function Test-MinimumVersion {
  param([Parameter()][version]$Actual, [Parameter()][string]$Minimum)
  if ($null -eq $Actual -or [string]::IsNullOrWhiteSpace($Minimum)) { return $false }
  return $Actual -ge [version]$Minimum
}

function Get-CommandInfo {
  param([Parameter(Mandatory = $true)][string]$Name, [Parameter()][string[]]$Arguments = @("--version"))
  $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $command) { return $null }
  $result = Invoke-NativeOutput ([string]$command.Source) $Arguments
  return [pscustomobject]@{
    path = [string]$command.Source
    output = [string]$result.output
    exit_code = [int]$result.exit_code
    version = Get-VersionObject ([string]$result.output)
  }
}

function Add-ProcessPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return }
  $parts = @($env:Path -split [IO.Path]::PathSeparator)
  if (-not ($parts | Where-Object { [string]::Equals($_, $Path, [StringComparison]::OrdinalIgnoreCase) })) {
    $env:Path = $Path + [IO.Path]::PathSeparator + $env:Path
  }
}

function Refresh-CommonPaths {
  $programFilesX86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
  foreach ($path in @(
      (Join-Path $env:ProgramFiles "Git\cmd"),
      (Join-Path $programFilesX86 "Git\cmd"),
      (Join-Path $env:LocalAppData "Programs\Python\Python312"),
      (Join-Path $env:LocalAppData "Programs\Python\Python312\Scripts"),
      (Join-Path $env:ProgramFiles "CMake\bin")
    )) {
    if ($path) { Add-ProcessPath $path }
  }
}

function Get-GitStatus {
  $info = Get-CommandInfo "git.exe" @("--version")
  if ($null -eq $info) { return [pscustomobject]@{ status = "missing"; detail = "git.exe is unavailable" } }
  $tool = Get-Requirement "git"
  if ($info.exit_code -ne 0 -or -not (Test-MinimumVersion $info.version ([string]$tool.minimum))) {
    return [pscustomobject]@{ status = "not_verified"; version = $info.version; path = $info.path; detail = "Git is below the pinned minimum or could not be queried" }
  }
  return [pscustomobject]@{ status = "pass"; version = $info.version; path = $info.path; detail = $info.output }
}

function Get-PythonCommand {
  $tool = Get-Requirement "python"
  foreach ($name in @("python.exe", "python")) {
    $info = Get-CommandInfo $name @("--version")
    if ($null -ne $info -and $info.exit_code -eq 0 -and (Test-MinimumVersion $info.version ([string]$tool.minimum))) {
      Add-ProcessPath (Split-Path -Parent $info.path)
      return [pscustomobject]@{ command = $info.path; version = $info.version; path = $info.path; detail = $info.output }
    }
  }

  $py = Get-Command "py.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $py) {
    $result = Invoke-NativeOutput ([string]$py.Source) @("-3", "-c", "import sys; print(sys.executable); print(sys.version.split()[0])")
    if ($result.exit_code -eq 0) {
      $lines = @(([string]$result.output) -split "\r?\n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
      if ($lines.Count -ge 2 -and (Test-Path -LiteralPath $lines[0].Trim() -PathType Leaf)) {
        $version = Get-VersionObject $lines[1]
        if (Test-MinimumVersion $version ([string]$tool.minimum)) {
          $resolved = (Resolve-Path -LiteralPath $lines[0].Trim()).Path
          Add-ProcessPath (Split-Path -Parent $resolved)
          return [pscustomobject]@{ command = $resolved; version = $version; path = $resolved; detail = "Resolved with py.exe -3" }
        }
      }
    }
  }
  return $null
}

function Get-PythonStatus {
  $python = Get-PythonCommand
  if ($null -eq $python) {
    return [pscustomobject]@{ status = "missing"; detail = "Python >=3.12 is required; py.exe is accepted only when it resolves a verified python.exe interpreter" }
  }
  $tool = Get-Requirement "python"
  if (-not (Test-MinimumVersion $python.version ([string]$tool.minimum))) {
    return [pscustomobject]@{ status = "not_verified"; version = $python.version; path = $python.path; detail = "Python is below the project minimum" }
  }
  return [pscustomobject]@{ status = "pass"; version = $python.version; path = $python.path; detail = $python.detail }
}

function Get-VsInstallation {
  $programFilesX86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
  $vswhereCandidates = @(
    (Join-Path $programFilesX86 "Microsoft Visual Studio\Installer\vswhere.exe"),
    (Join-Path $env:ProgramFiles "Microsoft Visual Studio\Installer\vswhere.exe")
  )
  foreach ($vswhere in $vswhereCandidates) {
    if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) { continue }
    $result = Invoke-NativeOutput $vswhere @("-latest", "-version", "[17.0,18.0)", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath")
    if ($result.exit_code -eq 0) {
      $candidate = @(([string]$result.output) -split "\r?\n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -First 1)
      if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Container)) {
        return (Resolve-Path -LiteralPath $candidate).Path
      }
    }
  }

  $fallbacks = @(
    (Join-Path $programFilesX86 "Microsoft Visual Studio\2022\BuildTools"),
    (Join-Path $env:ProgramFiles "Microsoft Visual Studio\2022\BuildTools"),
    (Join-Path $programFilesX86 "Microsoft Visual Studio\2022\Community"),
    (Join-Path $programFilesX86 "Microsoft Visual Studio\2022\Professional"),
    (Join-Path $programFilesX86 "Microsoft Visual Studio\2022\Enterprise")
  )
  foreach ($candidate in $fallbacks) {
    if (Test-Path -LiteralPath (Join-Path $candidate "VC\Tools\MSVC") -PathType Container) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }
  return $null
}

function Get-MsvcStatus {
  $vsPath = Get-VsInstallation
  if ($null -eq $vsPath) {
    return [pscustomobject]@{ status = "missing"; detail = "Visual Studio Build Tools with the x86/x64 C++ component are unavailable" }
  }
  $vcvars = Join-Path $vsPath "VC\Auxiliary\Build\vcvars64.bat"
  $clX86 = @(Get-ChildItem -LiteralPath (Join-Path $vsPath "VC\Tools\MSVC") -Filter cl.exe -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match '\\bin\\Hostx64\\x86\\cl\.exe$' } | Select-Object -First 1)
  $linkX86 = @(Get-ChildItem -LiteralPath (Join-Path $vsPath "VC\Tools\MSVC") -Filter link.exe -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match '\\bin\\Hostx64\\x86\\link\.exe$' } | Select-Object -First 1)
  if (-not (Test-Path -LiteralPath $vcvars -PathType Leaf) -or -not $clX86 -or -not $linkX86) {
    return [pscustomobject]@{ status = "not_verified"; path = $vsPath; detail = "vcvars64.bat and x86 target cl.exe/link.exe are required" }
  }
  $version = [string]$clX86[0].VersionInfo.FileVersion
  return [pscustomobject]@{ status = "pass"; version = $version; path = $vsPath; detail = "MSVC x86 target and vcvars64.bat are present" }
}

function Get-WindowsSdkStatus {
  $programFilesX86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
  $roots = @(
    (Join-Path $programFilesX86 "Windows Kits\10\bin"),
    (Join-Path $env:ProgramFiles "Windows Kits\10\bin")
  )
  foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
    $rc = @(Get-ChildItem -LiteralPath $root -Filter rc.exe -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match '\\x64\\rc\.exe$' } | Sort-Object FullName -Descending | Select-Object -First 1)
    if ($rc) {
      return [pscustomobject]@{ status = "pass"; version = [string]$rc[0].VersionInfo.FileVersion; path = $rc[0].FullName; detail = "Windows SDK x64 resource compiler is present" }
    }
  }
  return [pscustomobject]@{ status = "missing"; detail = "Windows Kits x64 rc.exe is unavailable" }
}

function Get-CmakeStatus {
  $tool = Get-Requirement "cmake"
  $info = Get-CommandInfo "cmake.exe" @("--version")
  if ($null -eq $info) { return [pscustomobject]@{ status = "missing"; detail = "cmake.exe is unavailable" } }
  if ($info.exit_code -ne 0 -or -not (Test-MinimumVersion $info.version ([string]$tool.minimum))) {
    return [pscustomobject]@{ status = "not_verified"; version = $info.version; path = $info.path; detail = "CMake is below the project minimum or could not be queried" }
  }
  return [pscustomobject]@{ status = "pass"; version = $info.version; path = $info.path; detail = $info.output }
}

function Get-DotnetRoot {
  $tool = Get-Requirement "dotnet_sdk"
  return Assert-LayoutPath -Path ([string]$tool.storage_path.Replace("{build_root}", [string]$script:Layout.build_root)) -Label "managed .NET SDK root"
}

function Get-DotnetReceiptPath {
  param([Parameter(Mandatory = $true)][string]$Root)
  $tool = Get-Requirement "dotnet_sdk"
  return Assert-LayoutPath -Path (Join-Path $Root ([string]$tool.receipt_name)) -Label ".NET SDK receipt"
}

function Get-Sha512Hash {
  param([Parameter(Mandatory = $true)][string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA512).Hash.ToLowerInvariant()
}

function Get-Sha256Hash {
  param([Parameter(Mandatory = $true)][string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
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

function Test-ReparseItem {
  param([Parameter(Mandatory = $true)]$Item)
  if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $true }
  return ($Item.PSObject.Properties.Name -contains 'LinkType' -and
    -not [string]::IsNullOrWhiteSpace([string]$Item.LinkType))
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
    if ($seen.ContainsKey($relative)) { throw "Managed .NET SDK extracted-tree manifest repeats: $relative" }
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
  $rootFull = Assert-LayoutPath -Path $Root -Label 'managed .NET SDK tree root'
  $rootItem = Get-Item -LiteralPath $rootFull -Force -ErrorAction Stop
  if (-not $rootItem.PSIsContainer -or (Test-ReparseItem -Item $rootItem)) {
    throw 'Managed .NET SDK tree root must be a regular directory'
  }
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
      [void]$entries.Add([ordered]@{ path = $relative; kind = 'file'; size_bytes = [int64]$item.Length; sha256 = Get-Sha256Hash -Path $item.FullName })
    }
  }
  return Convert-DotnetTreeEntriesToJson -Entries $entries.ToArray()
}

function Get-DotnetArchiveTreeInventory {
  param(
    [Parameter(Mandatory = $true)][string]$ArchivePath
  )
  $archiveFull = Assert-LayoutPath -Path $ArchivePath -Label 'managed .NET SDK source archive'
  $archiveItem = Get-Item -LiteralPath $archiveFull -Force -ErrorAction Stop
  if ($archiveItem.PSIsContainer -or (Test-ReparseItem -Item $archiveItem)) {
    throw 'Managed .NET SDK source archive must be a regular file'
  }
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $stream = $null
  $zip = $null
  $entriesByPath = @{}
  try {
    $stream = [IO.File]::Open($archiveFull, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Read, $false)
    foreach ($entry in @($zip.Entries)) {
      $raw = ([string]$entry.FullName).Replace('\', '/')
      $isDirectory = $raw.EndsWith('/')
      $relative = $raw.TrimEnd('/')
      $segments = @($relative.Split('/'))
      if ([string]::IsNullOrWhiteSpace($relative) -or
          $raw.StartsWith('/') -or $relative -match '^[A-Za-z]:' -or
          $raw.Contains('//') -or
          @($segments | Where-Object { [string]::IsNullOrWhiteSpace($_) -or $_ -eq '.' -or $_ -eq '..' }).Count -gt 0) {
        throw "Managed .NET SDK archive contains an unsafe entry: $raw"
      }
      $key = $relative.ToLowerInvariant()
      if ($entriesByPath.ContainsKey($key)) {
        throw "Managed .NET SDK archive repeats or collides at: $relative"
      }
      $parentPaths = New-Object System.Collections.Generic.List[string]
      for ($index = 1; $index -lt $segments.Count; $index++) {
        $parent = ($segments[0..($index - 1)] -join '/')
        [void]$parentPaths.Add($parent)
      }
      foreach ($parent in @($parentPaths)) {
        $parentKey = $parent.ToLowerInvariant()
        if ($entriesByPath.ContainsKey($parentKey)) {
          if ([string]$entriesByPath[$parentKey].kind -ne 'directory') {
            throw "Managed .NET SDK archive has a file/directory collision at: $parent"
          }
          continue
        }
        $entriesByPath[$parentKey] = [ordered]@{ path = $parent; kind = 'directory'; size_bytes = [int64]0; sha256 = '' }
      }
      if ($isDirectory) {
        $entriesByPath[$key] = [ordered]@{ path = $relative; kind = 'directory'; size_bytes = [int64]0; sha256 = '' }
        continue
      }
      $entryStream = $null
      $sha = $null
      try {
        $entryStream = $entry.Open()
        $sha = [Security.Cryptography.SHA256]::Create()
        $digest = ([BitConverter]::ToString($sha.ComputeHash($entryStream)) -replace '-', '').ToLowerInvariant()
      }
      finally {
        if ($null -ne $sha) { $sha.Dispose() }
        if ($null -ne $entryStream) { $entryStream.Dispose() }
      }
      $entriesByPath[$key] = [ordered]@{ path = $relative; kind = 'file'; size_bytes = [int64]$entry.Length; sha256 = $digest }
    }
    $entries = New-Object System.Collections.Generic.List[object]
    foreach ($entry in @($entriesByPath.Values)) { [void]$entries.Add($entry) }
    return Convert-DotnetTreeEntriesToJson -Entries $entries.ToArray()
  }
  finally {
    if ($null -ne $zip) { $zip.Dispose() }
    if ($null -ne $stream) { $stream.Dispose() }
  }
}

function Get-DotnetLegacyReceipt {
  param(
    [Parameter(Mandatory = $true)]$Tool,
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$ExpectedArchiveSha512
  )
  try {
    $rootFull = Assert-LayoutPath -Path $Root -Label 'managed .NET SDK root'
    $rootItem = Get-Item -LiteralPath $rootFull -Force -ErrorAction Stop
    if (-not $rootItem.PSIsContainer -or (Test-ReparseItem -Item $rootItem)) { return $null }
    $receiptPath = Get-DotnetReceiptPath -Root $rootFull
    if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) { return $null }
    $receiptItem = Get-Item -LiteralPath $receiptPath -Force -ErrorAction Stop
    if (Test-ReparseItem -Item $receiptItem) { return $null }
    $receipt = Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
    $treeProperties = @('tree_manifest_name', 'tree_manifest_sha256', 'tree_inventory_sha256', 'tree_file_count', 'tree_directory_count')
    if (@($treeProperties | Where-Object {
        $property = $receipt.PSObject.Properties[$_]
        $null -ne $property -and -not [string]::IsNullOrWhiteSpace([string]$property.Value)
      }).Count -gt 0) { return $null }
    if ([string]$receipt.schema -ne 'fullmag.windows-installer-dotnet-sdk-receipt.v1' -or
        [string]$receipt.version -ne [string]$Tool.version -or
        [string]$receipt.url -ne [string]$Tool.url -or
        ([string]$receipt.archive_sha512).ToLowerInvariant() -ne $ExpectedArchiveSha512 -or
        [string]$receipt.command -ne [string]$Tool.command -or
        [string]$receipt.runtime_identifier -ne [string]$Tool.runtime_identifier -or
        -not [string]::Equals([string]$receipt.tool_root, $rootFull, [StringComparison]::OrdinalIgnoreCase)) { return $null }
    $archive = Assert-LayoutPath -Path (Join-Path $rootFull ([string]$Tool.archive_receipt)) -Label 'managed .NET SDK source archive'
    if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) { return $null }
    $archiveItem = Get-Item -LiteralPath $archive -Force -ErrorAction Stop
    if ((Test-ReparseItem -Item $archiveItem) -or (Get-Sha512Hash -Path $archive) -ne $ExpectedArchiveSha512) { return $null }
    return [pscustomobject]@{ root = $rootFull; receipt = $receipt; receipt_path = $receiptPath; archive = $archive }
  }
  catch { return $null }
}

function Upgrade-LegacyDotnetSdkMetadata {
  param(
    [Parameter(Mandatory = $true)]$Tool,
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$ExpectedArchiveSha512
  )
  $legacy = Get-DotnetLegacyReceipt -Tool $Tool -Root $Root -ExpectedArchiveSha512 $ExpectedArchiveSha512
  if ($null -eq $legacy) {
    throw 'Existing .NET SDK root has no valid legacy receipt eligible for metadata upgrade'
  }
  $treeName = [string]$Tool.tree_manifest_name
  if ([string]::IsNullOrWhiteSpace($treeName) -or $treeName -match '[\\/]') {
    throw 'Pinned .NET SDK tree manifest name is unsafe'
  }
  $treePath = Assert-LayoutPath -Path (Join-Path $legacy.root $treeName) -Label 'managed .NET SDK extracted-tree receipt'
  if (Test-Path -LiteralPath $treePath) {
    throw 'Legacy .NET SDK root already contains an unadmitted extracted-tree receipt'
  }
  $expected = Get-DotnetArchiveTreeInventory -ArchivePath $legacy.archive
  if ((Get-Sha512Hash -Path $legacy.archive) -ne $ExpectedArchiveSha512) {
    throw 'Pinned .NET SDK source archive changed during metadata upgrade; CAS rejected'
  }
  $actual = Get-DotnetTreeInventory -Root $legacy.root -MetadataNames @([string]$Tool.archive_receipt, [string]$Tool.receipt_name)
  if ($actual.inventory_sha256 -ne $expected.inventory_sha256 -or $actual.canonical_json -cne $expected.canonical_json) {
    throw 'Existing .NET SDK extracted tree differs from the pinned archive (changed bytes or unknown file); metadata upgrade refused'
  }
  $treeManifest = [ordered]@{
    schema = 'fullmag.windows-installer-dotnet-sdk-tree.v1'
    archive_sha512 = $ExpectedArchiveSha512
    inventory_sha256 = [string]$expected.inventory_sha256
    file_count = [int64]$expected.file_count
    directory_count = [int64]$expected.directory_count
    inventory = @($expected.entries)
  }
  $parent = Split-Path -Parent $legacy.root
  $backupRoot = Assert-LayoutPath -Path (Join-Path $parent 'dotnet-sdk-receipt-backups') -Label 'legacy .NET SDK receipt backup directory'
  if (Test-Path -LiteralPath $backupRoot) {
    $backupItem = Get-Item -LiteralPath $backupRoot -Force -ErrorAction Stop
    if (-not $backupItem.PSIsContainer -or (Test-ReparseItem -Item $backupItem)) { throw 'Legacy .NET SDK receipt backup directory is not a regular directory' }
  }
  else { [IO.Directory]::CreateDirectory($backupRoot) | Out-Null }
  $backupName = '.dotnet-sdk-receipt.' + [guid]::NewGuid().ToString('N') + '.legacy.json'
  $backupPath = Assert-LayoutPath -Path (Join-Path $backupRoot $backupName) -Label 'legacy .NET SDK receipt backup'
  if (Test-Path -LiteralPath $backupPath) { throw 'Legacy .NET SDK receipt backup path unexpectedly exists' }
  $treeTemp = Assert-LayoutPath -Path (Join-Path $legacy.root ('.dotnet-sdk-tree.' + [guid]::NewGuid().ToString('N') + '.tmp')) -Label 'temporary .NET SDK tree receipt'
  $receiptTemp = Assert-LayoutPath -Path (Join-Path $legacy.root ('.dotnet-sdk-receipt.' + [guid]::NewGuid().ToString('N') + '.tmp')) -Label 'temporary .NET SDK receipt'
  try {
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($treeTemp, ($treeManifest | ConvertTo-Json -Depth 20), $utf8)
    [IO.File]::Move($treeTemp, $treePath)
    $treeHash = Get-Sha256Hash -Path $treePath
    $updated = [ordered]@{}
    foreach ($property in $legacy.receipt.PSObject.Properties) { $updated[$property.Name] = $property.Value }
    $updated.tree_manifest_name = $treeName
    $updated.tree_manifest_sha256 = $treeHash
    $updated.tree_inventory_sha256 = [string]$expected.inventory_sha256
    $updated.tree_file_count = [int64]$expected.file_count
    $updated.tree_directory_count = [int64]$expected.directory_count
    $updated.metadata_upgrade_backup = [string](Join-Path 'dotnet-sdk-receipt-backups' $backupName)
    [IO.File]::WriteAllText($receiptTemp, ($updated | ConvertTo-Json -Depth 20), $utf8)
    $receiptHashBefore = Get-Sha256Hash -Path $legacy.receipt_path
    $receiptCheck = Get-Sha256Hash -Path $legacy.receipt_path
    if ($receiptCheck -ne $receiptHashBefore) { throw 'Legacy .NET SDK receipt changed during metadata upgrade; CAS rejected' }
    [IO.File]::Replace($receiptTemp, $legacy.receipt_path, $backupPath, $false)
    $receiptTemp = $null
    $newReceipt = Get-Content -LiteralPath $legacy.receipt_path -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
    $verified = Assert-DotnetTreeManifest -Root $legacy.root -Tool $Tool -Receipt $newReceipt -ExpectedArchiveSha512 $ExpectedArchiveSha512
    return [pscustomobject]@{
      status = 'pass'
      detail = 'Legacy .NET SDK receipt upgraded with an archive-bound extracted-tree manifest'
      receipt = $legacy.receipt_path
      tree_manifest = $verified.manifest
      backup = $backupPath
      tree_manifest_sha256 = $verified.manifest_sha256
      tree_inventory_sha256 = $verified.inventory_sha256
    }
  }
  finally {
    if ($null -ne $treeTemp -and (Test-Path -LiteralPath $treeTemp)) { Remove-Item -LiteralPath $treeTemp -Force -ErrorAction SilentlyContinue }
    if ($null -ne $receiptTemp -and (Test-Path -LiteralPath $receiptTemp)) { Remove-Item -LiteralPath $receiptTemp -Force -ErrorAction SilentlyContinue }
  }
}

function Assert-DotnetTreeManifest {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)]$Tool,
    [Parameter(Mandatory = $true)]$Receipt,
    [Parameter(Mandatory = $true)][string]$ExpectedArchiveSha512
  )
  $rootFull = Assert-LayoutPath -Path $Root -Label 'managed .NET SDK root'
  $treeName = [string]$Tool.tree_manifest_name
  if ([string]::IsNullOrWhiteSpace($treeName) -or $treeName -match '[\\/]') {
    throw 'Managed .NET SDK manifest does not define a safe extracted-tree receipt name'
  }
  $treePath = Assert-LayoutPath -Path (Join-Path $rootFull $treeName) -Label 'managed .NET SDK extracted-tree receipt'
  $treeItem = Get-Item -LiteralPath $treePath -Force -ErrorAction Stop
  if ($treeItem.PSIsContainer -or (Test-ReparseItem -Item $treeItem)) { throw 'Managed .NET SDK extracted-tree receipt is not a regular file' }
  $treeHash = Get-Sha256Hash -Path $treePath
  if (([string]$Receipt.tree_manifest_name) -cne $treeName -or
      ([string]$Receipt.tree_manifest_sha256).ToLowerInvariant() -ne $treeHash) {
    throw 'Managed .NET SDK receipt does not bind the extracted-tree receipt'
  }
  $tree = Get-Content -LiteralPath $treePath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
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
  $actual = Get-DotnetTreeInventory -Root $rootFull -MetadataNames @([string]$Tool.archive_receipt, [string]$Tool.receipt_name, $treeName)
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

function Get-DotnetStatus {
  if ($null -eq $script:Layout) {
    return [pscustomobject]@{ status = "blocked"; detail = "Storage resolver admission is required before checking the managed .NET SDK" }
  }
  $tool = Get-Requirement "dotnet_sdk"
  $expectedHash = ([string]$tool.sha512).ToLowerInvariant()
  $root = Get-DotnetRoot
  if (-not (Test-Path -LiteralPath $root -PathType Container)) {
    return [pscustomobject]@{ status = "missing"; path = $root; detail = "Project-owned .NET SDK $($tool.version) root is missing" }
  }
  try {
    $receiptPath = Get-DotnetReceiptPath -Root $root
    if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) {
      throw ".NET SDK root exists without the project receipt; refusing to trust or overwrite it"
    }
    $receipt = Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
    $receiptArchiveHash = ([string]$receipt.archive_sha512).ToLowerInvariant()
    if ([string]$receipt.schema -ne "fullmag.windows-installer-dotnet-sdk-receipt.v1" -or
        [string]$receipt.version -ne [string]$tool.version -or
        [string]$receipt.url -ne [string]$tool.url -or
        $receiptArchiveHash -ne $expectedHash -or
        [string]$receipt.command -ne [string]$tool.command -or
        [string]$receipt.runtime_identifier -ne [string]$tool.runtime_identifier -or
        -not [string]::Equals([string]$receipt.tool_root, $root, [StringComparison]::OrdinalIgnoreCase)) {
      throw ".NET SDK receipt does not match the requirements manifest"
    }
    $archive = Assert-LayoutPath -Path (Join-Path $root ([string]$tool.archive_receipt)) -Label ".NET SDK source archive"
    if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) { throw ".NET SDK source archive is missing" }
    if ((Get-Sha512Hash -Path $archive) -ne $expectedHash) {
      throw ".NET SDK source archive hash does not match the pinned manifest"
    }
    $legacy = Get-DotnetLegacyReceipt -Tool $tool -Root $root -ExpectedArchiveSha512 $expectedHash
    if ($null -ne $legacy) {
      return [pscustomobject]@{
        status = "not_verified"
        version = [string]$tool.version
        path = $root
        detail = "Pinned .NET SDK archive and legacy receipt are valid, but extracted-tree metadata upgrade is required; rerun with -Install"
        tool_paths = [ordered]@{
          verified_dotnet_root = $root
          dotnet = (Join-Path $root ([string]$tool.command))
          receipt = $receiptPath
          archive = $archive
          tree_manifest = ""
        }
      }
    }
    $tree = Assert-DotnetTreeManifest -Root $root -Tool $tool -Receipt $receipt -ExpectedArchiveSha512 $expectedHash
    $dotnet = Assert-LayoutPath -Path (Join-Path $root ([string]$tool.command)) -Label ".NET SDK executable"
    if (-not (Test-Path -LiteralPath $dotnet -PathType Leaf)) { throw ".NET SDK executable is missing" }
    $sdk = Assert-LayoutPath -Path (Join-Path $root ("sdk\" + [string]$tool.version)) -Label ".NET SDK version directory"
    if (-not (Test-Path -LiteralPath $sdk -PathType Container)) { throw ".NET SDK version directory is missing" }

    $cliHome = Assert-LayoutPath -Path (Join-Path ([string]$script:Layout.build_root) "installer-dotnet-home") -Label ".NET CLI home"
    $nugetRoot = Assert-LayoutPath -Path (Join-Path ([string]$script:Layout.cache_root) "installer-dotnet-nuget") -Label ".NET NuGet cache" -RootKind "cache"
    $oldValues = @{}
    foreach ($name in @("DOTNET_ROOT", "DOTNET_ROOT(x86)", "DOTNET_CLI_HOME", "NUGET_PACKAGES", "PATH")) {
      $oldValues[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
    }
    try {
      [Environment]::SetEnvironmentVariable("DOTNET_ROOT", $root, "Process")
      [Environment]::SetEnvironmentVariable("DOTNET_ROOT(x86)", $null, "Process")
      [Environment]::SetEnvironmentVariable("DOTNET_CLI_HOME", $cliHome, "Process")
      [Environment]::SetEnvironmentVariable("NUGET_PACKAGES", $nugetRoot, "Process")
      [Environment]::SetEnvironmentVariable("PATH", $root + [IO.Path]::PathSeparator + [string]$oldValues["PATH"], "Process")
      $versionResult = Invoke-NativeOutput $dotnet @("--version")
    }
    finally {
      foreach ($name in @("DOTNET_ROOT", "DOTNET_ROOT(x86)", "DOTNET_CLI_HOME", "NUGET_PACKAGES", "PATH")) {
        if ($null -eq $oldValues[$name]) { Remove-Item -LiteralPath ("Env:" + $name) -ErrorAction SilentlyContinue } else { Set-Item -LiteralPath ("Env:" + $name) -Value $oldValues[$name] }
      }
    }
    if ($versionResult.exit_code -ne 0 -or [string]$versionResult.output -notmatch "(?m)^\s*$([regex]::Escape([string]$tool.version))\s*$") {
      throw "Managed .NET SDK reported an unexpected version: $($versionResult.output)"
    }
    return [pscustomobject]@{
      status = "pass"
      version = [string]$tool.version
      path = $root
      detail = "Pinned self-contained publish SDK is ready"
      tool_paths = [ordered]@{
        verified_dotnet_root = $root
        dotnet = $dotnet
        sdk = $sdk
        receipt = $receiptPath
        archive = $archive
        tree_manifest = $tree.manifest
        tree_manifest_sha256 = $tree.manifest_sha256
        tree_inventory_sha256 = $tree.inventory_sha256
      }
    }
  }
  catch {
    return [pscustomobject]@{ status = "blocked"; path = $root; detail = $_.Exception.Message }
  }
}

function Assert-LayoutPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter()][ValidateSet("build", "cache", "temp")][string]$RootKind = "build"
  )
  if ($null -eq $script:Layout) { throw "Cannot validate $Label before storage resolver admission" }
  $rootProperty = switch ($RootKind) {
    "temp" { "temp_root"; break }
    "cache" { "cache_root"; break }
    default { "build_root"; break }
  }
  $baseValue = [string]$script:Layout.$rootProperty
  if ([string]::IsNullOrWhiteSpace($baseValue)) { throw "Resolved $RootKind root is missing from the storage layout" }
  $base = [System.IO.Path]::GetFullPath($baseValue).TrimEnd("\", "/")
  $candidate = [System.IO.Path]::GetFullPath($Path).TrimEnd("\", "/")
  if (-not $candidate.StartsWith($base + "\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label escapes the resolved $RootKind root: $candidate"
  }
  $cursor = $candidate
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label traverses a junction or symlink: $cursor"
      }
    }
    $parent = Split-Path -Parent $cursor
    if (-not $parent -or [string]::Equals($parent, $cursor, [StringComparison]::OrdinalIgnoreCase)) { break }
    $cursor = $parent
  }
  return $candidate
}

function Get-WixRoot {
  $tool = Get-Requirement "wix3"
  return Assert-LayoutPath -Path ([string]$tool.storage_path.Replace("{build_root}", [string]$script:Layout.build_root)) -Label "WiX 3 tool root"
}

function Get-ReceiptPath {
  param([Parameter(Mandatory = $true)][string]$Root)
  $tool = Get-Requirement "wix3"
  return Join-Path $Root ([string]$tool.receipt_name)
}

function Get-ArchiveHash {
  param([Parameter(Mandatory = $true)][string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-WixStatus {
  if ($null -eq $script:Layout) {
    return [pscustomobject]@{ status = "blocked"; detail = "Storage resolver admission is required before checking portable WiX" }
  }
  $tool = Get-Requirement "wix3"
  $root = Get-WixRoot
  if (-not (Test-Path -LiteralPath $root -PathType Container)) {
    return [pscustomobject]@{ status = "missing"; path = $root; detail = "Project-owned WiX 3.14.1 root is missing" }
  }
  $receiptPath = Assert-LayoutPath -Path (Get-ReceiptPath -Root $root) -Label "WiX receipt"
  if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) {
    return [pscustomobject]@{ status = "blocked"; path = $root; detail = "WiX root exists without the project receipt; refusing to trust or overwrite it" }
  }
  try {
    $receipt = Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
    if ([string]$receipt.schema -ne "fullmag.windows-installer-wix3-receipt.v1" -or [string]$receipt.version -ne [string]$tool.version) {
      throw "WiX receipt schema/version does not match the requirements manifest"
    }
    if ([string]$receipt.url -ne [string]$tool.url) {
      throw "WiX receipt source URL does not match the requirements manifest"
    }
    if ([string]$receipt.archive_sha256 -ne [string]$tool.sha256) {
      throw "WiX receipt archive hash does not match the requirements manifest"
    }
    if (-not [string]::Equals([string]$receipt.tool_root, $root, [StringComparison]::OrdinalIgnoreCase)) {
      throw "WiX receipt points outside the resolved project tool root"
    }
    $archive = Assert-LayoutPath -Path (Join-Path $root ([string]$tool.archive_receipt)) -Label "WiX source archive"
    if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) { throw "WiX source archive is missing" }
    if ((Get-ArchiveHash -Path $archive) -ne [string]$tool.sha256) { throw "WiX source archive hash does not match the pinned manifest" }
    $binaryPaths = @{}
    foreach ($binary in @($tool.binaries)) {
      $path = Assert-LayoutPath -Path (Join-Path $root ([string]$binary.path)) -Label "WiX $($binary.id)"
      if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "$($binary.id) is missing from the WiX root" }
      $entry = @($receipt.binaries | Where-Object { [string]$_.id -eq [string]$binary.id }) | Select-Object -First 1
      if ($null -eq $entry -or [string]$entry.relative_path -ne [string]$binary.path) { throw "WiX receipt has no matching $($binary.id) entry" }
      if ((Get-ArchiveHash -Path $path) -ne [string]$entry.sha256) { throw "$($binary.id) hash does not match the immutable WiX receipt" }
      $binaryPaths[[string]$binary.id] = $path
    }
    $extensionPaths = @{}
    foreach ($extension in @($tool.extensions)) {
      $path = Assert-LayoutPath -Path (Join-Path $root ([string]$extension.path)) -Label "WiX $($extension.id)"
      if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "$($extension.id) extension is missing from the WiX root" }
      $entry = @($receipt.extensions | Where-Object { [string]$_.id -eq [string]$extension.id }) | Select-Object -First 1
      if ($null -eq $entry -or [string]$entry.relative_path -ne [string]$extension.path) { throw "WiX receipt has no matching $($extension.id) entry" }
      if ((Get-ArchiveHash -Path $path) -ne [string]$entry.sha256) { throw "$($extension.id) hash does not match the immutable WiX receipt" }
      $extensionPaths[[string]$extension.id] = $path
    }
    $toolPaths = [ordered]@{
      verified_wix_root = $root
      receipt = $receiptPath
      archive = $archive
      candle = [string]$binaryPaths['candle']
      light = [string]$binaryPaths['light']
      heat = [string]$binaryPaths['heat']
      bal_extension = [string]$extensionPaths['bal']
      ui_extension = [string]$extensionPaths['ui']
    }
    return [pscustomobject]@{
      status = "pass"
      version = [string]$tool.version
      path = $root
      detail = "Pinned WiX 3 candle/light/heat and Burn/UI extensions are ready"
      tool_paths = $toolPaths
    }
  }
  catch {
    return [pscustomobject]@{ status = "blocked"; path = $root; detail = $_.Exception.Message }
  }
}

function Invoke-WingetInstall {
  param([Parameter(Mandatory = $true)][string]$Id)
  $toolId = if ($Id -eq "windows_sdk") { "msvc_x86" } else { $Id }
  $tool = Get-Requirement $toolId
  $install = $tool.install
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $winget) { throw "winget.exe is required for -Install of $Id" }
  $arguments = @(
    "install", "--id", [string]$install.id, "--exact", "--source", [string]$install.source,
    "--accept-source-agreements", "--accept-package-agreements"
  )
  if ($install.override) { $arguments += @("--override", [string]$install.override) }
  if ($Id -eq "msvc_x86" -or $Id -eq "windows_sdk") { $arguments += "--force" }
  $script:InstallAttempted.Add($Id) | Out-Null
  if (-not $Json) { Write-Host ("> winget install " + $install.id) }
  $result = Invoke-NativeOutput ([string]$winget.Source) $arguments
  if ($result.exit_code -ne 0) {
    throw "winget installation of $Id failed with exit code $($result.exit_code)"
  }
  Refresh-CommonPaths
}

function Resolve-StorageWithCreate {
  if ($null -eq $script:Session -or $null -eq $script:PythonCommand) { throw "Storage session and Python are required before creating project-owned paths" }
  $oldStorage = [Environment]::GetEnvironmentVariable("FULLMAG_PROJECT_STORAGE_ROOT", "Process")
  $removed = @(
    "POSTGRES_PASSWORD", "MINIO_ROOT_PASSWORD",
    "FULLMAG_STORAGE_PROFILE", "FULLMAG_WINDOWS_VOLATILE_ROOT",
    "FULLMAG_BUILD_ROOT", "FULLMAG_CACHE_ROOT", "FULLMAG_TEMP_ROOT",
    "FULLMAG_WINDOWS_BUILD_ROOT", "FULLMAG_WINDOWS_CACHE_ROOT", "FULLMAG_WINDOWS_TEMP_ROOT",
    "FULLMAG_WINDOWS_TARGET_DIR", "FULLMAG_CARGO_TARGET_DIR", "CARGO_TARGET_DIR",
    "FULLMAG_CARGO_TARGET_ROOT", "CARGO_TARGET_ROOT", "FULLMAG_FDM_NATIVE_BUILD_ROOT",
    "FULLMAG_FRONTEND_ROOT", "FULLMAG_STORAGE_LOCK_TOKEN", "FULLMAG_STORAGE_LOCK_KEY",
    "FULLMAG_BUILD_STORAGE_ROOT", "FULLMAG_MANAGED_NATIVE_ROOT", "FULLMAG_NATIVE_BUILD_IMAGE",
    "FULLMAG_NATIVE_MOUNT_VIEW", "FULLMAG_STORAGE_USE_MANAGED_EXT4"
  )
  $oldValues = @{}
  try {
    $env:FULLMAG_PROJECT_STORAGE_ROOT = $script:StorageRootValue
    foreach ($name in $removed) {
      $oldValues[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
      Remove-Item -LiteralPath ("Env:" + $name) -ErrorAction SilentlyContinue
    }
    $arguments = @(
      $script:Session.resolver_script, "resolve",
      "--repo-root", $script:Session.requested_checkout,
      "--profile", $script:Session.storage_profile,
      "--format", "json", "--create"
    )
    $result = Invoke-NativeOutput ([string]$script:PythonCommand.command) $arguments
    if ($result.exit_code -ne 0) { throw "Storage resolver refused project-owned directory creation" }
    $layout = $result.output | ConvertFrom-Json -ErrorAction Stop
    if (-not [string]::Equals([string]$layout.storage_root, $script:StorageRootValue, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Storage resolver returned a different storage root during creation"
    }
    $script:Layout = $layout
  }
  finally {
    if ($null -eq $oldStorage) { Remove-Item Env:FULLMAG_PROJECT_STORAGE_ROOT -ErrorAction SilentlyContinue } else { $env:FULLMAG_PROJECT_STORAGE_ROOT = $oldStorage }
    foreach ($name in $removed) {
      if ($null -eq $oldValues[$name]) { Remove-Item -LiteralPath ("Env:" + $name) -ErrorAction SilentlyContinue } else { Set-Item -LiteralPath ("Env:" + $name) -Value $oldValues[$name] }
    }
  }
}

function Install-Wix3 {
  $tool = Get-Requirement "wix3"
  $root = Get-WixRoot
  if (Test-Path -LiteralPath $root) {
    throw "WiX root already exists but is not trusted; refusing overwrite: $root"
  }
  $parent = Split-Path -Parent $root
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  $lockPath = Assert-LayoutPath -Path (Join-Path $parent ".wix3-install.lock") -Label "WiX install lock"
  $lock = $null
  $tempRoot = $null
  $stagingRoot = $null
  try {
    try {
      $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    }
    catch {
      throw "Another WiX installation is active or the project tool root is locked"
    }
    if (Test-Path -LiteralPath $root) {
      throw "WiX root appeared while installation was being admitted; refusing overwrite: $root"
    }
    $stagingRoot = Assert-LayoutPath -Path (Join-Path $parent (".wix3-install-" + [guid]::NewGuid().ToString("N"))) -Label "WiX staging root"
    New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null
    $tempRoot = Assert-LayoutPath -Path (Join-Path ([string]$script:Layout.temp_root) ("wix3-" + [guid]::NewGuid().ToString("N"))) -Label "WiX temporary extraction" -RootKind temp
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    $archive = Assert-LayoutPath -Path (Join-Path $tempRoot ([string]$tool.archive_name)) -Label "WiX downloaded archive" -RootKind temp
    $extract = Assert-LayoutPath -Path (Join-Path $tempRoot "extract") -Label "WiX extraction root" -RootKind temp
    $script:InstallAttempted.Add("wix3") | Out-Null
    if (-not $Json) { Write-Host ("> download pinned WiX 3.14.1 archive") }
    Invoke-WebRequest -UseBasicParsing -Uri ([string]$tool.url) -OutFile $archive
    if ((Get-ArchiveHash -Path $archive) -ne [string]$tool.sha256) {
      throw "Downloaded WiX archive hash does not match the pinned manifest"
    }
    Expand-Archive -LiteralPath $archive -DestinationPath $extract -Force
    foreach ($binary in @($tool.binaries)) {
      if (-not (Test-Path -LiteralPath (Join-Path $extract ([string]$binary.path)) -PathType Leaf)) {
        throw "Pinned WiX archive is missing $($binary.id)"
      }
    }
    foreach ($extension in @($tool.extensions)) {
      if (-not (Test-Path -LiteralPath (Join-Path $extract ([string]$extension.path)) -PathType Leaf)) {
        throw "Pinned WiX archive is missing $($extension.id)"
      }
    }
    Copy-Item -Path (Join-Path $extract "*") -Destination $stagingRoot -Recurse -Force
    $stagedArchive = Assert-LayoutPath -Path (Join-Path $stagingRoot ([string]$tool.archive_receipt)) -Label "WiX staged source archive"
    Copy-Item -LiteralPath $archive -Destination $stagedArchive -Force
    $records = @()
    foreach ($binary in @($tool.binaries)) {
      $path = Assert-LayoutPath -Path (Join-Path $stagingRoot ([string]$binary.path)) -Label "WiX staged $($binary.id)"
      if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Staged WiX file is missing $($binary.id)" }
      $records += [ordered]@{ id = [string]$binary.id; relative_path = [string]$binary.path; sha256 = Get-ArchiveHash -Path $path }
    }
    $extensionRecords = @()
    foreach ($extension in @($tool.extensions)) {
      $path = Assert-LayoutPath -Path (Join-Path $stagingRoot ([string]$extension.path)) -Label "WiX staged $($extension.id)"
      if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Staged WiX file is missing $($extension.id)" }
      $extensionRecords += [ordered]@{ id = [string]$extension.id; relative_path = [string]$extension.path; sha256 = Get-ArchiveHash -Path $path }
    }
    $receipt = [ordered]@{
      schema = "fullmag.windows-installer-wix3-receipt.v1"
      version = [string]$tool.version
      url = [string]$tool.url
      archive_sha256 = [string]$tool.sha256
      tool_root = [string]$root
      binaries = $records
      extensions = $extensionRecords
    }
    $receiptPath = Assert-LayoutPath -Path (Join-Path $stagingRoot ([string]$tool.receipt_name)) -Label "WiX staged receipt"
    $receiptTmp = Assert-LayoutPath -Path (Join-Path $stagingRoot (".wix3-receipt." + [guid]::NewGuid().ToString("N") + ".tmp")) -Label "WiX temporary receipt"
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($receiptTmp, ($receipt | ConvertTo-Json -Depth 10), $utf8)
    Move-Item -LiteralPath $receiptTmp -Destination $receiptPath -Force

    # Validate the complete staged tree and receipt before exposing it at the
    # project-owned path. The final directory rename is the only publication.
    if ((Get-ArchiveHash -Path $stagedArchive) -ne [string]$tool.sha256) {
      throw "Staged WiX source archive hash does not match the pinned manifest"
    }
    $stagedReceipt = Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
    if ([string]$stagedReceipt.schema -ne "fullmag.windows-installer-wix3-receipt.v1" -or
        [string]$stagedReceipt.version -ne [string]$tool.version -or
        [string]$stagedReceipt.url -ne [string]$tool.url -or
        [string]$stagedReceipt.archive_sha256 -ne [string]$tool.sha256 -or
        [string]$stagedReceipt.tool_root -ne [string]$root) {
      throw "Staged WiX receipt failed provenance validation"
    }
    [IO.Directory]::Move($stagingRoot, $root)
    $stagingRoot = $null
  }
  finally {
    if ($null -ne $tempRoot -and (Test-Path -LiteralPath $tempRoot)) {
      Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($null -ne $stagingRoot -and (Test-Path -LiteralPath $stagingRoot)) {
      Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($null -ne $lock) { $lock.Dispose() }
  }
}

function Install-DotnetSdk {
  $tool = Get-Requirement "dotnet_sdk"
  $expectedHash = ([string]$tool.sha512).ToLowerInvariant()
  $root = Get-DotnetRoot
  $parent = Split-Path -Parent $root
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  $lockPath = Assert-LayoutPath -Path (Join-Path $parent ".dotnet-sdk-install.lock") -Label ".NET SDK install lock"
  $lock = $null
  $tempRoot = $null
  $stagingRoot = $null
  try {
    try {
      $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    }
    catch {
      throw "Another .NET SDK installation is active or the project tool root is locked"
    }
    if (Test-Path -LiteralPath $root) {
      $legacy = Get-DotnetLegacyReceipt -Tool $tool -Root $root -ExpectedArchiveSha512 $expectedHash
      if ($null -eq $legacy) {
        throw ".NET SDK root already exists but is not a valid legacy receipt; refusing overwrite: $root"
      }
      $script:InstallAttempted.Add("dotnet_sdk") | Out-Null
      if (-not $Json) { Write-Host ("> upgrade legacy .NET SDK metadata $($tool.version) without replacing the retained SDK") }
      $null = Upgrade-LegacyDotnetSdkMetadata -Tool $tool -Root $root -ExpectedArchiveSha512 $expectedHash
      return
    }
    $stagingRoot = Assert-LayoutPath -Path (Join-Path $parent (".dotnet-sdk-install-" + [guid]::NewGuid().ToString("N"))) -Label ".NET SDK staging root"
    New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null
    $tempRoot = Assert-LayoutPath -Path (Join-Path ([string]$script:Layout.temp_root) ("dotnet-sdk-" + [guid]::NewGuid().ToString("N"))) -Label ".NET SDK temporary extraction" -RootKind temp
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    $archive = Assert-LayoutPath -Path (Join-Path $tempRoot ([string]$tool.archive_name)) -Label ".NET SDK downloaded archive" -RootKind temp
    $extract = Assert-LayoutPath -Path (Join-Path $tempRoot "extract") -Label ".NET SDK extraction root" -RootKind temp
    $script:InstallAttempted.Add("dotnet_sdk") | Out-Null
    if (-not $Json) { Write-Host ("> download pinned .NET SDK $($tool.version) archive") }
    Invoke-WebRequest -UseBasicParsing -Uri ([string]$tool.url) -OutFile $archive
    if ((Get-Sha512Hash -Path $archive) -ne $expectedHash) {
      throw "Downloaded .NET SDK archive hash does not match the pinned manifest"
    }
    Expand-Archive -LiteralPath $archive -DestinationPath $extract -Force
    $extractedDotnet = Join-Path $extract ([string]$tool.command)
    $extractedSdk = Join-Path $extract ("sdk\" + [string]$tool.version)
    if (-not (Test-Path -LiteralPath $extractedDotnet -PathType Leaf) -or
        -not (Test-Path -LiteralPath $extractedSdk -PathType Container)) {
      throw "Pinned .NET SDK archive is missing dotnet.exe or SDK $($tool.version)"
    }
    Copy-Item -Path (Join-Path $extract "*") -Destination $stagingRoot -Recurse -Force
    $stagedArchive = Assert-LayoutPath -Path (Join-Path $stagingRoot ([string]$tool.archive_receipt)) -Label ".NET SDK staged source archive"
    Copy-Item -LiteralPath $archive -Destination $stagedArchive -Force
    $stagedDotnet = Assert-LayoutPath -Path (Join-Path $stagingRoot ([string]$tool.command)) -Label ".NET SDK staged executable"
    $stagedSdk = Assert-LayoutPath -Path (Join-Path $stagingRoot ("sdk\" + [string]$tool.version)) -Label ".NET SDK staged version directory"
    if (-not (Test-Path -LiteralPath $stagedDotnet -PathType Leaf) -or -not (Test-Path -LiteralPath $stagedSdk -PathType Container)) {
      throw "Staged .NET SDK tree is incomplete"
    }
    $treeManifestName = [string]$tool.tree_manifest_name
    if ([string]::IsNullOrWhiteSpace($treeManifestName) -or $treeManifestName -match '[\\/]') {
      throw "Pinned .NET SDK tree manifest name is unsafe"
    }
    $treeInventory = Get-DotnetTreeInventory -Root $stagingRoot -MetadataNames @([string]$tool.archive_receipt, [string]$tool.receipt_name, $treeManifestName)
    $treeManifest = [ordered]@{
      schema = "fullmag.windows-installer-dotnet-sdk-tree.v1"
      archive_sha512 = $expectedHash
      inventory_sha256 = [string]$treeInventory.inventory_sha256
      file_count = [int64]$treeInventory.file_count
      directory_count = [int64]$treeInventory.directory_count
      inventory = @($treeInventory.entries)
    }
    $treePath = Assert-LayoutPath -Path (Join-Path $stagingRoot $treeManifestName) -Label ".NET SDK staged extracted-tree receipt"
    $treeTmp = Assert-LayoutPath -Path (Join-Path $stagingRoot (".dotnet-sdk-tree." + [guid]::NewGuid().ToString("N") + ".tmp")) -Label ".NET SDK temporary extracted-tree receipt"
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($treeTmp, ($treeManifest | ConvertTo-Json -Depth 20), $utf8)
    Move-Item -LiteralPath $treeTmp -Destination $treePath -Force
    $treeManifestSha256 = Get-Sha256Hash -Path $treePath
    $receipt = [ordered]@{
      schema = "fullmag.windows-installer-dotnet-sdk-receipt.v1"
      version = [string]$tool.version
      url = [string]$tool.url
      archive_sha512 = $expectedHash
      tree_manifest_name = $treeManifestName
      tree_manifest_sha256 = $treeManifestSha256
      tree_inventory_sha256 = [string]$treeInventory.inventory_sha256
      tree_file_count = [int64]$treeInventory.file_count
      tree_directory_count = [int64]$treeInventory.directory_count
      tool_root = [string]$root
      command = [string]$tool.command
      runtime_identifier = [string]$tool.runtime_identifier
    }
    $receiptPath = Assert-LayoutPath -Path (Join-Path $stagingRoot ([string]$tool.receipt_name)) -Label ".NET SDK staged receipt"
    $receiptTmp = Assert-LayoutPath -Path (Join-Path $stagingRoot (".dotnet-sdk-receipt." + [guid]::NewGuid().ToString("N") + ".tmp")) -Label ".NET SDK temporary receipt"
    [IO.File]::WriteAllText($receiptTmp, ($receipt | ConvertTo-Json -Depth 10), $utf8)
    Move-Item -LiteralPath $receiptTmp -Destination $receiptPath -Force
    if ((Get-Sha512Hash -Path $stagedArchive) -ne $expectedHash) {
      throw "Staged .NET SDK source archive hash does not match the pinned manifest"
    }
    $stagedReceipt = Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
    $stagedArchiveHash = ([string]$stagedReceipt.archive_sha512).ToLowerInvariant()
    if ([string]$stagedReceipt.schema -ne "fullmag.windows-installer-dotnet-sdk-receipt.v1" -or
        [string]$stagedReceipt.version -ne [string]$tool.version -or
        [string]$stagedReceipt.url -ne [string]$tool.url -or
        $stagedArchiveHash -ne $expectedHash -or
        [string]$stagedReceipt.command -ne [string]$tool.command -or
        -not [string]::Equals([string]$stagedReceipt.tool_root, $root, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Staged .NET SDK receipt failed provenance validation"
    }
    $null = Assert-DotnetTreeManifest -Root $stagingRoot -Tool $tool -Receipt $stagedReceipt -ExpectedArchiveSha512 $expectedHash
    [IO.Directory]::Move($stagingRoot, $root)
    $stagingRoot = $null
  }
  finally {
    if ($null -ne $tempRoot -and (Test-Path -LiteralPath $tempRoot)) {
      Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($null -ne $stagingRoot -and (Test-Path -LiteralPath $stagingRoot)) {
      Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($null -ne $lock) { $lock.Dispose() }
  }
}

function Initialize-StorageSession {
  $helper = Join-Path $script:RepoRoot "scripts\windows\installer_env.ps1"
  if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) { throw "Installer environment helper is missing: $helper" }
  . $helper
  $session = Get-FullmagInstallerEnvSession -CheckoutPath $script:RepoRoot -PythonCommand ([string]$script:PythonCommand.command)
  $values = @{}
  if (-not [string]::IsNullOrWhiteSpace($StorageRoot)) {
    $values["FULLMAG_PROJECT_STORAGE_ROOT"] = $StorageRoot
  }
  $preview = Get-FullmagInstallerEnvPreview -Session $session -Values $values
  if (-not $preview.valid) {
    $errors = (@($preview.errors | ForEach-Object { [string]$_ }) -join "; ")
    if ([string]::IsNullOrWhiteSpace($errors)) { $errors = "storage selection was rejected" }
    throw $errors
  }
  $script:Session = $session
  $script:StorageRootValue = [string]$preview.storage_root
  $script:Layout = Invoke-FullmagInstallerStorageResolve -Session $session -StorageRoot $script:StorageRootValue
}

function Get-InstallableStatus {
  param([Parameter(Mandatory = $true)][string]$Id, [Parameter(Mandatory = $true)][scriptblock]$Checker)
  try {
    $status = & $Checker
    if ($status.status -ne "pass" -and $Install) {
      try {
        switch ($Id) {
          "git" { Invoke-WingetInstall "git" }
          "python" { Invoke-WingetInstall "python" }
          "msvc_x86" { Invoke-WingetInstall "msvc_x86" }
          "windows_sdk" { Invoke-WingetInstall "windows_sdk" }
          "cmake" { Invoke-WingetInstall "cmake" }
          "dotnet_sdk" { Resolve-StorageWithCreate; Install-DotnetSdk }
          "wix3" { Resolve-StorageWithCreate; Install-Wix3 }
          default { throw "No installer is defined for $Id" }
        }
        $status = & $Checker
      }
      catch {
        $status = [pscustomobject]@{ status = "blocked"; detail = $_.Exception.Message; path = ""; version = $null }
      }
    }
    return $status
  }
  catch {
    return [pscustomobject]@{ status = "blocked"; detail = $_.Exception.Message; path = ""; version = $null }
  }
}

function Show-Report {
  $all = @($script:Results.ToArray())
  $blockers = @($all | Where-Object { $_.status -ne "pass" })
  $readiness = if ($blockers.Count -gt 0) { "blocked" } else { "producer_ready" }
  $dotnetResult = @($all | Where-Object { $_.id -eq "dotnet_sdk" }) | Select-Object -First 1
  $wixResult = @($all | Where-Object { $_.id -eq "wix3" }) | Select-Object -First 1
  $emptyDotnetToolPaths = [ordered]@{
    verified_dotnet_root = ""
    dotnet = ""
    sdk = ""
    receipt = ""
    archive = ""
  }
  $dotnetToolPaths = $emptyDotnetToolPaths
  if ($null -ne $dotnetResult -and $null -ne $dotnetResult.tool_paths) {
    $dotnetToolPaths = $dotnetResult.tool_paths
  }
  $emptyWixToolPaths = [ordered]@{
    verified_wix_root = ""
    receipt = ""
    archive = ""
    candle = ""
    light = ""
    heat = ""
    bal_extension = ""
    ui_extension = ""
  }
  $wixToolPaths = $emptyWixToolPaths
  if ($null -ne $wixResult -and $null -ne $wixResult.tool_paths) {
    $wixToolPaths = $wixResult.tool_paths
  }
  $report = [ordered]@{
    schema = "fullmag.windows-installer-build-environment-report.v1"
    mode = if ($Install) { "install" } else { "check" }
    readiness = $readiness
    repository = $script:RepoRoot
    main_checkout = if ($script:Session) { [string]$script:Session.main_checkout } else { "" }
    storage_root = $script:StorageRootValue
    storage_profile = if ($script:Session) { [string]$script:Session.storage_profile } else { "" }
    producer_tools = [ordered]@{
      dotnet_sdk = [ordered]@{
        status = if ($dotnetResult) { [string]$dotnetResult.status } else { "blocked" }
        version = if ($dotnetResult) { [string]$dotnetResult.version } else { "" }
        verified_dotnet_root = [string]$dotnetToolPaths.verified_dotnet_root
        tool_paths = $dotnetToolPaths
      }
      wix3 = [ordered]@{
        status = if ($wixResult) { [string]$wixResult.status } else { "blocked" }
        version = if ($wixResult) { [string]$wixResult.version } else { "" }
        verified_wix_root = [string]$wixToolPaths.verified_wix_root
        tool_paths = $wixToolPaths
      }
    }
    installation = [ordered]@{
      requested = [bool]$Install
      attempted = @($all | Where-Object { $_.install_attempted })
      note = if ($Install) { "Only explicitly requested system installs and project-owned WiX provisioning are attempted; source builds and runtime qualification are separate." } else { "Check-only mode; no installer or project-owned directory write was requested." }
    }
    excluded_from_this_bootstrap = @($script:Requirements.excluded_from_this_bootstrap)
    checks = $all
    blockers = @($blockers | ForEach-Object { $_.id + ": " + $_.detail })
    runtime = [ordered]@{
      status = "NOT VERIFIED"
      note = "This command checks producer prerequisites and WiX provenance; it does not build, install, execute, or scientifically qualify Fullmag."
    }
  }
  if ($Json) {
    $report | ConvertTo-Json -Depth 12
    return
  }
  Write-Host "Fullmag Windows installer producer environment: $($report.mode)"
  Write-Host "Repository: $($report.repository)"
  if ($report.main_checkout) { Write-Host "Main checkout: $($report.main_checkout)" }
  if ($report.storage_root) { Write-Host "Storage: $($report.storage_root) (profile $($report.storage_profile))" }
  Write-Host "Readiness: $($report.readiness)"
  foreach ($item in $all) {
    $line = "[{0}] {1}" -f $item.status.ToUpperInvariant(), $item.id
    if ($item.version) { $line += " $($item.version)" }
    if ($item.detail) { $line += " - $($item.detail)" }
    Write-Host $line
  }
  Write-Host "Fullmag runtime and physics qualification: NOT VERIFIED"
  if ($blockers.Count -gt 0) {
    Write-Host "Blockers:"
    foreach ($blocker in $blockers) { Write-Host ("- " + $blocker.id + ": " + $blocker.detail) }
  }
}

try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw "This producer setup route is Windows-only and refuses WSL/Linux fallback."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $script:RepoRoot ".git"))) {
    throw "Git metadata is missing from the copied checkout; refusing git init or provenance fallback."
  }
  $script:Requirements = Read-Requirements

  $gitStatus = Get-InstallableStatus -Id "git" -Checker { Get-GitStatus }
  Add-Result -Id "git" -Status ([string]$gitStatus.status) -Version ([string]$gitStatus.version) -Path ([string]$gitStatus.path) -Detail ([string]$gitStatus.detail)

  $pythonStatus = Get-InstallableStatus -Id "python" -Checker { Get-PythonStatus }
  Add-Result -Id "python" -Status ([string]$pythonStatus.status) -Version ([string]$pythonStatus.version) -Path ([string]$pythonStatus.path) -Detail ([string]$pythonStatus.detail)

  $storageStatus = $null
  if ($gitStatus.status -eq "pass" -and $pythonStatus.status -eq "pass") {
    $script:PythonCommand = Get-PythonCommand
    try {
      Initialize-StorageSession
      $storageStatus = [pscustomobject]@{ status = "pass"; path = $script:StorageRootValue; version = ""; detail = "Main checkout, .env and storage resolver were admitted before project-owned writes" }
    }
    catch {
      $storageStatus = [pscustomobject]@{ status = "blocked"; path = ""; version = $null; detail = $_.Exception.Message }
    }
  }
  else {
    $missing = @()
    if ($gitStatus.status -ne "pass") { $missing += "Git" }
    if ($pythonStatus.status -ne "pass") { $missing += "Python >=3.12" }
    $storageStatus = [pscustomobject]@{ status = "blocked"; path = ""; version = $null; detail = ("Storage/session discovery waits for: " + ($missing -join ", ")) }
  }
  Add-Result -Id "storage_session" -Status ([string]$storageStatus.status) -Version ([string]$storageStatus.version) -Path ([string]$storageStatus.path) -Detail ([string]$storageStatus.detail)

  $msvcStatus = Get-InstallableStatus -Id "msvc_x86" -Checker { Get-MsvcStatus }
  Add-Result -Id "msvc_x86" -Status ([string]$msvcStatus.status) -Version ([string]$msvcStatus.version) -Path ([string]$msvcStatus.path) -Detail ([string]$msvcStatus.detail) -Scope "compiler"

  $sdkStatus = Get-InstallableStatus -Id "windows_sdk" -Checker { Get-WindowsSdkStatus }
  Add-Result -Id "windows_sdk" -Status ([string]$sdkStatus.status) -Version ([string]$sdkStatus.version) -Path ([string]$sdkStatus.path) -Detail ([string]$sdkStatus.detail) -Scope "compiler"

  $cmakeStatus = Get-InstallableStatus -Id "cmake" -Checker { Get-CmakeStatus }
  Add-Result -Id "cmake" -Status ([string]$cmakeStatus.status) -Version ([string]$cmakeStatus.version) -Path ([string]$cmakeStatus.path) -Detail ([string]$cmakeStatus.detail) -Scope "compiler"

  $dotnetStatus = Get-InstallableStatus -Id "dotnet_sdk" -Checker { Get-DotnetStatus }
  Add-Result -Id "dotnet_sdk" -Status ([string]$dotnetStatus.status) -Version ([string]$dotnetStatus.version) -Path ([string]$dotnetStatus.path) -Detail ([string]$dotnetStatus.detail) -Scope "packaging" -ToolPaths $dotnetStatus.tool_paths

  $wixStatus = Get-InstallableStatus -Id "wix3" -Checker { Get-WixStatus }
  Add-Result -Id "wix3" -Status ([string]$wixStatus.status) -Version ([string]$wixStatus.version) -Path ([string]$wixStatus.path) -Detail ([string]$wixStatus.detail) -Scope "packaging" -ToolPaths $wixStatus.tool_paths

  Show-Report
  $ok = @($script:Results.ToArray() | Where-Object { $_.status -ne "pass" }).Count -eq 0
  if (-not $ok) { exit 2 }
  exit 0
}
catch {
  Add-Result -Id "bootstrap" -Status "blocked" -Detail ([string]$_.Exception.Message)
  Show-Report
  exit 2
}
