"""Exercise native launcher dispatch without building or starting a runtime."""
import json
import hashlib
from pathlib import Path
import shutil
import subprocess

import pytest


LAUNCHER = Path(__file__).parent / "windows" / "run_fullmag.ps1"
POWERSHELL = shutil.which("powershell.exe") or shutil.which("pwsh")
pytestmark = pytest.mark.skipif(not POWERSHELL, reason="PowerShell required")


@pytest.mark.parametrize("cuda,expected", [("false", []), ("true", ["cuda"])])
def test_build_manifest_serializes_features_as_an_array(tmp_path, cuda, expected):
    probe = tmp_path / "features.ps1"
    probe.write_text(r'''
param([string]$Launcher, [string]$Cuda)
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($Launcher,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$tables=@($ast.FindAll({param($node)
  $node -is [System.Management.Automation.Language.HashtableAst] -and
  @($node.KeyValuePairs | Where-Object {$_.Item1.Extent.Text -eq "features"}).Count -eq 1
},$true))
if ($tables.Count -ne 1) {throw "Expected one feature inventory"}
$pair=@($tables[0].KeyValuePairs | Where-Object {$_.Item1.Extent.Text -eq "features"})[0]
$useCuda=$Cuda -eq "true"
$value=& ([scriptblock]::Create('[ordered]@{features = ' + $pair.Item2.Extent.Text + '}'))
$value | ConvertTo-Json -Compress
''', encoding="utf-8")
    result = subprocess.run([POWERSHELL, "-NoProfile", "-File", str(probe), str(LAUNCHER), cuda],
                            capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["features"] == expected


def test_active_workspace_does_not_repair_a_missing_python_environment(tmp_path):
    probe = tmp_path / "python-guard.ps1"
    probe.write_text(r'''
param([string]$Launcher, [string]$MissingPython)
$ErrorActionPreference = "Stop"
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($Launcher,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$function=$ast.Find({param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
  $node.Name -eq "Ensure-PythonEnvironment"
},$true)
. ([scriptblock]::Create($function.Extent.Text))
function Invoke-Uv { throw "MUST_NOT_INSTALL" }
function Ensure-Directory { throw "MUST_NOT_WRITE" }
$PythonExe=$MissingPython
$env:FULLMAG_NATIVE_RUNTIME_ACTIVE="1"
try { Ensure-PythonEnvironment; throw "MUST_REJECT" }
catch {
  if ($_.Exception.Message -notlike "Active workspace Python dependencies cannot be repaired*") {throw}
  Write-Output "guarded"
}
''', encoding="utf-8")
    result = subprocess.run([POWERSHELL, "-NoProfile", "-File", str(probe), str(LAUNCHER),
                             str(tmp_path / "missing-python.exe")],
                            capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "guarded"


@pytest.mark.parametrize("frontend,expected", [
    ("static", ["ui", "--web-port", "3197"]),
    ("dev", ["ui", "--web-port", "3197", "--dev"]),
])
def test_workspace_dispatch_opens_ui_without_script_or_solve(tmp_path, frontend, expected):
    # Parse the actual launcher, then execute only its workspace dispatch block.
    # All build/storage checks remain outside this focused argv regression.
    probe = tmp_path / "dispatch.ps1"
    probe.write_text(r'''
param([string]$Launcher, [string]$Frontend, [string]$RepoRoot)
$ErrorActionPreference = "Stop"
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  $Launcher, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$blocks = @($ast.FindAll({ param($node)
  $node -is [System.Management.Automation.Language.IfStatementAst] -and
  $node.Extent.Text.StartsWith('if ($RunMode -eq "workspace") {') -and
  $node.Extent.Text.Contains('$workspaceArguments = @("ui"')
}, $true))
if ($blocks.Count -ne 1) { throw "Expected one workspace dispatch" }
function Invoke-External {
  param([string]$Command, [string[]]$Arguments)
  [ordered]@{command=$Command; arguments=@($Arguments)} | ConvertTo-Json -Compress
}
function Publish-NativeWorkspaceRuntime { return "native-fullmag.exe" }
$RunMode = "workspace"; $WebPort = 3197; $FullmagExe = "native-fullmag.exe"
$FrontendWorkspaceRoot = Join-Path $RepoRoot "frontend-workspace"
$FrontendCacheRoot = Join-Path $RepoRoot "frontend-cache"
$StorageLayout = @{runtime_root=(Join-Path $RepoRoot "runtime")}
& ([scriptblock]::Create($blocks[0].Extent.Text))
''', encoding="utf-8")
    result = subprocess.run([POWERSHELL, "-NoProfile", "-File", str(probe),
                             str(LAUNCHER), frontend, str(tmp_path)],
                            capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {"command": "native-fullmag.exe", "arguments": expected}


@pytest.mark.parametrize("extra", [
    ["-ScriptPath", "must-not-execute.py"],
    ["-Backend", "fem"],
    ["-Device", "gpu"],
    ["-InitialMagnetizationStateSampleIndex", "0"],
    ["-OutputDir", "must-not-create"],
])
def test_workspace_rejects_simulation_inputs_before_storage_or_build(extra):
    result = subprocess.run([POWERSHELL, "-NoProfile", "-File", str(LAUNCHER),
                             "-BuildMode", "false", "-RunMode", "workspace", *extra],
                            capture_output=True, text=True, timeout=20)
    assert result.returncode != 0
    assert "Workspace mode opens an empty authoring shell" in result.stderr


@pytest.mark.parametrize("case", ["valid", "missing", "changed", "missing_hash", "empty"])
def test_desktop_runtime_requires_file_and_matching_manifest_hash(tmp_path, case):
    binary = tmp_path / "fullmag-ui.exe"
    original = b"desktop artifact hash fixture; not an executable"
    expected = hashlib.sha256(original).hexdigest()
    if case != "missing":
        binary.write_bytes(b"changed" if case == "changed" else original)
    if case == "missing_hash":
        expected = ""
    if case == "empty":
        binary.write_bytes(b"")
        expected = hashlib.sha256(b"").hexdigest()
    probe = tmp_path / "desktop.ps1"
    probe.write_text(r'''
param([string]$Launcher, [string]$Binary, [string]$ExpectedHash)
$ErrorActionPreference = "Stop"
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  $Launcher, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($name in @("Get-Sha256File", "Assert-FullmagDesktopRuntime")) {
  $functions = @($ast.FindAll({ param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq $name
  }, $true))
  if ($functions.Count -ne 1) { throw "Expected one function $name" }
  . ([scriptblock]::Create($functions[0].Extent.Text))
}
Assert-FullmagDesktopRuntime -Path $Binary -ExpectedHash $ExpectedHash
[Console]::Write("verified")
''', encoding="utf-8")
    result = subprocess.run([POWERSHELL, "-NoProfile", "-File", str(probe),
                             str(LAUNCHER), str(binary), expected],
                            capture_output=True, text=True, timeout=20)
    if case == "valid":
        assert result.returncode == 0, result.stderr
        assert result.stdout == "verified"
    else:
        assert result.returncode != 0
        assert "rerun with build=True" in result.stderr


@pytest.mark.parametrize("cuda,desktop", [(False, False), (True, False), (False, True), (True, True)])
@pytest.mark.parametrize("compiler_profile,profile_args", [
    ("release", ["--release"]),
    ("backend-dev", ["--profile", "backend-dev"]),
])
def test_desktop_build_uses_selected_cargo_profile_without_leaking_cuda(
    tmp_path, cuda, desktop, compiler_profile, profile_args
):
    source = LAUNCHER.read_text(encoding="utf-8")
    build = source.split('  $cargoProfileArguments = @(Get-WindowsCargoProfileArguments -CompilerProfile $CargoCompilerProfile)\n', 1)[1].split(
        '  if (-not (Test-Path -LiteralPath $FullmagExe', 1)[0]
    probe = tmp_path / "build-argv.ps1"
    probe.write_text('''
param([string]$Cuda, [string]$Desktop, [string]$CompilerProfile, [string]$Launcher, [string]$RepoRoot)
$ErrorActionPreference = "Stop"
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Launcher, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$profileFunctions = @($ast.FindAll({ param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
  $node.Name -eq "Get-WindowsCargoProfileArguments"
}, $true))
if ($profileFunctions.Count -ne 1) { throw "Expected the cargo profile selector" }
. ([scriptblock]::Create($profileFunctions[0].Extent.Text))
$useCuda = $Cuda -eq "true"
$needsControlRoomToolchain = $Desktop -eq "true"
$TargetTriple = "x86_64-pc-windows-msvc"
$CargoCompilerProfile = $CompilerProfile
$calls = [System.Collections.Generic.List[object]]::new()
function Invoke-External {
  param([string]$Command, [string[]]$Arguments)
  $calls.Add(@{command=$Command; arguments=@($Arguments)})
}
  $cargoProfileArguments = @(Get-WindowsCargoProfileArguments -CompilerProfile $CargoCompilerProfile)
''' + build + '\nConvertTo-Json -InputObject @($calls.ToArray()) -Depth 5 -Compress\n', encoding="utf-8")
    result = subprocess.run([POWERSHELL, "-NoProfile", "-File", str(probe),
                             str(cuda).lower(), str(desktop).lower(), compiler_profile,
                             str(LAUNCHER), str(tmp_path)],
                            capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    calls = json.loads(result.stdout)
    solver = ["build", "--locked", *profile_args, "--target", "x86_64-pc-windows-msvc",
              "-p", "fullmag-cli", "-p", "fullmag-api"]
    if cuda:
        solver += ["--features", "cuda"]
    expected = [{"command": "cargo", "arguments": solver}]
    if desktop:
        expected.append({"command": "cargo", "arguments": [
            "build", "--locked", *profile_args, "--target", "x86_64-pc-windows-msvc",
            "-p", "fullmag-desktop"]})
    assert calls == expected


def test_windows_workspace_profile_and_artifact_paths_are_separate(tmp_path):
    probe = tmp_path / "artifact-paths.ps1"
    probe.write_text(r'''
param([string]$Launcher, [string]$Root)
$ErrorActionPreference = "Stop"
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Launcher, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($name in @("Get-WindowsWorkspaceArtifactPaths", "Resolve-WindowsBackendProfile")) {
  $functions = @($ast.FindAll({ param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
  }, $true))
  if ($functions.Count -ne 1) { throw "Expected one function $name" }
  . ([scriptblock]::Create($functions[0].Extent.Text))
}
$devProfile = Resolve-WindowsBackendProfile -RequestedProfile auto -Frontend dev -RunMode workspace
$releaseProfile = Resolve-WindowsBackendProfile -RequestedProfile auto -Frontend static -RunMode workspace
$dev = Get-WindowsWorkspaceArtifactPaths -BuildRoot (Join-Path $Root "windows-native-fdm-cpu-dev") `
  -TargetRoot (Join-Path $Root "windows-native-fdm-cpu-dev/cargo-target") `
  -TargetTriple "x86_64-pc-windows-msvc" -CompilerProfile "backend-dev"
$release = Get-WindowsWorkspaceArtifactPaths -BuildRoot (Join-Path $Root "windows-native-fdm-cpu") `
  -TargetRoot (Join-Path $Root "windows-native-fdm-cpu/cargo-target") `
  -TargetTriple "x86_64-pc-windows-msvc" -CompilerProfile "release"
[ordered]@{dev_profile=$devProfile; release_profile=$releaseProfile; dev=$dev; release=$release} |
  ConvertTo-Json -Depth 5 -Compress
''', encoding="utf-8")
    result = subprocess.run([POWERSHELL, "-NoProfile", "-File", str(probe),
                             str(LAUNCHER), str(tmp_path)],
                            capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    value = json.loads(result.stdout)
    assert value["dev_profile"] == "dev"
    assert value["release_profile"] == "release"
    for key in ("binary", "api_binary", "desktop_binary", "manifest", "version_identity", "version_record"):
        assert value["dev"][key] != value["release"][key]
    assert "/backend-dev/" in value["dev"]["binary"].replace("\\", "/")
    assert "/release/" in value["release"]["binary"].replace("\\", "/")


def test_workspace_auto_reuse_rejects_manifest_from_another_compiler_profile(tmp_path):
    probe = tmp_path / "manifest-profile.ps1"
    probe.write_text(r'''
param([string]$Launcher, [string]$Root)
$ErrorActionPreference = "Stop"
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Launcher, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$functions = @($ast.FindAll({ param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
  $node.Name -eq "Test-WindowsWorkspaceBuildRequired"
}, $true))
if ($functions.Count -ne 1) { throw "Expected workspace manifest reuse validator" }
. ([scriptblock]::Create($functions[0].Extent.Text))
function Get-Sha256File {
  param([string]$Path)
  return [IO.Path]::GetFullPath($Path)
}
function Assert-FullmagStoragePath {
  param($Layout, [string]$Path, [string]$Label, [string]$Parent)
  return $Path
}
$WorkspaceNamespace = "fixture-worktree"
$TargetTriple = "x86_64-pc-windows-msvc"
$CargoCompilerProfile = "backend-dev"
$Frontend = "dev"
$BuildRoot = $Root
$StorageLayout = @{}
$FullmagExe = Join-Path $Root "fullmag.exe"
$FullmagApiExe = Join-Path $Root "fullmag-api.exe"
$FullmagUiExe = Join-Path $Root "fullmag-ui.exe"
$PythonExe = Join-Path $Root "python.exe"
$PinnedPnpmCli = Join-Path $Root "pnpm.cjs"
$ManifestPath = Join-Path $Root "build-manifest.json"
$FrontendWorkspaceRoot = Join-Path $Root "frontend"
$FrontendCacheRoot = Join-Path $Root "frontend-cache"
$nextPackage = Join-Path $FrontendWorkspaceRoot "apps/control-room/node_modules/next/package.json"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $nextPackage) | Out-Null
New-Item -ItemType Directory -Force -Path $FrontendCacheRoot | Out-Null
foreach ($path in @($FullmagExe, $FullmagApiExe, $FullmagUiExe, $PythonExe, $PinnedPnpmCli, $nextPackage)) {
  [IO.File]::WriteAllText($path, "fixture")
}
$versionFile = Join-Path $Root "build-version.json"
$frontendManifest = Join-Path $Root "frontend-manifest.json"
[IO.File]::WriteAllText($versionFile, "version")
[IO.File]::WriteAllText($frontendManifest, "frontend")
$candidate = [ordered]@{
  schema_version=1; backend_source_sha256=("a" * 64); compiler_profile="backend-dev"
  workspace_namespace=$WorkspaceNamespace; target_triple=$TargetTriple; frontend_mode="dev"
  git_commit=("b" * 40); source_snapshot_sha256=("c" * 64)
  source_identity_check="passed"; local_changes_check="enforced"
  build_version=@{schema="fullmag.build-version.v1"; git_commit=("b" * 40); source_snapshot_sha256=("c" * 64)}
  binary_sha256=(Get-Sha256File $FullmagExe); api_binary_sha256=(Get-Sha256File $FullmagApiExe)
  desktop_binary_sha256=(Get-Sha256File $FullmagUiExe)
  build_version_file=$versionFile; build_version_file_sha256=(Get-Sha256File $versionFile)
  frontend_source_manifest=$frontendManifest; frontend_source_manifest_sha256=(Get-Sha256File $frontendManifest)
}
$candidate | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ManifestPath
$matching = Test-WindowsWorkspaceBuildRequired -BackendDigest ("a" * 64)
$candidate.compiler_profile = "release"
$candidate | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ManifestPath
$wrongProfile = Test-WindowsWorkspaceBuildRequired -BackendDigest ("a" * 64)
[ordered]@{matching_profile=$matching; wrong_profile=$wrongProfile} | ConvertTo-Json -Compress
''', encoding="utf-8")
    result = subprocess.run([POWERSHELL, "-NoProfile", "-File", str(probe),
                             str(LAUNCHER), str(tmp_path)],
                            capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    value = json.loads(result.stdout)
    assert value == {"matching_profile": False, "wrong_profile": True}


@pytest.mark.parametrize("frontend,port", [("static", "3197"), ("dev", "3198")])
def test_just_windows_ui_dispatches_fixed_launcher_without_generic_preparation(tmp_path, frontend, port):
    import os
    bash = Path("C:/Program Files/Git/bin/bash.exe") if os.name == "nt" else Path(shutil.which("bash") or "/missing")
    if not bash.is_file():
        pytest.skip("Bash required")
    root = LAUNCHER.resolve().parents[2]
    stub = tmp_path / "powershell.exe"
    stub.write_text('#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n', encoding="utf-8")
    stub.chmod(0o755)
    recipe = (f'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass '
              f'-File "{root.as_posix()}/scripts/windows/run_fullmag.ps1" '
              f'-BuildMode "auto" -Frontend "{frontend}" -BackendProfile "auto" '
              f'-RunMode workspace -WebPort "{port}"')
    env = {**os.environ, "OS": "Windows_NT", "PATH": str(tmp_path) + os.pathsep + os.environ["PATH"]}
    result = subprocess.run([str(bash), "scripts/just_storage_shell.sh", recipe], cwd=root,
                            env=env, capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    arguments = result.stdout.splitlines()
    assert arguments[:5] == ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]
    assert arguments[5].replace("\\", "/").endswith("/scripts/windows/run_fullmag.ps1")
    assert arguments[6:] == ["-BuildMode", "auto", "-Frontend", frontend, "-BackendProfile", "auto",
                             "-RunMode", "workspace", "-WebPort", port]
    assert "inventoried migration" not in result.stderr


@pytest.mark.parametrize("frontend,port,suffix", [
    ("static", "0", ""), ("static", "65536", ""), ("static", "03197", ""),
    ("invalid", "3197", ""), ("static", "3197", " && printf MUST_NOT_EXECUTE"),
    ("static", "3197", " # fullmag_storage.py resolve"),
])
def test_just_windows_ui_rejects_invalid_or_composite_recipe(frontend, port, suffix):
    import os
    bash = Path("C:/Program Files/Git/bin/bash.exe") if os.name == "nt" else Path(shutil.which("bash") or "/missing")
    if not bash.is_file():
        pytest.skip("Bash required")
    root = LAUNCHER.resolve().parents[2]
    recipe = (f'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass '
              f'-File "{root.as_posix()}/scripts/windows/run_fullmag.ps1" '
              f'-BuildMode "auto" -Frontend "{frontend}" -BackendProfile "auto" '
              f'-RunMode workspace -WebPort "{port}"{suffix}')
    result = subprocess.run([str(bash), "scripts/just_storage_shell.sh", recipe], cwd=root,
                            capture_output=True, text=True, timeout=20)
    assert result.returncode == 2, result.stderr
    assert "[fullmag just]" in result.stderr
    assert "MUST_NOT_EXECUTE" not in result.stdout
    assert "inventoried migration" not in result.stderr


def test_just_windows_workspace_build_dispatch_is_closed_and_build_only(tmp_path):
    import os
    bash = Path("C:/Program Files/Git/bin/bash.exe") if os.name == "nt" else Path(shutil.which("bash") or "/missing")
    if not bash.is_file():
        pytest.skip("Bash required")
    root = LAUNCHER.resolve().parents[2]
    stub = tmp_path / "powershell.exe"
    stub.write_text('#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n', encoding="utf-8")
    stub.chmod(0o755)
    recipe = (f'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass '
              f'-File "{root.as_posix()}/scripts/windows/run_fullmag.ps1" '
              '-BuildMode "auto" -Frontend "dev" -BackendProfile "dev" '
              '-RunMode workspace -WebPort "3197" -BuildOnly')
    env = {**os.environ, "OS": "Windows_NT", "PATH": str(tmp_path) + os.pathsep + os.environ["PATH"]}
    result = subprocess.run([str(bash), "scripts/just_storage_shell.sh", recipe], cwd=root,
                            env=env, capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines()[6:] == [
        "-BuildMode", "auto", "-Frontend", "dev", "-BackendProfile", "dev",
        "-RunMode", "workspace", "-WebPort", "3197", "-BuildOnly",
    ]


@pytest.mark.parametrize("build,backend_profile", [("false", "dev"), ("auto", "auto")])
def test_just_windows_workspace_build_rejects_unsupported_profile_or_mode(tmp_path, build, backend_profile):
    import os
    bash = Path("C:/Program Files/Git/bin/bash.exe") if os.name == "nt" else Path(shutil.which("bash") or "/missing")
    if not bash.is_file():
        pytest.skip("Bash required")
    root = LAUNCHER.resolve().parents[2]
    recipe = (f'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass '
              f'-File "{root.as_posix()}/scripts/windows/run_fullmag.ps1" '
              f'-BuildMode "{build}" -Frontend "dev" -BackendProfile "{backend_profile}" '
              '-RunMode workspace -WebPort "3197" -BuildOnly')
    env = {**os.environ, "OS": "Windows_NT"}
    result = subprocess.run([str(bash), "scripts/just_storage_shell.sh", recipe], cwd=root,
                            env=env, capture_output=True, text=True, timeout=20)
    assert result.returncode == 2, result.stderr
    assert "build-only requires" in result.stderr


@pytest.mark.parametrize("suffix", [" --BuildOnly", " --once", " -BuildOnly"])
def test_just_windows_backend_watcher_dispatch_is_closed(tmp_path, suffix):
    import os
    bash = Path("C:/Program Files/Git/bin/bash.exe") if os.name == "nt" else Path(shutil.which("bash") or "/missing")
    if not bash.is_file():
        pytest.skip("Bash required")
    root = LAUNCHER.resolve().parents[2]
    python_stub = tmp_path / "python3"
    python_stub.write_text('''#!/usr/bin/env bash
if [[ "$1" == "-c" ]]; then exit 0; fi
printf "%s\\n" "$@"
''', encoding="utf-8")
    python_stub.chmod(0o755)
    recipe = (f'python "{root.as_posix()}/scripts/windows/watch_backend.py" '
              f'--repo-root "{root.as_posix()}" --web-port "3197"{suffix}')
    env = {**os.environ, "OS": "Windows_NT", "PATH": str(tmp_path) + os.pathsep + os.environ["PATH"]}
    result = subprocess.run([str(bash), "scripts/just_storage_shell.sh", recipe], cwd=root,
                            env=env, capture_output=True, text=True, timeout=20)
    assert result.returncode == 2, result.stderr
    assert "[fullmag just]" in result.stderr
    assert "watch_backend.py" not in result.stdout


def test_just_windows_backend_watcher_dispatches_only_fixed_helper_and_port(tmp_path):
    import os
    bash = Path("C:/Program Files/Git/bin/bash.exe") if os.name == "nt" else Path(shutil.which("bash") or "/missing")
    if not bash.is_file():
        pytest.skip("Bash required")
    root = LAUNCHER.resolve().parents[2]
    python_stub = tmp_path / "python3"
    python_stub.write_text('''#!/usr/bin/env bash
if [[ "$1" == "-c" ]]; then exit 0; fi
printf "%s\\n" "$@"
''', encoding="utf-8")
    python_stub.chmod(0o755)
    recipe = (f'python "{root.as_posix()}/scripts/windows/watch_backend.py" '
              f'--repo-root "{root.as_posix()}" --web-port "3197"')
    env = {**os.environ, "OS": "Windows_NT", "PATH": str(tmp_path) + os.pathsep + os.environ["PATH"]}
    result = subprocess.run([str(bash), "scripts/just_storage_shell.sh", recipe], cwd=root,
                            env=env, capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    arguments = result.stdout.splitlines()
    assert arguments[0].replace("\\", "/").endswith("/scripts/windows/watch_backend.py")
    assert arguments[1] == "--repo-root"
    assert Path(arguments[2]).name == root.name
    assert Path(arguments[2]).parent.name == root.parent.name
    assert arguments[3:] == ["--web-port", "3197"]
