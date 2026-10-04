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
    $prefix = (Resolve-Path -LiteralPath $DependencyPrefix).Path
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

function Invoke-FullmagMsiFemBuild {
  param([object]$Plan, [string]$RepoRoot, [string]$BuildRoot)
  if (-not $Plan.fem_enabled) { return }
  $cmake = if ($env:FULLMAG_CMAKE) { $env:FULLMAG_CMAKE } else { "cmake" }
  $cudaFlag = if ($Plan.fem_cuda) { "ON" } else { "OFF" }
  # Preserve the build-script modal defaults and explicit operator overrides.
  $slepc = if ($env:FULLMAG_FEM_WITH_SLEPC) { $env:FULLMAG_FEM_WITH_SLEPC } else { $cudaFlag }
  $configure = @("-S", (Join-Path $RepoRoot "native"), "-B", $BuildRoot,
    "-DCMAKE_BUILD_TYPE=Release", "-DFULLMAG_USE_MFEM_STACK=ON",
    "-DFULLMAG_ENABLE_CUDA=$cudaFlag", "-DFULLMAG_ENABLE_FEM_GPU=$cudaFlag",
    "-DFULLMAG_FEM_REQUIRE_GPU=$cudaFlag", "-DFULLMAG_FEM_WITH_SLEPC=$slepc",
    "-DFULLMAG_FEM_DEPENDENCY_PREFIX=$($Plan.dependency_prefix)",
    "-DCMAKE_PREFIX_PATH=$($Plan.dependency_prefix)")
  if ($env:FULLMAG_CUDA_ARCHITECTURES) { $configure += "-DCMAKE_CUDA_ARCHITECTURES=$env:FULLMAG_CUDA_ARCHITECTURES" }
  $configs = @(@("MFEMConfig.cmake", "lib/cmake/mfem/MFEMConfig.cmake", "lib/cmake/MFEM/MFEMConfig.cmake",
      "share/mfem/MFEMConfig.cmake", "share/cmake/mfem/MFEMConfig.cmake") | ForEach-Object {
    $candidate = Join-Path $Plan.dependency_prefix $_
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { (Resolve-Path -LiteralPath $candidate).Path }
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
  $output | Add-Member -NotePropertyMembers @{ configure_arguments=$configure; provider_config=$configs[0];
    modal_provider=$modalInventory;
    provider_config_sha256=$configHash; import_library_sha256=(Get-FileHash -LiteralPath $output.import_library -Algorithm SHA256).Hash.ToLowerInvariant();
    dll_sha256=(Get-FileHash -LiteralPath $output.dll -Algorithm SHA256).Hash.ToLowerInvariant() }
  $output
}

function Get-FullmagMsiFemDependencyRoots {
  param([object]$Plan)
  if (-not $Plan.fem_enabled) { return }
  @($Plan.dependency_prefix, (Join-Path $Plan.dependency_prefix "bin"), (Join-Path $Plan.dependency_prefix "lib")) |
    Where-Object { Test-Path -LiteralPath $_ -PathType Container }
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
