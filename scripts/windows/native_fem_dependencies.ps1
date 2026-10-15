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
    header_providers = @(
      [pscustomobject]@{
        name="boost_headers"
        version="1.89.0"
        url="https://archives.boost.io/release/1.89.0/source/boost_1_89_0.zip"
        archive="boost_1_89_0.zip"
        archive_sha256="77bee48e32cabab96a3fd2589ec3ab9a17798d330220fdd8bde6ff5611b4ccde"
        root_directory="boost_1_89_0"
        include_directory="boost"
        license_file="LICENSE_1_0.txt"
        required_headers=@("boost/multiprecision/cpp_int.hpp", "boost/rational.hpp")
        max_selected_files=50000
        max_selected_file_bytes=33554432
        max_selected_uncompressed_bytes=536870912
      }
    )
  }
}

function Assert-FullmagNativeFemProviderTree {
  param([object]$Layout, [string]$Path)
  Write-Host "[native-fem] provider tree validation starting"
  $null = Assert-FullmagStoragePath -Layout $Layout -Path $Path -Label "native FEM provider path" -Parent ([string]$Layout.build_root)
  if (-not (Test-Path -LiteralPath $Path)) {
    Write-Host "[native-fem] provider tree validation complete"
    return
  }
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
  Write-Host "[native-fem] provider tree validation complete"
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
  $helperPropertyNames = if ($null -ne $helper) {
    @($helper.PSObject.Properties | ForEach-Object { $_.Name })
  } else { @() }
  if ($null -eq $helper -or
      $helperPropertyNames -notcontains "host_requirement" -or
      $helper.host_requirement -isnot [bool] -or
      [string]$helper.kind -ne "provider_bootstrap_internal_helper" -or
      [bool]$helper.host_requirement -or
      [string]$helper.managed_by -ne "scripts/windows/native_fem_dependencies.ps1") {
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

function Get-FullmagNativeFemBoostRequirement {
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
  $boost = if ($null -ne $requirements.tools) { $requirements.tools.boost_headers } else { $null }
  if ($null -eq $boost) { throw "Windows build requirements do not define the managed Boost headers provider" }
  foreach ($name in @("kind", "version", "url", "archive", "archive_sha256", "root_directory", "include_directory", "license_file", "required_headers", "max_selected_files", "max_selected_file_bytes", "max_selected_uncompressed_bytes", "provider_path", "include_path", "license_path")) {
    if ($null -eq $boost.PSObject.Properties[$name] -or
        ([string]$name -notin @("required_headers", "max_selected_files", "max_selected_file_bytes", "max_selected_uncompressed_bytes") -and [string]::IsNullOrWhiteSpace([string]$boost.$name))) {
      throw "Windows Boost headers provider metadata is incomplete: $name"
    }
  }
  if ([string]$boost.kind -ne "project_managed_header_provider" -or
      [string]$boost.version -ne "1.89.0" -or
      [string]$boost.archive -ne "boost_1_89_0.zip" -or
      [string]$boost.url -ne "https://archives.boost.io/release/1.89.0/source/boost_1_89_0.zip" -or
      [string]$boost.root_directory -ne "boost_1_89_0" -or
      [string]$boost.include_directory -ne "boost" -or
      [string]$boost.license_file -ne "LICENSE_1_0.txt" -or
      [string]$boost.provider_path -ne "{build_root}\fem-dependencies\installed\providers\b-77bee48e32ca" -or
      [string]$boost.include_path -ne "{build_root}\fem-dependencies\installed\providers\b-77bee48e32ca\include" -or
      [string]$boost.license_path -ne "{build_root}\fem-dependencies\installed\providers\b-77bee48e32ca\share\licenses\boost\LICENSE_1_0.txt") {
    throw "Windows Boost headers provider metadata does not match the pinned upstream archive"
  }
  $requiredHeaders = @($boost.required_headers | ForEach-Object { [string]$_ })
  if ($requiredHeaders.Count -ne 2 -or
      $requiredHeaders[0] -ne "boost/multiprecision/cpp_int.hpp" -or
      $requiredHeaders[1] -ne "boost/rational.hpp") {
    throw "Windows Boost headers provider must pin cpp_int.hpp and rational.hpp"
  }
  foreach ($header in $requiredHeaders) {
    if ($header -notmatch '^boost/[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$') {
      throw "Windows Boost headers provider required header is invalid: $header"
    }
  }
  if ([string]$boost.url -notmatch '^https://archives\.boost\.io/') {
    throw "Windows Boost headers provider URL must use the official HTTPS archive"
  }
  if ([string]$boost.archive_sha256 -notmatch '^[0-9a-f]{64}$') {
    throw "Windows Boost headers provider archive SHA256 is invalid"
  }
  foreach ($name in @("archive", "root_directory", "include_directory", "license_file")) {
    if ([string]$boost.$name -match '[\\/]') {
      throw "Windows Boost headers provider contains an unsafe path component: $name"
    }
  }
  if ([int64]$boost.max_selected_files -ne 50000 -or
      [int64]$boost.max_selected_file_bytes -ne 33554432 -or
      [int64]$boost.max_selected_uncompressed_bytes -ne 536870912) {
    throw "Windows Boost headers provider extraction bounds differ from the pinned policy"
  }
  $plan = Get-FullmagNativeFemDependencyPlan -BuildRoot (Join-Path $SourceRoot "__manifest_probe__") -Cuda:$false -CudaArchitectures ""
  $pinned = @($plan.header_providers | Where-Object { [string]$_.name -eq "boost_headers" })
  if ($pinned.Count -ne 1) { throw "Native FEM plan has no unique Boost headers provider pin" }
  foreach ($name in @("version", "url", "archive", "archive_sha256", "root_directory", "include_directory", "license_file")) {
    if ([string]$pinned[0].$name -ne [string]$boost.$name) {
      throw "Native FEM plan and Windows requirements disagree for Boost headers: $name"
    }
  }
  if ((@($pinned[0].required_headers) -join "|") -ne ($requiredHeaders -join "|")) {
    throw "Native FEM plan and Windows requirements disagree for Boost required headers"
  }
  return $boost
}

function Get-FullmagNativeFemBoostInstallRoot {
  param(
    [Parameter(Mandatory=$true)][string]$ProviderRoot,
    [Parameter(Mandatory=$true)][object]$Requirement
  )
  $providerRoot = [IO.Path]::GetFullPath($ProviderRoot).TrimEnd([char[]]'\\/')
  $prefix = Join-Path $providerRoot "installed"
  $hashPrefix = ([string]$Requirement.archive_sha256).Substring(0, 12)
  $suffix = "b-$hashPrefix"
  return [IO.Path]::GetFullPath((Join-Path $prefix ("providers\" + $suffix)))
}

function Assert-FullmagNativeFemBoostPathBudget {
  param(
    [Parameter(Mandatory=$true)][string]$Path,
    [Parameter(Mandatory=$true)][string]$Label,
    [Parameter(Mandatory=$false)][switch]$FileDestination
  )
  $resolved = [IO.Path]::GetFullPath($Path)
  # Win32 MAX_PATH is 260 characters including the terminating NUL.  Keep
  # that boundary explicit; long-path policy and alternate roots are not
  # enabled implicitly for this provider.
  $maxPathLength = 259
  if ($resolved.Length -ge $maxPathLength) {
    throw "$Label exceeds the native Windows path budget (length $($resolved.Length), limit $maxPathLength): $resolved"
  }
  if ($FileDestination) {
    $parent = [IO.Directory]::GetParent($resolved)
    if (-not $parent) {
      throw "$Label has no directory parent: $resolved"
    }
    $parentLength = ([IO.Path]::GetFullPath($parent.FullName)).Length
    # Directory.CreateDirectory uses the legacy Win32 directory boundary on
    # this route.  Reject the parent before a selected file can be written.
    $maxDirectoryPathLength = 248
    if ($parentLength -ge $maxDirectoryPathLength) {
      throw "$Label parent exceeds the native Windows directory path budget (length $parentLength, limit $maxDirectoryPathLength): $($parent.FullName)"
    }
  }
  return $resolved
}

function Get-FullmagNativeFemRelativePath {
  param(
    [Parameter(Mandatory=$true)][string]$Root,
    [Parameter(Mandatory=$true)][string]$Path,
    [Parameter(Mandatory=$true)][string]$Label
  )
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd([char[]]'\\/')
  $pathFull = [IO.Path]::GetFullPath($Path)
  if (-not ($pathFull.StartsWith($rootFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase))) {
    throw "$Label escapes its canonical root: $pathFull"
  }
  return $pathFull.Substring($rootFull.Length + 1).Replace('\', '/')
}

function Get-FullmagNativeFemTreeInventory {
  param(
    [Parameter(Mandatory=$true)][string]$Root,
    [Parameter(Mandatory=$true)][string]$Label
  )
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd([char[]]'\\/')
  $rootItem = Get-Item -LiteralPath $rootFull -Force -ErrorAction Stop
  if (-not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "$Label is not a regular directory: $rootFull"
  }
  $pending = [Collections.Generic.Queue[string]]::new()
  $pending.Enqueue($rootFull)
  $records = [Collections.Generic.List[object]]::new()
  while ($pending.Count) {
    $current = $pending.Dequeue()
    $currentItem = Get-Item -LiteralPath $current -Force -ErrorAction Stop
    if ($currentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "$Label contains a reparse point: $current"
    }
    foreach ($child in Get-ChildItem -LiteralPath $current -Force -ErrorAction Stop) {
      if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "$Label contains a reparse point: $($child.FullName)"
      }
      if ($child.PSIsContainer) {
        $pending.Enqueue($child.FullName)
        continue
      }
      if (-not $child.PSIsContainer -and $child.PSObject.Properties.Name -contains "LinkType" -and $child.LinkType) {
        throw "$Label contains a linked file: $($child.FullName)"
      }
      $relative = Get-FullmagNativeFemRelativePath -Root $rootFull -Path $child.FullName -Label $Label
      $records.Add([pscustomobject]@{
        path = $relative
        size_bytes = [int64]$child.Length
        sha256 = Get-FullmagNativeFemLiteralFileSha256 -Path $child.FullName
      }) | Out-Null
    }
  }
  return @($records | Sort-Object path)
}

function Assert-FullmagNativeFemBoostTree {
  param(
    [Parameter(Mandatory=$true)][string]$Root,
    [Parameter(Mandatory=$true)][object[]]$ExpectedFiles,
    [Parameter(Mandatory=$true)][object]$Requirement
  )
  $actual = @(Get-FullmagNativeFemTreeInventory -Root $Root -Label "Boost installed tree")
  $expectedMap = @{}
  foreach ($expected in @($ExpectedFiles)) {
    $path = [string]$expected.path
    if ($path -notmatch '^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)+$' -or $path -match '(^|/)\.\.?(/|$)') {
      throw "Boost receipt contains an unsafe relative tree path: $path"
    }
    $key = $path.ToLowerInvariant()
    if ($expectedMap.ContainsKey($key)) { throw "Boost receipt contains duplicate tree path: $path" }
    if ([string]$expected.sha256 -notmatch '^[0-9a-f]{64}$') { throw "Boost receipt contains an invalid tree hash: $path" }
    $expectedMap[$key] = $expected
  }
  $actualMap = @{}
  foreach ($record in $actual) {
    $key = ([string]$record.path).ToLowerInvariant()
    if ($actualMap.ContainsKey($key)) { throw "Boost installed tree contains duplicate case-insensitive path: $($record.path)" }
    $actualMap[$key] = $record
    if (-not $expectedMap.ContainsKey($key)) { throw "Boost installed tree contains an unadmitted file: $($record.path)" }
    if ([int64]$record.size_bytes -ne [int64]$expectedMap[$key].size_bytes -or
        [string]$record.sha256 -ne ([string]$expectedMap[$key].sha256).ToLowerInvariant()) {
      throw "Boost installed tree differs from the exact expected bytes: $($record.path)"
    }
  }
  if ($actualMap.Count -ne $expectedMap.Count) { throw "Boost installed tree does not exactly match its expected file inventory" }
  foreach ($header in @($Requirement.required_headers | ForEach-Object { [string]$_ })) {
    $requiredPath = ("include/" + $header).ToLowerInvariant()
    if (-not $actualMap.ContainsKey($requiredPath)) { throw "Boost installed tree is missing required header: $header" }
  }
  $licensePath = ("share/licenses/boost/" + [string]$Requirement.license_file).ToLowerInvariant()
  if (-not $actualMap.ContainsKey($licensePath)) { throw "Boost installed tree is missing its pinned license" }
  return @($actual)
}

function Get-FullmagNativeFemBoostArchiveInventory {
  param(
    [Parameter(Mandatory=$true)][string]$ArchivePath,
    [Parameter(Mandatory=$true)][object]$Requirement,
    [Parameter(Mandatory=$true)][string]$ProviderRoot
  )
  $archive = Assert-FullmagNativeFemRegularFile -Path $ArchivePath -Root $ProviderRoot -Label "Boost archive"
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $records = [Collections.Generic.List[object]]::new()
  $seenEntries = @{}
  $selectedBytes = [int64]0
  $zip = [IO.Compression.ZipFile]::OpenRead($archive)
  try {
    $rootPrefix = [string]$Requirement.root_directory + "/"
    foreach ($entry in $zip.Entries) {
      $entryName = [string]$entry.FullName
      if ([string]::IsNullOrWhiteSpace($entryName) -or
          -not $entryName.StartsWith($rootPrefix, [StringComparison]::Ordinal)) { continue }
      if ($entryName.EndsWith("/", [StringComparison]::Ordinal)) { continue }
      $relative = $entryName.Substring($rootPrefix.Length)
      if ($relative -match '(^|/)\.\.?(/|$)' -or
          $relative.StartsWith("/", [StringComparison]::Ordinal) -or
          $relative.Contains('\')) {
        throw "Pinned Boost archive contains an unsafe selected path: $entryName"
      }
      if ($relative -eq [string]$Requirement.license_file) {
        $destinationRelative = "share/licenses/boost/" + [string]$Requirement.license_file
      }
      elseif ($relative.StartsWith("boost/", [StringComparison]::Ordinal)) {
        $destinationRelative = "include/" + $relative
      }
      else { continue }
      if ($entry.Length -lt 0 -or [int64]$entry.Length -gt [int64]$Requirement.max_selected_file_bytes) {
        throw "Pinned Boost archive selected file exceeds its per-file extraction bound: $entryName"
      }
      $selectedBytes += [int64]$entry.Length
      if ($selectedBytes -gt [int64]$Requirement.max_selected_uncompressed_bytes) {
        throw "Pinned Boost archive selected files exceed their total extraction bound"
      }
      if ($records.Count -ge [int64]$Requirement.max_selected_files) {
        throw "Pinned Boost archive selected file count exceeds its extraction bound"
      }
      if ($destinationRelative -notmatch '^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)+$' -or
          $destinationRelative -match '(^|/)\.\.?(/|$)') {
        throw "Pinned Boost archive selected path is unsafe: $entryName"
      }
      $key = $destinationRelative.ToLowerInvariant()
      if ($seenEntries.ContainsKey($key)) { throw "Pinned Boost archive contains duplicate selected path: $entryName" }
      $seenEntries[$key] = $true
      $entryStream = $null
      $sha = [Security.Cryptography.SHA256]::Create()
      try {
        $entryStream = $entry.Open()
        $digest = $sha.ComputeHash($entryStream)
      }
      finally {
        if ($null -ne $entryStream) { $entryStream.Dispose() }
        $sha.Dispose()
      }
      $records.Add([pscustomobject]@{
        path = $destinationRelative
        size_bytes = [int64]$entry.Length
        sha256 = ([BitConverter]::ToString($digest)).Replace("-", "").ToLowerInvariant()
      }) | Out-Null
    }
  }
  finally {
    $zip.Dispose()
  }
  $sorted = @($records | Sort-Object path)
  if ($sorted.Count -lt 3) { throw "Pinned Boost archive did not provide both required headers and the license" }
  $map = @{}
  foreach ($record in $sorted) { $map[([string]$record.path).ToLowerInvariant()] = $record }
  foreach ($header in @($Requirement.required_headers | ForEach-Object { [string]$_ })) {
    $requiredPath = ("include/" + $header).ToLowerInvariant()
    if (-not $map.ContainsKey($requiredPath)) { throw "Pinned Boost archive is missing required header: $header" }
  }
  $licensePath = ("share/licenses/boost/" + [string]$Requirement.license_file).ToLowerInvariant()
  if (-not $map.ContainsKey($licensePath)) { throw "Pinned Boost archive is missing its pinned license" }
  return $sorted
}

function Assert-FullmagNativeFemBoostReceipt {
  param(
    [Parameter(Mandatory=$true)][object]$Receipt,
    [Parameter(Mandatory=$true)][object]$Requirement,
    [Parameter(Mandatory=$true)][string]$ProviderRoot
  )
  $receiptProperties = @($Receipt.PSObject.Properties.Name)
  $boostReceipt = if ($receiptProperties -contains "boost") { $Receipt.boost } else { $Receipt }
  if ($null -eq $boostReceipt) { throw "Native FEM provider receipt is missing boost metadata" }
  foreach ($name in @("name", "kind", "version", "url", "archive_name", "archive_sha256", "archive", "install_root", "include_root", "installed_header", "installed_header_sha256", "installed_rational_header", "installed_rational_header_sha256", "license", "license_sha256")) {
    if ($null -eq $boostReceipt.PSObject.Properties[$name] -or [string]::IsNullOrWhiteSpace([string]$boostReceipt.$name)) {
      throw "Native FEM provider receipt boost metadata is incomplete: $name"
    }
  }
  if ($null -eq $boostReceipt.PSObject.Properties["include_tree"] -or -not @($boostReceipt.include_tree).Count) {
    throw "Native FEM provider receipt boost metadata is incomplete: include_tree"
  }
  if ($null -eq $boostReceipt.PSObject.Properties["required_headers"] -or -not @($boostReceipt.required_headers).Count) {
    throw "Native FEM provider receipt boost metadata is incomplete: required_headers"
  }
  if ([string]$boostReceipt.name -ne "boost_headers" -or
      [string]$boostReceipt.kind -ne [string]$Requirement.kind -or
      [string]$boostReceipt.version -ne [string]$Requirement.version -or
      [string]$boostReceipt.url -ne [string]$Requirement.url -or
      [string]$boostReceipt.archive_name -ne [string]$Requirement.archive -or
      [string]$boostReceipt.archive_sha256 -ne ([string]$Requirement.archive_sha256).ToLowerInvariant()) {
    throw "Native FEM provider receipt boost metadata does not match the committed pin"
  }
  $archive = Assert-FullmagNativeFemRegularFile -Path ([string]$boostReceipt.archive) -Root $ProviderRoot -Label "Boost archive"
  $expectedArchive = [IO.Path]::GetFullPath((Join-Path $ProviderRoot ("downloads\" + [string]$Requirement.archive)))
  if (-not $archive.Equals($expectedArchive, [StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFileName($archive) -ne [string]$Requirement.archive -or
      (Get-FullmagNativeFemLiteralFileSha256 -Path $archive) -ne ([string]$Requirement.archive_sha256).ToLowerInvariant()) {
    throw "Native FEM provider receipt Boost archive is not the pinned download with its exact SHA256"
  }
  if ([string]$boostReceipt.archive_sha256 -notmatch '^[0-9a-f]{64}$') { throw "Native FEM provider receipt Boost archive SHA256 is invalid" }
  $installRoot = Get-FullmagNativeFemBoostInstallRoot -ProviderRoot $ProviderRoot -Requirement $Requirement
  $reportedRoot = Assert-FullmagNativeFemRegularDirectory -Path ([string]$boostReceipt.install_root) -Root (Join-Path $ProviderRoot "installed") -Label "Boost installed root"
  if (-not $reportedRoot.Equals($installRoot, [StringComparison]::OrdinalIgnoreCase)) { throw "Native FEM provider receipt Boost install root is not the immutable pinned directory" }
  $includeRoot = Assert-FullmagNativeFemRegularDirectory -Path (Join-Path $installRoot "include") -Root $installRoot -Label "Boost include root"
  if (-not ([IO.Path]::GetFullPath([string]$boostReceipt.include_root)).Equals($includeRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Native FEM provider receipt Boost include root is not canonical"
  }
  $tree = @($boostReceipt.include_tree)
  if (-not $tree.Count) { throw "Native FEM provider receipt Boost include tree is empty" }
  $archiveTree = @(Get-FullmagNativeFemBoostArchiveInventory -ArchivePath $archive -Requirement $Requirement -ProviderRoot $ProviderRoot)
  $actual = @(Assert-FullmagNativeFemBoostTree -Root $installRoot -ExpectedFiles $tree -Requirement $Requirement)
  $actualMap = @{}
  foreach ($record in $actual) { $actualMap[([string]$record.path).ToLowerInvariant()] = $record }
  $archiveMap = @{}
  foreach ($record in $archiveTree) { $archiveMap[([string]$record.path).ToLowerInvariant()] = $record }
  $receiptMap = @{}
  foreach ($record in $tree) { $receiptMap[([string]$record.path).ToLowerInvariant()] = $record }
  if ($archiveMap.Count -ne $receiptMap.Count) {
    throw "Native FEM provider receipt Boost tree differs from the verified archive inventory"
  }
  foreach ($key in $archiveMap.Keys) {
    if (-not $receiptMap.ContainsKey($key) -or
        [int64]$receiptMap[$key].size_bytes -ne [int64]$archiveMap[$key].size_bytes -or
        [string]$receiptMap[$key].sha256 -ne [string]$archiveMap[$key].sha256) {
      throw "Native FEM provider receipt Boost tree is not bound to the verified archive bytes: $($archiveMap[$key].path)"
    }
  }
  $requiredHeaders = @($Requirement.required_headers | ForEach-Object { [string]$_ })
  if ((@($boostReceipt.required_headers | ForEach-Object { [string]$_ }) -join "|") -ne ($requiredHeaders -join "|")) {
    throw "Native FEM provider receipt Boost required headers do not match the committed two-header contract"
  }
  $headerFields = @("installed_header", "installed_rational_header")
  $hashFields = @("installed_header_sha256", "installed_rational_header_sha256")
  for ($i = 0; $i -lt $requiredHeaders.Count; $i++) {
    $relative = ("include/" + $requiredHeaders[$i]).ToLowerInvariant()
    if (-not $actualMap.ContainsKey($relative)) { throw "Native FEM provider receipt Boost tree misses $($requiredHeaders[$i])" }
    $expectedPath = Join-Path $installRoot ($relative.Replace('/', '\'))
    if (-not ([IO.Path]::GetFullPath([string]$boostReceipt.($headerFields[$i]))).Equals($expectedPath, [StringComparison]::OrdinalIgnoreCase) -or
        [string]$boostReceipt.($hashFields[$i]) -ne [string]$actualMap[$relative].sha256) {
      throw "Native FEM provider receipt Boost header metadata is not bound to the exact installed tree: $($requiredHeaders[$i])"
    }
  }
  $licenseRelative = ("share/licenses/boost/" + [string]$Requirement.license_file).ToLowerInvariant()
  $licensePath = Assert-FullmagNativeFemRegularFile -Path ([string]$boostReceipt.license) -Root $installRoot -Label "Boost license"
  if (-not ([IO.Path]::GetFullPath($licensePath)).Equals(([IO.Path]::GetFullPath((Join-Path $installRoot ($licenseRelative.Replace('/', '\'))))), [StringComparison]::OrdinalIgnoreCase) -or
      [string]$boostReceipt.license_sha256 -ne [string]$actualMap[$licenseRelative].sha256) {
    throw "Native FEM provider receipt Boost license metadata is not bound to the exact installed tree"
  }
  return $boostReceipt
}

function Test-FullmagNativeFemBoostReceipt {
  param(
    [Parameter(Mandatory=$true)][object]$Receipt,
    [Parameter(Mandatory=$true)][object]$Requirement,
    [Parameter(Mandatory=$true)][string]$ProviderRoot
  )
  try {
    $null = Assert-FullmagNativeFemBoostReceipt -Receipt $Receipt -Requirement $Requirement -ProviderRoot $ProviderRoot
    return $true
  }
  catch {
    return $false
  }
}

function New-FullmagNativeFemBoostReceipt {
  param(
    [Parameter(Mandatory=$true)][string]$ArchivePath,
    [Parameter(Mandatory=$true)][string]$InstallRoot,
    [Parameter(Mandatory=$true)][object[]]$PublishedTree,
    [Parameter(Mandatory=$true)][object]$Requirement
  )
  $publishedMap = @{}
  foreach ($record in @($PublishedTree)) {
    $publishedMap[([string]$record.path).ToLowerInvariant()] = $record
  }
  $requiredHeaders = @($Requirement.required_headers | ForEach-Object { [string]$_ })
  $headerPaths = @()
  $headerHashes = @()
  foreach ($header in $requiredHeaders) {
    $relative = ("include/" + $header).ToLowerInvariant()
    if (-not $publishedMap.ContainsKey($relative)) {
      throw "Published Boost tree is missing required header: $header"
    }
    $headerPath = Join-Path $InstallRoot ($relative.Replace('/', '\'))
    $headerPaths += $headerPath
    $headerHashes += [string]$publishedMap[$relative].sha256
  }
  $licenseRelative = ("share/licenses/boost/" + [string]$Requirement.license_file).ToLowerInvariant()
  if (-not $publishedMap.ContainsKey($licenseRelative)) {
    throw "Published Boost tree is missing its pinned license"
  }
  $licensePath = Join-Path $InstallRoot ($licenseRelative.Replace('/', '\'))
  return [pscustomobject]@{
    name = "boost_headers"
    kind = [string]$Requirement.kind
    version = [string]$Requirement.version
    url = [string]$Requirement.url
    archive = $ArchivePath
    archive_name = [string]$Requirement.archive
    archive_sha256 = ([string]$Requirement.archive_sha256).ToLowerInvariant()
    install_root = $InstallRoot
    include_root = Join-Path $InstallRoot "include"
    include_tree = @($PublishedTree)
    required_headers = $requiredHeaders
    installed_header = $headerPaths[0]
    installed_header_sha256 = $headerHashes[0]
    installed_rational_header = $headerPaths[1]
    installed_rational_header_sha256 = $headerHashes[1]
    license = $licensePath
    license_sha256 = [string]$publishedMap[$licenseRelative].sha256
  }
}

function Install-FullmagNativeFemBoostHeaders {
  param(
    [Parameter(Mandatory=$true)][object]$Plan,
    [Parameter(Mandatory=$true)][object]$Requirement,
    [Parameter(Mandatory=$true)][object]$Layout
  )
  Write-Host "[native-fem] Boost archive download and verification starting"
  $archivePath = Get-FullmagPinnedDownload -Url ([string]$Requirement.url) `
    -Path (Join-Path $Plan.root ("downloads\" + [string]$Requirement.archive)) `
    -Sha256 ([string]$Requirement.archive_sha256)
  $archivePath = Assert-FullmagNativeFemRegularFile -Path $archivePath -Root $Plan.root -Label "Boost archive"
  Write-Host "[native-fem] Boost archive validation starting"
  $installRoot = Get-FullmagNativeFemBoostInstallRoot -ProviderRoot $Plan.root -Requirement $Requirement
  $null = Assert-FullmagNativeFemBoostPathBudget -Path $installRoot -Label "Boost immutable install root"
  $archiveTree = @(Get-FullmagNativeFemBoostArchiveInventory `
    -ArchivePath $archivePath -Requirement $Requirement -ProviderRoot $Plan.root)
  Write-Host "[native-fem] Boost archive validation complete"
  if (Test-Path -LiteralPath $installRoot) {
    $receiptPath = Join-Path $Plan.root "provider-receipt.json"
    if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) {
      $recoveredTree = @(Assert-FullmagNativeFemBoostTree `
        -Root $installRoot -ExpectedFiles $archiveTree -Requirement $Requirement)
      $recovered = New-FullmagNativeFemBoostReceipt `
        -ArchivePath $archivePath -InstallRoot $installRoot `
        -PublishedTree $recoveredTree -Requirement $Requirement
      $null = Assert-FullmagNativeFemBoostReceipt `
        -Receipt $recovered -Requirement $Requirement -ProviderRoot $Plan.root
      return $recovered
    }
    try {
      $existingReceipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
      throw "Existing native FEM provider receipt is invalid; refusing to merge Boost files: $receiptPath ($($_.Exception.Message))"
    }
    $null = Assert-FullmagNativeFemBoostReceipt -Receipt $existingReceipt -Requirement $Requirement -ProviderRoot $Plan.root
    return $existingReceipt.boost
  }

  # Only the selected boost/** headers and the pinned license are copied.  The
  # archive is never expanded wholesale; every selected entry is size-, path-,
  # and reparse-checked before publication.
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $stagingParent = Join-Path $Plan.root "staging"
  Assert-FullmagNativeFemProviderTree -Layout $Layout -Path $stagingParent
  New-Item -ItemType Directory -Force -Path $stagingParent | Out-Null
  Assert-FullmagNativeFemProviderTree -Layout $Layout -Path $stagingParent
  $stageRoot = Join-Path $stagingParent ("s-" + ([Guid]::NewGuid().ToString("N").Substring(0, 16)))
  if (Test-Path -LiteralPath $stageRoot) {
    throw "Fresh Boost staging identifier unexpectedly exists: $stageRoot"
  }
  $null = Assert-FullmagNativeFemBoostPathBudget -Path $stageRoot -Label "Boost staging root"
  New-Item -ItemType Directory -Path $stageRoot | Out-Null
  Assert-FullmagNativeFemProviderTree -Layout $Layout -Path $stageRoot
  $expectedFiles = [Collections.Generic.List[object]]::new()
  $seenEntries = @{}
  $selectedBytes = [int64]0
  try {
    $zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
      $rootPrefix = [string]$Requirement.root_directory + "/"
      foreach ($entry in $zip.Entries) {
        $entryName = [string]$entry.FullName
        if ([string]::IsNullOrWhiteSpace($entryName) -or
            -not $entryName.StartsWith($rootPrefix, [StringComparison]::Ordinal)) { continue }
        if ($entryName.EndsWith("/", [StringComparison]::Ordinal)) { continue }
        $relative = $entryName.Substring($rootPrefix.Length)
        if ($relative -match '(^|/)\.\.?(/|$)' -or $relative.StartsWith("/", [StringComparison]::Ordinal) -or $relative.Contains('\')) {
          throw "Pinned Boost archive contains an unsafe selected path: $entryName"
        }
        if ($relative -eq [string]$Requirement.license_file) {
          $destinationRelative = "share/licenses/boost/" + [string]$Requirement.license_file
        }
        elseif ($relative.StartsWith("boost/", [StringComparison]::Ordinal)) {
          $destinationRelative = "include/" + $relative
        }
        else { continue }
        if ($entry.Length -lt 0 -or [int64]$entry.Length -gt [int64]$Requirement.max_selected_file_bytes) {
          throw "Pinned Boost archive selected file exceeds its per-file extraction bound: $entryName"
        }
        $selectedBytes += [int64]$entry.Length
        if ($selectedBytes -gt [int64]$Requirement.max_selected_uncompressed_bytes) {
          throw "Pinned Boost archive selected files exceed their total extraction bound"
        }
        if ($expectedFiles.Count -ge [int64]$Requirement.max_selected_files) {
          throw "Pinned Boost archive selected file count exceeds its extraction bound"
        }
        if ($destinationRelative -notmatch '^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)+$' -or
            $destinationRelative -match '(^|/)\.\.?(/|$)') {
          throw "Pinned Boost archive selected path is unsafe: $entryName"
        }
        $key = $destinationRelative.ToLowerInvariant()
        if ($seenEntries.ContainsKey($key)) { throw "Pinned Boost archive contains duplicate selected path: $entryName" }
        $seenEntries[$key] = $true
        $destination = Assert-FullmagNativeFemBoostPathBudget `
          -Path (Join-Path $stageRoot ($destinationRelative.Replace('/', '\'))) `
          -Label "Boost selected staging destination" -FileDestination
        $destinationParent = Split-Path -Parent $destination
        New-Item -ItemType Directory -Force -Path $destinationParent | Out-Null
        if (Test-Path -LiteralPath $destination) { throw "Fresh Boost staging path unexpectedly exists: $destination" }
        $entryStream = $null
        $output = $null
        try {
          $entryStream = $entry.Open()
          $output = [IO.File]::Open($destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
          $entryStream.CopyTo($output)
        }
        finally {
          if ($null -ne $output) { $output.Dispose() }
          if ($null -ne $entryStream) { $entryStream.Dispose() }
        }
        $expectedFiles.Add([pscustomobject]@{
          path = $destinationRelative
          size_bytes = [int64]$entry.Length
          sha256 = Get-FullmagNativeFemLiteralFileSha256 -Path $destination
        }) | Out-Null
      }
    }
    finally {
      $zip.Dispose()
    }
    if ($expectedFiles.Count -ne $archiveTree.Count) {
      throw "Boost selective staging does not match the verified archive inventory"
    }
    $actualStageTree = @(Assert-FullmagNativeFemBoostTree -Root $stageRoot -ExpectedFiles $archiveTree -Requirement $Requirement)
    if ($actualStageTree.Count -ne $archiveTree.Count) { throw "Boost selective staging inventory is not exact" }

    foreach ($expected in @($archiveTree)) {
      $publishedPath = Join-Path $installRoot (([string]$expected.path).Replace('/', '\'))
      $null = Assert-FullmagNativeFemBoostPathBudget `
        -Path $publishedPath `
        -Label "Boost published destination" -FileDestination
    }
    Write-Host "[native-fem] verified Boost headers publication starting"
    $installParent = Split-Path -Parent $installRoot
    Assert-FullmagNativeFemProviderTree -Layout $Layout -Path $installParent
    New-Item -ItemType Directory -Force -Path $installParent | Out-Null
    Assert-FullmagNativeFemProviderTree -Layout $Layout -Path $installParent
    if (Test-Path -LiteralPath $installRoot) {
      throw "Pinned Boost immutable install root appeared during staging; refusing merge: $installRoot"
    }
    Move-Item -LiteralPath $stageRoot -Destination $installRoot
    Assert-FullmagNativeFemProviderTree -Layout $Layout -Path $installRoot
    $publishedTree = @(Assert-FullmagNativeFemBoostTree -Root $installRoot -ExpectedFiles $archiveTree -Requirement $Requirement)
    $boostReceipt = New-FullmagNativeFemBoostReceipt `
      -ArchivePath $archivePath -InstallRoot $installRoot `
      -PublishedTree $publishedTree -Requirement $Requirement
    $null = Assert-FullmagNativeFemBoostReceipt `
      -Receipt $boostReceipt -Requirement $Requirement -ProviderRoot $Plan.root
    Write-Host "[native-fem] verified Boost headers publication complete"
    return $boostReceipt
  }
  catch {
    throw
  }
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

function Get-FullmagNativeFemToolCachePath {
  param(
    [Parameter(Mandatory=$true)][object]$Plan,
    [Parameter(Mandatory=$true)][string]$ToolName
  )
  if ($ToolName -notmatch '^[A-Za-z0-9._-]+$') {
    throw "Native FEM tool cache name is unsafe: $ToolName"
  }
  $cacheRoot = Join-Path ([string]$Plan.root) "tool-cache"
  return [IO.Path]::GetFullPath((Join-Path $cacheRoot ($ToolName + ".json")))
}

function Get-FullmagNativeFemToolRequiredRecords {
  param(
    [Parameter(Mandatory=$true)][object[]]$Inventory,
    [Parameter(Mandatory=$false)][object[]]$RequiredRelativePaths = @(),
    [Parameter(Mandatory=$false)][string]$RequiredLeafName = ""
  )
  $required = [Collections.Generic.List[object]]::new()
  $seen = @{}
  foreach ($relativePath in @($RequiredRelativePaths)) {
    $relative = ([string]$relativePath).Replace('\', '/')
    if ($relative -notmatch '^[^/\\:*?"<>|]+(?:/[^/\\:*?"<>|]+)*$' -or
        $relative -match '(^|/)\.\.?(/|$)' -or
        $relative -match '[\x00-\x1F]') {
      throw "Native FEM tool cache required path is unsafe: $relative"
    }
    $matches = @($Inventory | Where-Object {
      [string]$_.path -ieq $relative
    })
    if ($matches.Count -ne 1) {
      throw "Native FEM tool cache required path is missing or duplicated: $relative"
    }
    if ($null -eq $matches[0].PSObject.Properties["size_bytes"] -or
        [int64]$matches[0].size_bytes -lt 0) {
      throw "Native FEM tool cache required path has invalid size metadata: $relative"
    }
    $key = $relative.ToLowerInvariant()
    $seen[$key] = $true
    $required.Add([pscustomobject]@{
      path = $relative
      size_bytes = [int64]$matches[0].size_bytes
      sha256 = ([string]$matches[0].sha256).ToLowerInvariant()
    }) | Out-Null
  }
  if (-not [string]::IsNullOrWhiteSpace($RequiredLeafName)) {
    if ($RequiredLeafName -notmatch '^[A-Za-z0-9_.-]+$') {
      throw "Native FEM tool cache required executable name is unsafe: $RequiredLeafName"
    }
    $matches = @($Inventory | Where-Object {
      [IO.Path]::GetFileName(([string]$_.path).Replace('/', '\')) -ieq $RequiredLeafName
    })
    if ($matches.Count -ne 1) {
      throw "Native FEM tool cache required executable is missing or duplicated: $RequiredLeafName"
    }
    if ($null -eq $matches[0].PSObject.Properties["size_bytes"] -or
        [int64]$matches[0].size_bytes -lt 0) {
      throw "Native FEM tool cache required executable has invalid size metadata: $RequiredLeafName"
    }
    $relative = ([string]$matches[0].path).Replace('\', '/')
    $key = $relative.ToLowerInvariant()
    if ($seen.ContainsKey($key)) { throw "Native FEM tool cache required files are duplicated: $relative" }
    $required.Add([pscustomobject]@{
      path = $relative
      size_bytes = [int64]$matches[0].size_bytes
      sha256 = ([string]$matches[0].sha256).ToLowerInvariant()
    }) | Out-Null
  }
  if ($required.Count -eq 0) { throw "Native FEM tool cache has no required executable or file" }
  return @($required)
}

function Assert-FullmagNativeFemToolInventory {
  param(
    [Parameter(Mandatory=$true)][string]$Root,
    [Parameter(Mandatory=$true)][object[]]$ExpectedInventory,
    [Parameter(Mandatory=$true)][string]$Label
  )
  $actual = @(Get-FullmagNativeFemTreeInventory -Root $Root -Label $Label)
  $expectedMap = @{}
  foreach ($expected in @($ExpectedInventory)) {
    $relative = ([string]$expected.path).Replace('\', '/')
    if ($relative -notmatch '^[^/\\:*?"<>|]+(?:/[^/\\:*?"<>|]+)*$' -or
        $relative -match '(^|/)\.\.?(/|$)' -or
        $relative -match '[\x00-\x1F]' -or
        [string]$expected.sha256 -notmatch '^[0-9a-fA-F]{64}$' -or
        $null -eq $expected.PSObject.Properties["size_bytes"] -or
        [int64]$expected.size_bytes -lt 0) {
      throw "$Label cache inventory contains an unsafe or invalid file record: $relative"
    }
    $key = $relative.ToLowerInvariant()
    if ($expectedMap.ContainsKey($key)) { throw "$Label cache inventory contains duplicate file records: $relative" }
    $expectedMap[$key] = [pscustomobject]@{
      path = $relative
      size_bytes = [int64]$expected.size_bytes
      sha256 = ([string]$expected.sha256).ToLowerInvariant()
    }
  }
  $actualMap = @{}
  foreach ($record in @($actual)) {
    $relative = ([string]$record.path).Replace('\', '/')
    $key = $relative.ToLowerInvariant()
    if ($actualMap.ContainsKey($key)) { throw "$Label contains duplicate case-insensitive file paths: $relative" }
    if (-not $expectedMap.ContainsKey($key)) { throw "$Label contains an unadmitted file: $relative" }
    if ([int64]$record.size_bytes -ne [int64]$expectedMap[$key].size_bytes -or
        ([string]$record.sha256).ToLowerInvariant() -ne [string]$expectedMap[$key].sha256) {
      throw "$Label differs from its immutable cache inventory: $relative"
    }
    $actualMap[$key] = $record
  }
  if ($actualMap.Count -ne $expectedMap.Count) {
    throw "$Label does not exactly match its immutable cache inventory"
  }
  return @($actual)
}

function Write-FullmagNativeFemToolCache {
  param(
    [Parameter(Mandatory=$true)][object]$Plan,
    [Parameter(Mandatory=$true)][string]$ToolName,
    [Parameter(Mandatory=$true)][string]$ArchivePath,
    [Parameter(Mandatory=$true)][string]$ArchiveSha256,
    [Parameter(Mandatory=$true)][string]$Root,
    [Parameter(Mandatory=$true)][object[]]$Inventory,
    [Parameter(Mandatory=$true)][object[]]$RequiredFiles,
    [Parameter(Mandatory=$false)][string]$RecoveredFrom = ""
  )
  $cachePath = Get-FullmagNativeFemToolCachePath -Plan $Plan -ToolName $ToolName
  $cacheRoot = Split-Path -Parent $cachePath
  if (Test-Path -LiteralPath $cachePath) {
    $null = Assert-FullmagNativeFemRegularFile -Path $cachePath -Root $cacheRoot -Label "Native FEM tool cache receipt"
    throw "Native FEM tool cache already exists; refusing to overwrite it: $cachePath"
  }
  if (-not (Test-Path -LiteralPath $cacheRoot -PathType Container)) {
    New-Item -ItemType Directory -Path $cacheRoot | Out-Null
  }
  $null = Assert-FullmagNativeFemRegularDirectory -Path $cacheRoot -Root ([string]$Plan.root) -Label "Native FEM tool cache directory"
  $record = [pscustomobject]@{
    schema = "fullmag.windows.fem-tool-cache.v1"
    tool = $ToolName
    archive = [IO.Path]::GetFullPath($ArchivePath)
    archive_name = [IO.Path]::GetFileName($ArchivePath)
    archive_sha256 = $ArchiveSha256.ToLowerInvariant()
    root = [IO.Path]::GetFullPath($Root)
    inventory = @($Inventory)
    required_files = @($RequiredFiles)
    recovered_from = $RecoveredFrom
    created_at = [DateTime]::UtcNow.ToString("o")
  }
  $json = $record | ConvertTo-Json -Depth 12
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json)
  $stream = $null
  try {
    $stream = [IO.File]::Open($cachePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  }
  catch {
    throw "Native FEM tool cache could not be published without overwriting an existing record: $cachePath ($($_.Exception.Message))"
  }
  finally {
    if ($null -ne $stream) { $stream.Dispose() }
  }
  return $record
}

function Get-FullmagNativeFemToolCache {
  param(
    [Parameter(Mandatory=$true)][object]$Plan,
    [Parameter(Mandatory=$true)][string]$ToolName,
    [Parameter(Mandatory=$true)][string]$ArchivePath,
    [Parameter(Mandatory=$true)][string]$ArchiveSha256,
    [Parameter(Mandatory=$true)][string]$Root,
    [Parameter(Mandatory=$false)][object[]]$RequiredRelativePaths = @(),
    [Parameter(Mandatory=$false)][string]$RequiredLeafName = "",
    [Parameter(Mandatory=$false)][switch]$ArchiveAlreadyVerified
  )
  $cachePath = Get-FullmagNativeFemToolCachePath -Plan $Plan -ToolName $ToolName
  $rootFull = [IO.Path]::GetFullPath($Root)
  $archiveFull = [IO.Path]::GetFullPath($ArchivePath)
  $archiveHash = $ArchiveSha256.ToLowerInvariant()
  if ($archiveHash -notmatch '^[0-9a-f]{64}$') { throw "Native FEM tool cache archive SHA256 is invalid: $ToolName" }
  if (-not (Test-Path -LiteralPath $archiveFull -PathType Leaf)) {
    throw "Native FEM tool cache archive is missing: $archiveFull"
  }
  $planRoot = [IO.Path]::GetFullPath([string]$Plan.root).TrimEnd([char[]]'\\/')
  if (-not ($archiveFull.Equals($planRoot, [StringComparison]::OrdinalIgnoreCase) -or
      $archiveFull.StartsWith($planRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase))) {
    throw "Native FEM tool cache archive escapes the canonical provider root: $archiveFull"
  }
  $archiveFull = Assert-FullmagNativeFemRegularFile -Path $archiveFull -Root $planRoot -Label "Native FEM tool archive"
  if (-not $ArchiveAlreadyVerified -and (Get-FullmagNativeFemLiteralFileSha256 -Path $archiveFull) -ne $archiveHash) {
    throw "Native FEM tool cache archive does not match its pinned SHA256: $archiveFull"
  }
  if (-not ($rootFull.Equals($planRoot, [StringComparison]::OrdinalIgnoreCase) -or
      $rootFull.StartsWith($planRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase))) {
    throw "Native FEM tool tree escapes the canonical provider root: $rootFull"
  }
  $cache = $null
  if (Test-Path -LiteralPath $cachePath -PathType Leaf) {
    $null = Assert-FullmagNativeFemRegularFile -Path $cachePath -Root (Split-Path -Parent $cachePath) -Label "Native FEM tool cache receipt"
    try { $cache = Get-Content -LiteralPath $cachePath -Raw | ConvertFrom-Json -ErrorAction Stop }
    catch { throw "Native FEM tool cache receipt is invalid: $cachePath ($($_.Exception.Message))" }
    if ([string]$cache.schema -ne "fullmag.windows.fem-tool-cache.v1" -or
        [string]$cache.tool -ne $ToolName -or
        [string]$cache.archive_sha256 -ne $archiveHash -or
        [string]$cache.archive_name -ne [IO.Path]::GetFileName($archiveFull) -or
        -not ([IO.Path]::GetFullPath([string]$cache.archive)).Equals($archiveFull, [StringComparison]::OrdinalIgnoreCase) -or
        -not ([IO.Path]::GetFullPath([string]$cache.root)).Equals($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Native FEM tool cache receipt does not match the pinned archive or canonical root: $cachePath"
    }
    $expectedInventory = @($cache.inventory)
    if (-not $expectedInventory.Count) { throw "Native FEM tool cache inventory is empty: $cachePath" }
    $actual = @(Assert-FullmagNativeFemToolInventory -Root $rootFull -ExpectedInventory $expectedInventory -Label "$ToolName cached tool tree")
    $required = @(Get-FullmagNativeFemToolRequiredRecords -Inventory $actual -RequiredRelativePaths $RequiredRelativePaths -RequiredLeafName $RequiredLeafName)
    $cachedRequired = @(Get-FullmagNativeFemToolRequiredRecords -Inventory @($cache.required_files) -RequiredRelativePaths $RequiredRelativePaths -RequiredLeafName $RequiredLeafName)
    if ($required.Count -ne $cachedRequired.Count) { throw "Native FEM tool cache required-file inventory differs: $cachePath" }
    for ($i = 0; $i -lt $required.Count; $i++) {
      if ([string]$required[$i].path -ine [string]$cachedRequired[$i].path -or
          [int64]$required[$i].size_bytes -ne [int64]$cachedRequired[$i].size_bytes -or
          [string]$required[$i].sha256 -ne [string]$cachedRequired[$i].sha256) {
        throw "Native FEM tool cache required executable differs from its receipt: $ToolName"
      }
    }
    return $cache
  }
  if (-not (Test-Path -LiteralPath $rootFull)) { return $null }

  # A pre-existing tree without its immutable cache receipt may be reused only
  # through the completed provider receipt.  The receipt binds the required
  # executable/header hashes; the complete tree is then captured once without
  # overwriting any existing bytes.  Any mismatch remains fail-closed.
  $providerReceiptPath = Join-Path ([string]$Plan.root) "provider-receipt.json"
  if (-not (Test-Path -LiteralPath $providerReceiptPath -PathType Leaf)) {
    throw "Native FEM tool tree exists without an immutable cache receipt; refusing extraction or overwrite: $rootFull"
  }
  try { $providerReceipt = Get-Content -LiteralPath $providerReceiptPath -Raw | ConvertFrom-Json -ErrorAction Stop }
  catch { throw "Existing native FEM provider receipt is invalid while recovering tool cache: $providerReceiptPath ($($_.Exception.Message))" }
  if ([string]$providerReceipt.schema -ne "fullmag.windows.fem-providers.v1" -or
      $null -eq $providerReceipt.plan -or
      -not ([IO.Path]::GetFullPath([string]$providerReceipt.plan.root)).Equals([IO.Path]::GetFullPath([string]$Plan.root), [StringComparison]::OrdinalIgnoreCase)) {
    throw "Existing native FEM provider receipt cannot recover the cached tool tree: $providerReceiptPath"
  }
  $actual = @(Get-FullmagNativeFemTreeInventory -Root $rootFull -Label "$ToolName existing tool tree")
  $required = @(Get-FullmagNativeFemToolRequiredRecords -Inventory $actual -RequiredRelativePaths $RequiredRelativePaths -RequiredLeafName $RequiredLeafName)
  foreach ($requiredFile in $required) {
    $absolute = [IO.Path]::GetFullPath((Join-Path $rootFull ([string]$requiredFile.path).Replace('/', '\')))
    $matches = @($providerReceipt.tools | Where-Object {
      [IO.Path]::GetFullPath([string]$_.path).Equals($absolute, [StringComparison]::OrdinalIgnoreCase)
    })
    if ($matches.Count -ne 1 -or [string]$matches[0].sha256 -ne [string]$requiredFile.sha256) {
      throw "Existing native FEM provider receipt does not bind the required cached tool bytes: $absolute"
    }
  }
  return Write-FullmagNativeFemToolCache -Plan $Plan -ToolName $ToolName `
    -ArchivePath $archiveFull -ArchiveSha256 $archiveHash -Root $rootFull `
    -Inventory $actual -RequiredFiles $required -RecoveredFrom "provider-receipt"
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
  Write-Host "[native-fem] provider preparation starting"
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
  $boostRequirement = Get-FullmagNativeFemBoostRequirement -SourceRoot $SourceRoot
  $null = Assert-FullmagStoragePath -Layout $StorageLayout -Path $plan.root -Label "native FEM dependencies" -Parent ([string]$StorageLayout.build_root)
  Assert-FullmagNativeFemProviderTree -Layout $StorageLayout -Path $plan.root
  foreach ($relative in @("", "sources", "builds", "tools", "downloads", "installed")) {
    $destination = Join-Path $plan.root $relative
    Assert-FullmagNativeFemProviderTree -Layout $StorageLayout -Path $destination
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    Assert-FullmagNativeFemProviderTree -Layout $StorageLayout -Path $destination
  }
  # Boost is a header-only provider for exact integer/rational FEM paths.  Keep
  # the verified archive and installed headers under the selected FEM profile;
  # no global Boost discovery or system include path is accepted.
  $boostReceipt = Install-FullmagNativeFemBoostHeaders -Plan $plan -Requirement $boostRequirement -Layout $StorageLayout
  $ninjaArchiveSha256 = "07fc8261b42b20e71d1720b39068c2e14ffcee6396b76fb7a795fb460b78dc65"
  $ninjaZip = Get-FullmagPinnedDownload -Url "https://github.com/ninja-build/ninja/releases/download/v1.13.2/ninja-win.zip" `
    -Path (Join-Path $plan.root "downloads\ninja-1.13.2.zip") -Sha256 $ninjaArchiveSha256
  $ninjaRoot = Join-Path $plan.root "tools\ninja-1.13.2"
  $ninjaCache = Get-FullmagNativeFemToolCache -Plan $plan -ToolName "ninja-1.13.2" `
    -ArchivePath $ninjaZip -ArchiveSha256 $ninjaArchiveSha256 -Root $ninjaRoot `
    -RequiredRelativePaths @("ninja.exe") -ArchiveAlreadyVerified
  if ($null -eq $ninjaCache) {
    New-Item -ItemType Directory -Path $ninjaRoot | Out-Null
    Expand-Archive -LiteralPath $ninjaZip -DestinationPath $ninjaRoot
    Assert-FullmagNativeFemProviderTree -Layout $StorageLayout -Path $ninjaRoot
    $ninjaInventory = @(Get-FullmagNativeFemTreeInventory -Root $ninjaRoot -Label "Ninja extracted tree")
    $ninjaRequired = @(Get-FullmagNativeFemToolRequiredRecords -Inventory $ninjaInventory -RequiredRelativePaths @("ninja.exe"))
    $ninjaCache = Write-FullmagNativeFemToolCache -Plan $plan -ToolName "ninja-1.13.2" `
      -ArchivePath $ninjaZip -ArchiveSha256 $ninjaArchiveSha256 -Root $ninjaRoot `
      -Inventory $ninjaInventory -RequiredFiles $ninjaRequired
  }
  $ninja = Join-Path $ninjaRoot "ninja.exe"
  $env:Path = "$ninjaRoot;$env:Path"

  # Administrative extraction into task storage, not a global SDK installation.
  $mpiSdk = Join-Path $plan.root "tools\msmpi-10.1.1"
  $mpiArchiveSha256 = "6df47378c0acbb2b76989092165d7279ee096605fcaf7e455de733b2ffdf4bcc"
  $msi = Get-FullmagPinnedDownload -Url "https://github.com/microsoft/Microsoft-MPI/releases/download/v10.1.1/msmpisdk.msi" `
    -Path (Join-Path $plan.root "downloads\msmpisdk-10.1.1.msi") -Sha256 $mpiArchiveSha256
  $mpiCache = Get-FullmagNativeFemToolCache -Plan $plan -ToolName "msmpi-10.1.1" `
    -ArchivePath $msi -ArchiveSha256 $mpiArchiveSha256 -Root $mpiSdk `
    -RequiredRelativePaths @("PFiles\Microsoft SDKs\MPI\Include\mpi.h", "PFiles\Microsoft SDKs\MPI\Lib\x64\msmpi.lib") `
    -ArchiveAlreadyVerified
  if ($null -eq $mpiCache) {
    $process = Start-Process -FilePath "$env:SystemRoot\System32\msiexec.exe" `
      -ArgumentList @("/a", ('"'+$msi+'"'), "/qn", ('TARGETDIR="'+$mpiSdk+'"'), "/l*v", ('"'+(Join-Path $plan.root "msmpi-extract.log")+'"')) -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Microsoft MPI SDK extraction failed: $($process.ExitCode)" }
    Assert-FullmagNativeFemProviderTree -Layout $StorageLayout -Path $mpiSdk
    $mpiInventory = @(Get-FullmagNativeFemTreeInventory -Root $mpiSdk -Label "MSMPI extracted tree")
    $mpiRequired = @(Get-FullmagNativeFemToolRequiredRecords -Inventory $mpiInventory `
      -RequiredRelativePaths @("PFiles\Microsoft SDKs\MPI\Include\mpi.h", "PFiles\Microsoft SDKs\MPI\Lib\x64\msmpi.lib"))
    $mpiCache = Write-FullmagNativeFemToolCache -Plan $plan -ToolName "msmpi-10.1.1" `
      -ArchivePath $msi -ArchiveSha256 $mpiArchiveSha256 -Root $mpiSdk `
      -Inventory $mpiInventory -RequiredFiles $mpiRequired
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
  $zstdCache = Get-FullmagNativeFemToolCache -Plan $plan -ToolName ([string]$zstdRequirement.tool_directory) `
      -ArchivePath $zstdArchive -ArchiveSha256 ([string]$zstdRequirement.archive_sha256) -Root $zstdRoot `
      -RequiredLeafName ([string]$zstdRequirement.executable_name) -ArchiveAlreadyVerified
  if ($null -eq $zstdCache) {
    New-Item -ItemType Directory -Path $zstdRoot | Out-Null
    Expand-Archive -LiteralPath $zstdArchive -DestinationPath $zstdRoot
    Assert-FullmagNativeFemProviderTree -Layout $StorageLayout -Path $zstdRoot
    $zstdInventory = @(Get-FullmagNativeFemTreeInventory -Root $zstdRoot -Label "zstd extracted tree")
    $zstdRequired = @(Get-FullmagNativeFemToolRequiredRecords -Inventory $zstdInventory -RequiredLeafName ([string]$zstdRequirement.executable_name))
    $zstdCache = Write-FullmagNativeFemToolCache -Plan $plan -ToolName ([string]$zstdRequirement.tool_directory) `
      -ArchivePath $zstdArchive -ArchiveSha256 ([string]$zstdRequirement.archive_sha256) -Root $zstdRoot `
      -Inventory $zstdInventory -RequiredFiles $zstdRequired
  }
  Assert-FullmagNativeFemProviderTree -Layout $StorageLayout -Path $zstdRoot
  $zstdCandidates = @(Get-ChildItem -LiteralPath $zstdRoot -Filter ([string]$zstdRequirement.executable_name) -File -Recurse)
  if ($zstdCandidates.Count -ne 1) { throw "Pinned zstd archive must contain exactly one $($zstdRequirement.executable_name): $zstdRoot" }
  $zstd = $zstdCandidates[0].FullName

  # Use the pinned compiler even if an unrelated clang-cl is present on PATH.
  $llvmArchive = Get-FullmagPinnedDownload -Url "https://github.com/llvm/llvm-project/releases/download/llvmorg-23.1.3/clang%2Bllvm-23.1.3-x86_64-pc-windows-msvc.tar.zst" `
      -Path (Join-Path $plan.root "downloads\llvm-23.1.3.tar.zst") -Sha256 "7e69dc07a4536b79ff24a651a2611990bf8eaab17ea560f1092707c4f31ba01d"
  $llvmTar = Join-Path $plan.root "downloads\llvm-23.1.3.tar"
  $llvmRoot = Join-Path $plan.root "tools\llvm-23.1.3"
  $llvmArchiveSha256 = "7e69dc07a4536b79ff24a651a2611990bf8eaab17ea560f1092707c4f31ba01d"
  $llvmCache = Get-FullmagNativeFemToolCache -Plan $plan -ToolName "llvm-23.1.3" `
      -ArchivePath $llvmArchive -ArchiveSha256 $llvmArchiveSha256 -Root $llvmRoot `
      -RequiredRelativePaths @("bin\clang-cl.exe") -ArchiveAlreadyVerified
  if ($null -eq $llvmCache) {
    Invoke-FullmagProviderCommand $zstd @("-d", "--single-thread", "--memory=$([string]$zstdRequirement.decode_memory)", "--force", "-o", $llvmTar, $llvmArchive)
    if (-not (Test-Path -LiteralPath $llvmTar -PathType Leaf)) { throw "Pinned LLVM archive did not decode to a tar file: $llvmTar" }
    New-Item -ItemType Directory -Path $llvmRoot | Out-Null
    Invoke-FullmagProviderCommand "$env:SystemRoot\System32\tar.exe" @("-xf", $llvmTar, "--strip-components=1", "-C", $llvmRoot)
    Assert-FullmagNativeFemProviderTree -Layout $StorageLayout -Path $llvmRoot
    $llvmInventory = @(Get-FullmagNativeFemTreeInventory -Root $llvmRoot -Label "LLVM extracted tree")
    $llvmRequired = @(Get-FullmagNativeFemToolRequiredRecords -Inventory $llvmInventory -RequiredRelativePaths @("bin\clang-cl.exe"))
    $llvmCache = Write-FullmagNativeFemToolCache -Plan $plan -ToolName "llvm-23.1.3" `
      -ArchivePath $llvmArchive -ArchiveSha256 $llvmArchiveSha256 -Root $llvmRoot `
      -Inventory $llvmInventory -RequiredFiles $llvmRequired
  }
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
  $toolCacheInventory = @()
  foreach ($toolCache in @($ninjaCache, $mpiCache, $zstdCache, $llvmCache)) {
    $toolCachePath = Get-FullmagNativeFemToolCachePath -Plan $plan -ToolName ([string]$toolCache.tool)
    $null = Assert-FullmagNativeFemRegularFile -Path $toolCachePath -Root (Join-Path $plan.root "tool-cache") -Label "Native FEM tool cache receipt"
    $toolCacheInventory += [pscustomobject]@{
      tool = [string]$toolCache.tool
      path = $toolCachePath
      sha256 = Get-FullmagNativeFemLiteralFileSha256 -Path $toolCachePath
    }
  }
  $receipt = [pscustomobject]@{ schema="fullmag.windows.fem-providers.v1"; plan=$plan; mpi_include=$mpiInclude; mpi_library=$mpiLibrary; files=$inventory; licenses=$licenseInventory; tools=$toolInventory; tool_cache=$toolCacheInventory; zstd=$zstdTool; boost=$boostReceipt; clang_version=$compilerVersion; completed_at=[DateTime]::UtcNow.ToString("o") }
  $null = Assert-FullmagNativeFemBoostReceipt -Receipt $receipt -Requirement $boostRequirement -ProviderRoot $plan.root
  [IO.File]::WriteAllText((Join-Path $plan.root "provider-receipt.json"), ($receipt | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
  return $plan.prefix
}
