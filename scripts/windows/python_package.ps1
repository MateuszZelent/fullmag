function Stage-FullmagLockedPythonPackages {
  param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][string]$WheelPath,
    [Parameter(Mandatory = $true)][string]$SiteDirectory,
    [Parameter(Mandatory = $true)][string]$ProofDirectory,
    [string]$PythonCommand = "python",
    [string]$UvCommand = "uv",
    [int]$ExpectedPythonMinor = 0
  )
  $ErrorActionPreference = "Stop"
  $project = Join-Path $RepoRoot "packages\fullmag-py\pyproject.toml"
  $lock = Join-Path $RepoRoot "packages\fullmag-py\uv.lock"
  foreach ($path in @($project, $lock, $WheelPath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -eq 0) {
      throw "Python package input is missing or empty: $path"
    }
  }
  if (Test-Path -LiteralPath $ProofDirectory) { throw "Python package proof directory must be fresh: $ProofDirectory" }
  if (Test-Path -LiteralPath $SiteDirectory) {
    if (-not (Test-Path -LiteralPath $SiteDirectory -PathType Container) -or
        @(Get-ChildItem -LiteralPath $SiteDirectory -Force).Count -ne 0) {
      throw "Python package site directory must be empty: $SiteDirectory"
    }
  }
  $inputs = @($project, $lock, $WheelPath) | ForEach-Object {
    @{path=[System.IO.Path]::GetFullPath($_); sha256=(Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant()}
  }
  $assertInputs = {
    foreach ($entry in $inputs) {
      if ((Get-FileHash -LiteralPath $entry.path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256) {
        throw "Python package input changed during staging: $($entry.path)"
      }
    }
  }
  $hostJson = (& $PythonCommand -c "import json,sys,struct; print(json.dumps(dict(version=list(sys.version_info[:3]), implementation=sys.implementation.name, platform=sys.platform, bits=struct.calcsize('P')*8)))" | Out-String)
  if ($LASTEXITCODE -ne 0) { throw "Python package host inspection failed" }
  $hostInfo = $hostJson | ConvertFrom-Json
  if ($hostInfo.platform -ne "win32" -or $hostInfo.bits -ne 64 -or $hostInfo.implementation -ne "cpython" -or
      $hostInfo.version[0] -ne 3 -or $hostInfo.version[1] -lt 12) {
    throw "Python package staging requires native Windows x64 CPython 3.12 or newer"
  }
  if ($ExpectedPythonMinor -ne 0 -and $hostInfo.version[1] -ne $ExpectedPythonMinor) {
    throw "Python package host ABI does not match bundled CPython 3.$ExpectedPythonMinor"
  }
  New-Item -ItemType Directory -Path $ProofDirectory | Out-Null
  $requirements = Join-Path $ProofDirectory "requirements.txt"
  $wheelhouse = Join-Path $ProofDirectory "wheelhouse"
  New-Item -ItemType Directory -Path $wheelhouse | Out-Null
  & $UvCommand export --project (Split-Path -Parent $project) --locked --no-dev --all-extras --no-emit-project --output-file $requirements | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "Locked Python requirements export failed" }
  & $assertInputs
  if (-not (Test-Path -LiteralPath $requirements -PathType Leaf) -or (Get-Item -LiteralPath $requirements).Length -eq 0) {
    throw "Locked Python requirements export is missing or empty"
  }
  $requirementsHash = (Get-FileHash -LiteralPath $requirements -Algorithm SHA256).Hash.ToLowerInvariant()
  & $PythonCommand -m pip download --disable-pip-version-check --only-binary=:all: --require-hashes --dest $wheelhouse --requirement $requirements | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "Locked Windows Python wheel download failed" }
  & $assertInputs
  if ((Get-FileHash -LiteralPath $requirements -Algorithm SHA256).Hash.ToLowerInvariant() -ne $requirementsHash) {
    throw "Python requirements changed during wheel download"
  }
  $wheels = @(Get-ChildItem -LiteralPath $wheelhouse -File)
  if ($wheels.Count -eq 0 -or @($wheels | Where-Object { $_.Extension -ne '.whl' -or $_.Length -eq 0 }).Count -ne 0) {
    throw "Locked Python wheelhouse must contain only nonempty wheels"
  }
  $wheelInventory = @($wheels | Sort-Object Name | ForEach-Object {
    @{name=$_.Name; sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
  })
  & $PythonCommand -m pip --isolated install --disable-pip-version-check --no-index --find-links $wheelhouse --require-hashes --no-compile --target $SiteDirectory --requirement $requirements | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "Locked Python dependency installation failed" }
  & $assertInputs
  $projectRequirement = Join-Path $ProofDirectory "project-wheel.txt"
  $wheelUri = ([Uri][System.IO.Path]::GetFullPath($WheelPath)).AbsoluteUri
  [System.IO.File]::WriteAllText($projectRequirement, ($wheelUri + " --hash=sha256:" + $inputs[2].sha256 + "`n"), [System.Text.UTF8Encoding]::new($false))
  & $PythonCommand -m pip --isolated install --disable-pip-version-check --no-index --no-deps --require-hashes --no-compile --target $SiteDirectory --requirement $projectRequirement | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "Fullmag wheel installation failed" }
  & $assertInputs
  if ((Get-FileHash -LiteralPath $requirements -Algorithm SHA256).Hash.ToLowerInvariant() -ne $requirementsHash) {
    throw "Python requirements changed during installation"
  }
  foreach ($entry in $wheelInventory) {
    if ((Get-FileHash -LiteralPath (Join-Path $wheelhouse $entry.name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256) {
      throw "Python wheel changed during installation: $($entry.name)"
    }
  }
  return @{schema_version=1; scope="locked-windows-python-packages"; host=$hostInfo;
    inputs=@($inputs); requirements_sha256=$requirementsHash; wheels=@($wheelInventory);
    extras="all"; interpreter="external"; qualification="not_verified"}
}
