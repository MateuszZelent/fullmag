# Shared Windows adapter for scripts/fullmag_storage.py.
#
# Dot-source this file after setting $RepoRoot and call
# Resolve-FullmagStorageLayout before creating any project-owned directory.
# The Python resolver performs the authoritative Git, marker, containment and
# environment validation.  This adapter deliberately invokes it once per
# launcher process and only translates its JSON result for PowerShell.

function Resolve-FullmagStorageLayout {
  param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][string]$Profile
  )

  $resolver = Join-Path $RepoRoot "scripts\fullmag_storage.py"
  if (-not (Test-Path -LiteralPath $resolver -PathType Leaf)) {
    throw "Fullmag storage resolver is missing: $resolver"
  }
  $python = Get-Command "python" -ErrorAction SilentlyContinue
  if (-not $python) {
    throw "Python is required to resolve Fullmag project storage"
  }

  if ($env:FULLMAG_STORAGE_MANAGED_ENTRY -eq "1") {
    $lockOutput = (& $python.Source @(
        $resolver, "assert-lock", "--repo-root", $RepoRoot,
        "--profile", $Profile, "--format", "json"
      ) 2>&1 | Out-String)
    $lockExitCode = $LASTEXITCODE
    if ($lockExitCode -ne 0) {
      throw "Fullmag storage lock assertion failed with exit code ${lockExitCode}: $lockOutput"
    }
  }

  # --create is the first mutating operation in each Windows launcher.  All
  # environment overrides are validated by the resolver before it initializes
  # the marker or creates any layout directory.
  $resolverArguments = @(
    $resolver, "resolve", "--repo-root", $RepoRoot,
    "--profile", $Profile, "--format", "json", "--create"
  )
  $output = (& $python.Source @resolverArguments 2>&1 | Out-String)
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw "Fullmag storage resolution failed with exit code ${exitCode}: $output"
  }
  try {
    $layout = $output | ConvertFrom-Json
  }
  catch {
    throw "Fullmag storage resolver returned invalid JSON: $output"
  }
  foreach ($field in @(
      "repo_root", "project_root", "storage_root", "build_root", "cache_root",
      "temp_root", "runtime_root", "runs_root", "worktree_id", "profile", "env"
    )) {
    if ($null -eq $layout.$field -or [string]::IsNullOrWhiteSpace([string]$layout.$field)) {
      throw "Fullmag storage resolver omitted required field: $field"
    }
  }
  return $layout
}

function Invoke-FullmagStorageJson {
  param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][string]$Profile,
    [Parameter(Mandatory = $true)][string]$Action,
    [Parameter()][string[]]$ActionArguments = @()
  )

  $resolver = Join-Path $RepoRoot "scripts\fullmag_storage.py"
  if (-not (Test-Path -LiteralPath $resolver -PathType Leaf)) {
    throw "Fullmag storage resolver is missing: $resolver"
  }
  $python = Get-Command "python" -ErrorAction SilentlyContinue
  if (-not $python) {
    throw "Python is required to invoke the Fullmag storage resolver"
  }
  $resolverArguments = @(
    $resolver, $Action, "--repo-root", $RepoRoot,
    "--profile", $Profile, "--format", "json"
  ) + $ActionArguments
  $output = (& $python.Source @resolverArguments 2>&1 | Out-String)
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw "Fullmag storage action '$Action' failed with exit code ${exitCode}: $output"
  }
  try {
    return ($output | ConvertFrom-Json)
  }
  catch {
    throw "Fullmag storage action '$Action' returned invalid JSON: $output"
  }
}

function Prepare-FullmagStorageLinks {
  param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][string]$Profile,
    [switch]$Frontend,
    [switch]$Compat,
    [string]$NextDistDir
  )

  $arguments = @()
  if ($Frontend) {
    $arguments += "--frontend"
  }
  if ($Compat) {
    $arguments += "--compat"
  }
  if ($NextDistDir) {
    $arguments += @("--next-dist-dir", $NextDistDir)
  }
  return Invoke-FullmagStorageJson -RepoRoot $RepoRoot -Profile $Profile `
    -Action "prepare-links" -ActionArguments $arguments
}

function Invoke-FullmagStorageManagedScript {
  param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][string]$Profile,
    [Parameter(Mandatory = $true)][string]$ScriptPath,
    [Parameter()][string[]]$Arguments = @()
  )

  # The core runner owns the per-worktree OS lock for the entire launcher
  # lifetime.  The child receives a sentinel and the lock token/key; its
  # prepare-links call therefore verifies and re-enters the same lock rather
  # than allocating a second target or silently bypassing concurrency control.
  $resolver = Join-Path $RepoRoot "scripts\fullmag_storage.py"
  if (-not (Test-Path -LiteralPath $resolver -PathType Leaf)) {
    throw "Fullmag storage resolver is missing: $resolver"
  }
  $python = Get-Command "python" -ErrorAction SilentlyContinue
  if (-not $python) {
    throw "Python is required to invoke the managed Fullmag launcher"
  }
  $powerShell = Get-Command "powershell.exe" -ErrorAction SilentlyContinue
  if (-not $powerShell) {
    throw "Windows PowerShell is required to invoke the managed Fullmag launcher"
  }
  $command = @(
    $powerShell.Source, "-NoLogo", "-NoProfile", "-NonInteractive",
    "-ExecutionPolicy", "Bypass", "-File", $ScriptPath
  ) + $Arguments
  $previousSentinel = $env:FULLMAG_STORAGE_MANAGED_ENTRY
  $env:FULLMAG_STORAGE_MANAGED_ENTRY = "1"
  try {
    & $python.Source @(
      $resolver, "run", "--repo-root", $RepoRoot,
      "--profile", $Profile, "--"
    ) @command
    return $LASTEXITCODE
  }
  finally {
    if ($null -eq $previousSentinel) {
      Remove-Item Env:FULLMAG_STORAGE_MANAGED_ENTRY -ErrorAction SilentlyContinue
    }
    else {
      $env:FULLMAG_STORAGE_MANAGED_ENTRY = $previousSentinel
    }
  }
}

function Set-FullmagStorageEnvironment {
  param([Parameter(Mandatory = $true)]$Layout)

  foreach ($property in $Layout.env.psobject.Properties) {
    [Environment]::SetEnvironmentVariable(
      $property.Name,
      [string]$property.Value,
      "Process"
    )
  }
}

function Resolve-FullmagStoragePath {
  param([Parameter(Mandatory = $true)][string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) {
    throw "Fullmag storage path must not be empty"
  }
  if (-not [System.IO.Path]::IsPathRooted($Path)) {
    throw "Fullmag storage path must be absolute: $Path"
  }
  return [System.IO.Path]::GetFullPath($Path).TrimEnd("\")
}

# Compatibility name kept for older Windows launcher code. New callers should
# use Assert-FullmagStoragePath so the path is checked against the resolved
# project storage and build view rather than merely against the checkout.
function Require-ExternalBuildPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $candidate = Resolve-FullmagStoragePath $Path
  $repo = Resolve-FullmagStoragePath ([string]$StorageLayout.repo_root)
  if ($candidate.Equals($repo, [System.StringComparison]::OrdinalIgnoreCase) -or
      $candidate.StartsWith($repo + "\", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must be outside the repository: $candidate"
  }
  return $candidate
}

function Assert-FullmagStoragePath {
  param(
    [Parameter(Mandatory = $true)]$Layout,
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label,
    [string]$Parent = ""
  )

  $candidate = Resolve-FullmagStoragePath $Path
  $storage = (Resolve-FullmagStoragePath ([string]$Layout.storage_root))
  $base = if ($Parent) {
    Resolve-FullmagStoragePath $Parent
  } else {
    $storage
  }
  if ($candidate -eq [System.IO.Path]::GetPathRoot($candidate).TrimEnd("\")) {
    throw "$Label must not use a drive root directly: $candidate"
  }
  if (-not ($candidate.Equals($base, [System.StringComparison]::OrdinalIgnoreCase) -or
      $candidate.StartsWith($base + "\", [System.StringComparison]::OrdinalIgnoreCase))) {
    throw "$Label must be contained by ${base}: $candidate"
  }
  if (-not ($candidate.Equals($storage, [System.StringComparison]::OrdinalIgnoreCase) -or
      $candidate.StartsWith($storage + "\", [System.StringComparison]::OrdinalIgnoreCase))) {
    throw "$Label must be contained by Fullmag storage: $candidate"
  }

  # Resolve every existing component to catch a junction/symlink that would
  # redirect an approved path before a later Ensure-Directory call.
  $probe = $candidate
  while ($true) {
    if (Test-Path -LiteralPath $probe) {
      $item = Get-Item -LiteralPath $probe -Force
      if ($item.PSObject.Properties.Name -contains "LinkType" -and $item.LinkType) {
        throw "$Label must not traverse a junction or symlink: $candidate"
      }
      $resolved = (Resolve-Path -LiteralPath $probe).Path.TrimEnd("\")
      if (-not $resolved.Equals($probe, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label must not traverse a junction or symlink: $candidate -> $resolved"
      }
      break
    }
    $parent = Split-Path -Parent $probe
    if (-not $parent -or $parent -eq $probe) {
      break
    }
    $probe = $parent.TrimEnd("\")
  }
  return $candidate
}
