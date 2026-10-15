# Fullmag source-first installer workflow, embedded into the Win32 helper.
#
# The native launcher supplies this script with a deliberately small process
# environment.  This script is intentionally parameterless: accepting values
# from PowerShell's ambient command line would make the Burn ExePackage an
# unsafe second command interpreter.  The eight FULLMAG_BOOTSTRAP_* values are
# admitted by the native launcher and are removed before any project command
# is started.

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$WorkflowVersion = "1.0.0"
$script:FailureCode = "workflow_failure"
$script:ReceiptContext = $null
$script:ReceiptDirectoryReady = $false
$script:ReceiptWritten = $false

$ControlledNames = @(
  "FULLMAG_BOOTSTRAP_CHECKOUT",
  "FULLMAG_BOOTSTRAP_STORAGE_ROOT",
  "FULLMAG_BOOTSTRAP_PROFILE",
  "FULLMAG_BOOTSTRAP_MODE",
  "FULLMAG_BOOTSTRAP_RECEIPT",
  "FULLMAG_BOOTSTRAP_SOURCE_ADMISSION",
  "FULLMAG_BOOTSTRAP_SOURCE_ADMISSION_SHA256",
  "FULLMAG_BOOTSTRAP_WORKFLOW_VERSION"
)

function Stop-Workflow {
  param([Parameter(Mandatory = $true)][string]$Code)
  $script:FailureCode = ($Code -replace "[^a-zA-Z0-9_.-]", "_")
  throw "Fullmag installer environment bootstrap blocked"
}

function Get-ControlledValue {
  param([Parameter(Mandatory = $true)][string]$Name)
  $value = [Environment]::GetEnvironmentVariable($Name, "Process")
  if ([string]::IsNullOrWhiteSpace($value)) { Stop-Workflow "missing_$Name" }
  return [string]$value
}

function Assert-SanitizedEnvironment {
  $allowed = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($name in $ControlledNames) { [void]$allowed.Add($name) }
  foreach ($entry in [Environment]::GetEnvironmentVariables("Process").GetEnumerator()) {
    $name = [string]$entry.Key
    if ($name.StartsWith("FULLMAG_BOOTSTRAP_", [StringComparison]::OrdinalIgnoreCase) -and -not $allowed.Contains($name)) {
      Stop-Workflow "unknown_bootstrap_environment"
    }
    if ($name.StartsWith("FULLMAG_", [StringComparison]::OrdinalIgnoreCase) -and -not $allowed.Contains($name)) {
      Stop-Workflow "ambient_fullmag_environment"
    }
  }
}

function Assert-LocalAbsolutePath {
  param([Parameter(Mandatory = $true)][string]$Value, [Parameter(Mandatory = $true)][string]$Label)
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value.IndexOfAny([char[]]@([char]0, [char]10, [char]13)) -ge 0) {
    Stop-Workflow "invalid_$Label"
  }
  if ($Value -notmatch "^[A-Za-z]:[\\/]") { Stop-Workflow "non_local_$Label" }
  if ($Value -match "^[\\/]{2}") { Stop-Workflow "unc_$Label" }
  foreach ($part in ($Value -split "[\\/]")) {
    if ($part -eq "..") { Stop-Workflow "parent_segment_$Label" }
  }
  try { return [IO.Path]::GetFullPath($Value).TrimEnd('\', '/') }
  catch { Stop-Workflow "invalid_$Label" }
}

function Assert-NoReparseAncestors {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Label)
  $cursor = [IO.Path]::GetFullPath($Path)
  while ($true) {
    if (Test-Path -LiteralPath $cursor) {
      try { $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop }
      catch { Stop-Workflow "unreadable_$Label" }
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        Stop-Workflow "reparse_$Label"
      }
    }
    $parent = Split-Path -Parent $cursor
    if ([string]::IsNullOrWhiteSpace($parent) -or [string]::Equals($parent, $cursor, [StringComparison]::OrdinalIgnoreCase)) { break }
    $cursor = $parent
  }
}

function Assert-Directory {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Label)
  Assert-NoReparseAncestors $Path $Label
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { Stop-Workflow "missing_$Label" }
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-Workflow "reparse_$Label" }
}

function Assert-RegularFile {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Label)
  Assert-NoReparseAncestors $Path $Label
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { Stop-Workflow "missing_$Label" }
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-Workflow "reparse_$Label" }
}

function Assert-Inside {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Root, [Parameter(Mandatory = $true)][string]$Label)
  $candidate = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
  $base = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  if (-not [String]::Equals($candidate, $base, [StringComparison]::OrdinalIgnoreCase) -and
      -not $candidate.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)) {
    Stop-Workflow "outside_$Label"
  }
  return $candidate
}

function Get-Sha256Text {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text))).Replace("-", "").ToLowerInvariant()) }
  finally { $sha.Dispose() }
}

function Get-FileSha256Value {
  param([Parameter(Mandatory = $true)][string]$Path)
  Assert-RegularFile $Path "source_input"
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($Path))).Replace("-", "").ToLowerInvariant()) }
  finally { $sha.Dispose() }
}

function Assert-Sha256Value {
  param([Parameter(Mandatory = $true)][string]$Value, [Parameter(Mandatory = $true)][string]$Label)
  if ($Value -notmatch "^[0-9a-fA-F]{64}$") { Stop-Workflow "invalid_$Label" }
  return $Value.ToLowerInvariant()
}

function Invoke-Captured {
  param([Parameter(Mandatory = $true)][string]$Command, [Parameter()][string[]]$Arguments = @())
  $old = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $items = @(& $Command @Arguments 2>&1)
    $exit = $LASTEXITCODE
    $text = (($items | ForEach-Object { [string]$_ }) -join "`n").Trim()
    return [pscustomobject]@{ output = $text; exit_code = [int]$exit }
  }
  finally { $ErrorActionPreference = $old }
}

function Get-SafeToken {
  param([AllowNull()][object]$Value, [string]$Fallback = "unknown")
  $text = if ($null -eq $Value) { "" } else { [string]$Value }
  $text = ($text -replace "[^a-zA-Z0-9_.-]", "_").Trim("_")
  if ([string]::IsNullOrWhiteSpace($text)) { return $Fallback }
  return $text.Substring(0, [Math]::Min(96, $text.Length))
}

function Get-PowerShellCommand {
  $powerShell = Join-Path $PSHOME "powershell.exe"
  Assert-RegularFile $powerShell "powershell"
  return $powerShell
}

function Get-GitOutput {
  param([Parameter(Mandatory = $true)][string]$Git, [Parameter(Mandatory = $true)][string[]]$Arguments, [Parameter(Mandatory = $true)][string]$Code)
  $result = Invoke-Captured $Git $Arguments
  if ($result.exit_code -ne 0 -or [string]::IsNullOrWhiteSpace([string]$result.output)) { Stop-Workflow $Code }
  return [string]$result.output
}

function Get-MainCheckout {
  param([Parameter(Mandatory = $true)][string]$Checkout, [Parameter(Mandatory = $true)][string]$Git)
  $top = Get-GitOutput $Git @("-C", $Checkout, "rev-parse", "--show-toplevel") "checkout_not_git"
  $top = Assert-LocalAbsolutePath $top.Trim() "git_root"
  Assert-Directory $top "git_root"
  $worktrees = Get-GitOutput $Git @("-C", $top, "-c", "core.quotePath=false", "worktree", "list", "--porcelain") "worktree_list_failed"
  $first = ($worktrees -split "`r?`n" | Where-Object { $_ -match "^worktree\s+(.+)$" } | Select-Object -First 1)
  if ([string]::IsNullOrWhiteSpace($first)) { Stop-Workflow "main_checkout_missing" }
  $main = [regex]::Match($first, "^worktree\s+(.+)$").Groups[1].Value
  $main = Assert-LocalAbsolutePath $main "main_checkout"
  Assert-Directory $main "main_checkout"
  return [pscustomobject]@{ top = $top; main = $main; worktrees = $worktrees }
}

function Get-SourceIdentity {
  param([Parameter(Mandatory = $true)][string]$Checkout, [Parameter(Mandatory = $true)][string]$Main, [Parameter(Mandatory = $true)][string]$Git, [Parameter(Mandatory = $true)][string]$Profile)
  $head = Get-GitOutput $Git @("-C", $Checkout, "rev-parse", "HEAD") "git_head_failed"
  $mainHead = Get-GitOutput $Git @("-C", $Main, "rev-parse", "HEAD") "main_git_head_failed"
  $worktrees = Get-GitOutput $Git @("-C", $Checkout, "-c", "core.quotePath=false", "worktree", "list", "--porcelain") "worktree_list_failed"
  $mainWorktrees = Get-GitOutput $Git @("-C", $Main, "-c", "core.quotePath=false", "worktree", "list", "--porcelain") "main_worktree_list_failed"
  $statusResult = Invoke-Captured $Git @("-C", $Checkout, "status", "--porcelain=v1", "--untracked-files=all")
  if ($statusResult.exit_code -ne 0) { Stop-Workflow "git_status_failed" }
  $status = [string]$statusResult.output
  $rootFiles = @(
    ".env.example",
    "windows_build_requirements.json",
    "scripts/windows/setup_build_environment.ps1",
    "scripts/fullmag_storage.py"
  )
  $inputs = [System.Collections.Generic.List[object]]::new()
  foreach ($relative in $rootFiles) {
    $path = Join-Path $Checkout ($relative -replace "/", "\\")
    Assert-RegularFile $path "required_source"
    $inputs.Add([ordered]@{ path = $relative; sha256 = Get-FileSha256Value $path })
  }
  $statusHash = Get-Sha256Text $status
  $worktreeHash = Get-Sha256Text $worktrees
  $mainWorktreeHash = Get-Sha256Text $mainWorktrees
  $templatePath = Join-Path $Checkout ".env.example"
  $manifestPath = Join-Path $Checkout "windows_build_requirements.json"
  $setupPath = Join-Path $Checkout "scripts\windows\setup_build_environment.ps1"
  $resolverPath = Join-Path $Checkout "scripts\fullmag_storage.py"
  $environmentPath = Join-Path $Main ".env"
  Assert-RegularFile $environmentPath "committed_environment"
  $identity = [ordered]@{
    schema = "fullmag.source-identity.v1"
    requested_checkout = $Checkout
    checkout = $Checkout
    main_checkout = $Main
    template_path = $templatePath
    manifest_path = $manifestPath
    resolver_script = $resolverPath
    template_hash = Get-FileSha256Value $templatePath
    manifest_hash = Get-FileSha256Value $manifestPath
    resolver_hash = Get-FileSha256Value $resolverPath
    setup_hash = Get-FileSha256Value $setupPath
    environment_hash = Get-FileSha256Value $environmentPath
    git_top = $Main
    git_head = $mainHead.Trim()
    git_worktrees_hash = $mainWorktreeHash
    requested_git_top = $Checkout
    requested_git_head = $head.Trim()
    requested_git_worktrees_hash = $worktreeHash
    head = $head.Trim()
    worktree_listing_sha256 = $worktreeHash
    status_sha256 = $statusHash
    dirty = -not [string]::IsNullOrWhiteSpace($status)
    required_inputs = @($inputs.ToArray())
    profile = $Profile
  }
  $identity.source_identity_sha256 = Get-Sha256Text (($identity | ConvertTo-Json -Depth 12 -Compress))
  return $identity
}

function Assert-AdmissionIdentity {
  param(
    [Parameter(Mandatory = $true)][object]$Admission,
    [Parameter(Mandatory = $true)][object]$Identity,
    [Parameter(Mandatory = $true)][string]$FieldSetLabel
  )
  $fields = @(
    "requested_checkout", "main_checkout", "template_hash", "manifest_hash", "resolver_hash",
    "git_top", "git_head", "git_worktrees_hash", "requested_git_top", "requested_git_head",
    "requested_git_worktrees_hash", "setup_hash"
  )
  foreach ($field in $fields) {
    $expected = [string]$Identity.$field
    $actual = [string]$Admission.$field
    if ([string]::IsNullOrWhiteSpace($actual) -or
        -not [String]::Equals($actual, $expected, [StringComparison]::OrdinalIgnoreCase)) {
      Stop-Workflow ("admission_" + $FieldSetLabel + "_" + $field)
    }
  }
}

function Get-SourceAdmission {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Sha256,
    [Parameter(Mandatory = $true)][string]$Checkout,
    [Parameter(Mandatory = $true)][string]$Main,
    [Parameter(Mandatory = $true)][string]$StorageRoot,
    [Parameter(Mandatory = $true)][string]$StorageProfile,
    [Parameter(Mandatory = $true)][string]$Profile,
    [Parameter(Mandatory = $true)][string]$Mode,
    [Parameter(Mandatory = $true)][object]$Mapping,
    [Parameter(Mandatory = $true)][string]$SetupScript,
    [Parameter(Mandatory = $true)][object]$Identity
  )
  $admissionPath = Assert-LocalAbsolutePath $Path "source_admission"
  $expectedHash = Assert-Sha256Value $Sha256 "source_admission_sha256"
  Assert-Inside $admissionPath $StorageRoot "source_admission" | Out-Null
  Assert-RegularFile $admissionPath "source_admission"
  $actualHash = Get-FileSha256Value $admissionPath
  if (-not [String]::Equals($actualHash, $expectedHash, [StringComparison]::OrdinalIgnoreCase)) {
    Stop-Workflow "source_admission_hash_mismatch"
  }
  try { $admission = Get-Content -LiteralPath $admissionPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop }
  catch { Stop-Workflow "source_admission_invalid_json" }
  if ([string]$admission.schema -ne "fullmag.windows-installer-source-admission.v1" -or
      [string]$admission.version -ne "1.0.0") {
    Stop-Workflow "source_admission_schema"
  }
  $postReadHash = Get-FileSha256Value $admissionPath
  if (-not [String]::Equals($postReadHash, $expectedHash, [StringComparison]::OrdinalIgnoreCase)) {
    Stop-Workflow "source_admission_changed_during_read"
  }
  $sessionId = [string]$admission.session_id
  if ($sessionId -notmatch "^[A-Za-z0-9._-]{8,128}$") { Stop-Workflow "source_admission_session" }
  $identityPairs = @(
    [pscustomobject]@{ name = "requested_checkout"; expected = $Checkout }
    [pscustomobject]@{ name = "main_checkout"; expected = $Main }
    [pscustomobject]@{ name = "storage_root"; expected = $StorageRoot }
    [pscustomobject]@{ name = "storage_profile"; expected = $StorageProfile }
    [pscustomobject]@{ name = "runtime_profile"; expected = $Profile }
    [pscustomobject]@{ name = "lane"; expected = [string]$Mapping.lane }
    [pscustomobject]@{ name = "bootstrap_mode"; expected = $Mode }
    [pscustomobject]@{ name = "setup_script_path"; expected = $SetupScript }
    [pscustomobject]@{ name = "template_path"; expected = [string]$Identity.template_path }
    [pscustomobject]@{ name = "manifest_path"; expected = [string]$Identity.manifest_path }
    [pscustomobject]@{ name = "resolver_script"; expected = [string]$Identity.resolver_script }
  )
  foreach ($pair in $identityPairs) {
    if (-not [String]::Equals([string]$admission.($pair.name), [string]$pair.expected, [StringComparison]::OrdinalIgnoreCase)) {
      Stop-Workflow ("source_admission_" + $pair.name)
    }
  }
  Assert-Sha256Value ([string]$admission.environment_hash) "source_admission_environment_hash" | Out-Null
  foreach ($field in @("setup_hash", "template_hash", "manifest_hash", "resolver_hash", "git_worktrees_hash", "requested_git_worktrees_hash")) {
    Assert-Sha256Value ([string]$admission.$field) ("source_admission_" + $field) | Out-Null
  }
  $admissionRunsRoot = Assert-LocalAbsolutePath ([string]$admission.runs_root) "source_admission_runs_root"
  Assert-Inside $admissionRunsRoot $StorageRoot "source_admission_runs_root" | Out-Null
  Assert-Directory $admissionRunsRoot "source_admission_runs_root"
  Assert-Inside $admissionPath $admissionRunsRoot "source_admission" | Out-Null
  if (-not [String]::Equals([string]$admission.environment_hash, [string]$Identity.environment_hash, [StringComparison]::OrdinalIgnoreCase)) {
    Stop-Workflow "source_admission_environment_hash_mismatch"
  }
  Assert-AdmissionIdentity $admission $Identity "top_level"
  if ($null -eq $admission.source_identity) { Stop-Workflow "source_admission_identity_missing" }
  Assert-AdmissionIdentity $admission.source_identity $Identity "nested"
  if (-not [String]::Equals([string]$admission.source_identity.setup_hash, [string]$Identity.setup_hash, [StringComparison]::OrdinalIgnoreCase)) {
    Stop-Workflow "source_admission_nested_setup_hash"
  }
  return [pscustomobject]@{
    path = $admissionPath
    sha256 = $expectedHash
    session_id = $sessionId
    runs_root = $admissionRunsRoot
    environment_hash = [string]$admission.environment_hash
    value = $admission
  }
}

function Assert-AdmissionUnchanged {
  param([Parameter(Mandatory = $true)][object]$Admission)
  Assert-RegularFile ([string]$Admission.path) "source_admission"
  $current = Get-FileSha256Value ([string]$Admission.path)
  if (-not [String]::Equals($current, [string]$Admission.sha256, [StringComparison]::OrdinalIgnoreCase)) {
    Stop-Workflow "source_admission_changed"
  }
}

function Compare-SourceIdentity {
  param([Parameter(Mandatory = $true)][object]$Before, [Parameter(Mandatory = $true)][object]$After)
  $beforeJson = $Before | ConvertTo-Json -Depth 12 -Compress
  $afterJson = $After | ConvertTo-Json -Depth 12 -Compress
  return [string]::Equals($beforeJson, $afterJson, [StringComparison]::Ordinal)
}

function Resolve-StorageLayout {
  param(
    [Parameter(Mandatory = $true)][string]$Python,
    [Parameter(Mandatory = $true)][string]$Main,
    [Parameter(Mandatory = $true)][string]$StorageRoot,
    [Parameter(Mandatory = $true)][string]$Profile,
    [Parameter()][switch]$ReadOnly
  )
  $resolver = Join-Path $Main "scripts\fullmag_storage.py"
  Assert-RegularFile $resolver "storage_resolver"
  $old = [Environment]::GetEnvironmentVariable("FULLMAG_PROJECT_STORAGE_ROOT", "Process")
  [Environment]::SetEnvironmentVariable("FULLMAG_PROJECT_STORAGE_ROOT", $StorageRoot, "Process")
  try {
    $arguments = @($resolver, "resolve", "--repo-root", $Main, "--profile", $Profile, "--format", "json")
    if (-not $ReadOnly) { $arguments += "--create" }
    $result = Invoke-Captured $Python $arguments
  }
  finally {
    if ($null -eq $old) { [Environment]::SetEnvironmentVariable("FULLMAG_PROJECT_STORAGE_ROOT", $null, "Process") }
    else { [Environment]::SetEnvironmentVariable("FULLMAG_PROJECT_STORAGE_ROOT", $old, "Process") }
  }
  if ($result.exit_code -ne 0) { Stop-Workflow "storage_resolver_failed" }
  try { $layout = $result.output | ConvertFrom-Json -ErrorAction Stop }
  catch { Stop-Workflow "storage_resolver_invalid_json" }
  if ($null -eq $layout.storage_root -or $null -eq $layout.runs_root) { Stop-Workflow "storage_layout_incomplete" }
  if (-not [String]::Equals((Assert-LocalAbsolutePath ([string]$layout.storage_root) "resolved_storage"), $StorageRoot, [StringComparison]::OrdinalIgnoreCase)) { Stop-Workflow "storage_root_mismatch" }
  if ($null -ne $layout.profile -and -not [String]::Equals([string]$layout.profile, $Profile, [StringComparison]::OrdinalIgnoreCase)) { Stop-Workflow "storage_profile_mismatch" }
  foreach ($name in @("runs_root", "build_root", "cache_root", "temp_root", "runtime_root")) {
    if ($null -ne $layout.$name) {
      $child = Assert-LocalAbsolutePath ([string]$layout.$name) "layout_$name"
      Assert-Inside $child $StorageRoot "layout_$name" | Out-Null
      Assert-NoReparseAncestors $child "layout_$name"
    }
  }
  return $layout
}

function Get-ReceiptPath {
  param([Parameter(Mandatory = $true)][string]$Requested, [Parameter(Mandatory = $true)][string]$RunsRoot)
  $receipt = Assert-LocalAbsolutePath $Requested "receipt"
  Assert-Inside $receipt $RunsRoot "receipt" | Out-Null
  Assert-NoReparseAncestors $receipt "receipt"
  if (Test-Path -LiteralPath $receipt) { Stop-Workflow "receipt_exists" }
  $parent = Split-Path -Parent $receipt
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  Assert-Directory $parent "receipt_parent"
  $script:ReceiptDirectoryReady = $true
  return $receipt
}

function Write-AtomicReceipt {
  param([Parameter(Mandatory = $true)][ValidateSet("setup_complete", "completed", "blocked")][string]$State, [Parameter(Mandatory = $true)][string]$FailureCode)
  if (-not $script:ReceiptDirectoryReady -or $null -eq $script:ReceiptContext -or $script:ReceiptWritten) { return $false }
  $context = $script:ReceiptContext
  $receipt = [string]$context.receipt
  $isFullPackage = [string]$context.backend -eq "full"
  $payload = [ordered]@{
    schema = if ($isFullPackage) { "fullmag.windows-installer-environment-receipt.v2" } else { "fullmag.windows-installer-environment-receipt.v1" }
    version = if ($isFullPackage) { "2.0.0" } else { "1.0.0" }
    # A setup-only receipt records environment readiness.  It is deliberately
    # not an all-realizations runtime admission until the initial build has
    # produced and validated the four-capability manifest.
    scope = if ($isFullPackage -and [bool]$context.initial_build.requested) { "all" } else { $null }
    state = $State
    failure_code = Get-SafeToken $FailureCode "none"
    mode = [string]$context.mode
    profile = [string]$context.profile
    lane = [string]$context.lane
    backend = [string]$context.backend
    device = [string]$context.device
    checkout = [string]$context.checkout
    main_checkout = [string]$context.main_checkout
    storage_root = [string]$context.storage_root
    runs_root = [string]$context.runs_root
    storage_profile = [string]$context.storage_profile
    environment_hash = [string]$context.environment_hash
    requested_checkout = [string]$context.requested_checkout
    admission_path = [string]$context.admission_path
    admission_sha256 = [string]$context.admission_sha256
    source_admission_path = [string]$context.admission_path
    source_admission_sha256 = [string]$context.admission_sha256
    admission_session_id = [string]$context.session_id
    session = [ordered]@{
      session_id = [string]$context.session_id
      admitted_utc = [string]$context.admitted_utc
      source_identity = $context.source_identity
    }
    source_identity = $context.source_identity
    setup = $context.setup
    tools = $context.tools
    initial_build = $context.initial_build
    full_runtime = if ($isFullPackage -and [bool]$context.initial_build.requested) { $context.full_runtime } else { $null }
    workflow = [ordered]@{ version = $WorkflowVersion; embedded = $true }
    runtime_qualification = "NOT VERIFIED"
    sanitized_output = $true
  }
  $json = $payload | ConvertTo-Json -Depth 24
  $temporary = Join-Path (Split-Path -Parent $receipt) ("." + [IO.Path]::GetFileName($receipt) + "." + [Guid]::NewGuid().ToString("N") + ".tmp")
  try {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json + "`n")
    $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) }
    finally { $stream.Dispose() }
    Assert-NoReparseAncestors $receipt "receipt"
    if (Test-Path -LiteralPath $receipt) { Stop-Workflow "receipt_race" }
    [IO.File]::Move($temporary, $receipt)
    $script:ReceiptWritten = $true
    return $true
  }
  catch {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
    return $false
  }
}

function Get-SetupReport {
  param(
    [Parameter(Mandatory = $true)][string]$Output,
    [Parameter(Mandatory = $true)][string]$Checkout,
    [Parameter(Mandatory = $true)][string]$Main,
    [Parameter(Mandatory = $true)][string]$StorageRoot,
    [Parameter(Mandatory = $true)][string]$ExpectedReportProfile,
    [Parameter(Mandatory = $true)][string]$Lane
  )
  try { $report = $Output | ConvertFrom-Json -ErrorAction Stop }
  catch { Stop-Workflow "setup_report_invalid_json" }
  if ([string]$report.schema -ne "fullmag.windows-build-environment-report.v1" -or
      [string]$report.mode -ne "install" -or
      [string]$report.lane -ne $Lane -or
      [string]$report.readiness -notin @("compiler_ready_provider_pending", "ready") -or
      -not [bool]$report.installation.requested) {
    Stop-Workflow "setup_report_untrusted"
  }
  $reportedRepository = Assert-LocalAbsolutePath ([string]$report.repository) "setup_repository"
  $reportedMain = Assert-LocalAbsolutePath ([string]$report.main_checkout) "setup_main_checkout"
  $reportedStorage = Assert-LocalAbsolutePath ([string]$report.storage_root) "setup_storage_root"
  if (-not [String]::Equals($reportedRepository, $Checkout, [StringComparison]::OrdinalIgnoreCase) -or
      -not [String]::Equals($reportedMain, $Main, [StringComparison]::OrdinalIgnoreCase) -or
      -not [String]::Equals($reportedStorage, $StorageRoot, [StringComparison]::OrdinalIgnoreCase) -or
      -not [String]::Equals([string]$report.storage_profile, $ExpectedReportProfile, [StringComparison]::OrdinalIgnoreCase)) {
    Stop-Workflow "setup_report_identity_mismatch"
  }
  return $report
}

function Get-PrerequisiteReport {
  param(
    [Parameter(Mandatory = $true)][string]$Output,
    [Parameter(Mandatory = $true)][string]$Checkout,
    [Parameter(Mandatory = $true)][string]$StorageRoot,
    [Parameter(Mandatory = $true)][string]$Lane
  )
  try { $report = $Output | ConvertFrom-Json -ErrorAction Stop }
  catch { Stop-Workflow "prerequisite_report_invalid_json" }
  if ([string]$report.schema -ne "fullmag.windows-build-prerequisites.v1" -or
      [string]$report.readiness -ne "prerequisites_ready" -or
      [bool]$report.project_owned_writes -or
      [bool]$report.full_dependency_install -or
      [string]$report.storage_resolver -ne "not_run") {
    Stop-Workflow "prerequisite_report_untrusted"
  }
  $reportedCheckout = Assert-LocalAbsolutePath ([string]$report.repository) "prerequisite_repository"
  if (-not [String]::Equals($reportedCheckout, $Checkout, [StringComparison]::OrdinalIgnoreCase) -or
      -not [String]::Equals([string]$report.storage_root, $StorageRoot, [StringComparison]::OrdinalIgnoreCase) -or
      -not [String]::Equals([string]$report.lane, $Lane, [StringComparison]::OrdinalIgnoreCase)) {
    Stop-Workflow "prerequisite_report_identity_mismatch"
  }
  if ($null -eq $report.tools -or $null -eq $report.tools.git -or $null -eq $report.tools.python) {
    Stop-Workflow "prerequisite_report_incomplete"
  }
  return $report
}

function Get-PrerequisiteExecutable {
  param([Parameter(Mandatory = $true)][object]$Report, [Parameter(Mandatory = $true)][string]$Name)
  $entry = $Report.tools.$Name
  if ($null -eq $entry -or [string]::IsNullOrWhiteSpace([string]$entry.path)) {
    Stop-Workflow "prerequisite_$Name_missing"
  }
  $path = Assert-LocalAbsolutePath ([string]$entry.path) ("prerequisite_" + $Name)
  Assert-RegularFile $path ("prerequisite_" + $Name)
  return $path
}

function Enter-AdmittedToolPath {
  param([Parameter(Mandatory = $true)][string[]]$Executables)
  $separator = [IO.Path]::PathSeparator
  $directories = [System.Collections.Generic.List[string]]::new()
  $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($executable in $Executables) {
    $path = Assert-LocalAbsolutePath $executable "prerequisite_executable"
    Assert-RegularFile $path "prerequisite_executable"
    $directory = Split-Path -Parent $path
    Assert-Directory $directory "prerequisite_directory"
    if ($seen.Add($directory)) { [void]$directories.Add($directory) }
  }
  if ($directories.Count -eq 0) { Stop-Workflow "prerequisite_path_empty" }
  $oldPath = [Environment]::GetEnvironmentVariable("PATH", "Process")
  $prefix = $directories -join $separator
  $newPath = if ([string]::IsNullOrEmpty($oldPath)) {
    $prefix
  } else {
    $prefix + $separator + $oldPath
  }
  [Environment]::SetEnvironmentVariable("PATH", $newPath, "Process")
  return [pscustomobject]@{ original = $oldPath; prefix = $prefix }
}

function Restore-AdmittedToolPath {
  param([Parameter(Mandatory = $true)][object]$State)
  if ($null -eq $State.original) {
    [Environment]::SetEnvironmentVariable("PATH", $null, "Process")
  } else {
    [Environment]::SetEnvironmentVariable("PATH", [string]$State.original, "Process")
  }
}

function Get-ManagedJust {
  param([Parameter(Mandatory = $true)][object]$Layout)
  $candidates = @()
  foreach ($base in @([string]$Layout.cache_root, [string]$Layout.build_root)) {
    if (-not [string]::IsNullOrWhiteSpace($base)) { $candidates += Join-Path $base "tools\bin\just.exe" }
  }
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      Assert-RegularFile $candidate "managed_just"
      return $candidate
    }
  }
  Stop-Workflow "managed_just_missing"
}

function Get-DirectorySha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  Assert-Directory $Path "static_web_root"
  $root = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
  $records = @(Get-ChildItem -LiteralPath $Path -File -Recurse -Force -ErrorAction Stop |
    Sort-Object FullName |
    ForEach-Object {
      Assert-RegularFile $_.FullName "static_web_file"
      $relative = $_.FullName.Substring($root.Length).Replace('\', '/')
      $hash = Get-FileSha256Value $_.FullName
      "$relative|$hash"
    })
  $bytes = [Text.Encoding]::UTF8.GetBytes(($records -join "`n") + "`n")
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($bytes)).Replace("-", "")).ToLowerInvariant() }
  finally { $sha.Dispose() }
}

function Get-WorkspaceManifestPath {
  param(
    [Parameter(Mandatory = $true)][object]$Layout,
    [Parameter(Mandatory = $true)][object]$Mapping
  )
  $directory = if ([string]$Mapping.backend -eq "full") {
    "windows-full-runtime"
  } elseif ([string]$Mapping.backend -eq "fem") {
    "windows-fem-runtime"
  } else {
    "windows-runtime"
  }
  $path = Join-Path ([string]$Layout.build_root) (Join-Path $directory "build-manifest.json")
  Assert-Inside $path ([string]$Layout.build_root) "workspace_manifest" | Out-Null
  return $path
}

function Assert-WorkspaceArtifact {
  param(
    [Parameter(Mandatory = $true)][object]$Manifest,
    [Parameter(Mandatory = $true)][string]$Field,
    [Parameter(Mandatory = $true)][string]$HashField,
    [Parameter(Mandatory = $true)][string]$BuildRoot
  )
  $path = Assert-LocalAbsolutePath ([string]$Manifest.$Field) ("workspace_" + $Field)
  Assert-Inside $path $BuildRoot ("workspace_" + $Field) | Out-Null
  Assert-RegularFile $path ("workspace_" + $Field)
  $expected = Assert-Sha256Value ([string]$Manifest.$HashField) ("workspace_" + $HashField)
  $actual = Get-FileSha256Value $path
  if (-not [String]::Equals($actual, $expected, [StringComparison]::OrdinalIgnoreCase)) {
    Stop-Workflow ("workspace_" + $Field + "_hash_mismatch")
  }
  return $path
}

function Assert-StaticWorkspaceManifest {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][object]$Layout,
    [Parameter(Mandatory = $true)][object]$Mapping,
    [Parameter()][string]$ExpectedSourceCommit = ""
  )
  Assert-RegularFile $Path "workspace_manifest"
  try { $manifest = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop }
  catch { Stop-Workflow "workspace_manifest_invalid_json" }
  $buildRoot = Assert-LocalAbsolutePath ([string]$Layout.build_root) "build_root"
  Assert-Inside $Path $buildRoot "workspace_manifest" | Out-Null
  if ([string]$Mapping.backend -eq "full") {
    if ([string]$manifest.schema -ne "fullmag.windows-full-capability-package.v1" -or
        [string]$manifest.state -ne "completed" -or
        [string]$manifest.profile -ne "windows-native-fem-gpu" -or
        [string]$manifest.source_snapshot_sha256 -notmatch "^[0-9a-fA-F]{64}$" -or
        [string]$manifest.attempt_id -notmatch "^[0-9a-fA-F]{32}$" -or
        $null -eq $manifest.source_identity -or
        [string]$manifest.source_identity.head_commit_full -notmatch "^[0-9a-fA-F]{40}$") {
      Stop-Workflow "full_workspace_manifest_untrusted"
    }
    if (-not [string]::IsNullOrWhiteSpace($ExpectedSourceCommit) -and
        -not [String]::Equals([string]$manifest.source_identity.head_commit_full,
                               $ExpectedSourceCommit, [StringComparison]::OrdinalIgnoreCase)) {
      Stop-Workflow "full_workspace_source_commit_mismatch"
    }
    $paths = [System.Collections.Generic.List[string]]::new()
    foreach ($field in @("origin_manifest_path", "binary", "api_binary", "native_fdm_dll", "native_fem_dll")) {
      if ($null -eq $manifest.PSObject.Properties[$field]) { Stop-Workflow "full_workspace_${field}_missing" }
      [void]$paths.Add((Assert-LocalAbsolutePath ([string]$manifest.$field) ("full_workspace_" + $field)))
    }
    $expectedComponents = @("fdm_cpu", "fdm_gpu", "fem_cpu", "fem_gpu")
    if ($null -eq $manifest.components) { Stop-Workflow "full_workspace_components_missing" }
    $componentNames = @($manifest.components.PSObject.Properties.Name | Sort-Object)
    if (($componentNames -join ",") -ne (($expectedComponents | Sort-Object) -join ",")) {
      Stop-Workflow "full_workspace_components_incomplete"
    }
    foreach ($component in $expectedComponents) {
      $record = $manifest.components.PSObject.Properties[$component].Value
      foreach ($field in @("component_manifest_path", "receipt_path")) {
        [void]$paths.Add((Assert-LocalAbsolutePath ([string]$record.$field) ("full_workspace_${component}_" + $field)))
      }
      foreach ($artifact in @($record.artifacts)) {
        [void]$paths.Add((Assert-LocalAbsolutePath ([string]$artifact.path) ("full_workspace_${component}_artifact")))
      }
    }
    foreach ($candidate in $paths) {
      Assert-Inside $candidate $buildRoot "full_workspace_artifact" | Out-Null
    }
    try {
      $full = Assert-FullmagFullRuntimeManifest `
        -ManifestPath $Path `
        -OriginManifestPath ([string]$manifest.origin_manifest_path) `
        -FullmagExe ([string]$manifest.binary) `
        -FullmagApiExe ([string]$manifest.api_binary) `
        -NativeFdmDll ([string]$manifest.native_fdm_dll) `
        -NativeFemDll ([string]$manifest.native_fem_dll) `
        -BuildRoot $buildRoot `
        -ExpectedBuildId (Get-FileSha256Value $Path) `
        -SourceCommit ([string]$manifest.source_identity.head_commit_full) `
        -SourceSnapshotSha256 ([string]$manifest.source_snapshot_sha256) `
        -AttemptId ([string]$manifest.attempt_id)
    }
    catch {
      Stop-Workflow "full_workspace_manifest_untrusted"
    }
    if ([string]$manifest.frontend_mode -ne "static" -or
        [string]$manifest.ui_host -ne "browser" -or
        [string]$manifest.workspace_mode -ne "empty" -or
        $manifest.browser_workspace -isnot [bool] -or
        -not [bool]$manifest.browser_workspace -or
        $null -ne $manifest.desktop_binary -or
        $null -ne $manifest.desktop_binary_sha256) {
      Stop-Workflow "full_workspace_browser_manifest_untrusted"
    }
    $frontendWorkspace = Assert-LocalAbsolutePath ([string]$manifest.frontend_workspace_root) "full_frontend_workspace_root"
    $frontendCache = Assert-LocalAbsolutePath ([string]$manifest.frontend_cache_root) "full_frontend_cache_root"
    Assert-Inside $frontendWorkspace $buildRoot "full_frontend_workspace_root" | Out-Null
    Assert-Inside $frontendCache $buildRoot "full_frontend_cache_root" | Out-Null
    Assert-Directory $frontendWorkspace "full_frontend_workspace_root"
    Assert-Directory $frontendCache "full_frontend_cache_root"
    $frontendEntry = Assert-LocalAbsolutePath ([string]$manifest.frontend_entry_path) "full_frontend_entry"
    Assert-Inside $frontendEntry $frontendCache "full_frontend_entry" | Out-Null
    Assert-RegularFile $frontendEntry "full_frontend_entry"
    $frontendEntryHash = Assert-Sha256Value ([string]$manifest.frontend_entry_sha256) "full_frontend_entry_sha256"
    if ((Get-FileSha256Value $frontendEntry) -ne $frontendEntryHash) {
      Stop-Workflow "full_frontend_entry_hash_mismatch"
    }
    $staticHash = Assert-Sha256Value ([string]$manifest.static_web_sha256) "full_static_web_sha256"
    if ((Get-DirectorySha256 (Split-Path -Parent $frontendEntry)) -ne $staticHash) {
      Stop-Workflow "full_static_web_hash_mismatch"
    }
    return [pscustomobject]@{
      path = (Assert-LocalAbsolutePath $Path "workspace_manifest")
      sha256 = Get-FileSha256Value $Path
      value = $full
      binary = [string]$manifest.binary
      api_binary = [string]$manifest.api_binary
      full_runtime = $full
    }
  }
  if ([int]$manifest.schema_version -ne 1 -or
      [string]$manifest.compiler_profile -ne "release" -or
      [string]$manifest.frontend_mode -ne "static" -or
      [string]$manifest.git_commit -notmatch "^[0-9a-fA-F]{40}$" -or
      [string]$manifest.source_snapshot_sha256 -notmatch "^[0-9a-fA-F]{64}$" -or
      $null -eq $manifest.build_source_snapshot -or
      [string]$manifest.build_source_snapshot.inventory_sha256 -notmatch "^[0-9a-fA-F]{64}$") {
    Stop-Workflow "workspace_manifest_untrusted"
  }
  $binary = Assert-WorkspaceArtifact $manifest "binary" "binary_sha256" $buildRoot
  $api = Assert-WorkspaceArtifact $manifest "api_binary" "api_binary_sha256" $buildRoot
  foreach ($field in @("build_version_file", "frontend_source_manifest")) {
    [void](Assert-WorkspaceArtifact $manifest $field ($field + "_sha256") $buildRoot)
  }
  $frontendRoot = Assert-LocalAbsolutePath ([string]$manifest.frontend_workspace_root) "frontend_workspace_root"
  $frontendCache = Assert-LocalAbsolutePath ([string]$manifest.frontend_cache_root) "frontend_cache_root"
  Assert-Inside $frontendRoot $buildRoot "frontend_workspace_root" | Out-Null
  Assert-Inside $frontendCache $buildRoot "frontend_cache_root" | Out-Null
  Assert-Directory $frontendRoot "frontend_workspace_root"
  Assert-Directory $frontendCache "frontend_cache_root"
  $staticRoot = Join-Path $frontendRoot "apps\control-room\out"
  $index = Join-Path $staticRoot "index.html"
  Assert-RegularFile $index "static_control_room"
  $staticHash = Assert-Sha256Value ([string]$manifest.static_web_sha256) "static_web_sha256"
  if (-not [String]::Equals((Get-DirectorySha256 $staticRoot), $staticHash, [StringComparison]::OrdinalIgnoreCase)) {
    Stop-Workflow "static_web_hash_mismatch"
  }
  if ([string]$Mapping.backend -eq "fem") {
    if ([string]$manifest.backend -ne "fem" -or $null -eq $manifest.native_fem -or
        [string]$manifest.native_fem.device -ne [string]$Mapping.device -or
        [string]$manifest.native_fem.requested_device -ne [string]$Mapping.device -or
        [string]$manifest.native_fem_attempt_id -notmatch "^[0-9a-fA-F]{32}$" -or
        $manifest.native_fem.strict_gpu -isnot [bool] -or
        [bool]$manifest.native_fem.strict_gpu -ne ([string]$Mapping.device -eq "gpu") -or
        [string]$manifest.state -ne "completed") {
      Stop-Workflow "workspace_fem_manifest_mismatch"
    }
  } elseif ([string]$manifest.backend -notin @("auto", "fdm")) {
    Stop-Workflow "workspace_fdm_manifest_mismatch"
  }
  return [pscustomobject]@{
    path = (Assert-LocalAbsolutePath $Path "workspace_manifest")
    sha256 = Get-FileSha256Value $Path
    value = $manifest
    binary = $binary
    api_binary = $api
  }
}

function Get-ExistingInitialReceipt {
  param(
    [Parameter(Mandatory = $true)][string]$Requested,
    [Parameter(Mandatory = $true)][object]$Layout,
    [Parameter(Mandatory = $true)][object]$Admission,
    [Parameter(Mandatory = $true)][object]$Identity,
    [Parameter(Mandatory = $true)][object]$Mapping,
    [Parameter(Mandatory = $true)][string]$Profile,
    [Parameter(Mandatory = $true)][string]$StorageRoot,
    [Parameter()][object]$RuntimeLayout = $null
  )
  $runsRoot = Assert-LocalAbsolutePath ([string]$Layout.runs_root) "runs_root"
  $receipt = Assert-LocalAbsolutePath $Requested "receipt"
  Assert-Inside $receipt $runsRoot "receipt" | Out-Null
  Assert-RegularFile $receipt "initial_receipt"
  try { $value = Get-Content -LiteralPath $receipt -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop }
  catch { Stop-Workflow "initial_receipt_invalid_json" }
  $isFullPackage = [string]$Mapping.backend -eq "full"
  $expectedSchema = if ($isFullPackage) { "fullmag.windows-installer-environment-receipt.v2" } else { "fullmag.windows-installer-environment-receipt.v1" }
  $expectedVersion = if ($isFullPackage) { "2.0.0" } else { "1.0.0" }
  if ([string]$value.schema -ne $expectedSchema -or
      [string]$value.version -ne $expectedVersion -or
      [string]$value.state -ne "completed" -or
      [string]$value.mode -ne "initial-build" -or
      [string]$value.profile -ne $Profile -or
      [string]$value.lane -ne [string]$Mapping.lane -or
      [string]$value.backend -ne [string]$Mapping.backend -or
      [string]$value.device -ne [string]$Mapping.device -or
      [string]$value.storage_root -ne $StorageRoot -or
      [string]$value.runs_root -ne $runsRoot -or
      [string]$value.storage_profile -ne [string]$Layout.profile -or
      [string]$value.environment_hash -ne [string]$Admission.environment_hash -or
      [string]$value.admission_path -ne [string]$Admission.path -or
      [string]$value.admission_sha256 -ne [string]$Admission.sha256 -or
      [string]$value.session.session_id -ne [string]$Admission.session_id -or
      [bool]$value.initial_build.requested -ne $true -or
      [string]$value.initial_build.state -ne "completed" -or
      [int]$value.initial_build.exit_code -ne 0 -or
      [string]$value.initial_build.expected_build_id -notmatch "^[0-9a-fA-F]{64}$" -or
      [string]$value.initial_build.expected_build_id -ne [string]$value.initial_build.manifest_sha256 -or
      [string]$value.runtime_qualification -ne "NOT VERIFIED" -or
      [bool]$value.sanitized_output -ne $true) {
    Stop-Workflow "initial_receipt_identity_mismatch"
  }
  if ($isFullPackage) {
    if ($null -eq $RuntimeLayout) { Stop-Workflow "full_receipt_runtime_layout_missing" }
    $fullBuildRoot = Assert-LocalAbsolutePath ([string]$RuntimeLayout.build_root) "full_build_root"
    if (-not [String]::Equals([string]$RuntimeLayout.profile, $Profile, [StringComparison]::OrdinalIgnoreCase)) {
      Stop-Workflow "full_receipt_runtime_profile_mismatch"
    }
    $support = @($value.full_runtime.installed_support | ForEach-Object { [string]$_ }) | Sort-Object
    if ([string]$value.scope -ne "all" -or
        [string]$value.full_runtime.scope -ne "all" -or
        [string]$value.full_runtime.capability_manifest_path -ne [string]$value.initial_build.manifest_path -or
        [string]$value.full_runtime.capability_manifest_sha256 -ne [string]$value.initial_build.expected_build_id -or
        [string]$value.full_runtime.aggregate_manifest_sha256 -ne [string]$value.initial_build.expected_build_id -or
        ($support -join ",") -ne ((@("fdm_cpu", "fdm_gpu", "fem_cpu", "fem_gpu") | Sort-Object) -join ",")) {
      Stop-Workflow "full_initial_receipt_capabilities"
    }
    foreach ($field in @("capability_manifest_path", "origin_manifest_path")) {
      $candidate = Assert-LocalAbsolutePath ([string]$value.full_runtime.$field) ("full_receipt_" + $field)
      Assert-Inside $candidate $fullBuildRoot ("full_receipt_" + $field) | Out-Null
      Assert-RegularFile $candidate ("full_receipt_" + $field)
    }
    if ((Get-FileSha256Value ([string]$value.full_runtime.capability_manifest_path)) -ne
        [string]$value.full_runtime.capability_manifest_sha256 -or
        (Get-FileSha256Value ([string]$value.full_runtime.origin_manifest_path)) -ne
        [string]$value.full_runtime.origin_manifest_sha256) {
      Stop-Workflow "full_receipt_manifest_hash"
    }
    $sourceReceipt = Assert-LocalAbsolutePath ([string]$value.full_runtime.source_environment_receipt.path) "full_receipt_source_environment"
    Assert-Inside $sourceReceipt $runsRoot "full_receipt_source_environment" | Out-Null
    Assert-RegularFile $sourceReceipt "full_receipt_source_environment"
    if ($sourceReceipt -ne [string]$Admission.path -or
        [string]$value.full_runtime.source_environment_receipt.sha256 -ne [string]$Admission.sha256 -or
        (Get-FileSha256Value $sourceReceipt) -ne [string]$value.full_runtime.source_environment_receipt.sha256) {
      Stop-Workflow "full_receipt_source_environment_hash"
    }
  }
  Assert-LocalAbsolutePath ([string]$value.initial_build.manifest_path) "initial_receipt_manifest" | Out-Null
  if ($isFullPackage) {
    Assert-Inside ([string]$value.initial_build.manifest_path) $fullBuildRoot "initial_receipt_manifest" | Out-Null
  }
  $expectedBuildId = Assert-Sha256Value ([string]$value.initial_build.expected_build_id) "initial_receipt_expected_build_id"
  if ($null -eq $value.source_identity -or
      [string]$value.source_identity.source_identity_sha256 -ne [string]$Identity.source_identity_sha256 -or
      -not (Compare-SourceIdentity $Identity $value.source_identity)) {
    Stop-Workflow "initial_receipt_source_mismatch"
  }
  foreach ($name in @("git", "python", "just")) {
    if ($null -eq $value.tools.$name) { Stop-Workflow ("initial_receipt_tool_" + $name) }
    $tool = Assert-LocalAbsolutePath ([string]$value.tools.$name) ("initial_receipt_tool_" + $name)
    Assert-RegularFile $tool ("initial_receipt_tool_" + $name)
  }
  Assert-AdmissionUnchanged $Admission
  $afterRead = Get-FileSha256Value $receipt
  return [pscustomobject]@{ path = $receipt; value = $value; sha256 = $afterRead; expected_build_id = $expectedBuildId }
}

function Invoke-Setup {
  param([Parameter(Mandatory = $true)][string]$PowerShell, [Parameter(Mandatory = $true)][string]$SetupScript, [Parameter(Mandatory = $true)][string]$Lane, [Parameter(Mandatory = $true)][string]$StorageRoot)
  Assert-RegularFile $SetupScript "setup_script"
  $result = Invoke-Captured $PowerShell @(
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", $SetupScript, "-Install", "-Lane", $Lane, "-StorageRoot", $StorageRoot, "-Json"
  )
  return $result
}

function Invoke-PrerequisiteSetup {
  param([Parameter(Mandatory = $true)][string]$PowerShell, [Parameter(Mandatory = $true)][string]$SetupScript, [Parameter(Mandatory = $true)][string]$Lane, [Parameter(Mandatory = $true)][string]$StorageRoot)
  Assert-RegularFile $SetupScript "setup_script"
  return Invoke-Captured $PowerShell @(
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", $SetupScript, "-Install", "-PrerequisitesOnly", "-Lane", $Lane, "-StorageRoot", $StorageRoot, "-Json"
  )
}

function Invoke-InitialBuild {
  param([Parameter(Mandatory = $true)][string]$Just, [Parameter(Mandatory = $true)][string]$Checkout, [Parameter(Mandatory = $true)][string]$StorageRoot, [Parameter(Mandatory = $true)][string]$Backend, [Parameter(Mandatory = $true)][string]$Device)
  $old = [Environment]::GetEnvironmentVariable("FULLMAG_PROJECT_STORAGE_ROOT", "Process")
  [Environment]::SetEnvironmentVariable("FULLMAG_PROJECT_STORAGE_ROOT", $StorageRoot, "Process")
  Push-Location $Checkout
  try {
    $webPort = if ($Backend -in @("fem", "full")) { "0" } else { "3198" }
    if ($Backend -eq "full") {
      # One physical strict FEM GPU build publishes the four capability
      # records.  Runtime selection stays in the application; this installer
      # operation must never turn the package into a lane-specific build.
      return Invoke-Captured $Just @("windows-full-workspace-build", "static", $webPort)
    }
    if ($Backend -eq "fem") {
      # This is a closed managed recipe owned by the native FEM storage lane.
      # It always emits a static browser workspace and keeps the requested FEM
      # device explicit; the recipe must reject an unavailable GPU.
      return Invoke-Captured $Just @("windows-fem-workspace-build", $Device, "static", $webPort)
    }
    return Invoke-Captured $Just @("windows-workspace-build", "release", "static", $webPort, "true")
  }
  finally {
    Pop-Location
    if ($null -eq $old) { [Environment]::SetEnvironmentVariable("FULLMAG_PROJECT_STORAGE_ROOT", $null, "Process") }
    else { [Environment]::SetEnvironmentVariable("FULLMAG_PROJECT_STORAGE_ROOT", $old, "Process") }
  }
}

function Invoke-WorkspaceLaunch {
  param(
    [Parameter(Mandatory = $true)][string]$Just,
    [Parameter(Mandatory = $true)][string]$Checkout,
    [Parameter(Mandatory = $true)][string]$StorageRoot,
    [Parameter(Mandatory = $true)][string]$Backend,
    [Parameter(Mandatory = $true)][string]$Device,
    [Parameter(Mandatory = $true)][string]$ExpectedBuildId
  )
  $ExpectedBuildId = Assert-Sha256Value $ExpectedBuildId "expected_build_id"
  $old = [Environment]::GetEnvironmentVariable("FULLMAG_PROJECT_STORAGE_ROOT", "Process")
  [Environment]::SetEnvironmentVariable("FULLMAG_PROJECT_STORAGE_ROOT", $StorageRoot, "Process")
  Push-Location $Checkout
  try {
    $webPort = if ($Backend -in @("fem", "full")) { "0" } else { "3198" }
    if ($Backend -eq "full") {
      return Invoke-Captured $Just @("windows-full-workspace", "static", $webPort, $ExpectedBuildId)
    }
    if ($Backend -eq "fem") {
      # The FEM runtime recipe owns its lease, terminal receipt and browser
      # launch.  No build flag is exposed here: launch-ui is read-only with
      # respect to the accepted package.
      return Invoke-Captured $Just @("windows-fem-workspace", $Device, "static", $webPort, $ExpectedBuildId)
    }
    return Invoke-Captured $Just @("windows-ui", "static", $webPort, "false", "release", $ExpectedBuildId)
  }
  finally {
    Pop-Location
    if ($null -eq $old) { [Environment]::SetEnvironmentVariable("FULLMAG_PROJECT_STORAGE_ROOT", $null, "Process") }
    else { [Environment]::SetEnvironmentVariable("FULLMAG_PROJECT_STORAGE_ROOT", $old, "Process") }
  }
}

try {
  Assert-SanitizedEnvironment
  $checkout = Assert-LocalAbsolutePath (Get-ControlledValue "FULLMAG_BOOTSTRAP_CHECKOUT") "checkout"
  $storageRoot = Assert-LocalAbsolutePath (Get-ControlledValue "FULLMAG_BOOTSTRAP_STORAGE_ROOT") "storage"
  $profile = Get-ControlledValue "FULLMAG_BOOTSTRAP_PROFILE"
  $mode = Get-ControlledValue "FULLMAG_BOOTSTRAP_MODE"
  $requestedReceipt = Assert-LocalAbsolutePath (Get-ControlledValue "FULLMAG_BOOTSTRAP_RECEIPT") "receipt"
  $sourceAdmissionPath = Assert-LocalAbsolutePath (Get-ControlledValue "FULLMAG_BOOTSTRAP_SOURCE_ADMISSION") "source_admission"
  $sourceAdmissionSha256 = Get-ControlledValue "FULLMAG_BOOTSTRAP_SOURCE_ADMISSION_SHA256"
  $declaredVersion = Get-ControlledValue "FULLMAG_BOOTSTRAP_WORKFLOW_VERSION"
  if ($declaredVersion -ne $WorkflowVersion) { Stop-Workflow "workflow_version_mismatch" }
  foreach ($name in $ControlledNames) {
    [Environment]::SetEnvironmentVariable($name, $null, "Process")
  }

  $profileMap = @{
    "windows-native-fdm-cpu" = [ordered]@{ lane = "native"; backend = "fdm"; device = "cpu"; manifest_key = "native" }
    "windows-native-fem-cpu" = [ordered]@{ lane = "fem-cpu"; backend = "fem"; device = "cpu"; manifest_key = "fem_cpu" }
    # The existing FEM GPU storage profile is the physical all-backends
    # package.  The public installer carries the private all scope explicitly;
    # historical single-lane receipts remain v1 and are never accepted here.
    "windows-native-fem-gpu" = [ordered]@{ lane = "all"; backend = "full"; device = "auto"; manifest_key = "fem_gpu" }
  }
  if (-not $profileMap.ContainsKey($profile)) { Stop-Workflow "unsupported_profile" }
  if ($mode -notin @("setup-only", "initial-build", "launch-ui")) { Stop-Workflow "unsupported_mode" }
  $mapping = $profileMap[$profile]
  if ([string]$mapping.backend -eq "full") {
    $fullPackageModule = Join-Path $checkout "scripts\windows\native_full_package.ps1"
    Assert-RegularFile $fullPackageModule "full_runtime_package"
    try {
      # This is deliberately dot-sourced at script scope.  Loading it from a
      # helper function would limit the validator definitions to that local
      # scope and leave launch-time admission without the component checks.
      . $fullPackageModule
    }
    catch {
      Stop-Workflow "full_runtime_package_invalid"
    }
    foreach ($name in @("Assert-FullmagFullRuntimeManifest", "Get-FullmagFullPackageSha256", "Assert-FullmagFullPackageFile")) {
      if ($null -eq (Get-Command $name -ErrorAction SilentlyContinue)) {
        Stop-Workflow "full_runtime_package_incomplete"
      }
    }
  }
  Assert-Directory $checkout "checkout"

  # The setup script has a deliberately narrow pre-resolver bootstrap for
  # Git/Python.  It validates the copied checkout and explicit storage root
  # before installing the remaining lane requirements.  This is required for
  # a fresh host because source identity and the shared resolver cannot run
  # until these two interpreters exist.
  $setupScript = Join-Path $checkout "scripts\windows\setup_build_environment.ps1"
  Assert-RegularFile $setupScript "setup_script"
  $powerShell = Get-PowerShellCommand
  $manifest = Join-Path $checkout "windows_build_requirements.json"
  Assert-RegularFile $manifest "build_requirements"
  try { $requirements = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop }
  catch { Stop-Workflow "build_requirements_invalid_json" }
  $storageProfile = [string]$requirements.storage.setup_profile
  if ($storageProfile -ne "windows-setup") { Stop-Workflow "storage_profile_not_windows_setup" }
  $declaredProfile = [string]$requirements.storage.build_profiles.($mapping.manifest_key)
  if ($declaredProfile -ne $profile) { Stop-Workflow "build_profile_mismatch" }
  # The resolver/admission profile remains windows-setup. FEM setup reports
  # the lane-specific build profile after selecting its provider layout;
  # native FDM keeps the setup profile in both places.
  $expectedSetupReportProfile = if ([string]$mapping.backend -in @("fem", "full")) {
    $declaredProfile
  } else {
    $storageProfile
  }
  if ([string]::IsNullOrWhiteSpace($expectedSetupReportProfile)) { Stop-Workflow "setup_report_profile_missing" }

  $prerequisites = $null
  $preexistingReceipt = $null
  if ($mode -eq "launch-ui") {
    # A launch must never install or discover tools through a fresh bootstrap.
    # It reuses the exact tool paths recorded by the completed initial build.
    $preReceiptPath = Assert-LocalAbsolutePath $requestedReceipt "receipt"
    Assert-Inside $preReceiptPath $storageRoot "receipt" | Out-Null
    Assert-RegularFile $preReceiptPath "initial_receipt"
    try { $preexistingReceipt = Get-Content -LiteralPath $preReceiptPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop }
    catch { Stop-Workflow "initial_receipt_invalid_json" }
    $expectedPreReceiptSchema = if ([string]$mapping.backend -eq "full") {
      "fullmag.windows-installer-environment-receipt.v2"
    } else {
      "fullmag.windows-installer-environment-receipt.v1"
    }
    if ([string]$preexistingReceipt.schema -ne $expectedPreReceiptSchema -or
        [string]$preexistingReceipt.mode -ne "initial-build" -or
        [string]$preexistingReceipt.state -ne "completed" -or
        ([string]$mapping.backend -eq "full" -and [string]$preexistingReceipt.scope -ne "all")) {
      Stop-Workflow "initial_receipt_not_completed"
    }
    foreach ($name in @("git", "python", "just")) {
      if ($null -eq $preexistingReceipt.tools.$name) { Stop-Workflow ("initial_receipt_tool_" + $name) }
    }
    $git = Assert-LocalAbsolutePath ([string]$preexistingReceipt.tools.git) "receipt_git"
    $python = Assert-LocalAbsolutePath ([string]$preexistingReceipt.tools.python) "receipt_python"
    Assert-RegularFile $git "receipt_git"
    Assert-RegularFile $python "receipt_python"
  }
  else {
    $prerequisiteResult = Invoke-PrerequisiteSetup $powerShell $setupScript ([string]$mapping.lane) $storageRoot
    if ($prerequisiteResult.exit_code -ne 0) { Stop-Workflow "prerequisite_setup_failed" }
    $prerequisites = Get-PrerequisiteReport ([string]$prerequisiteResult.output) $checkout $storageRoot ([string]$mapping.lane)
    $git = Get-PrerequisiteExecutable $prerequisites "git"
    $python = Get-PrerequisiteExecutable $prerequisites "python"
  }
  $checkoutInfo = Get-MainCheckout $checkout $git
  $main = [string]$checkoutInfo.main
  $identity = Get-SourceIdentity $checkout $main $git $profile
  $admissionMode = if ($mode -eq "launch-ui") { "initial-build" } else { $mode }
  $admission = Get-SourceAdmission $sourceAdmissionPath $sourceAdmissionSha256 $checkout $main $storageRoot $storageProfile $profile $admissionMode $mapping $setupScript $identity
  $layout = if ($mode -eq "launch-ui") {
    Resolve-StorageLayout $python $main $storageRoot $storageProfile -ReadOnly
  } else {
    Resolve-StorageLayout $python $main $storageRoot $storageProfile
  }
  $runsRoot = Assert-LocalAbsolutePath ([string]$layout.runs_root) "runs_root"
  Assert-Directory $runsRoot "runs_root"
  if (-not [String]::Equals($runsRoot, [string]$admission.runs_root, [StringComparison]::OrdinalIgnoreCase)) {
    Stop-Workflow "storage_runs_root_mismatch"
  }
  if ($mode -eq "launch-ui") {
    $runtimeLayout = Resolve-StorageLayout $python $main $storageRoot $expectedSetupReportProfile -ReadOnly
    $initialReceipt = Get-ExistingInitialReceipt $requestedReceipt $layout $admission $identity $mapping $profile $storageRoot $runtimeLayout
    $just = Assert-LocalAbsolutePath ([string]$initialReceipt.value.tools.just) "receipt_just"
    Assert-RegularFile $just "receipt_just"
    $manifestPath = Get-WorkspaceManifestPath $runtimeLayout $mapping
    $workspaceManifest = Assert-StaticWorkspaceManifest $manifestPath $runtimeLayout $mapping ([string]$identity.head)
    if (-not [String]::Equals([string]$initialReceipt.value.initial_build.manifest_path, [string]$workspaceManifest.path, [StringComparison]::OrdinalIgnoreCase) -or
        -not [String]::Equals([string]$initialReceipt.value.initial_build.manifest_sha256, [string]$workspaceManifest.sha256, [StringComparison]::OrdinalIgnoreCase) -or
        -not [String]::Equals([string]$initialReceipt.expected_build_id, [string]$workspaceManifest.sha256, [StringComparison]::OrdinalIgnoreCase)) {
      Stop-Workflow "initial_receipt_manifest_mismatch"
    }
    if ([string]$mapping.backend -eq "full") {
      $receiptRuntime = $initialReceipt.value.full_runtime
      $manifestRuntime = $workspaceManifest.value
      if ([string]$receiptRuntime.source_snapshot_sha256 -ne [string]$manifestRuntime.source_snapshot_sha256 -or
          [string]$receiptRuntime.attempt_id -ne [string]$manifestRuntime.attempt_id -or
          [string]$receiptRuntime.origin_manifest_path -ne [string]$manifestRuntime.origin_manifest_path -or
          [string]$receiptRuntime.origin_manifest_sha256 -ne [string]$manifestRuntime.origin_manifest_sha256) {
        Stop-Workflow "initial_receipt_full_runtime_mismatch"
      }
    }
    $admittedToolPath = Enter-AdmittedToolPath @($git, $python, $just)
    try {
      Assert-AdmissionUnchanged $admission
      $beforeIdentity = Get-SourceIdentity $checkout $main $git $profile
      if (-not (Compare-SourceIdentity $identity $beforeIdentity)) { Stop-Workflow "source_changed_before_launch" }
      $expectedBuildId = [string]$initialReceipt.expected_build_id
      $launchResult = Invoke-WorkspaceLaunch $just $checkout $storageRoot ([string]$mapping.backend) ([string]$mapping.device) $expectedBuildId
      if ($launchResult.exit_code -ne 0) { Stop-Workflow "workspace_launch_failed" }
      Assert-AdmissionUnchanged $admission
      $afterLaunchIdentity = Get-SourceIdentity $checkout $main $git $profile
      if (-not (Compare-SourceIdentity $identity $afterLaunchIdentity)) { Stop-Workflow "source_changed_after_launch" }
      $afterReceiptHash = Get-FileSha256Value ([string]$initialReceipt.path)
      if (-not [String]::Equals($afterReceiptHash, [string]$initialReceipt.sha256, [StringComparison]::OrdinalIgnoreCase)) {
        Stop-Workflow "initial_receipt_changed_during_launch"
      }
    }
    finally {
      Restore-AdmittedToolPath $admittedToolPath
    }
    exit 0
  }
  $receipt = Get-ReceiptPath $requestedReceipt $runsRoot
  $script:ReceiptContext = [ordered]@{
    receipt = $receipt; mode = $mode; profile = $profile; lane = [string]$mapping.lane
    backend = [string]$mapping.backend; device = [string]$mapping.device
    checkout = $checkout; main_checkout = $main; storage_root = $storageRoot
    runs_root = $runsRoot; environment_hash = [string]$admission.environment_hash
    requested_checkout = $checkout; admission_path = [string]$admission.path
    admission_sha256 = [string]$admission.sha256
    storage_profile = if ($null -eq $layout.profile) { "windows-setup" } else { [string]$layout.profile }
    session_id = [string]$admission.session_id; admitted_utc = [DateTime]::UtcNow.ToString("o")
    source_identity = $identity
    setup = [ordered]@{ state = "not_started"; exit_code = $null; readiness = "not_started"; provider_pending = $false }
    tools = [ordered]@{ git = $git; python = $python; just = $null }
    full_runtime = if ([string]$mapping.backend -eq "full") { [ordered]@{} } else { $null }
    initial_build = [ordered]@{ requested = ($mode -eq "initial-build"); state = if ($mode -eq "initial-build") { "not_started" } else { "not_requested" }; exit_code = $null; expected_build_id = $null; command = if ([string]$mapping.backend -eq "full") { @("just", "windows-full-workspace-build", "static", "0") } elseif ([string]$mapping.backend -eq "fem") { @("just", "windows-fem-workspace-build", [string]$mapping.device, "static", "0") } else { @("just", "windows-workspace-build", "release", "static", "3198", "true") } }
  }

  $admittedToolPath = Enter-AdmittedToolPath @($git, $python)
  try {
    $setupResult = Invoke-Setup $powerShell $setupScript ([string]$mapping.lane) $storageRoot
    $script:ReceiptContext.setup.exit_code = [int]$setupResult.exit_code
    if ($setupResult.exit_code -eq 0) {
      $report = Get-SetupReport $setupResult.output $checkout $main $storageRoot $expectedSetupReportProfile ([string]$mapping.lane)
      $readiness = Get-SafeToken $report.readiness "unknown"
      $script:ReceiptContext.setup.readiness = $readiness
      $script:ReceiptContext.setup.provider_pending = ($readiness -eq "compiler_ready_provider_pending")
      $script:ReceiptContext.setup.state = "completed"
    }
    else {
      $script:ReceiptContext.setup.state = "blocked"
      Stop-Workflow "setup_failed"
    }

    Assert-AdmissionUnchanged $admission
    $afterSetup = Get-SourceIdentity $checkout $main $git $profile
    if (-not (Compare-SourceIdentity $identity $afterSetup)) { Stop-Workflow "source_changed_after_setup" }

    if ($mode -eq "initial-build") {
      # Setup uses the lane-specific FEM profile, while the admission and
      # receipt remain bound to the shared windows-setup resolver profile.
      $runtimeLayout = Resolve-StorageLayout $python $checkout $storageRoot $expectedSetupReportProfile
      $just = Get-ManagedJust $runtimeLayout
      $script:ReceiptContext.tools.just = $just
      $buildResult = Invoke-InitialBuild $just $checkout $storageRoot ([string]$mapping.backend) ([string]$mapping.device)
      $script:ReceiptContext.initial_build.exit_code = [int]$buildResult.exit_code
      if ($buildResult.exit_code -ne 0) {
        $script:ReceiptContext.initial_build.state = "blocked"
        Stop-Workflow "initial_build_failed"
      }
      Assert-AdmissionUnchanged $admission
      $afterBuild = Get-SourceIdentity $checkout $main $git $profile
      if (-not (Compare-SourceIdentity $identity $afterBuild)) { Stop-Workflow "source_changed_after_build" }
      $manifestPath = Get-WorkspaceManifestPath $runtimeLayout $mapping
      $workspaceManifest = Assert-StaticWorkspaceManifest $manifestPath $runtimeLayout $mapping ([string]$identity.head)
      $script:ReceiptContext.initial_build.manifest_path = [string]$workspaceManifest.path
      $script:ReceiptContext.initial_build.manifest_sha256 = [string]$workspaceManifest.sha256
      $script:ReceiptContext.initial_build.expected_build_id = [string]$workspaceManifest.sha256
      $script:ReceiptContext.initial_build.frontend = "static"
      $script:ReceiptContext.initial_build.backend = [string]$mapping.backend
      $script:ReceiptContext.initial_build.device = [string]$mapping.device
      if ([string]$mapping.backend -eq "full") {
        $fullManifest = $workspaceManifest.full_runtime
        $script:ReceiptContext.full_runtime = [ordered]@{
          scope = "all"
          capability_manifest_path = [string]$workspaceManifest.path
          capability_manifest_sha256 = [string]$workspaceManifest.sha256
          aggregate_manifest_sha256 = [string]$workspaceManifest.sha256
          origin_manifest_path = [string]$fullManifest.origin_manifest_path
          origin_manifest_sha256 = [string]$fullManifest.origin_manifest_sha256
          source_snapshot_sha256 = [string]$fullManifest.source_snapshot_sha256
          attempt_id = [string]$fullManifest.attempt_id
          installed_support = @("fdm_cpu", "fdm_gpu", "fem_cpu", "fem_gpu")
          source_environment_receipt = [ordered]@{
            path = [string]$admission.path
            sha256 = [string]$admission.sha256
          }
        }
      }
      $script:ReceiptContext.initial_build.state = "completed"
    }
  }
  finally {
    Restore-AdmittedToolPath $admittedToolPath
  }

  Assert-AdmissionUnchanged $admission
  $finalState = if ($mode -eq "initial-build") { "completed" } else { "setup_complete" }
  if (-not (Write-AtomicReceipt -State $finalState -FailureCode "none")) { Stop-Workflow "receipt_write_failed" }
  exit 0
}
catch {
  $written = Write-AtomicReceipt -State "blocked" -FailureCode $script:FailureCode
  [Console]::Error.WriteLine("Fullmag installer environment bootstrap blocked")
  exit 2
}
