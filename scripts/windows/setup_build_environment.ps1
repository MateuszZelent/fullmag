[CmdletBinding()]
param(
  [switch]$Install,

  [switch]$PrerequisitesOnly,

  [ValidateSet("native", "fem-cpu", "fem-gpu", "all")]
  [string]$Lane = "all",

  [string]$StorageRoot,

  # A bundled pre-admission caller supplies the hash of the requirements
  # payload it shipped. The ordinary checkout route may omit it because the
  # source identity is admitted by the caller before full setup.
  [string]$ExpectedRequirementsSha256,

  [switch]$WithWix,

  [switch]$Json
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# This script is intentionally a check-first setup boundary.  It never uses
# wsl.exe, never copies a storage path from another host, and does not mutate a
# project-owned directory until the shared storage resolver has accepted the
# checkout and profile.  A system installer is invoked only with -Install.
# -PrerequisitesOnly is the fresh-host exception: it may install only Git and
# Python after validating the bundled payload and explicit storage input, then
# returns their verified paths without reading Git identity, .env, or running
# the storage resolver. The caller performs source/layout admission before
# the full setup route is invoked.

$script:Results = [System.Collections.Generic.List[object]]::new()
$script:Requirements = $null
$script:RepoRoot = $null
$script:MainRepoRoot = $null
$script:StorageProfile = $null
$script:Layout = $null
$script:StorageRootValue = $null
$script:PayloadRoot = $null
$script:RequirementsPath = $null
$script:RequirementsSha256 = $null
$script:PythonCommand = $null
$script:PythonPrefix = @()
$script:ToolsPath = $null
$script:ProviderRoot = $null
$script:ProviderReceiptInventoryValidated = $false
$script:BoostRequirement = $null
$script:InstallAttempted = [System.Collections.Generic.HashSet[string]]::new()

function Add-Result {
  param(
    [Parameter(Mandatory = $true)][string]$Id,
    [Parameter(Mandatory = $true)][ValidateSet("pass", "missing", "not_verified", "blocked", "pending", "not_applicable")][string]$Status,
    [Parameter()][string]$Version = "",
    [Parameter()][string]$Path = "",
    [Parameter()][string]$Detail = "",
    [Parameter()][string]$Scope = "check"
  )
  $script:Results.Add([pscustomobject][ordered]@{
      id = $Id
      status = $Status
      version = $Version
      path = $Path
      detail = $Detail
      scope = $Scope
      install_attempted = $script:InstallAttempted.Contains($Id)
    })
}

function Get-RepoRoot {
  $git = Get-Command git.exe -ErrorAction SilentlyContinue
  if (-not $git) {
    throw "Git is required to identify the checkout. Install Git for Windows, then rerun this script."
  }
  $result = Invoke-NativeOutput ([string]$git.Source) @("-C", $PSScriptRoot, "rev-parse", "--show-toplevel")
  $output = [string]$result.output
  if ($result.exit_code -ne 0 -or [string]::IsNullOrWhiteSpace($output)) {
    throw "The setup script must run inside a Git checkout; Git could not resolve the project root: $output"
  }
  return (Resolve-Path -LiteralPath $output).Path
}

function Get-CheckoutDirectoryHint {
  $candidate = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\\..")).Path
  $metadata = Join-Path $candidate ".git"
  if (-not (Test-Path -LiteralPath $metadata)) {
    throw "Git metadata is missing from the copied checkout: $candidate; refusing to run git init or infer provenance. Copy the .git metadata and rerun."
  }
  return $candidate
}

function Get-MainCheckoutRoot {
  $git = Get-Command git.exe -ErrorAction SilentlyContinue
  if (-not $git) { throw "Git is required to identify the main checkout and preserve its .env configuration." }
  $result = Invoke-NativeOutput ([string]$git.Source) @("-C", $script:RepoRoot, "worktree", "list", "--porcelain")
  $lines = @(([string]$result.output) -split "`r?`n")
  if ($result.exit_code -ne 0) {
    throw "Git could not list worktrees for the main checkout: $($lines -join ' ')"
  }
  $first = $lines | Where-Object { $_ -match '^worktree\s+(.+)$' } | Select-Object -First 1
  $match = [regex]::Match([string]$first, '^worktree\s+(.+)$')
  if (-not $first -or -not $match.Success) {
    throw "Git returned no main checkout record; refusing to read a worktree-local .env or infer storage provenance."
  }
  return (Resolve-Path -LiteralPath $match.Groups[1].Value).Path
}

function Assert-MainCheckoutPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter()][string]$Label = "main checkout path"
  )
  if ([string]::IsNullOrWhiteSpace($script:MainRepoRoot)) {
    throw "Cannot validate $Label before the main checkout is resolved"
  }
  if (-not [System.IO.Path]::IsPathRooted($Path)) {
    throw "$Label must be an absolute path inside the main checkout: $Path"
  }
  $main = [System.IO.Path]::GetFullPath([string]$script:MainRepoRoot).TrimEnd('\', '/')
  $candidate = [System.IO.Path]::GetFullPath($Path)
  if (-not [string]::Equals($candidate, $main, [System.StringComparison]::OrdinalIgnoreCase) -and
      -not $candidate.StartsWith($main + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must remain inside the main checkout: $candidate"
  }
  $cursor = $candidate
  while ($true) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
          ($item.PSObject.Properties.Name -contains "LinkType" -and $item.LinkType)) {
        throw "$Label traverses a junction or symlink: $cursor"
      }
      if ([string]::Equals($cursor, $candidate, [System.StringComparison]::OrdinalIgnoreCase) -and $item.PSIsContainer) {
        throw "$Label is not a file: $cursor"
      }
    }
    if ([string]::Equals($cursor, $main, [System.StringComparison]::OrdinalIgnoreCase)) { break }
    $parent = Split-Path -Parent $cursor
    if (-not $parent -or $parent -eq $cursor) {
      throw "$Label has no safe main checkout ancestor: $candidate"
    }
    $cursor = $parent
  }
  return $candidate
}

function Read-Requirements {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Build requirements manifest is missing: $Path"
  }
  try {
    return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop)
  }
  catch {
    throw "Build requirements manifest is invalid: $Path; $($_.Exception.Message)"
  }
}

function Assert-RequirementsHash {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter()][string]$Expected = ""
  )
  if ([string]::IsNullOrWhiteSpace($Expected)) {
    return ([string](Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash).ToLowerInvariant()
  }
  if ($Expected -notmatch '^[0-9a-fA-F]{64}$') {
    throw "Expected requirements SHA-256 must contain exactly 64 hexadecimal characters"
  }
  $actual = ([string](Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash).ToLowerInvariant()
  if ($actual -ne $Expected.ToLowerInvariant()) {
    throw "Requirements manifest hash does not match the verified bundled payload"
  }
  return $actual
}

function Get-Requirement {
  param([Parameter(Mandatory = $true)][string]$Id)
  $property = $script:Requirements.tools.PSObject.Properties[$Id]
  if ($null -eq $property) { throw "Requirements manifest has no tool '$Id'" }
  return $property.Value
}

function Get-LaneRequirementIds {
  $lanes = $script:Requirements.lanes
  $selected = if ($Lane -eq "all") { @("native", "fem_gpu") } elseif ($Lane -eq "fem-cpu") { @("fem_cpu") } elseif ($Lane -eq "fem-gpu") { @("fem_gpu") } else { @("native") }
  $ids = [System.Collections.Generic.List[string]]::new()
  foreach ($laneName in $selected) {
    foreach ($id in @($lanes.$laneName.required)) {
      if (-not $ids.Contains([string]$id)) { $ids.Add([string]$id) }
    }
  }
  # Header providers are admitted by the same FEM bootstrap receipt as MFEM,
  # HYPRE, and libCEED.  Keep the requirement in the FEM lanes even though it
  # is maintained under provider_bootstrap rather than duplicated in every
  # lane's required list.
  if (@($selected | Where-Object { $_ -in @("fem_cpu", "fem_gpu") }).Count -gt 0 -and
      $null -ne $script:Requirements.provider_bootstrap -and
      $null -ne $script:Requirements.provider_bootstrap.required_for) {
    foreach ($id in @($script:Requirements.provider_bootstrap.required_for)) {
      if (-not $ids.Contains([string]$id)) { $ids.Add([string]$id) }
    }
  }
  if ($WithWix -and -not $ids.Contains("wix")) { $ids.Add("wix") }
  return @($ids)
}

function Get-StorageProfile {
  $profiles = $script:Requirements.storage.build_profiles
  if ($Lane -eq "fem-cpu") { return [string]$profiles.fem_cpu }
  if ($Lane -eq "fem-gpu" -or $Lane -eq "all") { return [string]$profiles.fem_gpu }
  return [string]$script:Requirements.storage.setup_profile
}

function Convert-ToLocalAbsolutePath {
  param([Parameter(Mandatory = $true)][string]$Value)
  $raw = $Value.Trim()
  if ([string]::IsNullOrWhiteSpace($raw)) { throw "Storage root must not be empty" }
  # Reject relative and drive-relative values before GetFullPath could resolve
  # them against the current process directory or drive.
  if ($raw -notmatch '^[A-Za-z]:[\\/]') {
    throw "Storage root must be an absolute local Windows path: $Value"
  }
  if ($raw -match '^[\\]{2}' -or $raw -match '^//') {
    throw "Storage root must be a local Windows path, not a UNC/network path: $Value"
  }
  $candidate = [System.IO.Path]::GetFullPath($raw)
  if ($candidate -notmatch '^[A-Za-z]:[\\/]') {
    throw "Storage root must be an absolute local Windows path: $Value"
  }
  return $candidate.TrimEnd('\', '/')
}

function Remove-EnvComment {
  param([string]$Value)
  $clean = $Value.Trim()
  if ($clean.Length -ge 2 -and (($clean.StartsWith('"') -and $clean.EndsWith('"')) -or ($clean.StartsWith("'") -and $clean.EndsWith("'")))) {
    return $clean.Substring(1, $clean.Length - 2)
  }
  return ($clean -split '\s+#', 2)[0].Trim()
}

function Get-DotEnvStorageRoot {
  param([Parameter(Mandatory = $true)][string]$Path)
  $safePath = Assert-MainCheckoutPath $Path ".env"
  if (-not (Test-Path -LiteralPath $safePath -PathType Leaf)) { return $null }
  foreach ($line in [System.IO.File]::ReadAllLines($safePath)) {
    if ($line -match '^\s*(?:export\s+)?FULLMAG_PROJECT_STORAGE_ROOT\s*=\s*(.*?)\s*$') {
      $value = Remove-EnvComment $matches[1]
      if ($value) { return $value }
    }
  }
  return $null
}

function Compare-LocalPath {
  param([Parameter(Mandatory = $true)][string]$Left, [Parameter(Mandatory = $true)][string]$Right)
  try {
    return [string]::Equals((Convert-ToLocalAbsolutePath $Left), (Convert-ToLocalAbsolutePath $Right), [System.StringComparison]::OrdinalIgnoreCase)
  }
  catch { return $false }
}

function Resolve-StorageConfiguration {
  $script:MainRepoRoot = Get-MainCheckoutRoot
  $envPath = Join-Path $script:MainRepoRoot ".env"
  $fromEnv = Get-DotEnvStorageRoot $envPath
  if ($fromEnv -and $StorageRoot -and -not (Compare-LocalPath $fromEnv $StorageRoot)) {
    throw "-StorageRoot disagrees with FULLMAG_PROJECT_STORAGE_ROOT in .env. Existing project configuration is preserved; choose the configured path or edit .env deliberately."
  }
  $selected = if ($fromEnv) { $fromEnv } else { $StorageRoot }
  if (-not $selected) {
    throw "This checkout has no FULLMAG_PROJECT_STORAGE_ROOT. A new clone must be given an explicit local -StorageRoot; no host path or fallback is copied."
  }
  $script:StorageRootValue = Convert-ToLocalAbsolutePath $selected
  return [pscustomobject]@{ path = $envPath; existing = $fromEnv; selected = $script:StorageRootValue }
}

function Get-PythonCommand {
  $minimum = [version]"3.12.0"
  $python = Get-Command python.exe -ErrorAction SilentlyContinue
  if ($python) {
    $result = Invoke-NativeOutput ([string]$python.Source) @("--version")
    $version = [string]$result.output
    $parsed = Get-VersionObject $version
    if ($result.exit_code -eq 0 -and $null -ne $parsed -and $parsed -ge $minimum) {
      Add-ProcessPath (Split-Path -Parent ([string]$python.Source))
      return [pscustomobject]@{ command = $python.Source; prefix = @(); version = $parsed }
    }
  }
  return $null
}

function Invoke-NativeOutput {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter()][string[]]$Arguments = @()
  )
  # Windows PowerShell 5.1 promotes stderr from a native process to an
  # error record.  A successful tool may still write informational text to
  # stderr, so capture it without Stop and decide from the process exit code.
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $output = (& $Command @Arguments 2>&1 | Out-String).Trim()
    $exitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousPreference
  }
  return [pscustomobject]@{ output = $output; exit_code = $exitCode }
}

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter()][string[]]$Arguments = @(),
    [Parameter()][string]$Label = $Command
  )
  if ($Json) {
    $result = Invoke-NativeOutput $Command $Arguments
    if ($result.exit_code -ne 0) { throw "$Label failed with exit code $($result.exit_code): $($result.output)" }
    return
  }
  Write-Host ("> " + $Command + " " + ($Arguments -join " "))
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & $Command @Arguments
    $exitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($exitCode -ne 0) { throw "$Label failed with exit code $exitCode" }
}

function Invoke-WingetInstall {
  param([Parameter(Mandatory = $true)][object]$Install, [Parameter(Mandatory = $true)][string]$ToolId)
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $winget) { throw "winget.exe is required to install $ToolId; install/update App Installer from Microsoft before rerunning -Install" }
  $source = if ($Install.source) { [string]$Install.source } else { "winget" }
  $arguments = @(
    "install", "--id", [string]$Install.id, "--exact", "--source", $source,
    "--accept-source-agreements", "--accept-package-agreements"
  )
  # A partially installed Build Tools product needs the same installer to add
  # the missing x64/SDK components; --force makes the explicit -Install repair
  # reach the Visual Studio bootstrapper instead of silently accepting the
  # already-present product.
  if ($ToolId -in @("msvc_x64", "windows_sdk")) { $arguments += "--force" }
  if ($Install.override) { $arguments += @("--override", [string]$Install.override) }
  Invoke-Checked $winget.Source $arguments ("winget installation of " + $ToolId)
}

function Invoke-Python {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  if ($null -eq $script:PythonCommand) { throw "Python is not available" }
  if ($Json) {
    $result = Invoke-NativeOutput ([string]$script:PythonCommand.command) @($script:PythonCommand.prefix + $Arguments)
    if ($result.exit_code -ne 0) { throw "Python command failed with exit code $($result.exit_code): $($result.output)" }
    return
  }
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & $script:PythonCommand.command @($script:PythonCommand.prefix + $Arguments)
    $exitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($exitCode -ne 0) { throw "Python command failed with exit code $exitCode" }
}

function Get-JsonFromPython {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  if ($null -eq $script:PythonCommand) { throw "Python is not available" }
  $result = Invoke-NativeOutput ([string]$script:PythonCommand.command) @($script:PythonCommand.prefix + $Arguments)
  if ($result.exit_code -ne 0) { throw "Python command failed with exit code $($result.exit_code): $($result.output)" }
  try { return ([string]$result.output | ConvertFrom-Json -ErrorAction Stop) }
  catch { throw "Python command returned invalid JSON: $($result.output)" }
}

function Resolve-FullmagStorage {
  param([Parameter(Mandatory = $true)][bool]$Create)
  if ($null -eq $script:PythonCommand) {
    throw "Python >= 3.12 is needed for the shared storage resolver"
  }
  $old = [Environment]::GetEnvironmentVariable("FULLMAG_PROJECT_STORAGE_ROOT", "Process")
  $env:FULLMAG_PROJECT_STORAGE_ROOT = $script:StorageRootValue
  try {
    $arguments = @(
      (Join-Path $script:RepoRoot "scripts\\fullmag_storage.py"), "resolve",
      "--repo-root", $script:RepoRoot, "--profile", ([string]$script:StorageProfile), "--format", "json"
    )
    if ($Create) { $arguments += "--create" }
    return Get-JsonFromPython $arguments
  }
  finally {
    if ($null -eq $old) { Remove-Item Env:FULLMAG_PROJECT_STORAGE_ROOT -ErrorAction SilentlyContinue }
    else { $env:FULLMAG_PROJECT_STORAGE_ROOT = $old }
  }
}

function Assert-StoragePath {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter()][string]$Label = "storage path")
  $root = [System.IO.Path]::GetFullPath([string]$script:Layout.storage_root).TrimEnd('\', '/') + '\'
  $candidate = [System.IO.Path]::GetFullPath($Path)
  if (-not $candidate.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) -and
      -not [string]::Equals($candidate.TrimEnd('\', '/'), $root.TrimEnd('\', '/'), [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label escapes the resolved Fullmag storage root: $candidate"
  }
  # An existing child may look ordinary while an ancestor is a junction.
  # Inspect all existing components before provisioning shared tool caches.
  $cursor = $candidate
  while ($cursor) {
    if ((Test-Path -LiteralPath $cursor) -and
        ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "$Label traverses a junction or symlink: $cursor"
    }
    $parent = Split-Path -Parent $cursor
    if (-not $parent -or $parent -eq $cursor) { break }
    $cursor = $parent
  }
  return $candidate
}

function Ensure-StorageDirectory {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter()][string]$Label = "storage directory")
  $safe = Assert-StoragePath $Path $Label
  if (Test-Path -LiteralPath $safe) {
    if (-not (Test-Path -LiteralPath $safe -PathType Container)) { throw "$Label is not a directory: $safe" }
    if ((Get-Item -LiteralPath $safe -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "$Label is a junction/symlink: $safe" }
  }
  else { New-Item -ItemType Directory -Path $safe -Force | Out-Null }
  return $safe
}

function Get-ManagedDirectory {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter()][string]$Label = "managed directory")
  $safe = Assert-StoragePath $Path $Label
  if (Test-Path -LiteralPath $safe) {
    if (-not (Test-Path -LiteralPath $safe -PathType Container)) { throw "$Label is not a directory: $safe" }
    if ((Get-Item -LiteralPath $safe -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "$Label is a junction/symlink: $safe" }
  }
  elseif ($Install) { New-Item -ItemType Directory -Path $safe -Force | Out-Null }
  return $safe
}

function Write-StorageDotEnv {
  param([Parameter(Mandatory = $true)][pscustomobject]$Configuration)
  if (-not $Install -or $Configuration.existing) { return }
  $safePath = Assert-MainCheckoutPath $Configuration.path ".env"
  $line = "FULLMAG_PROJECT_STORAGE_ROOT=$($Configuration.selected)"
  $prefix = ""
  if (Test-Path -LiteralPath $safePath -PathType Leaf) {
    $existingText = [System.IO.File]::ReadAllText($safePath)
    if ($existingText -match '(?m)^\s*(?:export\s+)?FULLMAG_PROJECT_STORAGE_ROOT\s*=') {
      throw "Refusing to overwrite an existing FULLMAG_PROJECT_STORAGE_ROOT assignment in .env"
    }
    if ($existingText.Length -gt 0 -and -not $existingText.EndsWith("`n") -and -not $existingText.EndsWith("`r")) { $prefix = "`r`n" }
  }
  [System.IO.File]::AppendAllText($safePath, $prefix + $line + "`r`n", (New-Object System.Text.UTF8Encoding -ArgumentList $false))
  if (-not $Json) { Write-Host "Persisted the explicitly supplied storage root in .env without replacing existing settings." }
}

function Add-ProcessPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return }
  $parts = @($env:Path -split [IO.Path]::PathSeparator)
  if (-not ($parts | Where-Object { [string]::Equals($_, $Path, [StringComparison]::OrdinalIgnoreCase) })) {
    $env:Path = $Path + [IO.Path]::PathSeparator + $env:Path
  }
}

function Refresh-CommonWindowsToolPaths {
  # Winget installers update machine/user PATH for future shells. Refresh only
  # well-known locations in this process; do not modify the user's profile.
  foreach ($path in @(
      (Join-Path ${env:ProgramFiles} "Git\\cmd"),
      (Join-Path ${env:LocalAppData} "Programs\\Git\\cmd"),
      (Join-Path ${env:ProgramFiles} "CMake\\bin"),
      (Join-Path ${env:ProgramFiles} "nodejs"),
      (Join-Path ${env:LocalAppData} "Programs\\Python\\Python312"),
      (Join-Path ${env:LocalAppData} "Programs\\Python\\Python312\\Scripts"),
      (Join-Path ${env:USERPROFILE} ".cargo\\bin")
    )) {
    Add-ProcessPath $path
  }
}

function Get-VersionObject {
  param([Parameter(Mandatory = $true)][string]$Text)
  $match = [regex]::Match($Text, '(?<!\d)(\d+)\.(\d+)(?:\.(\d+))?(?:[-+][0-9A-Za-z.-]+)?')
  if (-not $match.Success) { return $null }
  $patch = if ($match.Groups[3].Success) { $match.Groups[3].Value } else { "0" }
  return [version]::new([int]$match.Groups[1].Value, [int]$match.Groups[2].Value, [int]$patch)
}

function Test-MinimumVersion {
  param([Parameter()][version]$Actual, [Parameter()][string]$Minimum)
  if ($null -eq $Actual -or -not $Minimum) { return $false }
  return $Actual -ge [version]$Minimum
}

function Test-RangeVersion {
  param([Parameter()][version]$Actual, [Parameter()][string]$Minimum, [Parameter()][string]$MaximumExclusive)
  if ($null -eq $Actual) { return $false }
  return $Actual -ge [version]$Minimum -and $Actual -lt [version]$MaximumExclusive
}

function Get-CommandInfo {
  param([Parameter(Mandatory = $true)][string]$Name, [Parameter()][string[]]$Arguments = @("--version"))
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) { return $null }
  $result = Invoke-NativeOutput ([string]$command.Source) $Arguments
  if ($result.exit_code -ne 0) { return [pscustomobject]@{ path = $command.Source; output = $result.output; version = $null } }
  return [pscustomobject]@{ path = $command.Source; output = $result.output; version = Get-VersionObject ([string]$result.output) }
}

function Assert-ExecutablePath {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Label)
  if ($Path -notmatch '^[A-Za-z]:[\\/]') { throw "$Label is not a local absolute path: $Path" }
  $resolved = [System.IO.Path]::GetFullPath($Path)
  if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { throw "$Label is missing: $resolved" }
  $cursor = $resolved
  while ($cursor) {
    $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label traverses a junction or symlink: $cursor"
    }
    $parent = Split-Path -Parent $cursor
    if (-not $parent -or [string]::Equals($parent, $cursor, [System.StringComparison]::OrdinalIgnoreCase)) { break }
    $cursor = $parent
  }
  return $resolved
}

function Get-VsInfo {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\\Installer\\vswhere.exe"
  if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
    $candidate = Get-Command vswhere.exe -ErrorAction SilentlyContinue
    if ($candidate) { $vswhere = $candidate.Source }
  }
  if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) { return $null }
  $vsWhereResult = Invoke-NativeOutput ([string]$vswhere) @(
    "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
    "-latest", "-property", "installationPath"
  )
  if ($vsWhereResult.exit_code -ne 0) { return $null }
  $vsPath = [string](([string]$vsWhereResult.output) -split "`r?`n" | Select-Object -First 1)
  $vsPath = $vsPath.Trim()
  if (-not $vsPath) { return $null }
  $vcvars = Join-Path $vsPath "VC\\Auxiliary\\Build\\vcvars64.bat"
  $cl = @(Get-ChildItem -LiteralPath (Join-Path $vsPath "VC\\Tools\\MSVC") -Filter cl.exe -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match '\\bin\\Hostx64\\x64\\cl\.exe$' } | Select-Object -First 1)
  $link = @(Get-ChildItem -LiteralPath (Join-Path $vsPath "VC\\Tools\\MSVC") -Filter link.exe -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match '\\bin\\Hostx64\\x64\\link\.exe$' } | Select-Object -First 1)
  $clang = @(Get-ChildItem -LiteralPath $vsPath -Filter clang-cl.exe -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1)
  return [pscustomobject]@{
    vswhere = $vswhere
    path = $vsPath
    vcvars = $vcvars
    cl = if ($cl.Count) { $cl[0].FullName } else { "" }
    link = if ($link.Count) { $link[0].FullName } else { "" }
    clang = if ($clang.Count) { $clang[0].FullName } else { "" }
  }
}

function Import-VsEnvironment {
  param([Parameter(Mandatory = $true)][object]$VsInfo)
  if (-not (Test-Path -LiteralPath $VsInfo.vcvars -PathType Leaf)) { return }
  $environmentResult = Invoke-NativeOutput "cmd.exe" @(
    "/d", "/s", "/c", ('"' + $VsInfo.vcvars + '" amd64 && set')
  )
  if ($environmentResult.exit_code -ne 0) { return }
  $lines = @(([string]$environmentResult.output) -split "`r?`n")
  foreach ($line in $lines) {
    if ($line -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process") }
  }
  # vcvars64 can be present while one compiler executable is absent.  Keep
  # importing the environment so the individual tool check can report the
  # missing compiler; Split-Path rejects an empty -Path argument.
  if (-not [string]::IsNullOrWhiteSpace([string]$VsInfo.cl)) {
    Add-ProcessPath (Split-Path -Parent ([string]$VsInfo.cl))
  }
  if (-not [string]::IsNullOrWhiteSpace([string]$VsInfo.clang)) {
    Add-ProcessPath (Split-Path -Parent ([string]$VsInfo.clang))
  }
}

function Get-SdkInfo {
  $kits = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\\10\\bin"
  if (-not (Test-Path -LiteralPath $kits -PathType Container)) { return $null }
  $rc = @(Get-ChildItem -LiteralPath $kits -Filter rc.exe -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match '\\x64\\rc\.exe$' } | Sort-Object FullName -Descending | Select-Object -First 1)
  if ($rc.Count) { return $rc[0].FullName }
  return $null
}

function Get-NvccInfo {
  $candidates = [System.Collections.Generic.List[string]]::new()
  if ($env:CUDACXX) { $candidates.Add($env:CUDACXX) }
  if ($env:CUDA_PATH) { $candidates.Add((Join-Path $env:CUDA_PATH "bin\\nvcc.exe")) }
  $cudaRoot = Join-Path ${env:ProgramFiles} "NVIDIA GPU Computing Toolkit\\CUDA"
  if (Test-Path -LiteralPath $cudaRoot -PathType Container) {
    foreach ($item in @(Get-ChildItem -LiteralPath $cudaRoot -Directory | Sort-Object Name -Descending)) { $candidates.Add((Join-Path $item.FullName "bin\\nvcc.exe")) }
  }
  $command = Get-Command nvcc.exe -ErrorAction SilentlyContinue
  if ($command) { $candidates.Add($command.Source) }
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      $result = Invoke-NativeOutput ([string]$candidate) @("--version")
      if ($result.exit_code -ne 0) { continue }
      return [pscustomobject]@{ path = (Resolve-Path -LiteralPath $candidate).Path; output = $result.output; version = Get-VersionObject ([string]$result.output) }
    }
  }
  return $null
}

function Get-ProviderReceipt {
  $receiptPath = Join-Path $script:ProviderRoot "provider-receipt.json"
  if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) { return $null }
  try {
    $receiptPath = Assert-ProviderReceiptPathChain -Path $receiptPath -Base $script:ProviderRoot `
      -Label "Provider receipt" -Leaf
    $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json -ErrorAction Stop
  }
  catch {
    throw "Provider receipt is invalid: $receiptPath ($($_.Exception.Message))"
  }
  $providers = if ($null -ne $receipt -and $null -ne $receipt.plan) { @($receipt.plan.providers) } else { @() }
  if ($null -eq $receipt -or [string]$receipt.schema -ne "fullmag.windows.fem-providers.v1" -or
      $null -eq $receipt.plan -or $providers.Count -eq 0) {
    throw "Provider receipt has an incompatible schema or provider list: $receiptPath"
  }
  foreach ($name in @("hypre", "mfem", "libceed")) {
    $matches = @($providers | Where-Object { [string]$_.name -eq $name })
    if ($matches.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$matches[0].version) -or
        [string]$matches[0].sha -notmatch '^[0-9a-f]{40}$') {
      throw "Provider receipt has an incomplete or duplicate provider list: $receiptPath"
    }
  }
  $null = Assert-ProviderReceiptBoost -Receipt $receipt
  return $receipt
}

function Get-ProviderBoostRequirement {
  if ($null -ne $script:BoostRequirement) { return $script:BoostRequirement }
  $dependencyScript = Join-Path $script:RepoRoot "scripts\windows\native_fem_dependencies.ps1"
  if (-not (Test-Path -LiteralPath $dependencyScript -PathType Leaf)) {
    throw "Native FEM dependency helper is missing: $dependencyScript"
  }
  . $dependencyScript
  $script:BoostRequirement = Get-FullmagNativeFemBoostRequirement -SourceRoot $script:RepoRoot
  return $script:BoostRequirement
}

function Assert-ProviderReceiptBoost {
  param([Parameter(Mandatory = $true)][object]$Receipt)
  # The dependency helper must be loaded in this validator's scope.  Dot
  # sourcing it only from Get-ProviderBoostRequirement creates functions in
  # that nested function scope; they disappear before this validator calls
  # Assert-FullmagNativeFemBoostReceipt, which blocks every provider check.
  $dependencyScript = Join-Path $script:RepoRoot "scripts\windows\native_fem_dependencies.ps1"
  if (-not (Test-Path -LiteralPath $dependencyScript -PathType Leaf)) {
    throw "Native FEM dependency helper is missing: $dependencyScript"
  }
  . $dependencyScript
  $requirement = Get-ProviderBoostRequirement
  # The frozen dependency helper owns the archive pin, immutable install root,
  # selected tree, required headers, and license binding. Keep setup readiness
  # on that same fail-closed contract instead of reinterpreting the receipt.
  $null = Assert-FullmagNativeFemBoostReceipt `
    -Receipt $Receipt -Requirement $requirement -ProviderRoot $script:ProviderRoot
  return $Receipt.boost
}

function Test-ProviderReceiptPathWithin {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Base
  )
  try {
    $candidate = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    $root = [System.IO.Path]::GetFullPath($Base).TrimEnd('\', '/')
  }
  catch { return $false }
  return [string]::Equals($candidate, $root, [System.StringComparison]::OrdinalIgnoreCase) -or
    $candidate.StartsWith($root + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-ProviderReceiptPathChain {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Base,
    [Parameter(Mandatory = $true)][string]$Label,
    [switch]$Leaf
  )
  $resolved = [System.IO.Path]::GetFullPath($Path)
  $root = [System.IO.Path]::GetFullPath($Base)
  if (-not (Test-ProviderReceiptPathWithin -Path $resolved -Base $root)) {
    throw "$Label escapes its canonical root: $resolved"
  }
  $pathType = if ($Leaf) { "Leaf" } else { "Container" }
  if (-not (Test-Path -LiteralPath $resolved -PathType $pathType)) {
    throw "$Label is missing: $resolved"
  }
  $cursor = $resolved
  while ($true) {
    $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
        ($item.PSObject.Properties.Name -contains "LinkType" -and $item.LinkType)) {
      throw "$Label contains a junction or symlink: $cursor"
    }
    if ([string]::Equals($cursor, $root, [System.StringComparison]::OrdinalIgnoreCase)) { break }
    $parent = Split-Path -Parent $cursor
    if (-not $parent -or [string]::Equals($parent, $cursor, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "$Label has no safe canonical ancestor: $resolved"
    }
    $cursor = $parent
  }
  return $resolved
}

function Assert-ProviderReceiptZstd {
  param([Parameter(Mandatory = $true)][object]$Receipt)
  $helper = $null
  if ($null -ne $script:Requirements -and
      $null -ne $script:Requirements.provider_bootstrap -and
      $null -ne $script:Requirements.provider_bootstrap.internal_helpers) {
    $helper = $script:Requirements.provider_bootstrap.internal_helpers.zstd
  }
  if ($null -eq $helper -or [string]$helper.kind -ne "provider_bootstrap_internal_helper" -or
      [bool]$helper.host_requirement -or [string]$helper.managed_by -ne "scripts/windows/native_fem_dependencies.ps1") {
    throw "Provider requirements do not define zstd as the managed internal FEM bootstrap helper"
  }
  $metadata = $Receipt.zstd
  if ($null -eq $metadata) { throw "Provider receipt is missing zstd helper metadata" }
  foreach ($name in @("kind", "version", "url", "archive", "archive_name", "archive_sha256", "executable", "executable_name", "executable_sha256", "decode_memory")) {
    if ([string]::IsNullOrWhiteSpace([string]$metadata.$name)) {
      throw "Provider receipt zstd metadata is incomplete: $name"
    }
  }
  if ([string]$metadata.kind -ne [string]$helper.kind -or
      [string]$metadata.version -ne [string]$helper.version -or
      [string]$metadata.url -ne [string]$helper.url -or
      [string]$metadata.archive_name -ne [string]$helper.archive -or
      [string]$metadata.archive_sha256 -ne [string]$helper.archive_sha256 -or
      [string]$metadata.executable_name -ne [string]$helper.executable_name -or
      [string]$metadata.decode_memory -ne [string]$helper.decode_memory) {
    throw "Provider receipt zstd metadata does not match the committed helper pin"
  }
  if ([string]$metadata.archive_sha256 -notmatch '^[0-9a-f]{64}$' -or
      [string]$metadata.executable_sha256 -notmatch '^[0-9a-f]{64}$') {
    throw "Provider receipt zstd metadata contains an invalid SHA256"
  }
  $archive = [string]$metadata.archive
  if (-not [System.IO.Path]::IsPathRooted($archive) -or
      -not (Test-ProviderReceiptPathWithin -Path $archive -Base $script:ProviderRoot) -or
      [System.IO.Path]::GetFileName($archive) -ne [string]$helper.archive) {
    throw "Provider receipt zstd archive is outside the canonical provider root or has the wrong pin"
  }
  $archive = Assert-ProviderReceiptPathChain -Path $archive -Base $script:ProviderRoot `
    -Label "Provider zstd archive" -Leaf
  $archiveHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($archiveHash -ne ([string]$metadata.archive_sha256).ToLowerInvariant()) {
    throw "Provider zstd archive hash does not match the committed helper pin"
  }
  $executable = [string]$metadata.executable
  $toolRoot = Join-Path $script:ProviderRoot ("tools\" + [string]$helper.tool_directory)
  if (-not [System.IO.Path]::IsPathRooted($executable) -or
      -not (Test-ProviderReceiptPathWithin -Path $executable -Base $toolRoot) -or
      [System.IO.Path]::GetFileName($executable) -ne [string]$helper.executable_name) {
    throw "Provider receipt zstd executable is outside the canonical helper directory or has the wrong name"
  }
  $matches = @($Receipt.tools | Where-Object {
    [string]::Equals([string]$_.path, $executable, [System.StringComparison]::OrdinalIgnoreCase)
  })
  if ($matches.Count -ne 1 -or
      [string]$matches[0].sha256 -ne [string]$metadata.executable_sha256) {
    throw "Provider receipt zstd executable is not bound to its hashed tools inventory"
  }
}

function Assert-ProviderReceiptInventory {
  param([Parameter(Mandatory = $true)][object]$Receipt)
  if ($script:ProviderReceiptInventoryValidated) { return }
  $expectedPrefix = Join-Path $script:ProviderRoot "installed"
  if (-not (Test-Path -LiteralPath $expectedPrefix -PathType Container)) {
    throw "Provider receipt installed prefix is missing: $expectedPrefix"
  }
  $prefixItem = Get-Item -LiteralPath $expectedPrefix -Force -ErrorAction Stop
  if (($prefixItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
      ($prefixItem.PSObject.Properties.Name -contains "LinkType" -and $prefixItem.LinkType)) {
    throw "Provider receipt installed prefix is a reparse point: $expectedPrefix"
  }
  foreach ($kind in @("files", "tools")) {
    $entries = @($Receipt.$kind)
    if (-not $entries.Count) { throw "Provider receipt has an empty $kind inventory" }
    $base = if ($kind -eq "files") { $expectedPrefix } else { $script:ProviderRoot }
    $seen = @{}
    foreach ($entry in $entries) {
      if ($null -eq $entry) { throw "Provider receipt contains an empty $kind inventory entry" }
      $path = [string]$entry.path
      $hash = [string]$entry.sha256
      if (-not [System.IO.Path]::IsPathRooted($path) -or $hash -notmatch '^[0-9a-f]{64}$') {
        throw "Provider receipt contains an invalid $kind inventory entry"
      }
      $resolved = [System.IO.Path]::GetFullPath($path)
      if (-not (Test-ProviderReceiptPathWithin -Path $resolved -Base $base)) {
        throw "Provider receipt $kind inventory escapes its canonical root: $path"
      }
      $key = $resolved.ToLowerInvariant()
      if ($seen.ContainsKey($key)) { throw "Provider receipt contains duplicate $kind inventory entry: $path" }
      $seen[$key] = $true
      if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
        throw "Provider receipt inventory file is missing: $resolved"
      }
      $fileItem = Get-Item -LiteralPath $resolved -Force -ErrorAction Stop
      $cursor = $resolved
      while ($true) {
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
            ($item.PSObject.Properties.Name -contains "LinkType" -and $item.LinkType)) {
          throw "Provider receipt inventory contains a reparse point: $cursor"
        }
        if ([string]::Equals($cursor, [System.IO.Path]::GetFullPath($base), [System.StringComparison]::OrdinalIgnoreCase)) { break }
        $parent = Split-Path -Parent $cursor
        if (-not $parent -or $parent -eq $cursor) { throw "Provider receipt inventory has no safe canonical ancestor: $resolved" }
        $cursor = $parent
      }
      $hasSize = $entry.PSObject.Properties.Name -contains "size_bytes"
      if ($kind -eq "files" -and -not $hasSize) {
        throw "Provider receipt files inventory entry has no size_bytes: $resolved"
      }
      if ($hasSize) {
        try { $size = [int64]$entry.size_bytes }
        catch { throw "Provider receipt size_bytes is invalid: $resolved" }
        if ($size -lt 0 -or $size -ne [int64]$fileItem.Length) {
          throw "Provider receipt size mismatch: $resolved"
        }
      }
      $actualHash = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($actualHash -ne $hash.ToLowerInvariant()) { throw "Provider receipt hash mismatch: $resolved" }
    }
    if ($kind -eq "files") {
      $null = Assert-ProviderReceiptPathChain -Path $base -Base $base `
        -Label "Provider installed prefix"
      $providerDirectories = @(Get-ChildItem -LiteralPath $base -Directory -Recurse -Force -ErrorAction Stop)
      foreach ($directory in $providerDirectories) {
        $null = Assert-ProviderReceiptPathChain -Path $directory.FullName -Base $base `
          -Label "Provider installed directory"
      }
      $providerFiles = @(Get-ChildItem -LiteralPath $base -File -Recurse -Force -ErrorAction Stop)
      foreach ($providerFile in $providerFiles) {
        $providerFilePath = [System.IO.Path]::GetFullPath($providerFile.FullName)
        $providerFileKey = $providerFilePath.ToLowerInvariant()
        if (-not $seen.ContainsKey($providerFileKey)) {
          throw "Provider receipt installed-prefix inventory omits a file: $providerFilePath"
        }
      }
      if ($providerFiles.Count -ne $seen.Count) {
        throw "Provider receipt installed-prefix inventory does not exactly cover its files"
      }
    }
  }
  Assert-ProviderReceiptZstd -Receipt $Receipt
  $script:ProviderReceiptInventoryValidated = $true
}

function Get-ProviderReceiptLaneError {
  param([Parameter(Mandatory = $true)][object]$Receipt)
  if ($null -eq $Receipt.plan) { return "Provider receipt has no build plan" }
  if (-not (Compare-LocalPath ([string]$Receipt.plan.root) ([string]$script:ProviderRoot))) {
    return "Provider receipt root does not match the selected FEM storage profile"
  }
  $expectedPrefix = Join-Path $script:ProviderRoot "installed"
  if (-not (Test-Path -LiteralPath $expectedPrefix -PathType Container)) {
    return "Provider receipt installed prefix is missing: $expectedPrefix"
  }
  $prefixItem = Get-Item -LiteralPath $expectedPrefix -Force -ErrorAction SilentlyContinue
  if ($null -eq $prefixItem -or
      ($prefixItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
      ($prefixItem.PSObject.Properties.Name -contains "LinkType" -and $prefixItem.LinkType)) {
    return "Provider receipt installed prefix is a reparse point: $expectedPrefix"
  }
  if (-not (Compare-LocalPath ([string]$Receipt.plan.prefix) $expectedPrefix)) {
    return "Provider receipt install prefix does not match the selected FEM storage profile"
  }
  $gpuLane = $Lane -in @("fem-gpu", "all")
  $receiptCuda = [bool]$Receipt.plan.cuda
  $architectures = [string]$Receipt.plan.cuda_architectures
  if ($receiptCuda -ne $gpuLane) {
    $expected = if ($gpuLane) { "GPU" } else { "CPU" }
    return "Provider receipt CUDA mode does not match the selected $expected FEM lane"
  }
  if ($gpuLane) {
    $pattern = [string]$script:Requirements.provider_bootstrap.receipt_contract.gpu.pattern
    if (-not $pattern) { $pattern = '^\d+(;\d+)*$' }
    if ([string]::IsNullOrWhiteSpace($architectures) -or $architectures -notmatch $pattern) {
      return "GPU provider receipt must contain a non-empty numeric CUDA architecture list"
    }
  }
  elseif (-not [string]::IsNullOrWhiteSpace($architectures)) {
    return "CPU provider receipt must not contain CUDA architectures"
  }
  return $null
}

function Get-ProviderPath {
  param([Parameter(Mandatory = $true)][object]$Tool, [Parameter(Mandatory = $true)][string]$Label)
  $template = [string]$Tool.provider_path
  if ([string]::IsNullOrWhiteSpace($template)) { throw "$Label has no provider_path in the requirements manifest" }
  $expanded = $template.Replace("{build_root}", [string]$script:Layout.build_root)
  return Assert-StoragePath $expanded $Label
}

function Get-ToolStatus {
  param([Parameter(Mandatory = $true)][string]$Id)
  $tool = Get-Requirement $Id
  switch ($Id) {
    "git" {
      $info = Get-CommandInfo "git.exe"
      if ($null -eq $info) { return [pscustomobject]@{ status="missing"; detail="git.exe is not on PATH" } }
      if (-not (Test-MinimumVersion $info.version ([string]$tool.minimum))) { return [pscustomobject]@{ status="not_verified"; version=$info.version; path=$info.path; detail="Git version is below the project minimum" } }
      return [pscustomobject]@{ status="pass"; version=$info.version; path=$info.path; detail=$info.output }
    }
    "msvc_x64" {
      $vs = Get-VsInfo
      if ($null -eq $vs) { return [pscustomobject]@{ status="missing"; detail="Visual Studio Build Tools with the x64 C++ workload were not found" } }
      if (-not (Test-Path -LiteralPath $vs.vcvars -PathType Leaf) -or -not $vs.cl -or -not $vs.link) { return [pscustomobject]@{ status="not_verified"; path=$vs.path; detail="vcvars64, cl.exe, or link.exe is missing" } }
      return [pscustomobject]@{ status="pass"; path=$vs.path; detail="MSVC x64 environment is present" }
    }
    "windows_sdk" {
      $sdk = Get-SdkInfo
      if (-not $sdk) { return [pscustomobject]@{ status="missing"; detail="No Windows Kits x64 rc.exe was found" } }
      return [pscustomobject]@{ status="pass"; path=$sdk; detail="Windows SDK resource compiler is present" }
    }
    "rust_msvc" {
      $rustup = Get-CommandInfo "rustup.exe"
      $cargo = Get-CommandInfo "cargo.exe"
      $rustc = Get-CommandInfo "rustc.exe"
      if ($null -eq $rustup -or $null -eq $cargo -or $null -eq $rustc) { return [pscustomobject]@{ status="missing"; detail="rustup.exe, cargo.exe and rustc.exe are all required" } }
      $toolchainResult = Invoke-NativeOutput "rustup.exe" @("toolchain", "list")
      $targetResult = Invoke-NativeOutput "rustup.exe" @("target", "list", "--installed")
      if ($toolchainResult.exit_code -ne 0 -or $targetResult.exit_code -ne 0) {
        return [pscustomobject]@{ status="not_verified"; path=$rustup.path; detail="rustup could not enumerate the stable MSVC toolchain/target: $($toolchainResult.output) $($targetResult.output)" }
      }
      if ([string]$toolchainResult.output -notmatch '(?m)^stable-x86_64-pc-windows-msvc(?:\s|$)' -or [string]$targetResult.output -notmatch '(?m)^x86_64-pc-windows-msvc\s*$') {
        return [pscustomobject]@{ status="not_verified"; path=$rustup.path; detail="The stable x86_64-pc-windows-msvc toolchain/target is not installed" }
      }
      return [pscustomobject]@{ status="pass"; version=$rustc.version; path=$rustc.path; detail="stable MSVC toolchain and target are installed" }
    }
    "cmake" {
      $info = Get-CommandInfo "cmake.exe"
      if ($null -eq $info) { return [pscustomobject]@{ status="missing"; detail="cmake.exe is not on PATH" } }
      if (-not (Test-MinimumVersion $info.version ([string]$tool.minimum))) { return [pscustomobject]@{ status="not_verified"; version=$info.version; path=$info.path; detail="CMake is below the minimum" } }
      return [pscustomobject]@{ status="pass"; version=$info.version; path=$info.path; detail=$info.output }
    }
    "ninja" {
      $path = Get-ProviderPath $tool "pinned provider Ninja"
      if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        $system = Get-CommandInfo "ninja.exe"
        if ($system) { return [pscustomobject]@{ status="not_verified"; version=$system.version; path=$system.path; detail="A system Ninja exists, but the project-owned pinned provider Ninja 1.13.2 is missing" } }
        return [pscustomobject]@{ status="missing"; path=$path; detail="Pinned provider Ninja 1.13.2 is missing" }
      }
      $info = Get-CommandInfo $path
      if ($null -eq $info) { return [pscustomobject]@{ status="not_verified"; path=$path; detail="Pinned provider Ninja exists but could not be executed" } }
      if ($null -eq $info.version -or $info.version -ne [version]$tool.version) { return [pscustomobject]@{ status="not_verified"; version=$info.version; path=$info.path; detail="Ninja is not the pinned provider version" } }
      return [pscustomobject]@{ status="pass"; version=$info.version; path=$info.path; detail="provider Ninja is ready" }
    }
    "clang_cl" {
      $path = Get-ProviderPath $tool "pinned provider clang-cl"
      if (Test-Path -LiteralPath $path -PathType Leaf) {
        $info = Get-CommandInfo $path
        if ($info.output -match '23\.1\.3') { return [pscustomobject]@{ status="pass"; version=$info.version; path=$info.path; detail="pinned provider clang-cl is ready" } }
        return [pscustomobject]@{ status="not_verified"; version=$info.version; path=$info.path; detail="provider clang-cl has an unexpected version" }
      }
      $vs = Get-VsInfo
      if ($vs -and $vs.clang) { return [pscustomobject]@{ status="not_verified"; path=$vs.clang; detail="Visual Studio clang-cl is available, but the pinned LLVM provider is missing" } }
      return [pscustomobject]@{ status="missing"; detail="Pinned LLVM 23.1.3 clang-cl is missing" }
    }
    "msmpi_runtime" {
      $mpi = Get-CommandInfo "mpiexec.exe"
      if ($null -eq $mpi) { return [pscustomobject]@{ status="missing"; detail="Microsoft MPI x64 runtime mpiexec.exe is missing" } }
      $fileVersion = (Get-Item -LiteralPath $mpi.path -ErrorAction SilentlyContinue).VersionInfo.FileVersion
      $version = Get-VersionObject ([string]$fileVersion)
      if (-not (Test-MinimumVersion $version ([string]$tool.minimum))) {
        return [pscustomobject]@{ status="not_verified"; version=$version; path=$mpi.path; detail="Microsoft MPI runtime is present, but its file version could not be verified as >= $($tool.minimum)" }
      }
      return [pscustomobject]@{ status="pass"; version=$version; path=$mpi.path; detail="Microsoft MPI runtime command and file version are present" }
    }
    "msmpi_sdk" {
      $root = Get-ProviderPath $tool "pinned provider Microsoft MPI SDK"
      $header = @(Get-ChildItem -LiteralPath $root -Filter mpi.h -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1)
      $library = @(Get-ChildItem -LiteralPath $root -Filter msmpi.lib -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.Directory.Name -eq "x64" } | Select-Object -First 1)
      if (-not $header -or -not $library) { return [pscustomobject]@{ status="missing"; path=$root; detail="Provider Microsoft MPI SDK 10.1.1 is not extracted" } }
      return [pscustomobject]@{ status="pass"; version=$tool.version; path=$root; detail="provider MPI SDK header and x64 library are present" }
    }
    { $_ -in @("mfem", "hypre", "libceed") } {
      try { $receipt = Get-ProviderReceipt }
      catch { return [pscustomobject]@{ status="blocked"; path=$script:ProviderRoot; detail=$_.Exception.Message } }
      if ($null -eq $receipt -or $null -eq $receipt.plan.providers) { return [pscustomobject]@{ status="not_verified"; path=$script:ProviderRoot; detail="Provider receipt is missing; run the pinned FEM provider bootstrap" } }
      $laneError = Get-ProviderReceiptLaneError $receipt
      if ($laneError) { return [pscustomobject]@{ status="blocked"; path=$script:ProviderRoot; detail=$laneError } }
      try { $null = Assert-ProviderReceiptInventory $receipt }
      catch { return [pscustomobject]@{ status="blocked"; path=$script:ProviderRoot; detail=$_.Exception.Message } }
      $entry = @($receipt.plan.providers | Where-Object { $_.name -eq $Id }) | Select-Object -First 1
      if ($null -eq $entry -or [string]$entry.version -ne [string]$tool.version -or [string]$entry.sha -ne [string]$tool.commit) {
        return [pscustomobject]@{ status="not_verified"; path=$script:ProviderRoot; detail="Provider receipt does not match the committed version/commit pin" }
      }
      return [pscustomobject]@{ status="pass"; version=$tool.version; path=$script:ProviderRoot; detail="provider receipt matches the committed pin; runtime/build still separate" }
    }
    "boost_headers" {
      try { $receipt = Get-ProviderReceipt }
      catch { return [pscustomobject]@{ status="blocked"; path=$script:ProviderRoot; detail=$_.Exception.Message } }
      if ($null -eq $receipt -or $null -eq $receipt.boost) {
        return [pscustomobject]@{ status="not_verified"; path=$script:ProviderRoot; detail="Provider receipt is missing; run the pinned FEM provider bootstrap" }
      }
      try { $null = Assert-ProviderReceiptInventory $receipt }
      catch { return [pscustomobject]@{ status="blocked"; path=$script:ProviderRoot; detail=$_.Exception.Message } }
      return [pscustomobject]@{ status="pass"; version=$tool.version; path=$script:ProviderRoot; detail="managed Boost headers receipt matches the committed pin; runtime/build still separate" }
    }
    "cuda" {
      $nvcc = Get-NvccInfo
      if ($null -eq $nvcc) { return [pscustomobject]@{ status="missing"; detail="CUDA nvcc.exe is missing" } }
      if (-not (Test-MinimumVersion $nvcc.version ([string]$tool.minimum))) { return [pscustomobject]@{ status="not_verified"; version=$nvcc.version; path=$nvcc.path; detail="CUDA toolkit is below the minimum" } }
      return [pscustomobject]@{ status="pass"; version=$nvcc.version; path=$nvcc.path; detail="nvcc is present; GPU runtime is a separate gate" }
    }
    "python" {
      $python = Get-PythonCommand
      if ($null -eq $python) { return [pscustomobject]@{ status="missing"; detail="Python >=3.12 must be available as python.exe on PATH; py.exe alone is not sufficient for managed Windows entrypoints" } }
      $info = Get-CommandInfo $python.command (@($python.prefix + @("--version")))
      if ($null -eq $info -or -not (Test-MinimumVersion $info.version ([string]$tool.minimum))) { return [pscustomobject]@{ status="not_verified"; version=$python.version; path=$python.command; detail="Python is below 3.12 or could not be queried" } }
      return [pscustomobject]@{ status="pass"; version=$info.version; path=$info.path; detail=$info.output }
    }
    "uv" {
      $candidates = @(
        (Join-Path $script:Layout.cache_root "tools\\uv\\Scripts\\uv.exe"),
        (Join-Path $script:Layout.cache_root "tools\\uv\\uv.exe")
      )
      $info = $null
      foreach ($candidate in $candidates) { if (Test-Path -LiteralPath $candidate -PathType Leaf) { $info = Get-CommandInfo $candidate; break } }
      if ($null -eq $info) {
        $system = Get-CommandInfo "uv.exe"
        if ($system) { return [pscustomobject]@{ status="not_verified"; version=$system.version; path=$system.path; detail="A global uv exists, but project-owned uv is required" } }
        return [pscustomobject]@{ status="missing"; detail="uv is missing from the project tool root" }
      }
      if (-not (Test-MinimumVersion $info.version ([string]$tool.minimum)) -or $info.version -ne [version]$tool.version) {
        return [pscustomobject]@{ status="not_verified"; version=$info.version; path=$info.path; detail="uv is not the pinned project version $($tool.version)" }
      }
      return [pscustomobject]@{ status="pass"; version=$info.version; path=$info.path; detail="project-managed uv $($tool.version) is ready" }
    }
    "node" {
      $info = Get-CommandInfo "node.exe"
      if ($null -eq $info) { return [pscustomobject]@{ status="missing"; detail="node.exe is not on PATH" } }
      if (-not (Test-RangeVersion $info.version ([string]$tool.minimum) ([string]$tool.maximum_exclusive))) { return [pscustomobject]@{ status="not_verified"; version=$info.version; path=$info.path; detail="Node must be in the 24.18.x through 24.99.x range" } }
      return [pscustomobject]@{ status="pass"; version=$info.version; path=$info.path; detail=$info.output }
    }
    "pnpm" {
      $cli = Join-Path $script:Layout.env.COREPACK_HOME "v1\\pnpm\\$($tool.version)\\bin\\pnpm.cjs"
      if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { return [pscustomobject]@{ status="missing"; path=$cli; detail="Pinned pnpm CLI is missing from project Corepack storage" } }
      $result = Invoke-NativeOutput "node.exe" @($cli, "--version")
      if ($result.exit_code -ne 0 -or [string]$result.output -ne [string]$tool.version) { return [pscustomobject]@{ status="not_verified"; version=$result.output; path=$cli; detail="Pinned pnpm CLI did not report the required version" } }
      return [pscustomobject]@{ status="pass"; version=$result.output; path=$cli; detail="project Corepack pin is ready" }
    }
    "just" {
      $managed = Join-Path $script:Layout.cache_root "tools\\bin\\just.exe"
      if (-not (Test-Path -LiteralPath $managed -PathType Leaf)) {
        $system = Get-CommandInfo "just.exe"
        if ($system) { return [pscustomobject]@{ status="not_verified"; version=$system.version; path=$system.path; detail="A global just exists, but project-managed just.exe is required" } }
        return [pscustomobject]@{ status="missing"; path=$managed; detail="project-managed just.exe is missing" }
      }
      $info = Get-CommandInfo $managed
      if ($null -eq $info) { return [pscustomobject]@{ status="not_verified"; path=$managed; detail="project-managed just.exe exists but could not be executed" } }
      if ($null -eq $info.version -or $info.version -ne [version]$tool.version) {
        return [pscustomobject]@{ status="not_verified"; version=$info.version; path=$info.path; detail="project-managed just.exe is not the pinned version $($tool.version)" }
      }
      return [pscustomobject]@{ status="pass"; version=$info.version; path=$info.path; detail="project-managed just $($tool.version) is ready" }
    }
    "wix" {
      $info = Get-CommandInfo "wix.exe"
      if ($null -eq $info) { return [pscustomobject]@{ status="missing"; detail="WiX is optional; use -WithWix to make it required" } }
      return [pscustomobject]@{ status="pass"; version=$info.version; path=$info.path; detail=$info.output }
    }
    default { throw "No checker implemented for requirement '$Id'" }
  }
}

function Install-Uv {
  $tool = Get-Requirement "uv"
  $root = Ensure-StorageDirectory (Join-Path $script:Layout.cache_root "tools\\uv") "project uv tool root"
  $prefix = Join-Path $script:Layout.cache_root "tools\\uv"
  $uvBinary = Join-Path $prefix "Scripts\\uv.exe"
  if ((Get-ChildItem -LiteralPath $prefix -Force -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0 -and
      -not (Test-Path -LiteralPath $uvBinary -PathType Leaf)) {
    throw "Project uv directory contains an incomplete installation; refusing to overwrite it: $prefix"
  }
  if (Test-Path -LiteralPath $uvBinary -PathType Leaf) {
    $existing = Get-CommandInfo $uvBinary
    if ($null -eq $existing -or -not (Test-MinimumVersion $existing.version ([string]$tool.version)) -or $existing.version -ne [version]$tool.version) {
      throw "Project uv installation is not the pinned version; refusing to overwrite it: $uvBinary"
    }
    return
  }
  $env:PIP_CACHE_DIR = [string]$script:Layout.env.PIP_CACHE_DIR
  $null = Ensure-StorageDirectory $env:PIP_CACHE_DIR "Python package cache"
  Invoke-Python @("-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--prefix", $prefix, "uv==$($tool.version)")
  Add-ProcessPath (Join-Path $prefix "Scripts")
}

function Install-PinnedNode {
  $tool = Get-Requirement "node"
  $reference = $tool.pinned_reference
  $downloads = Ensure-StorageDirectory (Join-Path $script:Layout.cache_root "downloads") "Node installer downloads"
  $msi = Join-Path $downloads "node-v$($reference.version)-x64.msi"
  $partial = $msi + ".partial"
  if (Test-Path -LiteralPath $msi -PathType Leaf) {
    $hash = (Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne [string]$reference.sha256) { throw "Existing Node installer has a hash mismatch; refusing overwrite: $msi" }
  }
  elseif (Test-Path -LiteralPath $partial -PathType Leaf) {
    $hash = (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne [string]$reference.sha256) { throw "Existing partial Node installer has a hash mismatch; refusing overwrite: $partial" }
    Move-Item -LiteralPath $partial -Destination $msi
  }
  else {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri ([string]$reference.url) -OutFile $partial
    $hash = (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne [string]$reference.sha256) { Remove-Item -LiteralPath $partial -Force; throw "Node installer hash mismatch; refusing installation" }
    Move-Item -LiteralPath $partial -Destination $msi
  }
  $process = Start-Process -FilePath (Join-Path $env:SystemRoot "System32\msiexec.exe") -ArgumentList @(
    "/i", ('"' + $msi + '"'), "/qn", "/norestart"
  ) -Wait -PassThru
  if ($process.ExitCode -notin @(0, 3010)) { throw "Pinned Node $($reference.version) installation failed with exit code $($process.ExitCode)" }
}

function Install-RustToolchain {
  $tool = Get-Requirement "rust_msvc"
  if (-not (Get-Command rustup.exe -ErrorAction SilentlyContinue)) {
    Invoke-WingetInstall (Get-Requirement "rust_msvc").install "rust_msvc"
    Add-ProcessPath (Join-Path $env:USERPROFILE ".cargo\\bin")
  }
  $env:CARGO_HOME = [string]$script:Layout.env.CARGO_HOME
  $env:RUSTUP_HOME = [string]$script:Layout.env.RUSTUP_HOME
  $null = Ensure-StorageDirectory $env:CARGO_HOME "Cargo home"
  $null = Ensure-StorageDirectory $env:RUSTUP_HOME "Rustup home"
  Invoke-Checked "rustup.exe" @("toolchain", "install", [string]$tool.toolchain, "--profile", "minimal", "--component", "rustfmt", "--component", "clippy", "--no-self-update") "Rust MSVC toolchain installation"
  Invoke-Checked "rustup.exe" @("target", "add", [string]$tool.target, "--toolchain", [string]$tool.toolchain) "Rust MSVC target installation"
  Add-ProcessPath (Join-Path $env:CARGO_HOME "bin")
}

function Get-CorepackCommand {
  foreach ($name in @("corepack.exe", "corepack.cmd")) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($command) {
      if ($command.Source) { return [string]$command.Source }
      return [string]$command.Path
    }
  }
  return $null
}

function Install-Pnpm {
  $tool = Get-Requirement "pnpm"
  $corepack = Get-CorepackCommand
  if (-not $corepack) { throw "Node's corepack.exe or corepack.cmd is required to provision pinned pnpm $($tool.version)" }
  $env:COREPACK_HOME = [string]$script:Layout.env.COREPACK_HOME
  $null = Ensure-StorageDirectory $env:COREPACK_HOME "Corepack home"
  Invoke-Checked $corepack @("install", "--global", "pnpm@$($tool.version)") "pnpm provisioning"
}

function Install-Just {
  $tool = Get-Requirement "just"
  $managed = Join-Path $script:Layout.cache_root "tools\\bin"
  $null = Ensure-StorageDirectory $managed "project just tool root"
  $binary = Join-Path $managed "just.exe"
  if (Test-Path -LiteralPath $binary -PathType Leaf) {
    $existing = Get-CommandInfo $binary
    if ($null -eq $existing -or $null -eq $existing.version -or $existing.version -ne [version]$tool.version) {
      throw "Project just installation is not the pinned version; refusing to overwrite it: $binary"
    }
    Add-ProcessPath $managed
    return
  }
  $existingFiles = @(Get-ChildItem -LiteralPath $managed -Force -ErrorAction SilentlyContinue)
  if ($existingFiles.Count -gt 0) {
    throw "Project just tool root contains an incomplete installation; refusing to overwrite it: $managed"
  }

  $downloads = Ensure-StorageDirectory (Join-Path $script:Layout.cache_root "downloads") "just installer downloads"
  $archive = Join-Path $downloads "just-$($tool.version)-x86_64-pc-windows-msvc.zip"
  $partial = $archive + ".partial"
  if (Test-Path -LiteralPath $archive -PathType Leaf) {
    $hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne [string]$tool.install.sha256) { throw "Existing just archive has a hash mismatch; refusing overwrite: $archive" }
  }
  elseif (Test-Path -LiteralPath $partial -PathType Leaf) {
    $hash = (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne [string]$tool.install.sha256) { throw "Existing partial just archive has a hash mismatch; refusing overwrite: $partial" }
    $null = Move-Item -LiteralPath $partial -Destination $archive
  }
  else {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $null = Invoke-WebRequest -UseBasicParsing -Uri ([string]$tool.install.url) -OutFile $partial
    $hash = (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne [string]$tool.install.sha256) { throw "just archive hash mismatch; refusing installation" }
    $null = Move-Item -LiteralPath $partial -Destination $archive
  }

  $extract = Join-Path $downloads "just-$($tool.version)-x86_64-pc-windows-msvc-extract"
  if (Test-Path -LiteralPath $extract) {
    throw "An incomplete just extraction already exists; refusing overwrite: $extract"
  }
  $null = Ensure-StorageDirectory $extract "just extraction directory"
  try {
    $null = Expand-Archive -LiteralPath $archive -DestinationPath $extract
    $source = @(Get-ChildItem -LiteralPath $extract -Filter "just.exe" -File -Recurse | Select-Object -First 1)
    if ($source.Count -ne 1) { throw "Pinned just archive did not contain just.exe" }
    if (Test-Path -LiteralPath $binary) { throw "Project just binary appeared during installation; refusing overwrite: $binary" }
    $null = Move-Item -LiteralPath $source[0].FullName -Destination $binary
  }
  finally {
    if (Test-Path -LiteralPath $extract) { Remove-Item -LiteralPath $extract -Recurse -Force }
  }
  Add-ProcessPath $managed
}

function Install-Tool {
  param([Parameter(Mandatory = $true)][string]$Id)
  if (-not $script:InstallAttempted.Add($Id)) { return }
  $tool = Get-Requirement $Id
  switch ($Id) {
    "msvc_x64" { Invoke-WingetInstall $tool.install $Id; return }
    "windows_sdk" { Invoke-WingetInstall (Get-Requirement "msvc_x64").install $Id; return }
    "rust_msvc" { Install-RustToolchain; return }
    "cmake" { Invoke-WingetInstall $tool.install $Id; return }
    "msmpi_runtime" { Invoke-WingetInstall $tool.install $Id; return }
    "cuda" { Invoke-WingetInstall $tool.install $Id; return }
    "python" { Invoke-WingetInstall $tool.install $Id; return }
    "uv" { Install-Uv; return }
    "node" { Install-PinnedNode; return }
    "pnpm" { Install-Pnpm; return }
    "just" { Install-Just; return }
    "wix" { Invoke-WingetInstall $tool.install $Id; return }
    "git" { Invoke-WingetInstall $tool.install $Id; return }
    { $_ -in @("ninja", "clang_cl", "msmpi_sdk", "mfem", "hypre", "libceed", "boost_headers") } {
      throw "$Id is supplied by the pinned FEM provider bootstrap ($($script:Requirements.provider_bootstrap.script)); this setup script will not silently install a second global provider."
    }
    default { throw "No installer implemented for requirement '$Id'" }
  }
}

function Test-ProviderRequirement {
  param([Parameter(Mandatory = $true)][string]$Id)
  return $Id -in @("ninja", "clang_cl", "msmpi_sdk", "mfem", "hypre", "libceed", "boost_headers")
}

function Invoke-ToolChecks {
  foreach ($id in Get-LaneRequirementIds) {
    try {
      try {
        $status = Get-ToolStatus $id
      }
      catch {
        if (-not $Install) { throw }
        # A malformed/partial pre-installation may make the first probe fail
        # before it can return a status.  -Install must still reach the
        # explicit installer, especially for rustup/rustc provisioning.
        $status = [pscustomobject]@{
          status = "not_verified"
          version = $null
          path = ""
          detail = "Initial check failed; attempting the requested installation: $($_.Exception.Message)"
        }
      }
      if ((Test-ProviderRequirement $id) -and $status.status -in @("missing", "not_verified")) {
        $prepare = if ($Lane -eq "fem-cpu") { "just windows-build fem cpu" } else { [string]$script:Requirements.provider_bootstrap.prepare_command }
        $status = [pscustomobject]@{
          status = "pending"
          version = $status.version
          path = $status.path
          detail = "Provider bootstrap pending; run '$prepare' through the managed Windows build route."
        }
      }
      elseif ($Install -and $status.status -notin @("pass", "not_applicable", "blocked")) {
        try {
          Install-Tool $id
          Refresh-CommonWindowsToolPaths
          if ($id -eq "python") { $script:PythonCommand = Get-PythonCommand }
          if ($id -eq "rust_msvc") { Add-ProcessPath (Join-Path $script:Layout.env.CARGO_HOME "bin") }
          if ($id -eq "uv") { Add-ProcessPath (Join-Path $script:Layout.cache_root "tools\\uv\\Scripts") }
          if ($id -eq "just") { Add-ProcessPath (Join-Path $script:Layout.cache_root "tools\\bin") }
          if ($id -eq "msvc_x64") { $vsAfter = Get-VsInfo; if ($vsAfter) { Import-VsEnvironment $vsAfter } }
          $status = Get-ToolStatus $id
        }
        catch {
          $status = [pscustomobject]@{ status = "blocked"; detail = $_.Exception.Message; path = ""; version = $null }
        }
      }
      $scope = if ($id -in @("mfem", "hypre", "libceed", "boost_headers", "ninja", "clang_cl", "msmpi_sdk")) { "provider" } elseif ($id -eq "msmpi_runtime") { "runtime" } elseif ($id -in @("msvc_x64", "windows_sdk", "rust_msvc", "cmake", "cuda")) { "compiler" } else { "check" }
      Add-Result -Id $id -Status ([string]$status.status) -Version ([string]$status.version) -Path ([string]$status.path) -Detail ([string]$status.detail) -Scope $scope
    }
    catch {
      Add-Result -Id $id -Status "blocked" -Detail $_.Exception.Message
    }
  }
}

function Show-Report {
  # Convert the generic list explicitly. Windows PowerShell 5.1 can throw
  # "Argument types do not match" for @($list) when the list was New-Object'd.
  $allResults = @($script:Results.ToArray())
  $blockingResults = @($allResults | Where-Object { $_.status -notin @("pass", "not_applicable", "pending") })
  $pendingResults = @($allResults | Where-Object { $_.status -eq "pending" })
  $readiness = if ($blockingResults.Count -gt 0) { "blocked" } elseif ($pendingResults.Count -gt 0) { "compiler_ready_provider_pending" } else { "ready" }
  $report = [ordered]@{
    schema = "fullmag.windows-build-environment-report.v1"
    mode = if ($Install) { "install" } else { "check" }
    lane = $Lane
    readiness = $readiness
    repository = $script:RepoRoot
    main_checkout = $script:MainRepoRoot
    storage_dotenv = if ($script:MainRepoRoot) { Join-Path $script:MainRepoRoot ".env" } else { "" }
    storage_root = if ($script:Layout) { [string]$script:Layout.storage_root } else { $script:StorageRootValue }
    storage_profile = if ($script:Layout) { [string]$script:Layout.profile } else { [string]$script:StorageProfile }
    project_owned_tools_root = if ($script:Layout) { Join-Path $script:Layout.build_root "tools" } else { "" }
    installation = [ordered]@{
      requested = [bool]$Install
      attempted = @($allResults | Where-Object { $_.install_attempted })
      note = if ($Install) { "Only explicitly requested -Install actions are attempted; a result still requires a fresh check." } else { "Check-only mode; no installer or project-owned directory creation was requested." }
    }
    compiler_status = @($allResults | Where-Object { $_.scope -eq "compiler" })
    provider_status = @($allResults | Where-Object { $_.scope -eq "provider" })
    runtime_tool_status = @($allResults | Where-Object { $_.scope -eq "runtime" })
    pending = $pendingResults
    checks = $allResults
    blockers = @($blockingResults | ForEach-Object { $_.id + ": " + $_.detail })
    runtime = [ordered]@{
      status = "NOT VERIFIED"
      note = "This command checks tool availability and provider receipts only; it does not build, execute, or scientifically qualify Fullmag."
    }
  }
  if ($Json) { $report | ConvertTo-Json -Depth 10; return }
  Write-Host "Fullmag Windows build environment: $($report.mode), lane=$Lane"
  Write-Host "Repository: $($report.repository)"
  Write-Host "Storage: $($report.storage_root) (profile $($report.storage_profile))"
  Write-Host "Readiness: $($report.readiness)"
  Write-Host ("Installation requested: " + [bool]$Install)
  foreach ($item in $script:Results) {
    $line = "[{0}] {1}" -f $item.status.ToUpperInvariant(), $item.id
    if ($item.version) { $line += " $($item.version)" }
    if ($item.detail) { $line += " - $($item.detail)" }
    Write-Host $line
  }
  Write-Host "Runtime/physics qualification: NOT VERIFIED"
  if ($pendingResults.Count -gt 0) { Write-Host "Pending provider bootstrap:"; foreach ($item in $pendingResults) { Write-Host ("- " + $item.id + ": " + $item.detail) } }
  if ($blockingResults.Count -gt 0) { Write-Host "Blockers:"; foreach ($blocker in $blockingResults) { Write-Host ("- " + $blocker.id + ": " + $blocker.detail) } }
}

function Show-PrerequisiteReport {
  param(
    [Parameter(Mandatory = $true)][object]$Git,
    [Parameter(Mandatory = $true)][object]$Python
  )
  $gitPath = Assert-ExecutablePath ([string]$Git.path) "git"
  $pythonPath = Assert-ExecutablePath ([string]$Python.command) "python"
  $report = [ordered]@{
    schema = "fullmag.windows-build-prerequisites.v1"
    mode = "prerequisites-only"
    phase = "preadmission"
    state = "complete"
    lane = $Lane
    readiness = "prerequisites_ready"
    repository = $script:RepoRoot
    payload_root = $script:PayloadRoot
    requirements_path = $script:RequirementsPath
    requirements_sha256 = $script:RequirementsSha256
    main_checkout = $script:MainRepoRoot
    storage_root = $script:StorageRootValue
    storage_profile = [string]$script:Requirements.storage.setup_profile
    source_admitted = $false
    env_write = $false
    tools = [ordered]@{
      git = [ordered]@{ path = $gitPath; version = [string]$Git.version }
      python = [ordered]@{ path = $pythonPath; version = [string]$Python.version }
    }
    installation = [ordered]@{
      requested = [bool]$Install
      attempted = @($script:InstallAttempted | ForEach-Object { [string]$_ })
    }
    project_owned_writes = $false
    storage_resolver = "not_run"
    full_dependency_install = $false
  }
  if ($Json) { $report | ConvertTo-Json -Depth 12; return }
  Write-Host "Fullmag Windows prerequisite bootstrap: lane=$Lane"
  Write-Host "Repository: $($report.repository)"
  Write-Host "Git: $gitPath"
  Write-Host "Python: $pythonPath ($($Python.version))"
  Write-Host "No project-owned storage or full dependency installation was performed."
}

try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw "This setup route is Windows-only and refuses WSL/Linux fallback." }
  if ($PrerequisitesOnly) {
    if (-not $Install) { throw "-PrerequisitesOnly requires explicit -Install" }
    if ([string]::IsNullOrWhiteSpace($StorageRoot)) { throw "-PrerequisitesOnly requires an explicit -StorageRoot" }
    $StorageRoot = Convert-ToLocalAbsolutePath $StorageRoot

    # This branch is also invoked from the signed/bundled installer payload,
    # before a selected checkout can be admitted.  Resolve the requirements
    # from the payload directory itself; do not require .git or execute the
    # source checkout's resolver/.env path before the toolchain is ready.
    $payloadRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
    $requirementsPath = Assert-ExecutablePath (Join-Path $payloadRoot "windows_build_requirements.json") "requirements manifest"
    $script:PayloadRoot = $payloadRoot
    $script:RequirementsPath = $requirementsPath
    $script:RequirementsSha256 = Assert-RequirementsHash $requirementsPath $ExpectedRequirementsSha256
    $bootstrapRequirements = Read-Requirements $requirementsPath
    $script:RepoRoot = $payloadRoot
    $script:Requirements = $bootstrapRequirements
    $script:StorageProfile = [string]$script:Requirements.storage.setup_profile
    if ([string]::IsNullOrWhiteSpace($script:StorageProfile)) { throw "Requirements manifest has no storage setup profile" }
    $script:StorageRootValue = $StorageRoot

    $gitRequirement = $bootstrapRequirements.tools.git
    if ($null -eq $gitRequirement -or $null -eq $gitRequirement.install -or [string]::IsNullOrWhiteSpace([string]$gitRequirement.minimum)) { throw "Git bootstrap pin is missing from the requirements manifest" }
    Refresh-CommonWindowsToolPaths
    $gitInfo = Get-CommandInfo "git.exe"
    if ($null -eq $gitInfo -or -not (Test-MinimumVersion $gitInfo.version ([string]$gitRequirement.minimum))) {
      [void]$script:InstallAttempted.Add("git")
      Invoke-WingetInstall $gitRequirement.install "git"
      Refresh-CommonWindowsToolPaths
      $gitInfo = Get-CommandInfo "git.exe"
    }
    if ($null -eq $gitInfo -or -not (Test-MinimumVersion $gitInfo.version ([string]$gitRequirement.minimum))) {
      throw "Git >= $($gitRequirement.minimum) is not available after the prerequisite bootstrap"
    }

    $script:PythonCommand = Get-PythonCommand
    if ($null -eq $script:PythonCommand) {
      [void]$script:InstallAttempted.Add("python")
      Invoke-WingetInstall (Get-Requirement "python").install "python"
      Refresh-CommonWindowsToolPaths
      $script:PythonCommand = Get-PythonCommand
    }
    if ($null -eq $script:PythonCommand) { throw "Python >=3.12 is not available after the prerequisite bootstrap" }
    Show-PrerequisiteReport $gitInfo $script:PythonCommand
    exit 0
  }
  if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) {
    if (-not $Install) {
      throw "git.exe is missing. Rerun with -Install after confirming this copied checkout includes its .git metadata; no git init or provenance fallback is performed."
    }
    $hint = Get-CheckoutDirectoryHint
    $bootstrapRequirements = Read-Requirements (Join-Path $hint "windows_build_requirements.json")
    Invoke-WingetInstall $bootstrapRequirements.tools.git.install "git"
    Refresh-CommonWindowsToolPaths
  }
  $script:RepoRoot = Get-RepoRoot
  $script:Requirements = Read-Requirements (Join-Path $script:RepoRoot "windows_build_requirements.json")
  $script:StorageProfile = Get-StorageProfile
  $storageConfiguration = Resolve-StorageConfiguration

  $script:PythonCommand = Get-PythonCommand
  if ($null -eq $script:PythonCommand -and $Install) {
    # This is the only pre-resolver installer. It does not write project-owned
    # data; a storage argument was validated above before it can run.
    Invoke-WingetInstall (Get-Requirement "python").install "python"
    Refresh-CommonWindowsToolPaths
    $script:PythonCommand = Get-PythonCommand
  }
  if ($null -eq $script:PythonCommand) {
    Add-Result -Id "python" -Status "missing" -Detail "Python >=3.12 must be available as python.exe on PATH; py.exe alone is not sufficient for managed Windows entrypoints"
    throw "Python >=3.12 must be available as python.exe on PATH; install it with -Install or open a fresh PowerShell after adding its directory to PATH."
  }

  $script:Layout = Resolve-FullmagStorage -Create:$Install
  Write-StorageDotEnv $storageConfiguration
  $script:ToolsPath = Get-ManagedDirectory (Join-Path $script:Layout.cache_root "tools") "project tool cache"
  $script:ProviderRoot = Get-ManagedDirectory (Join-Path $script:Layout.build_root "fem-dependencies") "FEM provider root"
  Add-ProcessPath (Join-Path $script:Layout.cache_root "tools\\bin")
  Add-ProcessPath (Join-Path $script:Layout.cache_root "tools\\uv\\Scripts")
  Add-ProcessPath (Join-Path $script:Layout.env.CARGO_HOME "bin")
  $env:CARGO_HOME = [string]$script:Layout.env.CARGO_HOME
  $env:RUSTUP_HOME = [string]$script:Layout.env.RUSTUP_HOME
  $env:COREPACK_HOME = [string]$script:Layout.env.COREPACK_HOME

  $vs = Get-VsInfo
  if ($vs) { Import-VsEnvironment $vs }
  Invoke-ToolChecks
  Show-Report
  $ok = @($script:Results.ToArray() | Where-Object { $_.status -notin @("pass", "not_applicable", "pending") }).Count -eq 0
  if (-not $ok) { exit 2 }
  exit 0
}
catch {
  if ($Json) {
    if ($PrerequisitesOnly) {
      [ordered]@{
        schema = "fullmag.windows-build-prerequisites.v1"
        mode = "prerequisites-only"
        phase = "preadmission"
        state = "blocked"
        lane = $Lane
        readiness = "blocked"
        repository = $script:RepoRoot
        payload_root = $script:PayloadRoot
        requirements_path = $script:RequirementsPath
        requirements_sha256 = $script:RequirementsSha256
        main_checkout = $script:MainRepoRoot
        storage_root = $script:StorageRootValue
        storage_profile = $script:StorageProfile
        source_admitted = $false
        env_write = $false
        project_owned_writes = $false
        storage_resolver = "not_run"
        full_dependency_install = $false
        installation = [ordered]@{
          requested = [bool]$Install
          attempted = @($script:InstallAttempted | ForEach-Object { [string]$_ })
        }
        blockers = @($_.Exception.Message)
      } | ConvertTo-Json -Depth 10
    }
    else {
      [ordered]@{
        schema = "fullmag.windows-build-environment-report.v1"
        mode = if ($Install) { "install" } else { "check" }
        lane = $Lane
        readiness = "blocked"
        repository = $script:RepoRoot
        main_checkout = $script:MainRepoRoot
        storage_profile = $script:StorageProfile
        storage_root = $script:StorageRootValue
        failure_location = $_.ScriptStackTrace
        installation = [ordered]@{ requested = [bool]$Install; attempted = @($script:Results.ToArray() | Where-Object { $_.install_attempted }) }
        checks = @($script:Results.ToArray())
        blockers = @($_.Exception.Message)
        runtime = [ordered]@{ status = "NOT VERIFIED" }
      } | ConvertTo-Json -Depth 10
    }
  }
  else { [Console]::Error.WriteLine("Fullmag Windows setup blocked: " + $_.Exception.Message) }
  exit 2
}
