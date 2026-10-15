[CmdletBinding()]
param(
  [switch]$InstallMissing,
  [string]$StorageRoot,
  [switch]$ManagedBuild,
  [Parameter()]
  [ValidateSet('setup-only', 'initial-build')]
  [string]$BootstrapMode = 'initial-build'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$profile = 'windows-installer-source'

function Assert-ProducerPath {
  param([string]$Path, [string]$Root)
  $full = [IO.Path]::GetFullPath($Path)
  $base = [IO.Path]::GetFullPath($Root).TrimEnd('\','/')
  if (-not ($full.Equals($base,[StringComparison]::OrdinalIgnoreCase) -or
      $full.StartsWith($base+'\',[StringComparison]::OrdinalIgnoreCase))) {
    throw 'Installer producer path is outside its canonical build root'
  }
  $probe = $full
  while ($probe) {
    if (Test-Path -LiteralPath $probe) {
      $item = Get-Item -LiteralPath $probe -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Installer producer path traverses a reparse point'
      }
    }
    $parent = Split-Path -Parent $probe
    if ($parent -eq $probe) { break }
    $probe = $parent
  }
  return $full
}

function Get-InstallerProductVersion {
  param([string]$SourceRoot)
  $cargo = [IO.File]::ReadAllText((Join-Path $SourceRoot 'Cargo.toml'))
  $section = [regex]::Match($cargo, '(?ms)^\[workspace\.package\]\s*\r?\n(?<body>.*?)(?=^\[|\z)')
  if (-not $section.Success) { throw 'Frozen source has no workspace package metadata' }
  $versions = [regex]::Matches($section.Groups['body'].Value, '(?m)^version\s*=\s*"(?<version>[^"\r\n]+)"\s*$')
  if ($versions.Count -ne 1 -or $versions[0].Groups['version'].Value -notmatch '^\d+\.\d+\.\d+$') {
    throw 'Installer requires one numeric x.y.z version in frozen workspace metadata'
  }
  return $versions[0].Groups['version'].Value
}

function Invoke-InstallerTool {
  param([string]$Command, [string[]]$Arguments)
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Installer producer command failed ($LASTEXITCODE): $Command" }
}

function Get-VerifiedPythonPath {
  param([Parameter(Mandatory = $true)][object]$Report)
  $check = @($Report.checks | Where-Object { $_.id -eq 'python' }) | Select-Object -First 1
  $path = [string]$check.path
  if ([string]::IsNullOrWhiteSpace($path) -or -not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw 'Installer producer bootstrap did not return a usable Python interpreter path'
  }
  $resolved = (Resolve-Path -LiteralPath $path -ErrorAction Stop).Path
  if (-not [string]::Equals([IO.Path]::GetFileName($resolved), 'python.exe', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Installer producer bootstrap returned a launcher instead of the resolved python.exe interpreter'
  }
  return $resolved
}

function Get-ProducerExecutionLayout {
  param(
    [Parameter(Mandatory = $true)][string]$BuildRoot,
    [Parameter(Mandatory = $true)][string]$RunId,
    [int]$MaxPathLength = 260
  )
  if ($RunId -notmatch '^[0-9a-fA-F]{32}$') { throw 'Installer producer run identity is not a full GUID hex value' }
  $shortRunId = $RunId.Substring(0, 12).ToLowerInvariant()
  $productionRoot = [IO.Path]::GetFullPath((Join-Path $BuildRoot ('i\' + $shortRunId)))
  $baBuild = Join-Path $productionRoot 'b'
  $hostBuild = Join-Path $productionRoot 'h'
  # This bounds the deepest MSBuild FileTracker path observed during the
  # Visual Studio CMake compiler probe, including a deliberately conservative
  # TryCompile directory name. Refuse the build if the bound reaches MAX_PATH.
  $cmakeProbeSuffix = 'CMakeFiles\CMakeScratch\TryCompile-000000\cmTC_00000.dir\Debug\cmTC_00000.tlog\link-cvtres.write.1.tlog'
  $worstPath = @(
    (Join-Path $baBuild $cmakeProbeSuffix),
    (Join-Path $hostBuild $cmakeProbeSuffix)
  ) | ForEach-Object { [IO.Path]::GetFullPath($_) } | Sort-Object Length -Descending | Select-Object -First 1
  $worstLength = [int]$worstPath.Length
  if ($worstLength -ge $MaxPathLength) {
    throw "Installer producer CMake path budget exceeded: $worstLength >= $MaxPathLength ($worstPath)"
  }
  return [pscustomobject]@{
    run_id = $RunId
    short_run_id = $shortRunId
    execution_directory = 'i\' + $shortRunId
    production_root = $productionRoot
    ba_build = $baBuild
    host_build = $hostBuild
    max_path_length = $MaxPathLength
    worst_path_length = $worstLength
    worst_path = $worstPath
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

function Copy-CompilerInputMirror {
  param(
    [Parameter(Mandatory = $true)][string]$FrozenSourceRoot,
    [Parameter(Mandatory = $true)][string]$ProductionRoot,
    [Parameter(Mandatory = $true)][string]$BuildRoot,
    [Parameter(Mandatory = $true)][string]$SnapshotId,
    [Parameter(Mandatory = $true)][string]$SnapshotSha256
  )
  if ($SnapshotId -notmatch '^[0-9a-fA-F]{64}$' -or $SnapshotSha256 -notmatch '^[0-9a-fA-F]{64}$') {
    throw 'Compiler input mirror requires the complete frozen source identity'
  }
  $requirementsPath = Assert-ProducerPath (Join-Path $FrozenSourceRoot 'windows_installer_build_requirements.json') $BuildRoot
  if (-not (Test-Path -LiteralPath $requirementsPath -PathType Leaf)) {
    throw 'Compiler input mirror requirements manifest is missing from the frozen source'
  }
  try {
    $requirements = Get-Content -LiteralPath $requirementsPath -Raw -Encoding UTF8 |
      ConvertFrom-Json -ErrorAction Stop
  }
  catch {
    throw 'Compiler input mirror requirements manifest is not valid JSON'
  }
  $guiProjectRelative = ([string]$requirements.gui.project_path).Replace('/', '\')
  if ([string]::IsNullOrWhiteSpace($guiProjectRelative) -or
      [IO.Path]::IsPathRooted($guiProjectRelative) -or
      $guiProjectRelative -match '(^|[\\])\.\.([\\]|$)' -or
      $guiProjectRelative -notmatch '\.csproj$') {
    throw 'Compiler input mirror GUI project path is not a safe relative .csproj path'
  }
  $guiProjectFile = Assert-ProducerPath (Join-Path $FrozenSourceRoot $guiProjectRelative) $BuildRoot
  $guiProjectSource = Split-Path -Parent $guiProjectRelative
  $guiProjectName = [IO.Path]::GetFileName($guiProjectRelative)
  $guiLockedFileRelative = ([string]$requirements.nuget.lock_relative_path).Replace('/', '\')
  if ([string]::IsNullOrWhiteSpace($guiLockedFileRelative) -or
      [IO.Path]::IsPathRooted($guiLockedFileRelative) -or
      $guiLockedFileRelative -cne 'packages.lock.json') {
    throw 'Compiler input mirror NuGet lock path is not the admitted versioned UI packages.lock.json file'
  }
  $guiLockedFile = Assert-ProducerPath (Join-Path (Split-Path -Parent $guiProjectFile) $guiLockedFileRelative) $BuildRoot
  if (-not (Test-Path -LiteralPath $guiLockedFile -PathType Leaf)) {
    throw "Compiler input mirror NuGet lock file is missing: $guiLockedFile"
  }
  if (-not (Test-Path -LiteralPath $guiProjectFile -PathType Leaf)) {
    throw "Compiler input mirror GUI project is missing: $guiProjectFile"
  }
  $plans = @(
    [ordered]@{
      source = 'scripts\windows\installer\FullmagBootstrapperApplication'
      destination = 's\b'
      files = @('CMakeLists.txt', 'FullmagBootstrapperApplication.cpp', 'FullmagBootstrapperApplication.h',
        'FullmagBootstrapperApplication.def', 'FullmagBootstrapperApplication.manifest', 'FullmagBootstrapperApplication.rc',
        'FullmagInstallerUiBroker.cpp', 'FullmagInstallerUiBroker.h')
    },
    [ordered]@{
      role = 'ui'
      source = $guiProjectSource
      destination = 's\ui'
      recursive = $true
      project_name = $guiProjectName
      locked_file = $guiLockedFileRelative
      files = @()
    },
    [ordered]@{
      source = 'scripts\windows\installer\FullmagEnvironmentBootstrap'
      destination = 's\h'
      files = @('CMakeLists.txt', 'FullmagEnvironmentBootstrap.cpp', 'FullmagEnvironmentBootstrap.manifest',
        'FullmagEnvironmentBootstrap.rc', 'resource.h')
    },
    [ordered]@{
      source = 'scripts\windows'
      destination = ''
      files = @('run_installer_environment.ps1')
    }
  )
  $generatedOutputRoots = @('s/ui/obj', 'b', 'h')
  $entries = [System.Collections.Generic.List[object]]::new()
  $uiSource = $null
  $uiProject = $null
  foreach ($plan in $plans) {
    $sourceBase = Assert-ProducerPath (Join-Path $FrozenSourceRoot ([string]$plan.source)) $BuildRoot
    $destinationBase = if ([string]::IsNullOrEmpty([string]$plan.destination)) {
      Assert-ProducerPath $ProductionRoot $BuildRoot
    } else {
      Assert-ProducerPath (Join-Path $ProductionRoot ([string]$plan.destination)) $BuildRoot
    }
    $destinationIsProductionRoot = [string]::IsNullOrEmpty([string]$plan.destination)
    if (-not $destinationIsProductionRoot -and (Test-Path -LiteralPath $destinationBase)) {
      throw "Compiler input mirror destination already exists: $destinationBase"
    }
    if (-not (Test-Path -LiteralPath $destinationBase -PathType Container)) {
      [IO.Directory]::CreateDirectory($destinationBase) | Out-Null
    }
    $files = @()
    if ([bool]$plan.recursive) {
      $sourcePrefix = ([IO.Path]::GetFullPath($sourceBase)).TrimEnd('\','/') + '\'
      foreach ($sourceItem in @(Get-ChildItem -LiteralPath $sourceBase -Force -Recurse)) {
        if (($sourceItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
          throw "Frozen compiler input contains a reparse point: $($sourceItem.FullName)"
        }
        if (-not $sourceItem.PSIsContainer) {
          $relative = $sourceItem.FullName.Substring($sourcePrefix.Length).Replace('\','/')
          if ($relative -match '^(?:bin|obj)(?:/|$)') {
            if ($relative -ne $guiLockedFileRelative.Replace('\', '/')) {
              throw "Frozen compiler input GUI project contains generated output: $relative"
            }
          }
          $files += $relative
        }
      }
      $files = @($files | Sort-Object)
      if (-not ($files -contains $guiLockedFileRelative.Replace('\', '/'))) {
        $files += $guiLockedFileRelative.Replace('\', '/')
        $files = @($files | Sort-Object)
      }
    } else {
      $files = @($plan.files)
    }
    foreach ($relative in $files) {
      $sourceFile = Assert-ProducerPath (Join-Path $sourceBase $relative) $BuildRoot
      if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf)) {
        throw "Frozen compiler input is missing: $sourceFile"
      }
      $sourceItem = Get-Item -LiteralPath $sourceFile -Force
      if (($sourceItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Frozen compiler input is a reparse point: $sourceFile"
      }
      $destinationFile = Assert-ProducerPath (Join-Path $destinationBase $relative) $BuildRoot
      $destinationParent = Split-Path -Parent $destinationFile
      if (-not (Test-Path -LiteralPath $destinationParent -PathType Container)) {
        [IO.Directory]::CreateDirectory($destinationParent) | Out-Null
      }
      if (Test-Path -LiteralPath $destinationFile) {
        throw "Compiler input mirror file already exists: $destinationFile"
      }
      [IO.File]::Copy($sourceFile, $destinationFile, $false)
      $sourceHash = (Get-FileHash -LiteralPath $sourceFile -Algorithm SHA256).Hash.ToLowerInvariant()
      $destinationHash = (Get-FileHash -LiteralPath $destinationFile -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($sourceHash -ne $destinationHash) {
        throw "Compiler input mirror changed during copy: $relative"
      }
      $relativeToProduction = $destinationFile.Substring(([IO.Path]::GetFullPath($ProductionRoot)).TrimEnd('\','/').Length).TrimStart('\','/').Replace('\','/')
      [void]$entries.Add([pscustomobject]@{
        path = $relativeToProduction
        size = [int64]$sourceItem.Length
        sha256 = $sourceHash
      })
    }
    if ([string]$plan.role -eq 'ui') {
      $uiSource = $destinationBase
      $uiProject = Assert-ProducerPath (Join-Path $destinationBase ([string]$plan.project_name)) $BuildRoot
      if (-not (Test-Path -LiteralPath $uiProject -PathType Leaf)) {
        throw "Compiler input mirror GUI project was not copied: $uiProject"
      }
    }
  }
  if ([string]::IsNullOrWhiteSpace($uiSource) -or [string]::IsNullOrWhiteSpace($uiProject)) {
    throw 'Compiler input mirror did not produce a GUI project root'
  }
  $orderedEntries = @($entries | Sort-Object -Property path)
  $inventoryJson = $orderedEntries | ConvertTo-Json -Depth 10 -Compress
  $recordPath = Assert-ProducerPath (Join-Path $ProductionRoot 'source-mirror.json') $BuildRoot
  if (Test-Path -LiteralPath $recordPath) { throw "Compiler input mirror record already exists: $recordPath" }
  $record = [ordered]@{
    schema = 'fullmag.windows-installer-compiler-input-mirror.v1'
    snapshot_id = $SnapshotId
    source_snapshot_sha256 = $SnapshotSha256
    ui_project_path = $uiProject.Substring(([IO.Path]::GetFullPath($ProductionRoot)).TrimEnd('\','/').Length).TrimStart('\','/').Replace('\','/')
    generated_output_policy = [ordered]@{
      roots = $generatedOutputRoots
      purpose = 'dotnet restore and publish intermediate output only'
    }
    inventory_sha256 = Get-TextSha256 $inventoryJson
    inventory = $orderedEntries
  }
  [IO.File]::WriteAllText($recordPath,($record | ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false))
  $recordHash = (Get-FileHash -LiteralPath $recordPath -Algorithm SHA256).Hash.ToLowerInvariant()
  return [pscustomobject]@{
    ba_source = Assert-ProducerPath (Join-Path $ProductionRoot 's\b') $BuildRoot
    host_source = Assert-ProducerPath (Join-Path $ProductionRoot 's\h') $BuildRoot
    ui_source = $uiSource
    ui_project = $uiProject
    record_path = $recordPath
    record_sha256 = $recordHash
    inventory_sha256 = [string]$record.inventory_sha256
    snapshot_id = $SnapshotId
  }
}

function Assert-CompilerInputMirror {
  param(
    [Parameter(Mandatory = $true)][string]$RecordPath,
    [Parameter(Mandatory = $true)][string]$BuildRoot,
    [Parameter(Mandatory = $true)][string]$ProductionRoot,
    [Parameter(Mandatory = $true)][string]$ExpectedRecordSha256,
    [Parameter(Mandatory = $true)][string]$ExpectedSnapshotId,
    [Parameter(Mandatory = $true)][string]$ExpectedSnapshotSha256
  )
  $record = Assert-ProducerPath $RecordPath $BuildRoot
  if (-not (Test-Path -LiteralPath $record -PathType Leaf)) { throw 'Compiler input mirror record is missing' }
  if ($ExpectedRecordSha256 -notmatch '^[0-9a-fA-F]{64}$' -or
      $ExpectedSnapshotId -notmatch '^[0-9a-fA-F]{64}$' -or
      $ExpectedSnapshotSha256 -notmatch '^[0-9a-fA-F]{64}$') {
    throw 'Compiler input mirror verification requires complete immutable identities'
  }
  if ((Get-FileHash -LiteralPath $record -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedRecordSha256.ToLowerInvariant()) {
    throw 'Compiler input mirror record bytes changed during compilation'
  }
  $value = Get-Content -LiteralPath $record -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([string]$value.schema -ne 'fullmag.windows-installer-compiler-input-mirror.v1' -or $null -eq $value.inventory) {
    throw 'Compiler input mirror record schema is invalid'
  }
  if ([string]$value.snapshot_id -ne $ExpectedSnapshotId -or
      [string]$value.source_snapshot_sha256 -ne $ExpectedSnapshotSha256) {
    throw 'Compiler input mirror source identity changed during compilation'
  }
  $generatedRoots = @($value.generated_output_policy.roots | ForEach-Object {
      ([string]$_).Replace('\','/').TrimEnd('/')
    })
  if ($generatedRoots.Count -ne 3 -or
      @('b', 'h', 's/ui/obj' | Where-Object { $generatedRoots -notcontains $_ }).Count -ne 0 -or
      [string]$value.generated_output_policy.purpose -ne 'dotnet restore and publish intermediate output only') {
    throw 'Compiler input mirror generated-output policy is invalid'
  }
  $uiProjectRelative = [string]$value.ui_project_path
  if ($uiProjectRelative -notmatch '^s/ui/[^/]+\.csproj$') {
    throw 'Compiler input mirror GUI project path is invalid'
  }
  $entries = @($value.inventory | Sort-Object -Property path)
  $inventoryJson = $entries | ConvertTo-Json -Depth 10 -Compress
  if ((Get-TextSha256 $inventoryJson) -ne [string]$value.inventory_sha256) {
    throw 'Compiler input mirror inventory hash changed'
  }
  $expected = @{}
  foreach ($entry in $entries) {
    $path = [string]$entry.path
    if ($path -notmatch '^(s/b|s/h|s/ui|b|h)/|^run_installer_environment\.ps1$') {
      throw "Compiler input mirror contains an unsafe path: $path"
    }
    $expected[$path] = $entry
    $file = Assert-ProducerPath (Join-Path $ProductionRoot ($path -replace '/', '\')) $BuildRoot
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Compiler input mirror file is missing: $path" }
    $item = Get-Item -LiteralPath $file -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Compiler input mirror file is a reparse point: $path" }
    if ([int64]$item.Length -ne [int64]$entry.size -or
        (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne [string]$entry.sha256) {
      throw "Compiler input mirror bytes changed: $path"
    }
  }
  if (-not $expected.ContainsKey($uiProjectRelative)) {
    throw 'Compiler input mirror inventory does not contain the GUI project'
  }
  $productionRoot = Assert-ProducerPath $ProductionRoot $BuildRoot
  $uiProject = Assert-ProducerPath (Join-Path $productionRoot ($uiProjectRelative -replace '/', '\')) $BuildRoot
  if (-not (Test-Path -LiteralPath $uiProject -PathType Leaf)) {
    throw 'Compiler input mirror GUI project is missing from the mutable mirror'
  }
  $sourceRoot = Assert-ProducerPath (Join-Path $ProductionRoot 's') $BuildRoot
  foreach ($item in @(Get-ChildItem -LiteralPath $sourceRoot -Force -Recurse)) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Compiler input mirror contains a reparse point: $($item.FullName)" }
    if (-not $item.PSIsContainer) {
      $relative = $item.FullName.Substring(([IO.Path]::GetFullPath($ProductionRoot)).TrimEnd('\','/').Length).TrimStart('\','/').Replace('\','/')
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
    record_path = $record
    record_sha256 = (Get-FileHash -LiteralPath $record -Algorithm SHA256).Hash.ToLowerInvariant()
    inventory_sha256 = [string]$value.inventory_sha256
    snapshot_id = [string]$value.snapshot_id
    production_root = $productionRoot
    ui_project_path = $uiProjectRelative
    ui_project = $uiProject
    generated_output_roots = $generatedRoots
  }
}

function Get-ProducerEnvironment {
  param([switch]$Install)
  $arguments = @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
    '-File',(Join-Path $repo 'scripts\windows\setup_installer_build_environment.ps1'),'-Json')
  if ($Install) { $arguments += '-Install' }
  if ($StorageRoot) { $arguments += @('-StorageRoot',$StorageRoot) }
  # A second profile must resolve its own derived paths. The operator's storage
  # root and unknown environment values are preserved; changes are process-local.
  $names = @('FULLMAG_BUILD_ROOT','FULLMAG_WINDOWS_BUILD_ROOT','FULLMAG_WINDOWS_TARGET_DIR',
    'CARGO_TARGET_DIR','FULLMAG_CARGO_TARGET_DIR','FULLMAG_CARGO_TARGET_ROOT','CARGO_TARGET_ROOT',
    'FULLMAG_FDM_NATIVE_BUILD_ROOT','FULLMAG_NATIVE_STORAGE_PROFILE',
    'FULLMAG_TEMP_ROOT','FULLMAG_WINDOWS_TEMP_ROOT','FULLMAG_WINDOWS_STATE_ROOT',
    'FULLMAG_RUNTIME_ROOT','FULLMAG_STORAGE_PROFILE','FULLMAG_STORAGE_MANAGED_ENTRY',
    'FULLMAG_STORAGE_LOCK_TOKEN','FULLMAG_STORAGE_LOCK_KEY')
  $saved = @{}
  try {
    foreach ($name in $names) {
      $saved[$name] = [Environment]::GetEnvironmentVariable($name,'Process')
      [Environment]::SetEnvironmentVariable($name,$null,'Process')
    }
    $raw = (& (Join-Path $PSHOME 'powershell.exe') @arguments | Out-String)
    if ($LASTEXITCODE -ne 0) { throw 'Installer producer prerequisites are incomplete; run with -InstallMissing or resolve the bootstrap report' }
    $report = $raw | ConvertFrom-Json
    if ($report.readiness -ne 'producer_ready') { throw 'Installer producer bootstrap did not confirm readiness' }
    return $report
  }
  finally {
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name,$saved[$name],'Process') }
  }
}

if (-not $ManagedBuild) {
  # Direct PowerShell is the fresh-host entry: Python and Git are installed by
  # the minimal bootstrap before the resolver or optional just recipe is used.
  $report = Get-ProducerEnvironment -Install:$InstallMissing
  $python = Get-VerifiedPythonPath $report
  $git = [string](@($report.checks | Where-Object { $_.id -eq 'git' })[0].path)
  if (-not $python -or -not $git -or -not $report.storage_root) { throw 'Bootstrap report is missing admitted interpreter, Git or storage' }
  $oldPath = $env:Path
  $oldStorage = $env:FULLMAG_PROJECT_STORAGE_ROOT
  try {
    $env:Path = (Split-Path -Parent $python) + ';' + (Split-Path -Parent $git) + ';' + $oldPath
    $env:FULLMAG_PROJECT_STORAGE_ROOT = [string]$report.storage_root
    Invoke-InstallerTool $python @('-B',(Join-Path $repo 'scripts\fullmag_storage.py'),
      'run-windows-installer-source','--repo-root',$repo,'--profile',$profile,
      '--bootstrap-mode',$BootstrapMode)
  }
  finally { $env:Path = $oldPath; $env:FULLMAG_PROJECT_STORAGE_ROOT = $oldStorage }
  exit 0
}
if ($InstallMissing -or $StorageRoot) { throw 'Managed producer does not accept bootstrap mutations' }
if ($env:FULLMAG_INSTALLER_ATTEMPT_ID -notmatch '^[0-9a-f]{32}$') { throw 'Managed installer attempt identity is missing' }
if ($env:FULLMAG_STORAGE_MANAGED_ENTRY -ne '1' -or $env:FULLMAG_STORAGE_PROFILE -ne $profile) {
  throw 'Enter the installer producer through the closed storage operation'
}
$tools = Get-ProducerEnvironment
$python = Get-VerifiedPythonPath $tools
Invoke-InstallerTool $python @('-B',(Join-Path $repo 'scripts\fullmag_storage.py'),
  'assert-lock','--repo-root',$repo,'--profile',$profile)
$wix = [string]$tools.producer_tools.wix3.verified_wix_root
if (-not $wix) { throw 'Verified WiX 3 root is missing from bootstrap report' }
$cmake = [string](@($tools.checks | Where-Object { $_.id -eq 'cmake' })[0].path)
if (-not $cmake) { throw 'Verified CMake path is missing from bootstrap report' }
$visualStudio = [string](@($tools.checks | Where-Object { $_.id -eq 'msvc_x86' })[0].path)
if (-not $visualStudio -or -not (Test-Path -LiteralPath $visualStudio -PathType Container)) { throw 'Verified Visual Studio 2022 instance is missing' }
$buildRoot = [IO.Path]::GetFullPath($env:FULLMAG_BUILD_ROOT)
$raw = (& $python -B (Join-Path $repo 'scripts\windows\build_snapshot.py') create --repo-root $repo --build-root $buildRoot | Out-String)
if ($LASTEXITCODE -ne 0) { throw 'Installer source capture failed' }
$snapshot = $raw | ConvertFrom-Json
$record = Assert-ProducerPath ([string]$snapshot.record_path) $buildRoot
$source = Assert-ProducerPath ([string]$snapshot.source_root) $buildRoot
if (-not (Test-Path -LiteralPath $record -PathType Leaf) -or -not (Test-Path -LiteralPath $source -PathType Container)) {
  throw 'Installer snapshot record or frozen source directory is missing'
}
$admitted = (& $python -B (Join-Path $repo 'scripts\windows\build_snapshot.py') verify --record $record --build-root $buildRoot | Out-String)
if ($LASTEXITCODE -ne 0) { throw 'Installer frozen source admission failed before compilation' }
$snapshot = $admitted | ConvertFrom-Json
if (-not $source.Equals([string]$snapshot.source_root,[StringComparison]::OrdinalIgnoreCase)) {
  throw 'Installer snapshot verifier returned a different frozen source root'
}
Write-Host "Frozen installer source: $($snapshot.snapshot_id)"
$runId = [guid]::NewGuid().ToString('N')
$execution = Get-ProducerExecutionLayout -BuildRoot $buildRoot -RunId $runId
$productionRoot = Assert-ProducerPath ([string]$execution.production_root) $buildRoot
if (Test-Path -LiteralPath $productionRoot) {
  throw "Installer producer execution directory already exists; refusing overwrite: $productionRoot"
}
$null = New-Item -ItemType Directory -Path $productionRoot
$null = Assert-ProducerPath $productionRoot $buildRoot
$executionRecordPath = Assert-ProducerPath (Join-Path $productionRoot 'execution.json') $buildRoot
$executionRecord = [ordered]@{
  schema = 'fullmag.windows-installer-source-execution.v1'
  state = 'reserved'
  run_id = $runId
  short_run_id = $execution.short_run_id
  execution_directory = $execution.execution_directory
  path_budget_max = $execution.max_path_length
  worst_path_length = $execution.worst_path_length
  bootstrap_mode = [string]$BootstrapMode
}
[IO.File]::WriteAllText($executionRecordPath,($executionRecord | ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
$baBuild = Assert-ProducerPath ([string]$execution.ba_build) $buildRoot
$hostBuild = Assert-ProducerPath ([string]$execution.host_build) $buildRoot
$mirror = Copy-CompilerInputMirror -FrozenSourceRoot $source -ProductionRoot $productionRoot -BuildRoot $buildRoot `
  -SnapshotId ([string]$snapshot.snapshot_id) -SnapshotSha256 ([string]$snapshot.source_identity.source_snapshot_sha256)
$baSource = [string]$mirror.ba_source
$hostSource = [string]$mirror.host_source
foreach ($target in @(@{source=$baSource;build=$baBuild},@{source=$hostSource;build=$hostBuild})) {
  Invoke-InstallerTool $cmake @('-S',$target.source,'-B',$target.build,'-G','Visual Studio 17 2022','-A','Win32',
    ('-DWIX3_SDK_ROOT='+(Join-Path $wix 'sdk')),('-DCMAKE_GENERATOR_INSTANCE='+$visualStudio),'-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded')
  Invoke-InstallerTool $cmake @('--build',$target.build,'--config','Release','--parallel','2')
}
$mirror = Assert-CompilerInputMirror -RecordPath ([string]$mirror.record_path) -BuildRoot $buildRoot -ProductionRoot $productionRoot `
  -ExpectedRecordSha256 ([string]$mirror.record_sha256) -ExpectedSnapshotId ([string]$snapshot.snapshot_id) `
  -ExpectedSnapshotSha256 ([string]$snapshot.source_identity.source_snapshot_sha256)
$ba = Join-Path $baBuild 'Release\FullmagBootstrapperApplication.dll'
$hostExe = Join-Path $hostBuild 'Release\fullmag-installer-environment.exe'
$license = Join-Path $source 'LICENSE'
$setupBuildEnvironmentScript = Join-Path $source 'scripts\windows\setup_build_environment.ps1'
$runtimeBuildRequirementsManifest = Join-Path $source 'windows_build_requirements.json'
$installerBuildRequirementsManifest = Join-Path $source 'windows_installer_build_requirements.json'
$productVersion = Get-InstallerProductVersion $source
foreach ($file in @($ba,$hostExe,$license,$setupBuildEnvironmentScript,$runtimeBuildRequirementsManifest,$installerBuildRequirementsManifest)) {
  $null = Assert-ProducerPath $file $buildRoot
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Required producer artifact is missing: $file" }
}
$runsRoot = [IO.Path]::GetFullPath($env:FULLMAG_RUNS_ROOT)
$bundle = Assert-ProducerPath (Join-Path $runsRoot ('windows-installer-source-' + $runId + '\fullmag.exe')) $runsRoot
$wrapper = Join-Path $source 'scripts\windows\build_windows_installer_exe.ps1'
& $wrapper -RepoRoot $repo -FrozenSourceRecord $record -StorageProfile $profile -Route source-first -WixRoot $wix `
  -LicenseFile $license -LicenseFileSha256 (Get-FileHash $license -Algorithm SHA256).Hash `
  -SetupBuildEnvironmentScript $setupBuildEnvironmentScript -SetupBuildEnvironmentScriptSha256 (Get-FileHash $setupBuildEnvironmentScript -Algorithm SHA256).Hash `
  -BuildRequirementsManifest $runtimeBuildRequirementsManifest -BuildRequirementsManifestSha256 (Get-FileHash $runtimeBuildRequirementsManifest -Algorithm SHA256).Hash `
  -InstallerBuildRequirementsManifest $installerBuildRequirementsManifest -InstallerBuildRequirementsManifestSha256 (Get-FileHash $installerBuildRequirementsManifest -Algorithm SHA256).Hash `
  -SetupUiProjectPath ([string]$mirror.ui_project) `
  -CompilerInputMirrorRecord ([string]$mirror.record_path) -CompilerInputMirrorSha256 ([string]$mirror.record_sha256) `
  -BootstrapperApplicationDll $ba -BootstrapperApplicationSha256 (Get-FileHash $ba -Algorithm SHA256).Hash `
  -EnvironmentBootstrapExe $hostExe -EnvironmentBootstrapSha256 (Get-FileHash $hostExe -Algorithm SHA256).Hash `
  -EnvironmentBootstrapVersion '1.0.0' -BootstrapMode $BootstrapMode -ProductVersion $productVersion `
  -SourceCommit ([string]$snapshot.source_identity.head_commit_full) `
  -SourceSnapshotSha256 ([string]$snapshot.source_identity.source_snapshot_sha256) `
  -SourceSnapshotDirty ([bool]$snapshot.source_identity.source_snapshot_dirty) `
  -BundleUpgradeCode '8DC47A7E-C3DA-4D79-9F3F-802305A55623' -OutputPath $bundle
$null = Assert-ProducerPath $bundle $runsRoot
if (-not (Test-Path -LiteralPath $bundle -PathType Leaf)) { throw 'Burn producer did not publish fullmag.exe' }
$verified = (& $python -B (Join-Path $repo 'scripts\windows\build_snapshot.py') verify --record ([string]$snapshot.record_path) --build-root $buildRoot | Out-String)
if ($LASTEXITCODE -ne 0) { throw 'Installer frozen source verification failed' }
$manifest = [ordered]@{
  schema='fullmag.windows-installer-source-build.v1'; state='completed'; profile=$profile
  bootstrap_mode=[string]$BootstrapMode
  attempt_id=$env:FULLMAG_INSTALLER_ATTEMPT_ID
  run_id=$runId; execution_directory=$execution.execution_directory
  path_budget=[ordered]@{ max_length=$execution.max_path_length; worst_path_length=$execution.worst_path_length }
  source_snapshot=$snapshot; artifact=$bundle; artifact_sha256=(Get-FileHash $bundle -Algorithm SHA256).Hash.ToLowerInvariant()
  bootstrapper_application_sha256=(Get-FileHash $ba -Algorithm SHA256).Hash.ToLowerInvariant()
  environment_host_sha256=(Get-FileHash $hostExe -Algorithm SHA256).Hash.ToLowerInvariant()
  wix_root=$wix; compiler_input_mirror=[ordered]@{ record_filename='source-mirror.json'; record_sha256=[string]$mirror.record_sha256; inventory_sha256=[string]$mirror.inventory_sha256; snapshot_id=[string]$mirror.snapshot_id }; runtime_qualification='NOT VERIFIED'; created_at=[DateTime]::UtcNow.ToString('o')
}
$manifestPath = Join-Path $buildRoot 'installer-source\build-manifest.json'
$manifestPath = Assert-ProducerPath $manifestPath $buildRoot
$manifestDirectory = Assert-ProducerPath ([IO.Path]::GetDirectoryName($manifestPath)) $buildRoot
if (-not [IO.Directory]::Exists($manifestDirectory)) { [IO.Directory]::CreateDirectory($manifestDirectory) | Out-Null }
$tempManifest = Assert-ProducerPath ($manifestPath + '.' + $runId + '.tmp') $buildRoot
$backupManifest = Assert-ProducerPath ($manifestPath + '.' + $runId + '.bak') $buildRoot
if ([IO.Directory]::Exists($manifestPath)) { throw 'Installer manifest path is a directory' }
foreach ($candidate in @($tempManifest, $backupManifest)) {
  if ([IO.File]::Exists($candidate) -or [IO.Directory]::Exists($candidate)) { throw "Installer manifest staging path already exists: $candidate" }
}
[IO.File]::WriteAllText($tempManifest,($manifest | ConvertTo-Json -Depth 40),[Text.UTF8Encoding]::new($false))
if ([IO.File]::Exists($manifestPath)) { [IO.File]::Replace($tempManifest,$manifestPath,$backupManifest,$false) }
else { [IO.File]::Move($tempManifest,$manifestPath) }
Write-Host "Installer created: $bundle"
