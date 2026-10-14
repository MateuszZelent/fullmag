"""Exercise the native FEM provider bootstrap with mocked external tools.

The regression runs only the PowerShell orchestration.  It does not download,
configure, compile, or install any provider, CUDA toolkit, MPI SDK, or clang.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import textwrap

import pytest


ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / "scripts/windows/native_fem_dependencies.ps1"
MFEM_CUDA_OPTIONS_HOOK = ROOT / "scripts/windows/native_fem/mfem_windows_cuda_options.cmake"
HYPRE_CMAKE_COMPAT_HOOK = ROOT / "scripts/windows/native_fem/hypre_cmake_compat.cmake"
REQUIREMENTS = ROOT / "windows_build_requirements.json"
RUN_NATIVE_WINDOWS_POWERSHELL = os.environ.get("FULLMAG_RUN_NATIVE_WINDOWS_POWERSHELL") == "1"
PS = shutil.which("powershell.exe") or shutil.which("pwsh")
if RUN_NATIVE_WINDOWS_POWERSHELL and not PS:
    PS = os.environ.get("FULLMAG_WINDOWS_POWERSHELL")
NATIVE_WINDOWS_SKIP = pytest.mark.skipif(
    not PS or (os.name != "nt" and not RUN_NATIVE_WINDOWS_POWERSHELL),
    reason="native Windows PowerShell required",
)


DRIVER = r'''
param($Module, $RepoRoot, $BuildRoot, $SourceRoot)
$ErrorActionPreference = "Stop"
. $Module
# PowerShell 5.1 auto-loads Get-FileHash as a module function on first use;
# resolve it once so the fixture's same-session mock can override it.
$null = Get-Command Get-FileHash

$script:BuildRoot = [IO.Path]::GetFullPath($BuildRoot)
$script:Scans = [Collections.Generic.List[object]]::new()
$script:Commands = [Collections.Generic.List[object]]::new()
$script:CeedCache = @{}
$script:FakeClangName = "clang-cl.exe"
$env:FULLMAG_STORAGE_MANAGED_ENTRY = "1"
$env:FULLMAG_CMAKE = "mock-cmake"
$env:CUDACXX = "mock-cuda"

function Resolve-FullmagStorageLayout {
  param([string]$RepoRoot, [string]$Profile)
  [pscustomobject]@{ build_root = $script:BuildRoot; profile = $Profile }
}

function Assert-FullmagStoragePath {
  param([object]$Layout, [string]$Path, [string]$Label, [string]$Parent)
  return $Path
}

function Assert-FullmagNativeFemProviderTree {
  param([object]$Layout, [string]$Path)
  $hasMaterialized = $false
  if (Microsoft.PowerShell.Management\Test-Path -LiteralPath $Path) {
    $hasMaterialized = @(
      Microsoft.PowerShell.Management\Get-ChildItem -LiteralPath $Path -Force -Recurse -File -ErrorAction SilentlyContinue
    ).Count -gt 0
  }
  $script:Scans.Add([pscustomobject]@{
    path = $Path
    has_materialized = $hasMaterialized
  }) | Out-Null
}

function Get-FullmagPinnedDownload {
  param([string]$Url, [string]$Path, [string]$Sha256)
  $parent = Split-Path -Parent $Path
  if (-not (Microsoft.PowerShell.Management\Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  [IO.File]::WriteAllText($Path, "mock pinned archive")
  return $Path
}

function Get-FullmagPinnedProviderSource {
  param([object]$Provider, [string]$SourcesRoot)
  $source = Microsoft.PowerShell.Management\Join-Path $SourcesRoot $Provider.name
  New-Item -ItemType Directory -Force -Path $source | Out-Null
  [IO.File]::WriteAllText(
    (Microsoft.PowerShell.Management\Join-Path $source "mock-provider-source.txt"),
    $Provider.name
  )
  $licenseContents = @{
    hypre = @{
      "COPYRIGHT" = "HYPRE copyright bytes"
      "LICENSE-APACHE" = "HYPRE Apache license bytes"
      "LICENSE-MIT" = "HYPRE MIT license bytes"
      "NOTICE" = "HYPRE notice bytes"
    }
    mfem = @{
      "LICENSE" = "MFEM license bytes"
      "NOTICE" = "MFEM notice bytes"
    }
    libceed = @{
      "LICENSE" = "libCEED license bytes"
      "NOTICE" = "libCEED notice bytes"
    }
  }
  foreach ($license in $licenseContents[$Provider.name].GetEnumerator()) {
    [IO.File]::WriteAllBytes(
      (Microsoft.PowerShell.Management\Join-Path $source $license.Key),
      (New-Object System.Text.UTF8Encoding($false)).GetBytes([string]$license.Value)
    )
  }
  return $source
}

function Expand-Archive {
  param([string]$LiteralPath, [string]$DestinationPath, [switch]$Force)
  New-Item -ItemType Directory -Force -Path $DestinationPath | Out-Null
  if ($LiteralPath -match "zstd-v1\.5\.7-win64\.zip$") {
    $zstdRoot = Microsoft.PowerShell.Management\Join-Path $DestinationPath "zstd-v1.5.7-win64"
    New-Item -ItemType Directory -Force -Path $zstdRoot | Out-Null
    [IO.File]::WriteAllText(
      (Microsoft.PowerShell.Management\Join-Path $zstdRoot "zstd.exe"),
      "mock zstd"
    )
    return
  }
  [IO.File]::WriteAllText(
    (Microsoft.PowerShell.Management\Join-Path $DestinationPath "ninja.exe"),
    "mock ninja"
  )
}

function Start-Process {
  param([string]$FilePath, [object[]]$ArgumentList, [switch]$Wait, [switch]$PassThru)
  $targetToken = @($ArgumentList | Where-Object { ([string]$_).StartsWith('TARGETDIR="') })[0]
  if (-not $targetToken) { throw "mock MSI invocation omitted TARGETDIR" }
  $target = ([string]$targetToken).Substring('TARGETDIR="'.Length).TrimEnd('"')
  $include = Microsoft.PowerShell.Management\Join-Path $target "PFiles\Microsoft SDKs\MPI\Include"
  $library = Microsoft.PowerShell.Management\Join-Path $target "PFiles\Microsoft SDKs\MPI\Lib\x64"
  New-Item -ItemType Directory -Force -Path $include, $library | Out-Null
  [IO.File]::WriteAllText((Microsoft.PowerShell.Management\Join-Path $include "mpi.h"), "mock mpi")
  [IO.File]::WriteAllText((Microsoft.PowerShell.Management\Join-Path $library "msmpi.lib"), "mock msmpi")
  [pscustomobject]@{ ExitCode = 0 }
}

function Join-Path {
  param([string]$Path, [string]$ChildPath)
  if ($ChildPath -eq "bin\clang-cl.exe") { return $script:FakeClangName }
  Microsoft.PowerShell.Management\Join-Path -Path $Path -ChildPath $ChildPath
}

function Test-Path {
  param([object]$LiteralPath, [object]$Path, [string]$PathType)
  $candidate = if ($PSBoundParameters.ContainsKey("LiteralPath")) { $LiteralPath } else { $Path }
  if ([string]$candidate -eq "clang-cl.exe") { return $true }
  $delegate = @{}
  if ($PSBoundParameters.ContainsKey("LiteralPath")) { $delegate.LiteralPath = $LiteralPath }
  else { $delegate.Path = $Path }
  if ($PSBoundParameters.ContainsKey("PathType")) { $delegate.PathType = $PathType }
  Microsoft.PowerShell.Management\Test-Path @delegate
}

function Get-FileHash {
  param([object]$LiteralPath, [object]$Path, [string]$Algorithm)
  $candidate = if ($PSBoundParameters.ContainsKey("LiteralPath")) { $LiteralPath } else { $Path }
  if ([string]$candidate -eq "clang-cl.exe") {
    return [pscustomobject]@{ Path = "clang-cl.exe"; Hash = ("0" * 64) }
  }
  $delegate = @{ Algorithm = $Algorithm }
  if ($PSBoundParameters.ContainsKey("LiteralPath")) { $delegate.LiteralPath = $LiteralPath }
  else { $delegate.Path = $Path }
  Microsoft.PowerShell.Utility\Get-FileHash @delegate
}

function clang-cl.exe {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$ArgumentList)
  $global:LASTEXITCODE = 0
  "clang version 23.1.3 mock"
}

function Invoke-FullmagProviderCommand {
  param([string]$Command, [string[]]$Arguments, [string]$WorkingDirectory)
  $global:LASTEXITCODE = 0
  if ($Command -eq "mock-cmake") {
    if ($Arguments -contains "--build") { return }
    if ($Arguments -contains "--install") {
      $buildIndex = -1
      for ($i = 0; $i -lt $Arguments.Count - 1; $i++) {
        if ($Arguments[$i] -eq "--install") { $buildIndex = $i; break }
      }
      $build = [string]$Arguments[$buildIndex + 1]
      New-Item -ItemType Directory -Force -Path $script:InstallPrefix | Out-Null
      $provider = Split-Path -Leaf $build
      [IO.File]::WriteAllText(
        (Microsoft.PowerShell.Management\Join-Path $script:InstallPrefix "mock-$provider.txt"),
        "mock install"
      )
      return
    }

    $build = $null
    for ($i = 0; $i -lt $Arguments.Count - 1; $i++) {
      if ($Arguments[$i] -eq "-B") { $build = [string]$Arguments[$i + 1]; break }
    }
    if (-not $build) { throw "mock CMake configure omitted -B" }
    New-Item -ItemType Directory -Force -Path $build | Out-Null
    $prefixArg = @($Arguments | Where-Object { ([string]$_).StartsWith("-DCMAKE_INSTALL_PREFIX=") })[0]
    if ($prefixArg) {
      $script:InstallPrefix = ([string]$prefixArg).Substring("-DCMAKE_INSTALL_PREFIX=".Length)
    }
    $provider = Split-Path -Leaf $build
    if ($provider -eq "libceed") {
      $requestedArg = @($Arguments | Where-Object { ([string]$_).StartsWith("-DCEED_CUDA_ARCHITECTURES=") })[0]
      $requested = if ($requestedArg) { ([string]$requestedArg).Substring("-DCEED_CUDA_ARCHITECTURES=".Length) } else { $null }
      $cacheBefore = if ($script:CeedCache.ContainsKey($build)) { $script:CeedCache[$build] } else { $null }
      $effective = if ($requested) { $requested } else { $cacheBefore }
      $script:CeedCache[$build] = $effective
      $script:Commands.Add([pscustomobject]@{
        kind = "configure"
        provider = $provider
        build = $build
        arguments = @($Arguments)
        working_directory = $WorkingDirectory
        mpi_include_environment = $env:MSMPI_INC
        mpi_library_environment = $env:MSMPI_LIB64
        cache_before = $cacheBefore
        requested_architecture = $requested
        effective_architecture = $effective
      }) | Out-Null
    }
    else {
      $script:Commands.Add([pscustomobject]@{
        kind = "configure"
        provider = $provider
        build = $build
        arguments = @($Arguments)
        working_directory = $WorkingDirectory
        mpi_include_environment = $env:MSMPI_INC
        mpi_library_environment = $env:MSMPI_LIB64
      }) | Out-Null
    }
    return
  }

  if ($Command.ToLowerInvariant().EndsWith("tar.exe")) {
    $destination = $null
    for ($i = 0; $i -lt $Arguments.Count - 1; $i++) {
      if ($Arguments[$i] -eq "-C") { $destination = [string]$Arguments[$i + 1]; break }
    }
    if (-not $destination) { throw "mock LLVM extraction omitted -C" }
    $bin = Microsoft.PowerShell.Management\Join-Path $destination "bin"
    New-Item -ItemType Directory -Force -Path $bin | Out-Null
    [IO.File]::WriteAllText((Microsoft.PowerShell.Management\Join-Path $bin "clang-cl.exe"), "mock clang")
    return
  }
  if ($Command.ToLowerInvariant().EndsWith("zstd.exe")) {
    $outputIndex = -1
    for ($i = 0; $i -lt $Arguments.Count - 1; $i++) {
      if ($Arguments[$i] -eq "-o") { $outputIndex = $i; break }
    }
    if ($outputIndex -lt 0) { throw "mock zstd invocation omitted -o" }
    $tar = [string]$Arguments[$outputIndex + 1]
    $parent = Split-Path -Parent $tar
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    [IO.File]::WriteAllText($tar, "mock llvm tar")
    $script:Commands.Add([pscustomobject]@{
      kind = "tool"
      provider = "zstd"
      arguments = @($Arguments)
    }) | Out-Null
    return
  }
  throw "unexpected external command in mocked bootstrap: $Command"
}

$layout = [pscustomobject]@{
  build_root = $script:BuildRoot
  profile = "windows-native-fem-gpu"
}
Invoke-FullmagNativeFemDependencies -RepoRoot $RepoRoot -StorageLayout $layout -SourceRoot $SourceRoot -Cuda -CudaArchitectures "89" | Out-Null
Invoke-FullmagNativeFemDependencies -RepoRoot $RepoRoot -StorageLayout $layout -SourceRoot $SourceRoot -Cuda -CudaArchitectures "90" | Out-Null
$gpuCommands = @($script:Commands)
$script:Commands.Clear()
Invoke-FullmagNativeFemDependencies -RepoRoot $RepoRoot -StorageLayout $layout -SourceRoot $SourceRoot -Cuda:$false -CudaArchitectures "" | Out-Null
$cpuCommands = @($script:Commands)

[pscustomobject]@{
  commands = $gpuCommands
  cpu_commands = $cpuCommands
  scans = @($script:Scans)
  receipt = Get-Content -LiteralPath (Microsoft.PowerShell.Management\Join-Path $script:BuildRoot "fem-dependencies\provider-receipt.json") -Raw | ConvertFrom-Json
} | ConvertTo-Json -Depth 20 -Compress
'''


NATIVE_ARGV_DRIVER = r'''
param($Module, $CaptureScript)
$ErrorActionPreference = "Stop"
. $Module
if ($PSVersionTable.PSEdition -ne "Desktop" -or $PSVersionTable.PSVersion.Major -ne 5) {
  throw "native argv probe requires Windows PowerShell 5.1"
}
$probe = '-DPROBE=1 --pre-include="C:\source root with spaces\compat.h"'
Invoke-FullmagProviderCommand -Command "python.exe" -Arguments @($CaptureScript, $probe)
'''


NATIVE_EAP_DRIVER = r'''
param($Module)
$ErrorActionPreference = "Stop"
. $Module
if ($PSVersionTable.PSEdition -ne "Desktop" -or $PSVersionTable.PSVersion.Major -ne 5) {
  throw "native EAP probe requires Windows PowerShell 5.1"
}
$command = Join-Path $env:SystemRoot "System32\cmd.exe"
Invoke-FullmagProviderCommand -Command $command -Arguments @("/d", "/c", "echo stderr-exit0 1>&2 & exit /b 0")
$nonzeroCaught = $false
try {
  Invoke-FullmagProviderCommand -Command $command -Arguments @("/d", "/c", "echo stderr-exit7 1>&2 & exit /b 7")
}
catch {
  $nonzeroCaught = $true
}
if (-not $nonzeroCaught) { throw "native provider helper did not reject a nonzero native exit code" }
Write-Output "NATIVE_EAP_PROBE_OK"
'''


NATIVE_MFEM_HOOK_DRIVER = r'''
param($Hook, $FixtureRoot)
$ErrorActionPreference = "Stop"
$project = Join-Path $FixtureRoot "source root with spaces"
$build = Join-Path $FixtureRoot "build"
New-Item -ItemType Directory -Force -Path $project | Out-Null
$linalg = Join-Path $project "linalg"
$config = Join-Path $project "config"
$general = Join-Path $project "general"
New-Item -ItemType Directory -Force -Path $linalg, $config | Out-Null
[void](New-Item -ItemType Directory -Force -Path $general)
[IO.File]::WriteAllText(
  (Join-Path $config "config.hpp"),
  "#pragma once`n",
  (New-Object System.Text.UTF8Encoding($false))
)
[IO.File]::WriteAllText(
  (Join-Path $general "error.hpp"),
  @'
#ifndef MFEM_ERROR_HPP
#define MFEM_ERROR_HPP
#if defined(__CUDA_ARCH__)
#define MFEM_ABORT_KERNEL(...) { printf(__VA_ARGS__); asm("trap;"); }
#else
#define MFEM_ABORT_KERNEL(...) { MFEM_ABORT(""); }
#endif
#endif
'@,
  (New-Object System.Text.UTF8Encoding($false))
)
$kernels = @'
#ifndef MFEM_LINALG_KERNELS_HPP
#define MFEM_LINALG_KERNELS_HPP
#include "../config/config.hpp"
#include "tmatrix.hpp"
#include "tlayout.hpp"
#include "ttensor.hpp"
namespace mfem { namespace kernels { namespace internal {
const real_t Epsilon = std::numeric_limits<real_t>::epsilon();
} } }
#endif
'@
[IO.File]::WriteAllText(
  (Join-Path $linalg "kernels.hpp"),
  $kernels,
  (New-Object System.Text.UTF8Encoding($false))
)
$cmakeLists = @'
cmake_minimum_required(VERSION 3.25)
project(mfem NONE)
set(MFEM_USE_CUDA ON)
# The fixture intentionally avoids compiler discovery and emulates the values
# available after MFEM enables its Windows CUDA language path.
set(WIN32 TRUE)
set(MSVC TRUE)
add_library(mfem INTERFACE)
set_property(TARGET mfem PROPERTY COMPILE_OPTIONS "/wd4819;-O2")
set_property(TARGET mfem PROPERTY INTERFACE_COMPILE_OPTIONS "/wd4819;-DOK")
function(_write_options_after_hook)
  get_target_property(_compile_options mfem COMPILE_OPTIONS)
  get_target_property(_interface_options mfem INTERFACE_COMPILE_OPTIONS)
  get_target_property(_definitions mfem INTERFACE_COMPILE_DEFINITIONS)
  get_target_property(_compat_header mfem FULLMAG_MFEM_CUDA_COMPAT_HEADER)
  file(READ "${_compat_header}" _compat_source)
  file(WRITE "${CMAKE_BINARY_DIR}/options.txt"
    "${_compile_options}\n${_interface_options}\n${_definitions}\n"
    "COMPAT_HEADER=${_compat_header}\n${_compat_source}\n")
endfunction()
cmake_language(DEFER CALL _fullmag_fix_mfem_windows_cuda_options)
cmake_language(DEFER CALL _write_options_after_hook)
'@
[IO.File]::WriteAllText(
  (Join-Path $project "CMakeLists.txt"),
  $cmakeLists,
  (New-Object System.Text.UTF8Encoding($false))
)
& cmake.exe -S $project -B $build "-DCMAKE_PROJECT_INCLUDE_BEFORE=$Hook" | Out-Host
if ($LASTEXITCODE -ne 0) { throw "native CMake hook fixture configure failed: $LASTEXITCODE" }
$compatHeader = Join-Path $build "fullmag-mfem-cuda-compat\kernels.hpp"
$firstHeader = Get-Item -LiteralPath $compatHeader -Force
$firstHeaderTicks = $firstHeader.LastWriteTimeUtc.Ticks
Start-Sleep -Milliseconds 1500
& cmake.exe -S $project -B $build "-DCMAKE_PROJECT_INCLUDE_BEFORE=$Hook" | Out-Host
if ($LASTEXITCODE -ne 0) { throw "native CMake hook fixture reconfigure failed: $LASTEXITCODE" }
$secondHeader = Get-Item -LiteralPath $compatHeader -Force
if ($secondHeader.LastWriteTimeUtc.Ticks -ne $firstHeaderTicks) {
  throw "MFEM CUDA compatibility header was rewritten despite identical content"
}
$options = Get-Content -LiteralPath (Join-Path $build "options.txt") -Raw
if ($options -match '(^|;)/wd4819(;|$)') { throw "raw /wd4819 survived the MFEM hook: $options" }
if ($options -notmatch 'COMPILE_LANGUAGE:CXX') { throw "CXX warning option was not preserved: $options" }
if ($options -notmatch 'COMPILE_LANGUAGE:CUDA') { throw "CUDA host warning option was not wrapped: $options" }
if ($options -notmatch '_USE_MATH_DEFINES') { throw "MFEM math compatibility definition was not applied: $options" }
if ($options -notmatch 'COMPILE_LANGUAGE:CUDA.*--pre-include') { throw "CUDA pre-include option was not applied: $options" }
if (([regex]::Matches($options, '--pre-include')).Count -ne 1) { throw "MFEM CUDA hook was not idempotent: $options" }
if ($options -notmatch '__device__ const real_t Epsilon = 2\.220446049250313080847263336181640625e-16;') {
  throw "CUDA Epsilon compatibility patch was not generated: $options"
}
if ($options -notmatch 'fullmag_mfem_lzclz' -or
    $options -notmatch '#define __lzclz\(value\)') {
  throw "MFEM CUDA leading-zero compatibility patch was not generated: $options"
}
if (-not $options.Contains('#if defined(__CUDA_ARCH__)') -or
    -not $options.Contains('#else') -or
    -not $options.Contains('const real_t Epsilon = std::numeric_limits<real_t>::epsilon();')) {
  throw "host-side Epsilon branch was not retained in the compatibility patch: $options"
}
if ($options -notmatch '#include .*general[/\\]error\.hpp') {
  throw "MFEM error header was not included before the CUDA abort compatibility patch: $options"
}
if ($options -notmatch '#undef MFEM_ABORT_KERNEL' -or
    $options -notmatch '__trap\(\)' -or
    $options -notmatch 'FULLMAG_MFEM_ABORT_KERNEL_COMPAT') {
  throw "MFEM CUDA abort was not mapped to the supported device trap builtin: $options"
}
if ($options -match 'asm\("trap;"\)') {
  throw "GNU inline PTX asm survived the Windows CUDA compatibility patch: $options"
}
$sourceError = Get-Content -LiteralPath (Join-Path $general "error.hpp") -Raw
if ($sourceError -notmatch 'asm\("trap;"\)') {
  throw "MFEM fixture source no longer contains the pinned GNU trap marker"
}
if ($options -notmatch 'source root with spaces') { throw "compatibility header lost source path with spaces: $options" }
Write-Output "NATIVE_MFEM_HOOK_OK"
'''


def native_path(path: Path) -> str:
    if os.name == "nt" or not RUN_NATIVE_WINDOWS_POWERSHELL:
        return str(path)
    wslpath = shutil.which("wslpath")
    if not wslpath:
        raise AssertionError("wslpath is required for the explicit WSL PowerShell run")
    return subprocess.check_output(
        [wslpath, "-w", str(path)],
        text=True,
        timeout=10,
    ).strip()


def test_mfem_windows_cuda_options_hook_is_language_scoped() -> None:
    module_source = MODULE.read_text(encoding="utf-8")
    hook_source = MFEM_CUDA_OPTIONS_HOOK.read_text(encoding="utf-8")
    assert '"-DCMAKE_PROJECT_INCLUDE_BEFORE=$mfemCudaOptionsHook"' in module_source
    assert "cmake_language(DEFER CALL _fullmag_fix_mfem_windows_cuda_options)" in hook_source
    assert 'list(REMOVE_ITEM _fullmag_options "/wd4819")' in hook_source
    assert '"$<$<COMPILE_LANGUAGE:CXX>:/wd4819>"' in hook_source
    assert '"$<$<COMPILE_LANGUAGE:CUDA>:-Xcompiler=/wd4819>"' in hook_source
    assert '__device__ const real_t Epsilon = 2.220446049250313080847263336181640625e-16;' in hook_source
    assert '#if defined(__CUDA_ARCH__)' in hook_source
    assert 'fullmag_mfem_lzclz' in hook_source
    assert '#define __lzclz(value)' in hook_source
    assert '#undef MFEM_ABORT_KERNEL' in hook_source
    assert '__trap();' in hook_source
    assert 'general/error.hpp' in hook_source
    assert 'target_compile_definitions(mfem PRIVATE _USE_MATH_DEFINES)' in hook_source
    assert '"$<$<COMPILE_LANGUAGE:CUDA>:--pre-include>"' in hook_source
    assert 'string(REPLACE "\\r\\n" "\\n" _fullmag_existing_compat_source' in hook_source
    assert 'string(SHA256 _fullmag_existing_compat_sha256' in hook_source
    assert 'string(SHA256 _fullmag_generated_compat_sha256' in hook_source
    assert 'if(_fullmag_existing_compat_sha256 STREQUAL _fullmag_generated_compat_sha256)' in hook_source
    assert 'file(WRITE "${_fullmag_mfem_compat_header}" "${_fullmag_kernels_source}")' in hook_source
    assert 'target_compile_options(mfem PUBLIC "/wd4819")' not in hook_source


@NATIVE_WINDOWS_SKIP
def test_mocked_bootstrap_overrides_cached_architecture_and_scans_outputs(tmp_path: Path) -> None:
    module_source = MODULE.read_text(encoding="utf-8")
    assert "Get-FullmagNativeFemZstdRequirement -SourceRoot $SourceRoot" in module_source
    driver = tmp_path / "mock-native-fem-bootstrap.ps1"
    driver.write_text(textwrap.dedent(DRIVER), encoding="utf-8")
    build_root = tmp_path / "build"
    source_root = tmp_path / "source root with spaces"
    frozen_requirements = json.loads(REQUIREMENTS.read_text(encoding="utf-8"))
    frozen_requirements["provider_bootstrap"]["internal_helpers"]["zstd"]["decode_memory"] = "4096MB"
    source_root.mkdir(parents=True)
    (source_root / "windows_build_requirements.json").write_text(
        json.dumps(frozen_requirements), encoding="utf-8"
    )
    compat = ROOT / "scripts/windows/native_fem/hypre_cccl_compat.h"
    compat_source = compat.read_text(encoding="utf-8")
    source_compat = source_root / "scripts/windows/native_fem/hypre_cccl_compat.h"
    source_compat.parent.mkdir(parents=True)
    source_compat.write_text(compat_source, encoding="utf-8")
    source_hook = source_root / "scripts/windows/native_fem/mfem_windows_cuda_options.cmake"
    source_hook.parent.mkdir(parents=True, exist_ok=True)
    source_hook.write_text(MFEM_CUDA_OPTIONS_HOOK.read_text(encoding="utf-8"), encoding="utf-8")
    source_hypre_hook = source_root / "scripts/windows/native_fem/hypre_cmake_compat.cmake"
    source_hypre_hook.write_text(HYPRE_CMAKE_COMPAT_HOOK.read_text(encoding="utf-8"), encoding="utf-8")
    result = subprocess.run(
        [
            PS,
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            native_path(driver),
            native_path(MODULE),
            native_path(ROOT),
            native_path(build_root),
            native_path(source_root),
        ],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    zstd_requirement = frozen_requirements["provider_bootstrap"]["internal_helpers"]["zstd"]
    assert zstd_requirement["host_requirement"] is False

    ceed_configures = [
        command
        for command in payload["commands"]
        if command.get("provider") == "libceed"
    ]
    assert len(ceed_configures) == 2
    first, second = ceed_configures
    assert "-DCEED_CUDA_ARCHITECTURES=89" in first["arguments"]
    assert "-DCEED_CUDA_ARCHITECTURES=90" in second["arguments"]
    assert "-DCMAKE_CUDA_FLAGS=-Xcompiler=/Zc:preprocessor" in first["arguments"]
    assert "-DCMAKE_CUDA_FLAGS=-Xcompiler=/Zc:preprocessor" in second["arguments"]
    assert "-UCMAKE_CXX_*" in first["arguments"]
    assert "-UCMAKE_CXX_*" in second["arguments"]
    assert "-DCMAKE_C_COMPILER=clang-cl.exe" in first["arguments"]
    assert "-DCMAKE_C_COMPILER=clang-cl.exe" in second["arguments"]
    assert "-DCMAKE_CXX_COMPILER=clang-cl.exe" in first["arguments"]
    assert "-DCMAKE_CXX_COMPILER=clang-cl.exe" in second["arguments"]
    assert not any("clang++" in str(argument).lower() for argument in first["arguments"])
    assert not any("clang++" in str(argument).lower() for argument in second["arguments"])

    hypre = next(
        command
        for command in payload["commands"]
        if command.get("provider") == "hypre"
    )
    hypre_flags = next(
        argument
        for argument in hypre["arguments"]
        if argument.startswith("-DCMAKE_CUDA_FLAGS=")
    )
    assert hypre["working_directory"].replace("\\", "/").endswith(
        "/sources/hypre/src/seq_mv"
    )
    hypre_hooks = [
        argument
        for argument in hypre["arguments"]
        if argument.startswith("-DCMAKE_PROJECT_INCLUDE_BEFORE=")
    ]
    assert len(hypre_hooks) == 1
    assert hypre_hooks[0].replace("\\", "/").endswith(
        "/scripts/windows/native_fem/hypre_cmake_compat.cmake"
    )
    assert "-DFULLMAG_HYPRE_COMPAT_ENABLE=ON" in hypre["arguments"]
    expected_hypre_source = native_path(build_root / "fem-dependencies" / "sources" / "hypre").replace("\\", "/")
    assert f"-DFULLMAG_HYPRE_COMPAT_SOURCE_ROOT={expected_hypre_source}" in hypre["arguments"]
    assert "-Xcompiler=/Zc:preprocessor" in hypre_flags
    assert '--pre-include="' in hypre_flags
    assert r'\"' not in hypre_flags
    assert "source root with spaces" in hypre_flags
    assert hypre_flags.endswith('hypre_cccl_compat.h"')
    assert "hypre_cccl_compat.h" in hypre_flags
    assert "#include <thrust/pair.h>" in compat_source
    assert "#include <thrust/tuple.h>" in compat_source
    assert "#include <thrust/iterator/reverse_iterator.h>" in compat_source

    zstd_command = next(
        command
        for command in payload["commands"]
        if command.get("provider") == "zstd"
    )
    assert "-d" in zstd_command["arguments"]
    assert "--single-thread" in zstd_command["arguments"]
    assert f"--memory={zstd_requirement['decode_memory']}" in zstd_command["arguments"]
    output_index = zstd_command["arguments"].index("-o")
    assert zstd_command["arguments"][output_index + 1].lower().endswith(".tar")

    zstd_receipt = payload["receipt"]["zstd"]
    assert zstd_receipt["kind"] == zstd_requirement["kind"]
    assert zstd_receipt["version"] == zstd_requirement["version"]
    assert zstd_receipt["url"] == zstd_requirement["url"]
    assert zstd_receipt["archive_name"] == zstd_requirement["archive"]
    assert zstd_receipt["archive_sha256"] == zstd_requirement["archive_sha256"]
    assert zstd_receipt["executable_name"] == zstd_requirement["executable_name"]
    assert zstd_receipt["decode_memory"] == zstd_requirement["decode_memory"]
    assert len(zstd_receipt["executable_sha256"]) == 64
    assert any(
        tool["path"].replace("\\", "/").lower().endswith("zstd.exe")
        and len(tool["sha256"]) == 64
        for tool in payload["receipt"]["tools"]
    )

    expected_licenses = {
        "hypre": {
            "COPYRIGHT": "HYPRE copyright bytes",
            "LICENSE-APACHE": "HYPRE Apache license bytes",
            "LICENSE-MIT": "HYPRE MIT license bytes",
            "NOTICE": "HYPRE notice bytes",
        },
        "mfem": {
            "LICENSE": "MFEM license bytes",
            "NOTICE": "MFEM notice bytes",
        },
        "libceed": {
            "LICENSE": "libCEED license bytes",
            "NOTICE": "libCEED notice bytes",
        },
    }
    licenses = payload["receipt"]["licenses"]
    assert len(licenses) == sum(len(files) for files in expected_licenses.values())
    inventory_by_path = {
        entry["path"].replace("\\", "/").lower(): entry
        for entry in payload["receipt"]["files"]
    }
    provider_commits = {
        "hypre": "9dc9e18aed6a945a95f966e57daacfb1c269f6ec",
        "mfem": "d9d6526cc1749980a2ba1da16e2c1ca1e07d82ec",
        "libceed": "4018a20a98d451fac24765d3ddb936861647ce8d",
    }
    for license in licenses:
        component = license["component"]
        relative = license["source_relative"]
        assert license["provider_sha"] == provider_commits[component]
        assert license["provider_version"].startswith("v")
        expected_bytes = expected_licenses[component][relative].encode("utf-8")
        expected_sha = hashlib.sha256(expected_bytes).hexdigest()
        assert license["size_bytes"] == len(expected_bytes)
        assert license["source_sha256"] == expected_sha
        assert license["installed_sha256"] == expected_sha
        assert license["sha256"] == expected_sha
        assert license["installed_relative"] == f"share/licenses/{component}/{relative}"
        installed = license["installed_path"].replace("\\", "/").lower()
        assert installed.endswith(f"/fem-dependencies/installed/share/licenses/{component}/{relative}".lower())
        assert inventory_by_path[installed]["sha256"] == expected_sha
        assert inventory_by_path[installed]["size_bytes"] == len(expected_bytes)
        source = license["source_path"].replace("\\", "/").lower()
        assert source.endswith(f"/fem-dependencies/sources/{component}/{relative}".lower())
        assert not source.startswith(source_root.as_posix().lower())

    mfem = next(
        command
        for command in payload["commands"]
        if command.get("provider") == "mfem"
    )
    assert "-DCMAKE_CUDA_FLAGS=-Xcompiler=/Zc:preprocessor" in mfem["arguments"]
    assert not any("hypre_cccl_compat.h" in argument for argument in mfem["arguments"])
    mfem_options_hooks = [
        argument
        for argument in mfem["arguments"]
        if argument.startswith("-DCMAKE_PROJECT_INCLUDE_BEFORE=")
    ]
    assert len(mfem_options_hooks) == 1
    assert mfem_options_hooks[0].replace("\\", "/").endswith(
        "/scripts/windows/native_fem/mfem_windows_cuda_options.cmake"
    )

    cpu_hypre = next(
        command
        for command in payload["cpu_commands"]
        if command.get("provider") == "hypre"
    )
    cpu_mfem = next(
        command
        for command in payload["cpu_commands"]
        if command.get("provider") == "mfem"
    )
    assert not any(
        argument.startswith("-DCMAKE_CUDA_FLAGS=")
        for argument in cpu_hypre["arguments"] + cpu_mfem["arguments"]
    )
    assert not any(
        "hypre_cccl_compat.h" in argument
        for argument in cpu_hypre["arguments"] + cpu_mfem["arguments"]
    )
    assert not any(
        argument.startswith("-DCMAKE_PROJECT_INCLUDE_BEFORE=")
        for argument in cpu_mfem["arguments"]
    )

    source = MODULE.read_text(encoding="utf-8-sig")
    assert "CCCL_IGNORE_MSVC_TRADITIONAL_PREPROCESSOR_WARNING" not in source

    assert "-UMPI_*" in hypre["arguments"]
    assert "-UHYPRE_HAVE_MPI*" in hypre["arguments"]
    assert "-DMPI_ASSUME_NO_BUILTIN_MPI=ON" in hypre["arguments"]
    assert "-DMPI_SKIP_COMPILER_WRAPPER=ON" in hypre["arguments"]
    assert any(
        argument.startswith("-DMPI_C_ADDITIONAL_INCLUDE_DIRS=")
        for argument in hypre["arguments"]
    )
    assert all(
        "\\" not in argument
        for argument in hypre["arguments"]
        if argument.startswith("-DMPI_")
    )

    mfem = next(
        command
        for command in payload["commands"]
        if command.get("provider") == "mfem"
    )
    assert "-UMPI_*" in mfem["arguments"]
    assert "-DMPI_ASSUME_NO_BUILTIN_MPI=ON" in mfem["arguments"]
    assert any(
        argument.startswith("-DMPI_CXX_ADDITIONAL_INCLUDE_DIRS=")
        for argument in mfem["arguments"]
    )
    assert all(
        "\\" not in argument
        for argument in mfem["arguments"]
        if argument.startswith("-DMPI_")
    )
    for configure in (hypre, mfem):
        assert configure["mpi_include_environment"]
        assert configure["mpi_library_environment"]
        assert "\\" not in configure["mpi_include_environment"]
        assert "\\" not in configure["mpi_library_environment"]
    assert "-DCMAKE_CUDA_ARCHITECTURES=89" in first["arguments"]
    assert "-DCMAKE_CUDA_ARCHITECTURES=90" in second["arguments"]
    assert second["cache_before"] == "89"
    assert second["effective_architecture"] == "90"

    scans = payload["scans"]

    def states(suffix: str) -> list[bool]:
        normalized_suffix = suffix.replace("\\", "/").lower()
        return [
            scan["has_materialized"]
            for scan in scans
            if scan["path"].replace("\\", "/").lower().endswith(normalized_suffix)
        ]

    for suffix in (
        "tools/ninja-1.13.2",
        "tools/msmpi-10.1.1",
        "tools/llvm-23.1.3",
        "tools/zstd-1.5.7",
    ):
        observed = states(suffix)
        assert False in observed and True in observed, suffix

    for suffix in (
        "sources/hypre",
        "sources/mfem",
        "sources/libceed",
    ):
        observed = states(suffix)
        assert observed and all(observed), suffix


@NATIVE_WINDOWS_SKIP
def test_native_provider_command_preserves_quoted_windows_argv(tmp_path: Path) -> None:
    capture = tmp_path / "capture_native_argv.py"
    capture.write_text(
        "import json\nimport sys\nprint(json.dumps(sys.argv[1:]))\n",
        encoding="utf-8",
    )
    driver = tmp_path / "native-argv-probe.ps1"
    driver.write_text(textwrap.dedent(NATIVE_ARGV_DRIVER), encoding="utf-8")
    environment = os.environ.copy()
    environment["PATHEXT"] = ".COM;.EXE;.BAT;.CMD"
    result = subprocess.run(
        [
            PS,
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            native_path(driver),
            native_path(MODULE),
            native_path(capture),
        ],
        capture_output=True,
        text=True,
        timeout=60,
        env=environment,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout.strip()) == [
        '-DPROBE=1 --pre-include="C:\\source root with spaces\\compat.h"'
    ]


@NATIVE_WINDOWS_SKIP
def test_native_provider_command_handles_stderr_under_stop(tmp_path: Path) -> None:
    """Native stderr must not turn exit 0 into a PowerShell exception."""

    driver = tmp_path / "native-eap-probe.ps1"
    driver.write_text(textwrap.dedent(NATIVE_EAP_DRIVER), encoding="utf-8")
    environment = os.environ.copy()
    environment["PATHEXT"] = ".COM;.EXE;.BAT;.CMD"
    result = subprocess.run(
        [
            PS,
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            native_path(driver),
            native_path(MODULE),
        ],
        capture_output=True,
        text=True,
        timeout=60,
        env=environment,
    )
    assert result.returncode == 0, result.stderr
    assert "NATIVE_EAP_PROBE_OK" in result.stdout
    combined = f"{result.stdout}\n{result.stderr}".lower()
    assert "cannot run a document in the middle of a pipeline" not in combined


@NATIVE_WINDOWS_SKIP
def test_native_cmake_mfem_hook_rewrites_raw_cuda_option(tmp_path: Path) -> None:
    driver = tmp_path / "native-mfem-hook-probe.ps1"
    driver.write_text(textwrap.dedent(NATIVE_MFEM_HOOK_DRIVER), encoding="utf-8")
    environment = os.environ.copy()
    environment["PATHEXT"] = ".COM;.EXE;.BAT;.CMD"
    result = subprocess.run(
        [
            PS,
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            native_path(driver),
            native_path(MFEM_CUDA_OPTIONS_HOOK),
            native_path(tmp_path),
        ],
        capture_output=True,
        text=True,
        timeout=60,
        env=environment,
    )
    assert result.returncode == 0, result.stderr
    assert "NATIVE_MFEM_HOOK_OK" in result.stdout
