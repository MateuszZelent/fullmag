# Native Windows FEM assembly helpers; no build runs when this file is loaded.
function Get-FullmagMsiBuildPlan {
  param([string]$FemMode = "cpu", [switch]$Cuda, [string]$DependencyPrefix, [string]$PrebuiltFemDirectory)
  $mode = $FemMode.Trim().ToLowerInvariant()
  if ($mode -notin @("none", "cpu", "gpu")) { throw "MSI FEM mode must be none, cpu or gpu" }
  if ($mode -eq "gpu" -and -not $Cuda) { throw "FEM GPU packaging requires FULLMAG_WINDOWS_MSI_CUDA=1" }
  $enabled = $mode -ne "none"
  $prefix = ""
  if ($enabled) {
    if ($PrebuiltFemDirectory) { throw "MSI builds its own FEM provider; remove FULLMAG_FEM_LIB_DIR" }
    if (-not $DependencyPrefix -or -not [System.IO.Path]::IsPathRooted($DependencyPrefix) -or
        -not (Test-Path -LiteralPath $DependencyPrefix -PathType Container)) {
      throw "FEM packaging requires an absolute existing FULLMAG_FEM_DEPENDENCY_PREFIX"
    }
    # Provider-qualified paths (for example, FileSystem::\\wsl.localhost\...) are
    # not valid filesystem arguments for .NET or CMake. Keep the provider path.
    $prefix = (Resolve-Path -LiteralPath $DependencyPrefix).ProviderPath
  }
  $features = @()
  if ($Cuda) { $features += "cuda" }
  # This historical Cargo feature also enables native FEM CPU.
  if ($enabled) { $features += "fem-gpu" }
  $profile = if ($enabled) {
    "windows-msi-fem-$mode" + $(if ($Cuda -and $mode -eq "cpu") { "-cuda" } else { "" })
  } elseif ($Cuda) { "windows-msi-gpu" } else { "windows-msi-cpu" }
  [pscustomobject]@{ fem_mode=$mode; fem_enabled=$enabled; fem_cuda=($mode -eq "gpu");
    dependency_prefix=$prefix; features=@($features); storage_profile=$profile }
}

function Find-FullmagMsiFemOutput {
  param([string]$BuildRoot)
  $root = Join-Path $BuildRoot "backends\fem"
  $pairs = @()
  foreach ($directory in @((Join-Path $root "Release"), $root)) {
    $dll = Join-Path $directory "fullmag_fem.dll"
    $lib = Join-Path $directory "fullmag_fem.lib"
    if ((Test-Path -LiteralPath $dll) -or (Test-Path -LiteralPath $lib)) {
      foreach ($path in @($dll, $lib)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -eq 0) {
          throw "Incomplete native FEM DLL/import library pair: $directory"
        }
      }
      $pairs += [pscustomobject]@{ directory=$directory; dll=$dll; import_library=$lib }
    }
  }
  if ($pairs.Count -ne 1) { throw "Expected exactly one native FEM DLL/import library pair, found $($pairs.Count)" }
  $pairs[0]
}

function Get-FullmagMsiModalProviderInventory {
  param([string]$BuildRoot, [string]$DependencyPrefix, [bool]$Enabled)
  if (-not $Enabled) { return [pscustomobject]@{ enabled=$false } }
  $cachePath = Join-Path $BuildRoot "CMakeCache.txt"
  if (-not (Test-Path -LiteralPath $cachePath -PathType Leaf)) { throw "Modal provider CMake cache is missing" }
  $lines = @(Get-Content -LiteralPath $cachePath)
  $values = @{}
  foreach ($field in @("SCHEMA", "FILES", "CONFIGS", "TARGETS", "PROFILE")) {
    $key = if ($field -eq "PROFILE") { "FULLMAG_WINDOWS_MODAL_PROVIDER_PROFILE:INTERNAL=" } else {
      "FULLMAG_WINDOWS_MODAL_PROVIDER_RECEIPT_${field}:INTERNAL="
    }
    $entries = @($lines | Where-Object { $_.StartsWith($key, [System.StringComparison]::Ordinal) })
    if ($entries.Count -ne 1) { throw "Modal provider inventory field is missing or ambiguous: $field" }
    $values[$field] = $entries[0].Substring($key.Length)
  }
  if ($values.SCHEMA -ne "fullmag.windows.modal-provider.v1" -or $values.PROFILE -ne "Release") {
    throw "Modal provider inventory schema/profile is incompatible"
  }
  $paths = @($values.FILES.Split(';') | Where-Object { $_ })
  $configs = @($values.CONFIGS.Split(';') | Where-Object { $_ })
  $targets = @($values.TARGETS.Split(';') | Where-Object { $_ })
  if (-not $paths.Count -or -not $configs.Count) { throw "Modal provider inventory is empty" }
  foreach ($target in @("MPI::MPI_CXX", "PETSC::petsc", "SLEPC::slepc")) {
    if ($targets -notcontains $target) { throw "Modal provider inventory omits target: $target" }
  }
  foreach ($config in $configs) {
    if ($paths -notcontains $config) { throw "Modal provider inventory omits config: $config" }
  }
  $prefix = [System.IO.Path]::GetFullPath($DependencyPrefix).TrimEnd([char[]]'\/') + [System.IO.Path]::DirectorySeparatorChar
  $files = @()
  foreach ($path in $paths) {
    if (-not [System.IO.Path]::IsPathRooted($path) -or -not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "Modal provider inventory file is missing: $path"
    }
    $fullPath = [System.IO.Path]::GetFullPath($path)
    if (-not $fullPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Modal provider inventory file escapes prefix: $path"
    }
    $item = Get-Item -LiteralPath $fullPath
    if ($item.Length -eq 0) { throw "Modal provider inventory file is empty: $path" }
    $files += [pscustomobject]@{ path=$fullPath; size_bytes=$item.Length;
      sha256=(Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToLowerInvariant() }
  }
  [pscustomobject]@{ enabled=$true; schema_version=$values.SCHEMA; profile=$values.PROFILE;
    configs=$configs; targets=$targets; files=$files }
}

function Assert-FullmagMsiModalProviderInventory {
  param([object]$Inventory)
  if (-not $Inventory.enabled) { return }
  foreach ($file in $Inventory.files) {
    if (-not (Test-Path -LiteralPath $file.path -PathType Leaf) -or
        (Get-FileHash -LiteralPath $file.path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) {
      throw "Modal provider input changed after configure: $($file.path)"
    }
  }
}

function Get-FullmagMsiFemSourceSnapshotSha256 {
  # The managed launcher supplies the stable source-snapshot identity.  Keep
  # the older generic variable as a compatibility input for direct package
  # callers, but never pass an unchecked value into CMake.
  $value = if ($env:FULLMAG_FEM_SOURCE_SNAPSHOT_SHA256) {
    [string]$env:FULLMAG_FEM_SOURCE_SNAPSHOT_SHA256
  }
  elseif ($env:FULLMAG_SOURCE_SNAPSHOT_SHA256) {
    [string]$env:FULLMAG_SOURCE_SNAPSHOT_SHA256
  }
  else { "" }
  if ($value -and $value -notmatch '^[0-9a-f]{64}$') {
    throw "FULLMAG_FEM_SOURCE_SNAPSHOT_SHA256 must be a lowercase SHA-256"
  }
  return $value.ToLowerInvariant()
}

function Invoke-FullmagMsiFemBuild {
  param([object]$Plan, [string]$RepoRoot, [string]$BuildRoot)
  if (-not $Plan.fem_enabled) { return }
  $cmake = if ($env:FULLMAG_CMAKE) { $env:FULLMAG_CMAKE } else { "cmake" }
  $cudaFlag = if ($Plan.fem_cuda) { "ON" } else { "OFF" }
  # Preserve the build-script modal defaults and explicit operator overrides.
  $slepc = if ($env:FULLMAG_FEM_WITH_SLEPC) { $env:FULLMAG_FEM_WITH_SLEPC } else { $cudaFlag }
  $sourceSnapshotSha256 = Get-FullmagMsiFemSourceSnapshotSha256
  $configure = @("-S", (Join-Path $RepoRoot "native"), "-B", $BuildRoot,
    "-DCMAKE_BUILD_TYPE=Release", "-DFULLMAG_USE_MFEM_STACK=ON",
    "-DFULLMAG_ENABLE_CUDA=$cudaFlag", "-DFULLMAG_ENABLE_FEM_GPU=$cudaFlag",
    "-DFULLMAG_FEM_REQUIRE_GPU=$cudaFlag", "-DFULLMAG_FEM_WITH_SLEPC=$slepc",
    "-DFULLMAG_FEM_DEPENDENCY_PREFIX=$($Plan.dependency_prefix)",
    "-DCMAKE_PREFIX_PATH=$($Plan.dependency_prefix)",
    "-DFULLMAG_FEM_SOURCE_SNAPSHOT_SHA256=$sourceSnapshotSha256")
  if ($env:FULLMAG_CUDA_ARCHITECTURES) { $configure += "-DCMAKE_CUDA_ARCHITECTURES=$env:FULLMAG_CUDA_ARCHITECTURES" }
  $configs = @(@("MFEMConfig.cmake", "lib/cmake/mfem/MFEMConfig.cmake", "lib/cmake/MFEM/MFEMConfig.cmake",
      "share/mfem/MFEMConfig.cmake", "share/cmake/mfem/MFEMConfig.cmake") | ForEach-Object {
    $candidate = Join-Path $Plan.dependency_prefix $_
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { (Resolve-Path -LiteralPath $candidate).ProviderPath }
  } | Sort-Object -Unique)
  if ($configs.Count -ne 1) { throw "Expected exactly one MFEM provider config before build" }
  $configHash = (Get-FileHash -LiteralPath $configs[0] -Algorithm SHA256).Hash.ToLowerInvariant()
  & $cmake @configure | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "Native Windows FEM configure failed with exit code $LASTEXITCODE" }
  # CMake's false constants; stale ON receipts are ignored for an OFF configure.
  $modalEnabled = $slepc -notmatch '^(|0|OFF|NO|FALSE|N|IGNORE|NOTFOUND|.*-NOTFOUND)$'
  $modalInventory = Get-FullmagMsiModalProviderInventory -BuildRoot $BuildRoot `
    -DependencyPrefix $Plan.dependency_prefix -Enabled $modalEnabled
  & $cmake --build $BuildRoot --config Release --target fullmag_fem | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "Native Windows FEM build failed with exit code $LASTEXITCODE" }
  if ((Get-FileHash -LiteralPath $configs[0] -Algorithm SHA256).Hash.ToLowerInvariant() -ne $configHash) {
    throw "MFEM provider config changed during build"
  }
  Assert-FullmagMsiModalProviderInventory -Inventory $modalInventory
  $output = Find-FullmagMsiFemOutput -BuildRoot $BuildRoot
  $output | Add-Member -NotePropertyMembers @{ configure_arguments=$configure; source_snapshot_sha256=$sourceSnapshotSha256; provider_config=$configs[0];
    modal_provider=$modalInventory;
    provider_config_sha256=$configHash; import_library_sha256=(Get-FileHash -LiteralPath $output.import_library -Algorithm SHA256).Hash.ToLowerInvariant();
    dll_sha256=(Get-FileHash -LiteralPath $output.dll -Algorithm SHA256).Hash.ToLowerInvariant() }
  $output
}

function Test-FullmagMsiPathWithin {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Base)
  $candidate = [System.IO.Path]::GetFullPath($Path).TrimEnd([char[]]'\/') + [System.IO.Path]::DirectorySeparatorChar
  $root = [System.IO.Path]::GetFullPath($Base).TrimEnd([char[]]'\/') + [System.IO.Path]::DirectorySeparatorChar
  return $candidate.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-FullmagMsiPathChain {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Base,
    [Parameter(Mandatory = $true)][string]$Label,
    [switch]$Leaf
  )
  $resolved = [System.IO.Path]::GetFullPath($Path)
  $root = [System.IO.Path]::GetFullPath($Base)
  if (-not (Test-FullmagMsiPathWithin -Path $resolved -Base $root)) {
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

function Assert-FullmagMsiReceiptMpiInventory {
  param(
    [Parameter(Mandatory = $true)][object]$Receipt,
    [Parameter(Mandatory = $true)][string]$ProviderRoot
  )
  if ([string]::IsNullOrWhiteSpace([string]$Receipt.mpi_include) -or
      [string]::IsNullOrWhiteSpace([string]$Receipt.mpi_library)) {
    throw "Native FEM provider receipt does not bind both MSMPI include and library paths"
  }
  $mpiInclude = Assert-FullmagMsiPathChain -Path ([string]$Receipt.mpi_include) -Base $ProviderRoot `
    -Label "Native FEM provider MSMPI include directory"
  $mpiLibrary = Assert-FullmagMsiPathChain -Path ([string]$Receipt.mpi_library) -Base $ProviderRoot `
    -Label "Native FEM provider MSMPI import library" -Leaf
  if ([System.IO.Path]::GetFileName($mpiLibrary) -ine "msmpi.lib") {
    throw "Native FEM provider receipt MSMPI library has the wrong filename: $mpiLibrary"
  }
  $mpiHeader = Assert-FullmagMsiPathChain -Path (Join-Path $mpiInclude "mpi.h") -Base $ProviderRoot `
    -Label "Native FEM provider MSMPI header" -Leaf
  $libraryTools = @($Receipt.tools | Where-Object {
    [string]::Equals(
      [System.IO.Path]::GetFullPath([string]$_.path),
      $mpiLibrary,
      [System.StringComparison]::OrdinalIgnoreCase
    )
  })
  $headerTools = @($Receipt.tools | Where-Object {
    [string]::Equals(
      [System.IO.Path]::GetFullPath([string]$_.path),
      $mpiHeader,
      [System.StringComparison]::OrdinalIgnoreCase
    )
  })
  if ($libraryTools.Count -ne 1 -or $headerTools.Count -ne 1) {
    throw "Native FEM provider receipt MSMPI paths are not bound to the hashed tools inventory"
  }
  [pscustomobject]@{ include = $mpiInclude; header = $mpiHeader; library = $mpiLibrary }
}

function Get-FullmagMsiMpiRuntimeRoot {
  param([Parameter(Mandatory = $true)][object]$Plan)
  if (-not $Plan.fem_enabled) { return }

  $prefix = [System.IO.Path]::GetFullPath([string]$Plan.dependency_prefix).TrimEnd([char[]]'\/')
  $providerRoot = Split-Path -Parent $prefix
  $receiptPath = Join-Path $providerRoot "provider-receipt.json"
  $receiptPath = Assert-FullmagMsiPathChain -Path $receiptPath -Base $providerRoot `
    -Label "Native FEM managed provider receipt" -Leaf
  try {
    $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json -ErrorAction Stop
  }
  catch {
    throw "Native FEM provider receipt is invalid while resolving MSMPI runtime: $receiptPath ($($_.Exception.Message))"
  }
  if ([string]$receipt.schema -ne "fullmag.windows.fem-providers.v1" -or
      $null -eq $receipt.plan -or [string]::IsNullOrWhiteSpace([string]$receipt.mpi_library)) {
    throw "Native FEM provider receipt does not bind an MSMPI library: $receiptPath"
  }
  $receiptRoot = [System.IO.Path]::GetFullPath([string]$receipt.plan.root).TrimEnd([char[]]'\/')
  if (-not $receiptRoot.Equals($providerRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Native FEM provider receipt root does not match its managed prefix: $receiptPath"
  }
  $mpiBinding = Assert-FullmagMsiReceiptMpiInventory -Receipt $receipt -ProviderRoot $providerRoot
  $receiptLibrary = [string]$mpiBinding.library
  if (-not (Test-Path -LiteralPath "HKLM:\SOFTWARE\Microsoft\MPI")) {
    throw "Native FEM MSMPI runtime registration is missing: HKLM:\SOFTWARE\Microsoft\MPI"
  }
  $registration = Get-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Microsoft\MPI" -ErrorAction Stop
  $installRoot = [string]$registration.InstallRoot
  $runtimeDll = [string]$registration.MSPMSProvider
  $registeredVersion = [string]$registration.Version
  if ([string]::IsNullOrWhiteSpace($installRoot) -or [string]::IsNullOrWhiteSpace($runtimeDll) -or
      [string]::IsNullOrWhiteSpace($registeredVersion) -or
      -not [System.IO.Path]::IsPathRooted($installRoot) -or
      -not [System.IO.Path]::IsPathRooted($runtimeDll)) {
    throw "Native FEM MSMPI registration is incomplete: HKLM:\SOFTWARE\Microsoft\MPI"
  }
  $installRoot = [System.IO.Path]::GetFullPath($installRoot).TrimEnd([char[]]'\/')
  $runtimeDll = [System.IO.Path]::GetFullPath($runtimeDll)
  if (-not (Test-Path -LiteralPath $runtimeDll -PathType Leaf) -or
      [System.IO.Path]::GetFileName($runtimeDll) -ine "msmpi.dll") {
    throw "Native FEM MSMPI registered runtime DLL is missing or invalid: $runtimeDll"
  }
  $runtimeItem = Get-Item -LiteralPath $runtimeDll -Force
  if (($runtimeItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
      ($runtimeItem.PSObject.Properties.Name -contains "LinkType" -and $runtimeItem.LinkType)) {
    throw "Native FEM MSMPI registered runtime DLL is a reparse point: $runtimeDll"
  }
  $runtimeVersion = [string]$runtimeItem.VersionInfo.FileVersion
  if ($runtimeVersion -ne $registeredVersion) {
    throw "Native FEM MSMPI runtime version does not match its registration: $runtimeVersion vs $registeredVersion"
  }
  $binCandidates = @()
  if ($env:MSMPI_BIN) { $binCandidates += [System.IO.Path]::GetFullPath([string]$env:MSMPI_BIN) }
  $binCandidates += Join-Path $installRoot "Bin"
  $binCandidates = @($binCandidates | Where-Object { $_ } | ForEach-Object {
    [System.IO.Path]::GetFullPath($_).TrimEnd([char[]]'\/')
  } | Sort-Object -Unique)
  $validBins = @()
  foreach ($bin in $binCandidates) {
    if (-not (Test-FullmagMsiPathWithin -Path $bin -Base $installRoot)) {
      throw "Native FEM MSMPI bin directory escapes its registered installation: $bin"
    }
    $mpiexec = Join-Path $bin "mpiexec.exe"
    if (Test-Path -LiteralPath $mpiexec -PathType Leaf) {
      $mpiexecVersion = [string](Get-Item -LiteralPath $mpiexec).VersionInfo.FileVersion
      if ($mpiexecVersion -ne $registeredVersion) {
        throw "Native FEM MSMPI mpiexec version does not match its registration: $mpiexecVersion vs $registeredVersion"
      }
      $validBins += $bin
    }
  }
  if ($validBins.Count -ne 1) {
    throw "Native FEM MSMPI installation must expose exactly one registered x64 mpiexec bin: $installRoot"
  }
  Split-Path -Parent $runtimeDll
}

function Get-FullmagMsiFemDependencyRoots {
  param([object]$Plan)
  if (-not $Plan.fem_enabled) { return }
  $roots = @(
    $Plan.dependency_prefix,
    (Join-Path $Plan.dependency_prefix "bin"),
    (Join-Path $Plan.dependency_prefix "lib"),
    (Get-FullmagMsiMpiRuntimeRoot -Plan $Plan)
  )
  $roots | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) } |
    ForEach-Object { [System.IO.Path]::GetFullPath($_) } | Sort-Object -Unique
}

function Assert-FullmagMsiFemAvailability {
  param([object]$Plan, [object]$Status)
  if (-not $Plan.fem_enabled) { return }
  if ($Status -isnot [System.Management.Automation.PSCustomObject]) { throw "Native FEM availability must be a JSON object" }
  if ($Status.native_fem_cpu_available -isnot [bool] -or -not $Status.native_fem_cpu_available) {
    throw "Staged native FEM CPU is unavailable"
  }
  if ($Status.native_fem_gpu_available -isnot [bool]) { throw "Native FEM GPU availability diagnostic is missing" }
  if (-not $Plan.fem_cuda -and $Status.native_fem_gpu_available) { throw "CPU FEM package unexpectedly exposes GPU" }
  # No visible build-host GPU is required to assemble a CUDA package.
  # Actual device execution and scientific qualification remain separate gates.
}

function Convert-FullmagMsiFemAvailability {
  param([object]$Plan, [string]$JsonOutput)
  # ConvertFrom-Json unwraps a one-item array in the pipeline; enforce the root.
  $text = $JsonOutput.Trim()
  if (-not $text.StartsWith("{") -or -not $text.EndsWith("}")) {
    throw "Native FEM availability must be a JSON object"
  }
  $status = $text | ConvertFrom-Json -ErrorAction Stop
  Assert-FullmagMsiFemAvailability -Plan $Plan -Status $status
  $status
}

function Write-FullmagMsiFemRuntimeManifests {
  param([object]$Plan, [string]$RuntimesRoot, [string]$Version)
  if (-not $Plan.fem_enabled) { return }
  $devices = @("cpu")
  if ($Plan.fem_cuda) { $devices += "gpu" }
  foreach ($device in $devices) {
    $family = if ($device -eq "cpu") { "fem-cpu-native" } else { "fem-gpu" }
    $directory = Join-Path $RuntimesRoot $family
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $json = @{ family=$family; version=$Version; worker="../../bin/fullmag-bin.exe";
      engines=@(@{ backend="fem"; device=$device; mode="strict"; precision="double";
        public=$false; stability="experimental" }) } |
      ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText((Join-Path $directory "manifest.json"), $json, [System.Text.UTF8Encoding]::new($false))
  }
}
