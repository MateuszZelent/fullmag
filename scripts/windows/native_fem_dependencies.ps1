# Reproducible native Windows FEM providers. Loading this file has no side effects.
function Get-FullmagNativeFemDependencyPlan {
  param([Parameter(Mandatory=$true)][string]$BuildRoot, [switch]$Cuda,
        [Parameter(Mandatory=$true)][AllowEmptyString()][string]$CudaArchitectures)
  if (-not [IO.Path]::IsPathRooted($BuildRoot)) { throw "Native FEM dependency build root must be absolute" }
  if ($Cuda -and $CudaArchitectures -notmatch '^\d+(;(\d+))*$') {
    throw "Native FEM requires an explicit numeric CUDA architecture list"
  }
  [pscustomobject]@{
    root = Join-Path $BuildRoot "fem-dependencies"
    prefix = Join-Path $BuildRoot "fem-dependencies\installed"
    cuda = [bool]$Cuda
    cuda_architectures = $CudaArchitectures
    providers = @(
      [pscustomobject]@{ name="hypre"; url="https://github.com/hypre-space/hypre.git"; version="v3.1.0"; sha="9dc9e18aed6a945a95f966e57daacfb1c269f6ec"; license_files=@("COPYRIGHT", "LICENSE-APACHE", "LICENSE-MIT", "NOTICE") },
      [pscustomobject]@{ name="mfem"; url="https://github.com/mfem/mfem.git"; version="v4.9"; sha="d9d6526cc1749980a2ba1da16e2c1ca1e07d82ec"; license_files=@("LICENSE", "NOTICE") },
      [pscustomobject]@{ name="libceed"; url="https://github.com/CEED/libCEED.git"; version="v0.12.0"; sha="4018a20a98d451fac24765d3ddb936861647ce8d"; license_files=@("LICENSE", "NOTICE") }
    )
  }
}

function Assert-FullmagNativeFemProviderTree {
  param([object]$Layout, [string]$Path)
  $null = Assert-FullmagStoragePath -Layout $Layout -Path $Path -Label "native FEM provider path" -Parent ([string]$Layout.build_root)
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $pending = [Collections.Generic.Queue[string]]::new()
  $pending.Enqueue($Path)
  while ($pending.Count) {
    $current = $pending.Dequeue()
    $item = Get-Item -LiteralPath $current -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Native FEM provider path contains a reparse point: $current" }
    if ($item.PSIsContainer) {
      foreach ($child in Get-ChildItem -LiteralPath $current -Force) {
        if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Native FEM provider path contains a reparse point: $($child.FullName)" }
        if ($child.PSIsContainer) { $pending.Enqueue($child.FullName) }
      }
    }
  }
}

function Invoke-FullmagProviderCommand {
  param([string]$Command, [string[]]$Arguments, [string]$WorkingDirectory)
  # Windows PowerShell 5.1 removes embedded double quotes while flattening
  # native arguments. Preserve them as literal backslash-quote pairs so a
  # nested flag such as --pre-include="C:\source root\compat.h" remains one
  # argument after the native process parses its command line. PowerShell 7
  # uses the standard native argument passing and must not be double-escaped.
  $nativeArguments = @($Arguments)
  if ($PSVersionTable.PSEdition -eq "Desktop" -and $PSVersionTable.PSVersion.Major -eq 5) {
    $nativeArguments = @(
      foreach ($argument in $Arguments) {
        ([string]$argument).Replace('"', '\"')
      }
    )
  }
  $locationPushed = $false
  $exitCode = 0
  try {
    if ($WorkingDirectory) {
      Push-Location -LiteralPath $WorkingDirectory
      $locationPushed = $true
    }
    & $Command @nativeArguments | Out-Host
    $exitCode = $LASTEXITCODE
  }
  finally {
    if ($locationPushed) { Pop-Location }
  }
  if ($exitCode -ne 0) { throw "Native FEM provider command failed ($exitCode): $Command" }
}

function ConvertTo-FullmagCMakePath {
  param([Parameter(Mandatory=$true)][string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { throw "CMake path cannot be empty" }
  return ([IO.Path]::GetFullPath($Path)).Replace('\', '/')
}

function Get-FullmagPinnedDownload {
  param([string]$Url, [string]$Path, [string]$Sha256)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile ($Path + ".partial")
    if ((Get-FileHash -LiteralPath ($Path + ".partial") -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Sha256) {
      throw "Downloaded native FEM dependency does not match its pinned SHA256: $Url"
    }
    Move-Item -LiteralPath ($Path + ".partial") -Destination $Path
  }
  if ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Sha256) {
    throw "Native FEM dependency cache hash mismatch: $Path"
  }
  return $Path
}

function Get-FullmagNativeFemZstdRequirement {
  param([Parameter(Mandatory=$true)][string]$SourceRoot)
  $manifestPath = Join-Path $SourceRoot "windows_build_requirements.json"
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Windows build requirements manifest is missing: $manifestPath"
  }
  try {
    $requirements = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json -ErrorAction Stop
  }
  catch {
    throw "Windows build requirements manifest is invalid: $manifestPath ($($_.Exception.Message))"
  }
  $helper = $null
  if ($null -ne $requirements.provider_bootstrap -and
      $null -ne $requirements.provider_bootstrap.internal_helpers) {
    $helper = $requirements.provider_bootstrap.internal_helpers.zstd
  }
  if ($null -eq $helper -or [string]$helper.kind -ne "provider_bootstrap_internal_helper" -or
      [bool]$helper.host_requirement -or [string]$helper.managed_by -ne "scripts/windows/native_fem_dependencies.ps1") {
    throw "Windows build requirements do not define zstd as the managed internal FEM bootstrap helper"
  }
  foreach ($name in @("version", "archive", "url", "archive_sha256", "tool_directory", "executable_name", "decode_memory")) {
    if ([string]::IsNullOrWhiteSpace([string]$helper.$name)) {
      throw "Windows build requirements have incomplete zstd helper metadata: $name"
    }
  }
  if ([string]$helper.url -notmatch '^https://') {
    throw "Windows build requirements zstd helper URL must be HTTPS"
  }
  if ([string]$helper.archive_sha256 -notmatch '^[0-9a-f]{64}$') {
    throw "Windows build requirements zstd helper archive SHA256 is invalid"
  }
  if ([string]$helper.archive -notmatch '^[A-Za-z0-9._-]+\.zip$' -or
      [string]$helper.tool_directory -notmatch '^[A-Za-z0-9._-]+$' -or
      [string]$helper.executable_name -notmatch '^[A-Za-z0-9._-]+\.exe$' -or
      [string]$helper.decode_memory -notmatch '^\d+MB$') {
    throw "Windows build requirements zstd helper contains unsafe or invalid path/decoder metadata"
  }
  return $helper
}

function Get-FullmagPinnedProviderSource {
  param([object]$Provider, [string]$SourcesRoot)
  $source = Join-Path $SourcesRoot $Provider.name
  if (-not (Test-Path -LiteralPath $source)) {
    Invoke-FullmagProviderCommand "git.exe" @("-c", "core.autocrlf=false", "clone", "--no-checkout", "--filter=blob:none", "--single-branch", "--branch", $Provider.version, $Provider.url, $source)
    Invoke-FullmagProviderCommand "git.exe" @("-c", "core.autocrlf=false", "-C", $source, "checkout", "--detach", $Provider.sha)
  }
  $actual = (& git.exe -C $source rev-parse HEAD | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $actual -ne $Provider.sha) { throw "Native FEM provider source identity mismatch: $source" }
  $dirty = (& git.exe -C $source status --porcelain --untracked-files=all | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $dirty) { throw "Native FEM provider source has local modifications: $source" }
  return $source
}

function Get-FullmagNativeFemLiteralFileSha256 {
  param([Parameter(Mandatory=$true)][string]$Path)
  $bytes = [IO.File]::ReadAllBytes($Path)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
  }
  finally {
    $sha.Dispose()
  }
}

function Assert-FullmagNativeFemRegularDirectory {
  param(
    [Parameter(Mandatory=$true)][string]$Path,
    [Parameter(Mandatory=$true)][string]$Root,
    [Parameter(Mandatory=$true)][string]$Label
  )
  $resolved = [IO.Path]::GetFullPath($Path)
  $resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd([char[]]'\\/')
  if (-not ($resolved.Equals($resolvedRoot, [StringComparison]::OrdinalIgnoreCase) -or
      $resolved.StartsWith($resolvedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase))) {
    throw "$Label escapes its canonical root: $resolved"
  }
  if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
    throw "$Label is missing: $resolved"
  }
  $cursor = $resolved
  while ($true) {
    $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        ($item.PSObject.Properties.Name -contains "LinkType" -and $item.LinkType)) {
      throw "$Label contains a reparse point: $cursor"
    }
    if ($cursor.Equals($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) { break }
    $parent = Split-Path -Parent $cursor
    if (-not $parent -or $parent.Equals($cursor, [StringComparison]::OrdinalIgnoreCase)) {
      throw "$Label has no safe canonical ancestor: $resolved"
    }
    $cursor = $parent
  }
  return $resolved
}

function Assert-FullmagNativeFemRegularFile {
  param(
    [Parameter(Mandatory=$true)][string]$Path,
    [Parameter(Mandatory=$true)][string]$Root,
    [Parameter(Mandatory=$true)][string]$Label
  )
  $resolved = [IO.Path]::GetFullPath($Path)
  $resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd([char[]]'\\/')
  if (-not ($resolved.StartsWith($resolvedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase))) {
    throw "$Label escapes its canonical root: $resolved"
  }
  if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
    throw "$Label is missing: $resolved"
  }
  $cursor = $resolved
  while ($true) {
    $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        ($item.PSObject.Properties.Name -contains "LinkType" -and $item.LinkType)) {
      throw "$Label contains a reparse point: $cursor"
    }
    if ([string]$cursor -eq $resolved) {
      if ($item.PSIsContainer) { throw "$Label is a directory, not a regular file: $resolved" }
    }
    if ($cursor.Equals($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) { break }
    $parent = Split-Path -Parent $cursor
    if (-not $parent -or $parent.Equals($cursor, [StringComparison]::OrdinalIgnoreCase)) {
      throw "$Label has no safe canonical ancestor: $resolved"
    }
    $cursor = $parent
  }
  return $resolved
}

function Copy-FullmagNativeFemProviderLicenses {
  param(
    [Parameter(Mandatory=$true)][object]$Plan,
    [Parameter(Mandatory=$true)][hashtable]$SourceRoots,
    [Parameter(Mandatory=$true)][object]$Layout
  )
  $prefix = [IO.Path]::GetFullPath([string]$Plan.prefix)
  Assert-FullmagNativeFemRegularDirectory -Path $prefix -Root $prefix -Label "Native FEM installed provider prefix" | Out-Null
  Assert-FullmagNativeFemProviderTree -Layout $Layout -Path $prefix
  $sourceBase = [IO.Path]::GetFullPath((Join-Path $Plan.root "sources")).TrimEnd([char[]]'\\/')
  $shareRoot = Join-Path $prefix "share"
  $licenseBase = Join-Path $prefix "share\licenses"
  $records = [Collections.Generic.List[object]]::new()
  foreach ($provider in @($Plan.providers)) {
    $component = [string]$provider.name
    if ($component -notmatch '^[A-Za-z0-9._-]+$' -or
        [string]$provider.sha -notmatch '^[0-9a-f]{40}$') {
      throw "Native FEM license provenance contains an invalid provider pin: $component"
    }
    if (-not $SourceRoots.ContainsKey($component)) {
      throw "Native FEM license source is missing for pinned provider: $component"
    }
    $sourceRoot = [IO.Path]::GetFullPath([string]$SourceRoots[$component])
    if (-not ($sourceRoot.Equals($sourceBase, [StringComparison]::OrdinalIgnoreCase) -or
        $sourceRoot.StartsWith($sourceBase + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase))) {
      throw "Native FEM license source escapes the pinned provider source mirror: $sourceRoot"
    }
    Assert-FullmagNativeFemRegularDirectory -Path $sourceRoot -Root $sourceBase -Label "$component pinned source" | Out-Null
    $componentRoot = Join-Path $licenseBase $component
    foreach ($directory in @($shareRoot, $licenseBase, $componentRoot)) {
      if (Test-Path -LiteralPath $directory) {
        Assert-FullmagNativeFemRegularDirectory -Path $directory -Root $prefix -Label "$component license directory" | Out-Null
      }
      else {
        $parent = Split-Path -Parent $directory
        Assert-FullmagNativeFemRegularDirectory -Path $parent -Root $prefix -Label "$component license parent" | Out-Null
        New-Item -ItemType Directory -Force -Path $directory | Out-Null
        Assert-FullmagNativeFemRegularDirectory -Path $directory -Root $prefix -Label "$component license directory" | Out-Null
      }
    }
    $licenseFiles = @($provider.license_files)
    if (-not $licenseFiles.Count) { throw "Native FEM license provenance is empty for pinned provider: $component" }
    foreach ($relative in $licenseFiles) {
      $relative = [string]$relative
      if ($relative -notmatch '^[A-Za-z0-9._-]+$') {
        throw "Native FEM license filename is unsafe for pinned provider $component`: $relative"
      }
      $sourceFile = Join-Path $sourceRoot $relative
      $destination = Join-Path $componentRoot $relative
      Assert-FullmagNativeFemRegularFile -Path $sourceFile -Root $sourceRoot -Label "$component pinned license source" | Out-Null
      $sourceBytes = [IO.File]::ReadAllBytes($sourceFile)
      if ($sourceBytes.Length -eq 0) { throw "Native FEM pinned license source is empty: $sourceFile" }
      $sourceSha256 = Get-FullmagNativeFemLiteralFileSha256 -Path $sourceFile
      if (Test-Path -LiteralPath $destination) {
        Assert-FullmagNativeFemRegularFile -Path $destination -Root $prefix -Label "$component installed license" | Out-Null
        $existingSha256 = Get-FullmagNativeFemLiteralFileSha256 -Path $destination
        if ($existingSha256 -ne $sourceSha256) {
          throw "Native FEM installed license conflicts with the pinned source bytes: $destination"
        }
      }
      else {
        # Write the exact source bytes; do not let a text cmdlet normalize
        # legal notices or add/remove a BOM.
        [IO.File]::WriteAllBytes($destination, $sourceBytes)
      }
      Assert-FullmagNativeFemRegularFile -Path $destination -Root $prefix -Label "$component installed license" | Out-Null
      $installedSha256 = Get-FullmagNativeFemLiteralFileSha256 -Path $destination
      if ($installedSha256 -ne $sourceSha256) {
        throw "Native FEM installed license bytes differ from the pinned source: $destination"
      }
      $records.Add([pscustomobject]@{
        component = $component
        source_relative = $relative
        source_path = $sourceFile
        provider_version = [string]$provider.version
        provider_sha = [string]$provider.sha
        installed_relative = "share/licenses/$component/$relative"
        installed_path = $destination
        size_bytes = [int64]$sourceBytes.Length
        source_sha256 = $sourceSha256
        installed_sha256 = $installedSha256
        sha256 = $installedSha256
      }) | Out-Null
    }
  }
  Assert-FullmagNativeFemProviderTree -Layout $Layout -Path $prefix
  return @($records)
}

function Invoke-FullmagNativeFemDependencies {
  param([Parameter(Mandatory=$true)][string]$RepoRoot,
        [Parameter(Mandatory=$true)][object]$StorageLayout,
        [string]$SourceRoot,
        [switch]$Cuda,
        [Parameter(Mandatory=$true)][AllowEmptyString()][string]$CudaArchitectures)
  if ($env:FULLMAG_STORAGE_MANAGED_ENTRY -ne "1") { throw "Native FEM providers require a managed build lease" }
  # The adapter validates the live token and exact worktree before any write.
  $authoritativeLayout = Resolve-FullmagStorageLayout -RepoRoot $RepoRoot -Profile ([string]$StorageLayout.profile)
  if ([IO.Path]::GetFullPath([string]$StorageLayout.build_root) -ne [IO.Path]::GetFullPath([string]$authoritativeLayout.build_root)) { throw "Native FEM provider layout differs from the resolver" }
  $StorageLayout = $authoritativeLayout
  if (-not $SourceRoot) { $SourceRoot = $RepoRoot }
  $plan = Get-FullmagNativeFemDependencyPlan -BuildRoot ([string]$StorageLayout.build_root) -Cuda:$Cuda -CudaArchitectures $CudaArchitectures
  # The compiler source mirror is the frozen input for this provider build.
  # Read its manifest rather than allowing later edits in the live checkout to
  # change the helper pin halfway through a managed operation.
  $zstdRequirement = Get-FullmagNativeFemZstdRequirement -SourceRoot $SourceRoot
  $null = Assert-FullmagStoragePath -Layout $StorageLayout -Path $plan.root -Label "native FEM dependencies" -Parent ([string]$StorageLayout.build_root)
  Assert-FullmagNativeFemProviderTree -Layout $StorageLayout -Path $plan.root
  foreach ($relative in @("", "sources", "builds", "tools", "downloads", "installed")) {
    $destination = Join-Path $plan.root $relative
    Assert-FullmagNativeFemProviderTree -Layout $StorageLayout -Path $destination
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    Assert-FullmagNativeFemProviderTree -Layout $StorageLayout -Path $destination
  }
  $ninjaZip = Get-FullmagPinnedDownload -Url "https://github.com/ninja-build/ninja/releases/download/v1.13.2/ninja-win.zip" `
    -Path (Join-Path $plan.root "downloads\ninja-1.13.2.zip") -Sha256 "07fc8261b42b20e71d1720b39068c2e14ffcee6396b76fb7a795fb460b78dc65"
  $ninjaRoot = Join-Path $plan.root "tools\ninja-1.13.2"
  Assert-FullmagNativeFemProviderTree -Layout $StorageLayout -Path $ninjaRoot
  Expand-Archive -LiteralPath $ninjaZip -DestinationPath $ninjaRoot -Force
  Assert-FullmagNativeFemProviderTree -Layout $StorageLayout -Path $ninjaRoot
  $ninja = Join-Path $ninjaRoot "ninja.exe"
  $env:Path = "$ninjaRoot;$env:Path"

  # Administrative extraction into task storage, not a global SDK installation.
  $mpiSdk = Join-Path $plan.root "tools\msmpi-10.1.1"
  $mpiInclude = Join-Path $mpiSdk "PFiles\Microsoft SDKs\MPI\Include"
  Assert-FullmagNativeFemProviderTree -Layout $StorageLayout -Path $mpiSdk
  & {
    $msi = Get-FullmagPinnedDownload -Url "https://github.com/microsoft/Microsoft-MPI/releases/download/v10.1.1/msmpisdk.msi" `
      -Path (Join-Path $plan.root "downloads\msmpisdk-10.1.1.msi") -Sha256 "6df47378c0acbb2b76989092165d7279ee096605fcaf7e455de733b2ffdf4bcc"
    $process = Start-Process -FilePath "$env:SystemRoot\System32\msiexec.exe" `
      -ArgumentList @("/a", ('"'+$msi+'"'), "/qn", ('TARGETDIR="'+$mpiSdk+'"'), "/l*v", ('"'+(Join-Path $plan.root "msmpi-extract.log")+'"')) -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Microsoft MPI SDK extraction failed: $($process.ExitCode)" }
  }
  Assert-FullmagNativeFemProviderTree -Layout $StorageLayout -Path $mpiSdk
  $mpiHeaders = @(Get-ChildItem -LiteralPath $mpiSdk -Filter mpi.h -File -Recurse)
  $mpiLibraries = @(Get-ChildItem -LiteralPath $mpiSdk -Filter msmpi.lib -File -Recurse | Where-Object { $_.Directory.Name -eq "x64" })
  if ($mpiHeaders.Count -ne 1 -or $mpiLibraries.Count -ne 1) { throw "Microsoft MPI x64 SDK extraction is incomplete or ambiguous" }
  $mpiInclude = $mpiHeaders[0].Directory.FullName
  $mpiLibrary = $mpiLibraries[0].FullName
  # CMake serializes these values into MFEMConfig.cmake.  A native Windows
  # path such as C:\git\fullmag\Microsoft SDKs\MPI\Include is parsed as
  # CMake escape syntax (for example, \g), so keep the filesystem paths for
  # receipts/tool hashing but pass forward-slash paths at the CMake boundary.
  $mpiIncludeCMake = ConvertTo-FullmagCMakePath $mpiInclude
  $mpiLibraryCMake = ConvertTo-FullmagCMakePath $mpiLibrary
  $mpiLibraryDirectoryCMake = ConvertTo-FullmagCMakePath $mpiLibraries[0].Directory.FullName
  $env:MSMPI_INC = $mpiIncludeCMake
  $env:MSMPI_LIB64 = $mpiLibraryDirectoryCMake
  $sourceRoots = @{}
  foreach ($provider in $plan.providers) {
    $sourceRoots[$provider.name] = Get-FullmagPinnedProviderSource -Provider $provider -SourcesRoot (Join-Path $plan.root "sources")
    Assert-FullmagNativeFemProviderTree -Layout $StorageLayout -Path $sourceRoots[$provider.name]
  }
  $cmake = if ($env:FULLMAG_CMAKE) { $env:FULLMAG_CMAKE } else { "cmake.exe" }
  $cudaFlag = if ($Cuda) { "ON" } else { "OFF" }
  $common = @("-G", "Ninja", "-DCMAKE_MAKE_PROGRAM=$ninja", "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_INSTALL_PREFIX=$($plan.prefix)", "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreadedDLL", "-DBUILD_SHARED_LIBS=OFF")
  $cudaProvider = @()
  $hypreCudaProvider = @()
  if ($Cuda) {
    $cudaProvider = @(
      "-DCMAKE_CUDA_ARCHITECTURES=$CudaArchitectures",
      "-DCMAKE_CUDA_COMPILER=$env:CUDACXX",
      # CUDA 13.3's CCCL requires the conforming MSVC preprocessor in every
      # NVCC host compilation. Keep this as an NVCC host flag rather than a
      # CCCL warning suppression or a source-level macro.
      "-DCMAKE_CUDA_FLAGS=-Xcompiler=/Zc:preprocessor"
    )
    $hypreCompatHeader = Join-Path $SourceRoot "scripts\windows\native_fem\hypre_cccl_compat.h"
    if (-not (Test-Path -LiteralPath $hypreCompatHeader -PathType Leaf)) {
      throw "Native HYPRE CUDA compatibility header is missing: $hypreCompatHeader"
    }
    # HYPRE v3.1.0 relies on transitive Thrust declarations that CUDA 13.3's
    # CCCL no longer guarantees. Pre-include one pinned repo helper for HYPRE
    # only; it maps pair/tuple/reverse-iterator symbols to public headers.
    $hypreCompatPreInclude = '--pre-include="' + $hypreCompatHeader + '"'
    $hypreCudaProvider = @(
      "-DCMAKE_CUDA_ARCHITECTURES=$CudaArchitectures",
      "-DCMAKE_CUDA_COMPILER=$env:CUDACXX",
      "-DCMAKE_CUDA_FLAGS=-Xcompiler=/Zc:preprocessor $hypreCompatPreInclude"
    )
  }
  # FindMPI caches the compiler probe and can mistake cl.exe for an MPI
  # wrapper.  Clear only the MPI/HYPRE probe cache entries before supplying
  # the explicit Microsoft MPI SDK paths below; never force *_WORKS true.
  $mpiCacheReset = @("-UMPI_*", "-UHYPRE_HAVE_MPI*")
  $mpiFind = @("-DMPI_ASSUME_NO_BUILTIN_MPI=ON", "-DMPI_SKIP_COMPILER_WRAPPER=ON")
  $hypreBuild = Join-Path $plan.root "builds\hypre"
  $hypreSource = Join-Path $sourceRoots.hypre "src"
  $hypreCmakeCompat = Join-Path $SourceRoot "scripts\windows\native_fem\hypre_cmake_compat.cmake"
  if (-not (Test-Path -LiteralPath $hypreCmakeCompat -PathType Leaf)) {
    throw "Native HYPRE CMake compatibility hook is missing: $hypreCmakeCompat"
  }
  $hypreCmakeCompatCMake = ConvertTo-FullmagCMakePath $hypreCmakeCompat
  $hypreSourceCMake = ConvertTo-FullmagCMakePath $sourceRoots.hypre
  $hypreCmakeCompatArgs = @(
    "-DCMAKE_PROJECT_INCLUDE_BEFORE=$hypreCmakeCompatCMake",
    "-DFULLMAG_HYPRE_COMPAT_ENABLE=ON",
    "-DFULLMAG_HYPRE_COMPAT_SOURCE_ROOT=$hypreSourceCMake"
  )
  $hypreConfigureArguments = @("-S", $hypreSource, "-B", $hypreBuild, "-UHYPRE_*UMPIRE*") + $mpiCacheReset + $common + $hypreCudaProvider + $mpiFind + $hypreCmakeCompatArgs + @(
    "-DHYPRE_ENABLE_CUDA=$cudaFlag", "-DHYPRE_ENABLE_MPI=ON", "-DHYPRE_ENABLE_UMPIRE=OFF",
    "-DMPI_C_HEADER_DIR=$mpiIncludeCMake", "-DMPI_C_INCLUDE_DIR=$mpiIncludeCMake", "-DMPI_C_INCLUDE_DIRS=$mpiIncludeCMake", "-DMPI_C_ADDITIONAL_INCLUDE_DIRS=$mpiIncludeCMake",
    "-DMPI_C_LIB_NAMES=msmpi", "-DMPI_msmpi_LIBRARY=$mpiLibraryCMake", "-DMPI_C_LIBRARIES=$mpiLibraryCMake",
    "-DHYPRE_ENABLE_FORTRAN=OFF", "-DHYPRE_BUILD_TESTS=OFF", "-DHYPRE_BUILD_EXAMPLES=OFF", "-DHYPRE_ENABLE_SINGLE=OFF", "-DHYPRE_ENABLE_BIGINT=OFF", "-DHYPRE_ENABLE_MIXEDINT=OFF")
  Invoke-FullmagProviderCommand -Command $cmake -Arguments $hypreConfigureArguments -WorkingDirectory (Join-Path $sourceRoots.hypre "src\seq_mv")
  Invoke-FullmagProviderCommand $cmake @("--build", $hypreBuild, "--target", "HYPRE", "--parallel", "8")
  Invoke-FullmagProviderCommand $cmake @("--install", $hypreBuild, "--config", "Release")

  # Windows tar.exe delegates Zstandard decoding to libarchive, whose frame
  # memory ceiling rejects the pinned LLVM archive before extraction. Decode
  # with a pinned upstream zstd CLI and pass the resulting plain tar to tar;
  # this avoids a PowerShell binary pipe and keeps the explicit decode bound.
  $zstdArchive = Get-FullmagPinnedDownload -Url ([string]$zstdRequirement.url) `
      -Path (Join-Path $plan.root ("downloads\" + [string]$zstdRequirement.archive)) -Sha256 ([string]$zstdRequirement.archive_sha256)
  $zstdRoot = Join-Path $plan.root ("tools\" + [string]$zstdRequirement.tool_directory)
  Assert-FullmagNativeFemProviderTree -Layout $StorageLayout -Path $zstdRoot
  New-Item -ItemType Directory -Force -Path $zstdRoot | Out-Null
  Expand-Archive -LiteralPath $zstdArchive -DestinationPath $zstdRoot -Force
  Assert-FullmagNativeFemProviderTree -Layout $StorageLayout -Path $zstdRoot
  $zstdCandidates = @(Get-ChildItem -LiteralPath $zstdRoot -Filter ([string]$zstdRequirement.executable_name) -File -Recurse)
  if ($zstdCandidates.Count -ne 1) { throw "Pinned zstd archive must contain exactly one $($zstdRequirement.executable_name): $zstdRoot" }
  $zstd = $zstdCandidates[0].FullName

  # Use the pinned compiler even if an unrelated clang-cl is present on PATH.
  $llvmArchive = Get-FullmagPinnedDownload -Url "https://github.com/llvm/llvm-project/releases/download/llvmorg-23.1.3/clang%2Bllvm-23.1.3-x86_64-pc-windows-msvc.tar.zst" `
      -Path (Join-Path $plan.root "downloads\llvm-23.1.3.tar.zst") -Sha256 "7e69dc07a4536b79ff24a651a2611990bf8eaab17ea560f1092707c4f31ba01d"
  $llvmTar = Join-Path $plan.root "downloads\llvm-23.1.3.tar"
  Invoke-FullmagProviderCommand $zstd @("-d", "--single-thread", "--memory=$([string]$zstdRequirement.decode_memory)", "--force", "-o", $llvmTar, $llvmArchive)
  if (-not (Test-Path -LiteralPath $llvmTar -PathType Leaf)) { throw "Pinned LLVM archive did not decode to a tar file: $llvmTar" }
  $llvmRoot = Join-Path $plan.root "tools\llvm-23.1.3"
  Assert-FullmagNativeFemProviderTree -Layout $StorageLayout -Path $llvmRoot
  New-Item -ItemType Directory -Force -Path $llvmRoot | Out-Null
  Invoke-FullmagProviderCommand "$env:SystemRoot\System32\tar.exe" @("-xf", $llvmTar, "--strip-components=1", "-C", $llvmRoot)
  Assert-FullmagNativeFemProviderTree -Layout $StorageLayout -Path $llvmRoot
  $clangCompiler = Join-Path $llvmRoot "bin\clang-cl.exe"
  if (-not (Test-Path -LiteralPath $clangCompiler -PathType Leaf)) { throw "Native libCEED requires clang-cl" }
  $ceedBuild = Join-Path $plan.root "builds\libceed"
  # libCEED's CMake project enables CXX while probing the C backend.  An
  # existing provider build can otherwise retain clang++ from PATH and mix a
  # GNU-like CXX frontend with clang-cl C, which is an invalid Windows ABI.
  # Clear only this build's CXX cache namespace before selecting clang-cl for
  # both languages; do not delete any shared build or compiler cache.
  $ceedCxxCacheReset = @("-UCMAKE_CXX_*")
  Invoke-FullmagProviderCommand $cmake (@("-S", (Join-Path $SourceRoot "scripts\windows\native_ceed"), "-B", $ceedBuild) + $ceedCxxCacheReset + $common + $cudaProvider + @(
    "-DCEED_CUDA_ARCHITECTURES=$CudaArchitectures", "-DFULLMAG_CEED_SOURCE_ROOT=$($sourceRoots.libceed)", "-DFULLMAG_CEED_ENABLE_CUDA=$cudaFlag", "-DCMAKE_C_COMPILER=$clangCompiler", "-DCMAKE_CXX_COMPILER=$clangCompiler"))
  Invoke-FullmagProviderCommand $cmake @("--build", $ceedBuild, "--target", "ceed", "--parallel", "8")
  Invoke-FullmagProviderCommand $cmake @("--install", $ceedBuild, "--config", "Release")

  $mfemBuild = Join-Path $plan.root "builds\mfem"
  $mfemConfigure = @("-S", $sourceRoots.mfem, "-B", $mfemBuild)
  if ($Cuda) {
    $mfemCudaOptionsHook = Join-Path $SourceRoot "scripts\windows\native_fem\mfem_windows_cuda_options.cmake"
    if (-not (Test-Path -LiteralPath $mfemCudaOptionsHook -PathType Leaf)) {
      throw "Native MFEM CUDA options hook is missing: $mfemCudaOptionsHook"
    }
    # MFEM v4.9 publishes /wd4819 unqualified.  The frozen hook repairs the
    # target after MFEM creates it and routes the option through nvcc only for
    # CUDA translation units; the pinned MFEM source remains unchanged.
    $mfemConfigure += "-DCMAKE_PROJECT_INCLUDE_BEFORE=$mfemCudaOptionsHook"
  }
  Invoke-FullmagProviderCommand $cmake ($mfemConfigure + $mpiCacheReset + $common + $cudaProvider + $mpiFind + @(
    "-DMFEM_USE_MPI=ON", "-DMPI_CXX_HEADER_DIR=$mpiIncludeCMake", "-DMPI_CXX_INCLUDE_DIR=$mpiIncludeCMake", "-DMPI_CXX_INCLUDE_DIRS=$mpiIncludeCMake", "-DMPI_CXX_ADDITIONAL_INCLUDE_DIRS=$mpiIncludeCMake",
    "-DMPI_CXX_LIB_NAMES=msmpi", "-DMPI_msmpi_LIBRARY=$mpiLibraryCMake", "-DMPI_CXX_LIBRARIES=$mpiLibraryCMake", "-DMFEM_USE_CUDA=$cudaFlag", "-DMFEM_USE_DOUBLE=ON", "-DMFEM_USE_SINGLE=OFF",
    "-DMFEM_USE_CEED=ON", "-DCEED_DIR=$($plan.prefix)", "-DHYPRE_DIR=$($plan.prefix)", "-DMFEM_USE_METIS=OFF", "-DMFEM_ENABLE_TESTING=OFF", "-DMFEM_ENABLE_EXAMPLES=OFF", "-DMFEM_ENABLE_MINIAPPS=OFF"))
  Invoke-FullmagProviderCommand $cmake @("--build", $mfemBuild, "--target", "mfem", "--parallel", "8")
  Invoke-FullmagProviderCommand $cmake @("--install", $mfemBuild, "--config", "Release")
  # Keep the exact pinned provider notices in the canonical installed prefix.
  # The source paths come only from the detached provider mirrors above; the
  # live compiler checkout cannot override or contribute legal files.
  $licenseInventory = Copy-FullmagNativeFemProviderLicenses -Plan $plan -SourceRoots $sourceRoots -Layout $StorageLayout
  # An immutable inventory binds installed inputs to the source and flags.
  $inventory = @()
  foreach ($file in Get-ChildItem -LiteralPath $plan.prefix -Recurse -File) {
    $inventory += [pscustomobject]@{ path=$file.FullName; size_bytes=$file.Length; sha256=(Get-FullmagNativeFemLiteralFileSha256 -Path $file.FullName) }
  }
  foreach ($license in @($licenseInventory)) {
    $inventoryMatch = @($inventory | Where-Object {
      [IO.Path]::GetFullPath([string]$_.path).Equals([IO.Path]::GetFullPath([string]$license.installed_path), [StringComparison]::OrdinalIgnoreCase)
    })
    if ($inventoryMatch.Count -ne 1 -or [string]$inventoryMatch[0].sha256 -ne [string]$license.installed_sha256) {
      throw "Native FEM receipt license is not covered by the exact installed-prefix inventory: $($license.installed_path)"
    }
  }
  $toolInventory = @()
  foreach ($tool in @($ninja, $zstd, $clangCompiler, $mpiLibrary, (Join-Path $mpiInclude "mpi.h"))) {
    $toolInventory += [pscustomobject]@{ path=$tool; sha256=(Get-FileHash -LiteralPath $tool -Algorithm SHA256).Hash.ToLowerInvariant() }
  }
  $compilerVersion = (& $clangCompiler --version | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { throw "Pinned clang-cl version query failed" }
  $zstdTool = [pscustomobject]@{
    name="zstd"
    kind=[string]$zstdRequirement.kind
    version=[string]$zstdRequirement.version
    url=[string]$zstdRequirement.url
    archive=$zstdArchive
    archive_name=[string]$zstdRequirement.archive
    archive_sha256=[string]$zstdRequirement.archive_sha256
    executable=$zstd
    executable_name=[string]$zstdRequirement.executable_name
    executable_sha256=(Get-FileHash -LiteralPath $zstd -Algorithm SHA256).Hash.ToLowerInvariant()
    decode_memory=[string]$zstdRequirement.decode_memory
  }
  $receipt = [pscustomobject]@{ schema="fullmag.windows.fem-providers.v1"; plan=$plan; mpi_include=$mpiInclude; mpi_library=$mpiLibrary; files=$inventory; licenses=$licenseInventory; tools=$toolInventory; zstd=$zstdTool; clang_version=$compilerVersion; completed_at=[DateTime]::UtcNow.ToString("o") }
  [IO.File]::WriteAllText((Join-Path $plan.root "provider-receipt.json"), ($receipt | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
  return $plan.prefix
}
