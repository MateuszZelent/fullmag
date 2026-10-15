# Helpers for the single physical native FEM GPU package that advertises the
# four selectable runtime capabilities.  Loading this file performs no build
# or runtime operation; run_fullmag.ps1 owns the managed operation and calls
# these functions only after the physical FEM manifest is complete.

function Get-FullmagFullPackageSha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  return ([string](Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash).ToLowerInvariant()
}

function Test-FullmagFullPackagePathWithin {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Root
  )
  $candidate = [System.IO.Path]::GetFullPath($Path)
  $rootPath = [System.IO.Path]::GetFullPath($Root)
  if ([string]::Equals($candidate, $rootPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $true
  }
  $prefix = $rootPath.TrimEnd([char[]]'\/') + [System.IO.Path]::DirectorySeparatorChar
  return $candidate.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-FullmagFullPackagePathChain {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Label,
    [switch]$AllowMissingLeaf
  )
  $rootPath = [System.IO.Path]::GetFullPath($Root)
  if (-not (Test-Path -LiteralPath $rootPath -PathType Container)) {
    throw "$Label canonical root is missing: $rootPath"
  }
  $rootItem = Get-Item -LiteralPath $rootPath -Force -ErrorAction Stop
  if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$Label canonical root is a reparse point: $rootPath"
  }
  $resolved = [System.IO.Path]::GetFullPath($Path)
  if (-not (Test-FullmagFullPackagePathWithin -Path $resolved -Root $rootPath)) {
    throw "$Label escapes its canonical package root: $resolved"
  }
  $cursor = $resolved
  while (-not [string]::Equals($cursor, $rootPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label has a reparse-point ancestor or destination: $cursor"
      }
    }
    elseif (-not $AllowMissingLeaf) {
      throw "$Label is missing: $cursor"
    }
    $parent = Split-Path -Parent $cursor
    if (-not $parent -or [string]::Equals($parent, $cursor, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "$Label has no safe canonical ancestor: $resolved"
    }
    $cursor = [System.IO.Path]::GetFullPath($parent)
  }
  return $resolved
}

function Assert-FullmagFullPackageFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter()][string]$Root
  )
  if ($Root) {
    Assert-FullmagFullPackagePathChain -Path $Path -Root $Root -Label $Label | Out-Null
  }
  if (-not [System.IO.Path]::IsPathRooted($Path) -or
      -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label is missing: $Path"
  }
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$Label is a reparse point: $Path"
  }
  if ($item.Length -le 0) { throw "$Label is empty: $Path" }
  return $item
}

function Assert-FullmagFullPackageDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if (-not [System.IO.Path]::IsPathRooted($Path) -or
      -not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "$Label is missing: $Path"
  }
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$Label is a reparse point: $Path"
  }
  $cursor = [System.IO.Path]::GetFullPath($Path)
  while ($true) {
    $parent = Split-Path -Parent $cursor
    if (-not $parent -or [string]::Equals($parent, $cursor, [System.StringComparison]::OrdinalIgnoreCase)) {
      break
    }
    $ancestor = Get-Item -LiteralPath $parent -Force -ErrorAction Stop
    if (($ancestor.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label has a reparse-point ancestor: $parent"
    }
    $cursor = $parent
  }
  return $item
}

function Get-FullmagFullPackageArtifact {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][string]$Root
  )
  $item = Assert-FullmagFullPackageFile -Path $Path -Label $Label -Root $Root
  return [ordered]@{
    path = [System.IO.Path]::GetFullPath($Path)
    size_bytes = [int64]$item.Length
    sha256 = Get-FullmagFullPackageSha256 -Path $Path
  }
}

function Get-FullmagFullPackageCanonicalRuntimeNames {
  [CmdletBinding()]
  param(
    [switch]$IncludeDesktop,
    [Parameter()][string]$ToolsRoot = ""
  )
  # runtime_bundle.py is the single Cargo-to-public-runtime inventory.  The
  # browser workspace deliberately omits only the desktop/Tauri executable.
  if ([string]::IsNullOrWhiteSpace($ToolsRoot)) {
    $toolsRootCommand = Get-Command "Get-WindowsBuildToolsRoot" -CommandType Function -ErrorAction SilentlyContinue
    $runtimeBundleRoot = if ($null -ne $toolsRootCommand) {
      [string](Get-WindowsBuildToolsRoot)
    } else {
      $PSScriptRoot
    }
  } else {
    $runtimeBundleRoot = [System.IO.Path]::GetFullPath($ToolsRoot)
  }
  Assert-FullmagFullPackageDirectory -Path $runtimeBundleRoot `
    -Label "canonical runtime inventory tools root" | Out-Null
  $runtimeBundle = Join-Path $runtimeBundleRoot "runtime_bundle.py"
  Assert-FullmagFullPackageFile -Path $runtimeBundle `
    -Label "canonical runtime inventory" -Root $runtimeBundleRoot | Out-Null
  $python = Get-Command "python.exe" -ErrorAction SilentlyContinue
  if ($null -eq $python) { $python = Get-Command "python" -ErrorAction SilentlyContinue }
  if ($null -eq $python) { throw "Python is required to read the canonical runtime inventory" }
  $pythonPath = if ($python.Source) { [string]$python.Source } else { [string]$python.Name }
  $scriptsRoot = Split-Path -Parent $runtimeBundle
  $code = "import sys; sys.path.insert(0, sys.argv[1]); from runtime_bundle import BINARY_NAMES; print('\n'.join(BINARY_NAMES))"
  $output = @(& $pythonPath -B -c $code $scriptsRoot 2>&1)
  if ($LASTEXITCODE -ne 0) { throw "Canonical runtime inventory failed: $($output -join [Environment]::NewLine)" }
  $names = @($output | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
  if ($names.Count -eq 0 -or @($names | Where-Object { $_ -notmatch '^[A-Za-z0-9][A-Za-z0-9.-]*\.exe$' }).Count -ne 0) {
    throw "Canonical runtime inventory contains an invalid executable name"
  }
  if (@($names | Sort-Object -Unique).Count -ne $names.Count) {
    throw "Canonical runtime inventory contains duplicate executable names"
  }
  if (-not $IncludeDesktop) { $names = @($names | Where-Object { $_ -ine "fullmag-ui.exe" }) }
  if ($names.Count -eq 0) { throw "Canonical runtime inventory is empty after workspace filtering" }
  return $names
}

function Get-FullmagFullPackageRuntimeFamilyInventorySha256 {
  param([Parameter(Mandatory = $true)][object[]]$Artifacts)
  # The caller supplies runtime_bundle.BINARY_NAMES order.  Preserve it: the
  # Windows PowerShell culture sort is not byte/ordinal stable across hosts.
  $lines = @($Artifacts | ForEach-Object {
    if ([string]$_.name -notmatch '^[A-Za-z0-9][A-Za-z0-9.-]*\.exe$' -or
        [int64]$_.size_bytes -le 0 -or [string]$_.sha256 -notmatch '^[0-9a-f]{64}$') {
      throw "Runtime family artifact identity is malformed"
    }
    "{0}|{1}|{2}" -f ([string]$_.name), ([int64]$_.size_bytes), ([string]$_.sha256).ToLowerInvariant()
  })
  $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes(($lines -join "`n") + "`n")
  return ([System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes) | ForEach-Object { $_.ToString("x2") }) -join ""
}

function Assert-FullmagFullPackageRuntimeFamily {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][object]$NativeFem,
    [Parameter(Mandatory = $true)][bool]$BrowserWorkspace,
    [Parameter(Mandatory = $true)][string]$BuildRoot,
    [Parameter()][string]$ToolsRoot = ""
  )
  foreach ($name in @("runtime_family_root", "runtime_family", "runtime_family_inventory", "runtime_family_inventory_sha256", "dependency_audit_path", "dependency_audit_sha256")) {
    if ($null -eq $NativeFem.PSObject.Properties[$name] -or $null -eq $NativeFem.$name) {
      throw "Native FEM manifest is missing runtime family proof: $name"
    }
  }
  $root = Assert-FullmagFullPackageDirectory -Path ([string]$NativeFem.runtime_family_root) `
    -Label "native FEM runtime family root"
  $expectedNames = @(Get-FullmagFullPackageCanonicalRuntimeNames `
    -IncludeDesktop:(-not $BrowserWorkspace) -ToolsRoot $ToolsRoot)
  $declaredNames = @($NativeFem.runtime_family_inventory | ForEach-Object { [string]$_ })
  $declaredRecords = @($NativeFem.runtime_family)
  if ($declaredNames.Count -ne $expectedNames.Count -or
      $declaredRecords.Count -ne $expectedNames.Count -or
      ((@($declaredNames | Sort-Object) -join ",") -ne (@($expectedNames | Sort-Object) -join ","))) {
    throw "Native FEM runtime family inventory does not match the canonical runtime inventory"
  }
  $artifacts = @()
  foreach ($name in $expectedNames) {
    $record = @($NativeFem.runtime_family | Where-Object { [string]$_.name -eq $name })
    if ($record.Count -ne 1) { throw "Native FEM runtime family is missing $name" }
    $path = [System.IO.Path]::GetFullPath([string]$record[0].path)
    if ([System.IO.Path]::GetFileName($path) -cne $name -or
        [System.IO.Path]::GetFullPath((Split-Path -Parent $path)) -ine [System.IO.Path]::GetFullPath($root)) {
      throw "Native FEM runtime family path is not rooted at the declared family root: $name"
    }
    $artifact = Get-FullmagFullPackageArtifact -Path $path -Label "native FEM runtime family $name" -Root $BuildRoot
    if ([int64]$record[0].size_bytes -ne [int64]$artifact.size_bytes -or
        [string]$record[0].sha256 -ne [string]$artifact.sha256) {
      throw "Native FEM runtime family artifact changed: $name"
    }
    $artifacts += [ordered]@{ name = $name; path = $artifact.path; size_bytes = $artifact.size_bytes; sha256 = $artifact.sha256 }
  }
  if ((Get-FullmagFullPackageRuntimeFamilyInventorySha256 -Artifacts $artifacts) -ne [string]$NativeFem.runtime_family_inventory_sha256) {
    throw "Native FEM runtime family inventory hash mismatch"
  }
  $audit = Get-FullmagFullPackageArtifact -Path ([string]$NativeFem.dependency_audit_path) `
    -Label "native FEM PE dependency audit" -Root $BuildRoot
  if ([string]$audit.sha256 -ne [string]$NativeFem.dependency_audit_sha256) {
    throw "Native FEM PE dependency audit hash mismatch"
  }
  try {
    $auditReport = Get-Content -LiteralPath $audit.path -Raw -Encoding UTF8 |
      ConvertFrom-Json -ErrorAction Stop
  }
  catch {
    throw "Native FEM PE dependency audit is not valid JSON: $($audit.path)"
  }
  if ([int]$auditReport.schema_version -ne 1 -or
      [string]$auditReport.target -ne "x86_64-pc-windows-msvc" -or
      [string]$auditReport.scope -ne "bin_pe_static_and_delay_imports" -or
      $null -eq $auditReport.images) {
    throw "Native FEM PE dependency audit has an incompatible schema: $($audit.path)"
  }
  $auditedImages = @{}
  foreach ($image in @($auditReport.images)) {
    $relative = [string]$image.path
    if ($relative -notmatch '^bin[\\/][^\\/]+$' -or
        [string]$image.sha256 -notmatch '^[0-9a-f]{64}$') {
      throw "Native FEM PE dependency audit contains an invalid image record"
    }
    $key = $relative.Substring(4).ToLowerInvariant()
    if ($auditedImages.ContainsKey($key)) {
      throw "Native FEM PE dependency audit contains a duplicate image: $key"
    }
    $auditedImages[$key] = [string]$image.sha256
  }
  foreach ($artifact in $artifacts) {
    $key = ([System.IO.Path]::GetFileName([string]$artifact.path)).ToLowerInvariant()
    if (-not $auditedImages.ContainsKey($key) -or
        $auditedImages[$key] -ne ([string]$artifact.sha256).ToLowerInvariant()) {
      throw "Native FEM PE dependency audit does not cover runtime family binary: $key"
    }
  }
  return [ordered]@{
    root = [System.IO.Path]::GetFullPath($root)
    names = $expectedNames
    artifacts = $artifacts
    inventory_sha256 = [string]$NativeFem.runtime_family_inventory_sha256
    dependency_audit_path = $audit.path
    dependency_audit_sha256 = $audit.sha256
  }
}

function Write-FullmagFullPackageJsonAtomic {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][object]$Value,
    [Parameter(Mandatory = $true)][string]$PackageRoot
  )
  $rootPath = [System.IO.Path]::GetFullPath($PackageRoot)
  Assert-FullmagFullPackageDirectory -Path $rootPath -Label "full capability write root" | Out-Null
  $resolvedPath = Assert-FullmagFullPackagePathChain -Path $Path -Root $rootPath `
    -Label "full capability JSON destination" -AllowMissingLeaf
  $parent = Split-Path -Parent $resolvedPath
  Assert-FullmagFullPackagePathChain -Path $parent -Root $rootPath `
    -Label "full capability JSON parent" -AllowMissingLeaf | Out-Null
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  Assert-FullmagFullPackagePathChain -Path $parent -Root $rootPath `
    -Label "full capability JSON parent" | Out-Null
  $temporary = "$resolvedPath.tmp-$([Guid]::NewGuid().ToString('N'))"
  try {
    Assert-FullmagFullPackagePathChain -Path $temporary -Root $rootPath `
      -Label "full capability JSON temporary destination" -AllowMissingLeaf | Out-Null
    $json = $Value | ConvertTo-Json -Depth 30
    [System.IO.File]::WriteAllText(
      $temporary,
      $json + [Environment]::NewLine,
      [System.Text.UTF8Encoding]::new($false)
    )
    Assert-FullmagFullPackageFile -Path $temporary -Label "full capability JSON temporary file" -Root $rootPath | Out-Null
    # Check the destination immediately before replacement.  Existing regular
    # files are replaceable; a reparse destination is always refused.
    Assert-FullmagFullPackagePathChain -Path $resolvedPath -Root $rootPath `
      -Label "full capability JSON destination" -AllowMissingLeaf | Out-Null
    Move-Item -LiteralPath $temporary -Destination $resolvedPath -Force
    Assert-FullmagFullPackageFile -Path $resolvedPath -Label "full capability JSON output" -Root $rootPath | Out-Null
  }
  finally {
    if (Test-Path -LiteralPath $temporary -PathType Leaf) {
      $temporaryItem = Get-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
      if ($null -ne $temporaryItem -and
          ($temporaryItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
      }
    }
  }
}

function Get-FullmagFullPackageProperty {
  param(
    [Parameter(Mandatory = $true)][object]$Object,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value) {
    throw "$Label is missing from the physical FEM manifest"
  }
  return $property.Value
}

function New-FullmagFullRuntimeComponent {
  param(
    [Parameter(Mandatory = $true)][string]$Component,
    [Parameter(Mandatory = $true)][string]$Backend,
    [Parameter(Mandatory = $true)][string]$Device,
    [Parameter(Mandatory = $true)][bool]$RequiresNvidiaDriver,
    [Parameter(Mandatory = $true)][object[]]$Artifacts,
    [Parameter(Mandatory = $true)][string]$ComponentRoot,
    [Parameter(Mandatory = $true)][string]$PackageRoot,
    [Parameter(Mandatory = $true)][string]$OriginManifestPath,
    [Parameter(Mandatory = $true)][string]$OriginManifestSha256,
    [Parameter(Mandatory = $true)][object]$SourceIdentity,
    [Parameter(Mandatory = $true)][string]$SourceSnapshotSha256,
    [Parameter(Mandatory = $true)][string]$AttemptId
  )
  Assert-FullmagFullPackagePathChain -Path $ComponentRoot -Root $PackageRoot `
    -Label "full capability component output" | Out-Null
  Assert-FullmagFullPackageDirectory -Path $ComponentRoot `
    -Label "full capability component output" | Out-Null
  $componentManifestPath = Join-Path $ComponentRoot "$Component.manifest.json"
  $receiptPath = Join-Path $ComponentRoot "$Component.receipt.json"
  $componentManifest = [ordered]@{
    schema = "fullmag.windows-runtime-component.v1"
    component = $Component
    backend = $Backend
    device = $Device
    installed_support = $true
    requires_nvidia_driver = $RequiresNvidiaDriver
    origin_manifest_path = $OriginManifestPath
    origin_manifest_sha256 = $OriginManifestSha256
    source_identity = $SourceIdentity
    source_snapshot_sha256 = $SourceSnapshotSha256
    attempt_id = $AttemptId
    artifacts = @($Artifacts)
    receipt_path = [System.IO.Path]::GetFullPath($receiptPath)
  }
  Write-FullmagFullPackageJsonAtomic -Path $componentManifestPath -Value $componentManifest `
    -PackageRoot $PackageRoot
  $componentManifestSha256 = Get-FullmagFullPackageSha256 -Path $componentManifestPath
  $receipt = [ordered]@{
    schema = "fullmag.windows-runtime-component-receipt.v1"
    component = $Component
    backend = $Backend
    device = $Device
    installed_support = $true
    requires_nvidia_driver = $RequiresNvidiaDriver
    component_manifest_path = [System.IO.Path]::GetFullPath($componentManifestPath)
    component_manifest_sha256 = $componentManifestSha256
    origin_manifest_path = $OriginManifestPath
    origin_manifest_sha256 = $OriginManifestSha256
    source_snapshot_sha256 = $SourceSnapshotSha256
    attempt_id = $AttemptId
  }
  Write-FullmagFullPackageJsonAtomic -Path $receiptPath -Value $receipt `
    -PackageRoot $PackageRoot
  return [ordered]@{
    backend = $Backend
    device = $Device
    installed_support = $true
    requires_nvidia_driver = $RequiresNvidiaDriver
    component_manifest_path = [System.IO.Path]::GetFullPath($componentManifestPath)
    component_manifest_sha256 = $componentManifestSha256
    receipt_path = [System.IO.Path]::GetFullPath($receiptPath)
    receipt_sha256 = Get-FullmagFullPackageSha256 -Path $receiptPath
    artifacts = @($Artifacts)
  }
}

function New-FullmagFullRuntimeManifest {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$OutputRoot,
    [Parameter(Mandatory = $true)][string]$ManifestPath,
    [Parameter(Mandatory = $true)][string]$OriginManifestPath,
    [Parameter(Mandatory = $true)][string]$FullmagExe,
    [Parameter(Mandatory = $true)][string]$FullmagApiExe,
    [Parameter(Mandatory = $true)][string]$NativeFdmDll,
    [Parameter(Mandatory = $true)][string]$NativeFemDll,
    [Parameter(Mandatory = $true)][string]$SourceCommit,
    [Parameter(Mandatory = $true)][string]$SourceSnapshotSha256,
    [Parameter(Mandatory = $true)][string]$AttemptId,
    [Parameter()][string]$BuildRoot = "",
    [Parameter()][string]$ToolsRoot = ""
  )
  $outputRootPath = [System.IO.Path]::GetFullPath($OutputRoot)
  $buildRootPath = if ([string]::IsNullOrWhiteSpace($BuildRoot)) {
    [System.IO.Path]::GetFullPath((Split-Path -Parent $outputRootPath))
  } else {
    [System.IO.Path]::GetFullPath($BuildRoot)
  }
  Assert-FullmagFullPackageDirectory -Path $buildRootPath `
    -Label "full capability build root" | Out-Null
  $manifestPathResolved = [System.IO.Path]::GetFullPath($ManifestPath)
  $expectedManifestPath = [System.IO.Path]::GetFullPath(
    (Join-Path $outputRootPath "build-manifest.json")
  )
  if (-not [string]::Equals($manifestPathResolved, $expectedManifestPath,
      [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "full capability manifest must be build-manifest.json inside its package root"
  }
  if (-not (Test-FullmagFullPackagePathWithin -Path $manifestPathResolved -Root $outputRootPath)) {
    throw "full capability manifest destination escapes its package root"
  }
  Assert-FullmagFullPackagePathChain -Path $outputRootPath -Root $buildRootPath `
    -Label "full capability output root" -AllowMissingLeaf | Out-Null
  if (Test-Path -LiteralPath $outputRootPath) {
    if (-not (Test-Path -LiteralPath $outputRootPath -PathType Container)) {
      throw "full capability output root is not a directory: $outputRootPath"
    }
  } else {
    New-Item -ItemType Directory -Force -Path $outputRootPath | Out-Null
  }
  Assert-FullmagFullPackageDirectory -Path $outputRootPath `
    -Label "full capability output root" | Out-Null
  Assert-FullmagFullPackagePathChain -Path $manifestPathResolved -Root $outputRootPath `
    -Label "full capability manifest destination" -AllowMissingLeaf | Out-Null
  $originItem = Assert-FullmagFullPackageFile -Path $OriginManifestPath `
    -Label "physical FEM manifest" -Root $buildRootPath
  $physical = Get-Content -LiteralPath $OriginManifestPath -Raw -Encoding UTF8 |
    ConvertFrom-Json -ErrorAction Stop
  if ([string]$physical.schema_version -ne "1" -or
      [string]$physical.backend -ne "fem" -or
      [string]$physical.state -ne "completed" -or
      [bool]$physical.cuda -ne $true -or
      $null -eq $physical.native_fem -or
      [string]$physical.native_fem.device -ne "gpu" -or
      [bool]$physical.native_fem.strict_gpu -ne $true) {
    throw "The full capability package requires a completed strict FEM GPU origin manifest"
  }
  if ([string]$physical.source_commit_after -ne $SourceCommit -or
      [string]$physical.source_snapshot_sha256_after -ne $SourceSnapshotSha256) {
    throw "The physical FEM manifest source identity does not match the full capability package"
  }
  if ([string]$physical.native_fem_attempt_id -ne $AttemptId) {
    throw "The physical FEM manifest attempt identity does not match the full capability package"
  }
  if ($physical.browser_workspace -isnot [bool]) {
    throw "The physical FEM manifest is missing its browser workspace marker"
  }
  if ($SourceSnapshotSha256 -notmatch '^[0-9a-f]{64}$' -or
      $AttemptId -notmatch '^[0-9a-f]{32}$') {
    throw "The full capability package source identity is malformed"
  }
  $originPath = [System.IO.Path]::GetFullPath($OriginManifestPath)
  $originSha256 = Get-FullmagFullPackageSha256 -Path $OriginManifestPath
  $baseArtifacts = @(
    Get-FullmagFullPackageArtifact -Path $FullmagExe -Label "Fullmag executable" -Root $buildRootPath
    Get-FullmagFullPackageArtifact -Path $FullmagApiExe -Label "Fullmag API executable" -Root $buildRootPath
  )
  $fdmArtifact = Get-FullmagFullPackageArtifact -Path $NativeFdmDll `
    -Label "native FDM DLL" -Root $buildRootPath
  $femArtifact = Get-FullmagFullPackageArtifact -Path $NativeFemDll `
    -Label "native FEM DLL" -Root $buildRootPath
  $runtimeFamilyProof = Assert-FullmagFullPackageRuntimeFamily `
    -NativeFem $physical.native_fem -BrowserWorkspace ([bool]$physical.browser_workspace) `
    -BuildRoot $buildRootPath -ToolsRoot $ToolsRoot
  $componentsRoot = Join-Path $outputRootPath "components"
  Assert-FullmagFullPackagePathChain -Path $componentsRoot -Root $outputRootPath `
    -Label "full capability component root" -AllowMissingLeaf | Out-Null
  if (Test-Path -LiteralPath $componentsRoot) {
    if (-not (Test-Path -LiteralPath $componentsRoot -PathType Container)) {
      throw "full capability component root is not a directory: $componentsRoot"
    }
    Assert-FullmagFullPackageDirectory -Path $componentsRoot `
      -Label "full capability component root" | Out-Null
  }
  else {
    New-Item -ItemType Directory -Force -Path $componentsRoot | Out-Null
    Assert-FullmagFullPackageDirectory -Path $componentsRoot `
      -Label "full capability component root" | Out-Null
  }
  # Component proofs are immutable attempt records.  The aggregate manifest is
  # the only publication switch; retaining older attempt directories preserves
  # rollback evidence and avoids deleting files referenced by an older receipt.
  $componentRoot = Join-Path $componentsRoot $AttemptId
  Assert-FullmagFullPackagePathChain -Path $componentRoot -Root $outputRootPath `
    -Label "full capability component attempt" -AllowMissingLeaf | Out-Null
  if (Test-Path -LiteralPath $componentRoot) {
    throw "Full capability component attempt already exists: $AttemptId"
  }
  New-Item -ItemType Directory -Force -Path $componentRoot | Out-Null
  Assert-FullmagFullPackageDirectory -Path $componentRoot -Label "full capability component attempt" | Out-Null
  $sourceIdentity = [ordered]@{
    head_commit_full = $SourceCommit
    source_snapshot_sha256 = $SourceSnapshotSha256
    source_worktree_state = [string]$physical.source_worktree_state_after
  }
  $components = [ordered]@{}
  $components.fdm_cpu = New-FullmagFullRuntimeComponent `
    -Component "fdm_cpu" -Backend "fdm" -Device "cpu" -RequiresNvidiaDriver:$false `
    -Artifacts @($baseArtifacts + $fdmArtifact) -ComponentRoot $componentRoot `
    -PackageRoot $outputRootPath -OriginManifestPath $originPath -OriginManifestSha256 $originSha256 `
    -SourceIdentity $sourceIdentity -SourceSnapshotSha256 $SourceSnapshotSha256 -AttemptId $AttemptId
  $components.fdm_gpu = New-FullmagFullRuntimeComponent `
    -Component "fdm_gpu" -Backend "fdm" -Device "gpu" -RequiresNvidiaDriver:$true `
    -Artifacts @($baseArtifacts + $fdmArtifact) -ComponentRoot $componentRoot `
    -PackageRoot $outputRootPath -OriginManifestPath $originPath -OriginManifestSha256 $originSha256 `
    -SourceIdentity $sourceIdentity -SourceSnapshotSha256 $SourceSnapshotSha256 -AttemptId $AttemptId
  $components.fem_cpu = New-FullmagFullRuntimeComponent `
    -Component "fem_cpu" -Backend "fem" -Device "cpu" -RequiresNvidiaDriver:$false `
    -Artifacts @($baseArtifacts + $femArtifact) -ComponentRoot $componentRoot `
    -PackageRoot $outputRootPath -OriginManifestPath $originPath -OriginManifestSha256 $originSha256 `
    -SourceIdentity $sourceIdentity -SourceSnapshotSha256 $SourceSnapshotSha256 -AttemptId $AttemptId
  $components.fem_gpu = New-FullmagFullRuntimeComponent `
    -Component "fem_gpu" -Backend "fem" -Device "gpu" -RequiresNvidiaDriver:$true `
    -Artifacts @($baseArtifacts + $femArtifact) -ComponentRoot $componentRoot `
    -PackageRoot $outputRootPath -OriginManifestPath $originPath -OriginManifestSha256 $originSha256 `
    -SourceIdentity $sourceIdentity -SourceSnapshotSha256 $SourceSnapshotSha256 -AttemptId $AttemptId
  $manifestMetadata = [ordered]@{
    # Keep the aggregate consumable by the existing workspace handoff.  The
    # physical FEM manifest remains the origin of truth; these fields are a
    # copied, hash-bound view of the already-built workspace metadata.
    schema_version = 1
    target_triple = [string]$physical.target_triple
    compiler_profile = [string]$physical.compiler_profile
    backend = "auto"
    cuda = [bool]$physical.cuda
    features = @($physical.features)
    native_fdm_dll = [string]$physical.native_fdm_dll
    native_fem = $physical.native_fem
    runtime_family_root = [string]$runtimeFamilyProof.root
    runtime_family = @($runtimeFamilyProof.artifacts)
    runtime_family_inventory = @($runtimeFamilyProof.names)
    runtime_family_inventory_sha256 = [string]$runtimeFamilyProof.inventory_sha256
    runtime_family_dependency_audit_path = [string]$runtimeFamilyProof.dependency_audit_path
    runtime_family_dependency_audit_sha256 = [string]$runtimeFamilyProof.dependency_audit_sha256
    workspace_namespace = [string]$physical.workspace_namespace
    cuda_bin = [string]$physical.cuda_bin
    cargo_target_dir = [string]$physical.cargo_target_dir
    cache_root = [string]$physical.cache_root
    git_commit = [string]$physical.git_commit
    worktree_state = [string]$physical.worktree_state
    build_version = $physical.build_version
    build_version_file = [string]$physical.build_version_file
    build_version_file_sha256 = [string]$physical.build_version_file_sha256
    installed_python_version = [string]$physical.installed_python_version
    python_sync_required = [bool]$physical.python_sync_required
    executable_sha256 = $physical.executable_sha256
    dependency_source_sha256 = [string]$physical.dependency_source_sha256
    backend_source_sha256 = [string]$physical.backend_source_sha256
    build_source_snapshot = $physical.build_source_snapshot
    volatile_build_storage = $physical.volatile_build_storage
    frontend_source_sha256 = [string]$physical.frontend_source_sha256
    frontend_mode = [string]$physical.frontend_mode
    frontend_workspace_root = [string]$physical.frontend_workspace_root
    frontend_cache_root = [string]$physical.frontend_cache_root
    frontend_source_manifest = [string]$physical.frontend_source_manifest
    frontend_source_manifest_sha256 = [string]$physical.frontend_source_manifest_sha256
    ui_host = [string]$physical.ui_host
    workspace_mode = [string]$physical.workspace_mode
    browser_workspace = [bool]$physical.browser_workspace
    frontend_entry_path = [string]$physical.frontend_entry_path
    frontend_entry_sha256 = [string]$physical.frontend_entry_sha256
    source_identity_check = [string]$physical.source_identity_check
    local_changes_check = [string]$physical.local_changes_check
    source_commit_after = [string]$physical.source_commit_after
    source_worktree_state_after = [string]$physical.source_worktree_state_after
    source_snapshot_sha256_after = [string]$physical.source_snapshot_sha256_after
    node_version = [string]$physical.node_version
    pnpm_version = [string]$physical.pnpm_version
    static_web_sha256 = [string]$physical.static_web_sha256
    desktop_binary_sha256 = [string]$physical.desktop_binary_sha256
    built_at_utc = [string]$physical.built_at_utc
  }
  $manifest = [ordered]@{
    schema = "fullmag.windows-full-capability-package.v1"
    state = "completed"
    profile = "windows-native-fem-gpu"
    requested_backend = "auto"
    requested_device = "auto"
    runtime_selection = "ui"
    origin_manifest_path = $originPath
    origin_manifest_sha256 = $originSha256
    source_identity = $sourceIdentity
    source_snapshot_sha256 = $SourceSnapshotSha256
    attempt_id = $AttemptId
    binary = [System.IO.Path]::GetFullPath($FullmagExe)
    binary_sha256 = $baseArtifacts[0].sha256
    api_binary = [System.IO.Path]::GetFullPath($FullmagApiExe)
    api_binary_sha256 = $baseArtifacts[1].sha256
    native_fdm_dll = [System.IO.Path]::GetFullPath($NativeFdmDll)
    native_fdm_dll_sha256 = $fdmArtifact.sha256
    native_fem_dll = [System.IO.Path]::GetFullPath($NativeFemDll)
    native_fem_dll_sha256 = $femArtifact.sha256
    runtime_environment = [ordered]@{
      FULLMAG_FDM_EXECUTION = $null
      FULLMAG_FEM_EXECUTION = $null
      FULLMAG_RELAX_DEVICE = $null
    }
    components = $components
  }
  foreach ($entry in $manifestMetadata.GetEnumerator()) {
    $manifest[$entry.Key] = $entry.Value
  }
  Write-FullmagFullPackageJsonAtomic -Path $manifestPathResolved -Value $manifest `
    -PackageRoot $outputRootPath
  return (Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop)
}

function Assert-FullmagFullRuntimeManifest {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$ManifestPath,
    [Parameter(Mandatory = $true)][string]$OriginManifestPath,
    [Parameter(Mandatory = $true)][string]$FullmagExe,
    [Parameter(Mandatory = $true)][string]$FullmagApiExe,
    [Parameter(Mandatory = $true)][string]$NativeFdmDll,
    [Parameter(Mandatory = $true)][string]$NativeFemDll,
    [Parameter(Mandatory = $true)][string]$ExpectedBuildId,
    [Parameter(Mandatory = $true)][string]$SourceCommit,
    [Parameter(Mandatory = $true)][string]$SourceSnapshotSha256,
    [Parameter(Mandatory = $true)][string]$AttemptId,
    [Parameter()][string]$BuildRoot = "",
    [Parameter()][string]$ToolsRoot = ""
  )
  $manifestPathResolved = [System.IO.Path]::GetFullPath($ManifestPath)
  $outputRootPath = [System.IO.Path]::GetFullPath((Split-Path -Parent $manifestPathResolved))
  $buildRootPath = if ([string]::IsNullOrWhiteSpace($BuildRoot)) {
    [System.IO.Path]::GetFullPath((Split-Path -Parent $outputRootPath))
  } else {
    [System.IO.Path]::GetFullPath($BuildRoot)
  }
  Assert-FullmagFullPackageDirectory -Path $buildRootPath `
    -Label "full capability build root" | Out-Null
  Assert-FullmagFullPackagePathChain -Path $outputRootPath -Root $buildRootPath `
    -Label "full capability output root" | Out-Null
  $expectedManifestPath = [System.IO.Path]::GetFullPath(
    (Join-Path $outputRootPath "build-manifest.json")
  )
  if (-not [string]::Equals($manifestPathResolved, $expectedManifestPath,
      [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "full capability manifest must be build-manifest.json inside its package root"
  }
  Assert-FullmagFullPackageFile -Path $manifestPathResolved `
    -Label "full capability manifest" -Root $buildRootPath | Out-Null
  if ($ExpectedBuildId -notmatch '^[0-9a-f]{64}$' -or
      (Get-FullmagFullPackageSha256 -Path $ManifestPath) -ne $ExpectedBuildId) {
    throw "Full capability manifest hash does not match the requested build identity"
  }
  $manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 |
    ConvertFrom-Json -ErrorAction Stop
  if ([string]$manifest.schema -ne "fullmag.windows-full-capability-package.v1" -or
      [string]$manifest.state -ne "completed" -or
      [string]$manifest.profile -ne "windows-native-fem-gpu" -or
      [string]$manifest.requested_backend -ne "auto" -or
      [string]$manifest.requested_device -ne "auto") {
    throw "Full capability manifest has an invalid package identity"
  }
  foreach ($name in @("FULLMAG_FDM_EXECUTION", "FULLMAG_FEM_EXECUTION", "FULLMAG_RELAX_DEVICE")) {
    $property = $manifest.runtime_environment.PSObject.Properties[$name]
    if ($null -eq $property -or $null -ne $property.Value) {
      throw "Full capability workspace must not force $name"
    }
  }
  $physical = Assert-FullmagFullPackageFile -Path $OriginManifestPath `
    -Label "physical FEM manifest" -Root $buildRootPath
  foreach ($artifactPath in @($FullmagExe, $FullmagApiExe, $NativeFdmDll, $NativeFemDll)) {
    Assert-FullmagFullPackageFile -Path $artifactPath `
      -Label "full capability input artifact" -Root $buildRootPath | Out-Null
  }
  $componentsRoot = Join-Path $outputRootPath "components"
  Assert-FullmagFullPackagePathChain -Path $componentsRoot -Root $outputRootPath `
    -Label "full capability component root" | Out-Null
  Assert-FullmagFullPackageDirectory -Path $componentsRoot `
    -Label "full capability component root" | Out-Null
  $componentAttemptRoot = Join-Path $componentsRoot ([string]$manifest.attempt_id)
  Assert-FullmagFullPackagePathChain -Path $componentAttemptRoot -Root $outputRootPath `
    -Label "full capability component attempt" | Out-Null
  Assert-FullmagFullPackageDirectory -Path $componentAttemptRoot `
    -Label "full capability component attempt" | Out-Null
  $physicalManifest = Get-Content -LiteralPath $OriginManifestPath -Raw -Encoding UTF8 |
    ConvertFrom-Json -ErrorAction Stop
  if ([string]$physicalManifest.schema_version -ne "1" -or
      [string]$physicalManifest.backend -ne "fem" -or
      [string]$physicalManifest.state -ne "completed" -or
      $physicalManifest.cuda -isnot [bool] -or -not [bool]$physicalManifest.cuda -or
      $null -eq $physicalManifest.native_fem -or
      [string]$physicalManifest.native_fem.device -ne "gpu" -or
      $physicalManifest.native_fem.strict_gpu -isnot [bool] -or
      -not [bool]$physicalManifest.native_fem.strict_gpu) {
    throw "The full capability package origin is not a completed strict FEM GPU manifest"
  }
  if ([string]$physicalManifest.source_commit_after -ne $SourceCommit -or
      [string]$physicalManifest.source_snapshot_sha256_after -ne $SourceSnapshotSha256 -or
      [string]$physicalManifest.native_fem_attempt_id -ne $AttemptId) {
    throw "The full capability package origin source identity is stale"
  }
  if ($physicalManifest.browser_workspace -isnot [bool]) {
    throw "The full capability package origin is missing its browser workspace marker"
  }
  $runtimeFamilyProof = Assert-FullmagFullPackageRuntimeFamily `
    -NativeFem $physicalManifest.native_fem -BrowserWorkspace ([bool]$physicalManifest.browser_workspace) `
    -BuildRoot $buildRootPath -ToolsRoot $ToolsRoot
  $originPath = [System.IO.Path]::GetFullPath($OriginManifestPath)
  if ([string]$manifest.origin_manifest_path -ine $originPath -or
      [string]$manifest.origin_manifest_sha256 -ne (Get-FullmagFullPackageSha256 -Path $OriginManifestPath)) {
    throw "Full capability manifest is not bound to the physical FEM manifest"
  }
  if ([string]$manifest.source_snapshot_sha256 -ne $SourceSnapshotSha256 -or
      [string]$manifest.source_identity.head_commit_full -ne $SourceCommit -or
      [string]$manifest.source_identity.source_snapshot_sha256 -ne $SourceSnapshotSha256 -or
      [string]$manifest.attempt_id -ne $AttemptId) {
    throw "Full capability manifest source identity does not match the requested build"
  }
  $expectedArtifacts = @{
    fdm_cpu = @($FullmagExe, $FullmagApiExe, $NativeFdmDll)
    fdm_gpu = @($FullmagExe, $FullmagApiExe, $NativeFdmDll)
    fem_cpu = @($FullmagExe, $FullmagApiExe, $NativeFemDll)
    fem_gpu = @($FullmagExe, $FullmagApiExe, $NativeFemDll)
  }
  foreach ($propertyName in @("runtime_family_root", "runtime_family", "runtime_family_inventory", "runtime_family_inventory_sha256", "runtime_family_dependency_audit_path", "runtime_family_dependency_audit_sha256")) {
    if ($null -eq $manifest.PSObject.Properties[$propertyName] -or $null -eq $manifest.$propertyName) {
      throw "Full capability manifest is missing runtime family proof: $propertyName"
    }
  }
  if ([System.IO.Path]::GetFullPath([string]$manifest.runtime_family_root) -ine [string]$runtimeFamilyProof.root -or
      [string]$manifest.runtime_family_inventory_sha256 -ne [string]$runtimeFamilyProof.inventory_sha256 -or
      [System.IO.Path]::GetFullPath([string]$manifest.runtime_family_dependency_audit_path) -ine [string]$runtimeFamilyProof.dependency_audit_path -or
      [string]$manifest.runtime_family_dependency_audit_sha256 -ne [string]$runtimeFamilyProof.dependency_audit_sha256) {
    throw "Full capability manifest runtime family proof does not match the physical FEM manifest"
  }
  $aggregateNames = @($manifest.runtime_family_inventory | ForEach-Object { [string]$_ })
  if ((@($aggregateNames | Sort-Object) -join ",") -ne (@($runtimeFamilyProof.names | Sort-Object) -join ",")) {
    throw "Full capability manifest runtime family inventory is stale"
  }
  $aggregateFamily = @($manifest.runtime_family)
  if ($aggregateFamily.Count -ne $runtimeFamilyProof.artifacts.Count) {
    throw "Full capability manifest runtime family is incomplete"
  }
  foreach ($expectedFamilyArtifact in @($runtimeFamilyProof.artifacts)) {
    $matchingFamily = @($aggregateFamily | Where-Object {
      [string]$_.name -eq [string]$expectedFamilyArtifact.name -and
      [System.IO.Path]::GetFullPath([string]$_.path) -ieq [string]$expectedFamilyArtifact.path -and
      [int64]$_.size_bytes -eq [int64]$expectedFamilyArtifact.size_bytes -and
      [string]$_.sha256 -eq [string]$expectedFamilyArtifact.sha256
    })
    if ($matchingFamily.Count -ne 1) {
      throw "Full capability manifest runtime family record is stale: $($expectedFamilyArtifact.name)"
    }
  }
  $expectedComponents = @("fdm_cpu", "fdm_gpu", "fem_cpu", "fem_gpu")
  $properties = @($manifest.components.PSObject.Properties.Name)
  if (@($properties | Sort-Object) -join "," -ne (@($expectedComponents | Sort-Object) -join ",")) {
    throw "Full capability manifest must contain exactly the four runtime components"
  }
  foreach ($component in $expectedComponents) {
    $record = $manifest.components.PSObject.Properties[$component].Value
    $expectedBackend = if ($component.StartsWith("fdm", [System.StringComparison]::Ordinal)) { "fdm" } else { "fem" }
    $expectedDevice = if ($component.EndsWith("gpu", [System.StringComparison]::Ordinal)) { "gpu" } else { "cpu" }
    if ([string]$record.backend -ne $expectedBackend -or
        [string]$record.device -ne $expectedDevice) {
      throw "Full capability component has an invalid lane: $component"
    }
    if ($record.installed_support -isnot [bool] -or -not [bool]$record.installed_support) {
      throw "Full capability component is not installed: $component"
    }
    foreach ($propertyName in @("component_manifest_path", "component_manifest_sha256", "receipt_path", "receipt_sha256")) {
      if ([string]$record.$propertyName -eq "") { throw "Full capability component is missing ${propertyName}: $component" }
    }
    $expectedComponentManifestPath = [System.IO.Path]::GetFullPath(
      (Join-Path $componentAttemptRoot "$component.manifest.json")
    )
    $expectedReceiptPath = [System.IO.Path]::GetFullPath(
      (Join-Path $componentAttemptRoot "$component.receipt.json")
    )
    if ([string]$record.component_manifest_path -ine $expectedComponentManifestPath -or
        [string]$record.receipt_path -ine $expectedReceiptPath) {
      throw "Full capability component metadata escapes its immutable attempt directory: $component"
    }
    Assert-FullmagFullPackageFile -Path ([string]$record.component_manifest_path) `
      -Label "$component manifest" -Root $outputRootPath | Out-Null
    Assert-FullmagFullPackageFile -Path ([string]$record.receipt_path) `
      -Label "$component receipt" -Root $outputRootPath | Out-Null
    if ((Get-FullmagFullPackageSha256 -Path ([string]$record.component_manifest_path)) -ne [string]$record.component_manifest_sha256 -or
        (Get-FullmagFullPackageSha256 -Path ([string]$record.receipt_path)) -ne [string]$record.receipt_sha256) {
      throw "Full capability component metadata hash mismatch: $component"
    }
    $componentManifest = Get-Content -LiteralPath ([string]$record.component_manifest_path) -Raw -Encoding UTF8 |
      ConvertFrom-Json -ErrorAction Stop
    if ([string]$componentManifest.component -ne $component -or
        [string]$componentManifest.backend -ne $expectedBackend -or
        [string]$componentManifest.device -ne $expectedDevice -or
        $componentManifest.installed_support -isnot [bool] -or
        -not [bool]$componentManifest.installed_support -or
        [string]$componentManifest.origin_manifest_path -ine [string]$manifest.origin_manifest_path -or
        [string]$componentManifest.origin_manifest_sha256 -ne [string]$manifest.origin_manifest_sha256) {
      throw "Full capability component is not bound to its package origin: $component"
    }
    $componentReceipt = Get-Content -LiteralPath ([string]$record.receipt_path) -Raw -Encoding UTF8 |
      ConvertFrom-Json -ErrorAction Stop
    if ([string]$componentReceipt.component -ne $component -or
        [string]$componentReceipt.component_manifest_path -ine [string]$record.component_manifest_path -or
        [string]$componentReceipt.component_manifest_sha256 -ne [string]$record.component_manifest_sha256 -or
        [string]$componentReceipt.origin_manifest_sha256 -ne [string]$manifest.origin_manifest_sha256 -or
        [string]$componentReceipt.source_snapshot_sha256 -ne $SourceSnapshotSha256 -or
        [string]$componentReceipt.attempt_id -ne $AttemptId) {
      throw "Full capability component receipt is not bound to its component: $component"
    }
    $actualPaths = @($componentManifest.artifacts | ForEach-Object { [string]$_.path })
    foreach ($expectedPath in $expectedArtifacts[$component]) {
      $fullExpected = [System.IO.Path]::GetFullPath($expectedPath)
      if ($actualPaths -notcontains $fullExpected) { throw "Full capability component is missing an artifact: $component" }
    }
    foreach ($artifact in @($componentManifest.artifacts)) {
      Assert-FullmagFullPackageFile -Path ([string]$artifact.path) `
        -Label "$component artifact" -Root $buildRootPath | Out-Null
      if ((Get-FullmagFullPackageSha256 -Path ([string]$artifact.path)) -ne [string]$artifact.sha256) {
        throw "Full capability artifact hash mismatch: $component"
      }
    }
    $recordArtifacts = @($record.artifacts)
    if ($recordArtifacts.Count -ne $componentManifest.artifacts.Count) {
      throw "Full capability component artifact record is incomplete: $component"
    }
    foreach ($artifact in $recordArtifacts) {
      $matching = @($componentManifest.artifacts | Where-Object {
        [string]$_.path -eq [string]$artifact.path -and
        [string]$_.sha256 -eq [string]$artifact.sha256 -and
        [int64]$_.size_bytes -eq [int64]$artifact.size_bytes
      })
      if ($matching.Count -ne 1) {
        throw "Full capability component artifact record is stale: $component"
      }
    }
  }
  $physical | Out-Null
  return $manifest
}
