$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$DockerContext = (Join-Path $RepoRoot "docker\windows-msi")
$ImageName = if ($env:FULLMAG_WINDOWS_MSI_IMAGE) { $env:FULLMAG_WINDOWS_MSI_IMAGE } else { "fullmag/windows-msi-build:ltsc2022" }
$ContainerName = "fullmag-windows-msi-build-" + [Guid]::NewGuid().ToString("N")
$WorkspacePath = "C:\workspace\fullmag"
$SkipImageBuild = $env:FULLMAG_WINDOWS_MSI_SKIP_IMAGE_BUILD -eq "1"

function Require-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $Name"
  }
}

Require-Command docker

if ($SkipImageBuild) {
  Write-Host "Skipping Windows MSI container image build because FULLMAG_WINDOWS_MSI_SKIP_IMAGE_BUILD=1"
} else {
  Write-Host "Building Windows MSI container image: $ImageName"
  docker build -t $ImageName -f (Join-Path $DockerContext "Dockerfile") $DockerContext
  if ($LASTEXITCODE -ne 0) {
    throw "docker build failed with exit code $LASTEXITCODE"
  }
}

Write-Host "Running Windows MSI build inside container"
docker run --name $ContainerName --rm `
  -v "${RepoRoot}:${WorkspacePath}" `
  $ImageName `
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "${WorkspacePath}\scripts\windows\build_windows_msi.ps1"

if ($LASTEXITCODE -ne 0) {
  throw "docker run failed with exit code $LASTEXITCODE"
}

Write-Host "Artifact paths are printed by the storage-validated MSI packager."
