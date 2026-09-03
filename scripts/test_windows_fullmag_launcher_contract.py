import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
JUSTFILE = ROOT / "justfile"
LAUNCHER = ROOT / "scripts" / "windows" / "run_fullmag.ps1"
CONTROL_ROOM = ROOT / "crates" / "fullmag-cli" / "src" / "control_room.rs"
LEGACY_FEM_LAUNCHER = ROOT / "scripts" / "windows" / "run_fullmag_wsl.ps1"
FEM_LAUNCHER = ROOT / "scripts" / "windows" / "run_fullmag_fem.ps1"
DOCKER_LAUNCHER = ROOT / "scripts" / "windows" / "run_fullmag_docker.ps1"
WINDOWS_COMPOSE = ROOT / "compose.windows.yaml"
FEM_GPU_DOCKERFILE = ROOT / "docker" / "fem-gpu" / "Dockerfile"
FEM_CPU_DOCKERFILE = ROOT / "docker" / "fem-cpu" / "Dockerfile"
SETUP = ROOT / "scripts" / "windows" / "setup_fullmag.ps1"


def test_justfile_exposes_native_windows_fullmag_route() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    assert 'set windows-shell := ["C:\\\\Program Files\\\\Git\\\\bin\\\\bash.exe"' in justfile
    assert 'windows="false"' in justfile
    assert "--windows|windows)" in justfile
    assert "scripts/windows/run_fullmag.ps1" in justfile
    assert "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File" in justfile
    assert "windows=True" in justfile


def test_windows_launcher_keeps_build_and_cache_storage_outside_repo() -> None:
    launcher = LAUNCHER.read_text(encoding="utf-8")

    assert "GetPathRoot($RepoRoot)" in launcher
    assert "Require-ExternalBuildPath" in launcher
    assert "must be outside the repository" in launcher
    assert "Require-DPath" not in launcher
    for variable in (
        "CARGO_HOME",
        "RUSTUP_HOME",
        "CARGO_TARGET_DIR",
        "PNPM_HOME",
        "npm_config_store_dir",
        "npm_config_cache",
        "COREPACK_HOME",
        "PIP_CACHE_DIR",
        "UV_CACHE_DIR",
        "UV_PYTHON_INSTALL_DIR",
        "TEMP",
        "TMP",
        "CUDA_CACHE_PATH",
        "PLAYWRIGHT_BROWSERS_PATH",
        "PYTHONPYCACHEPREFIX",
    ):
        assert f"$env:{variable}" in launcher

    assert 'Join-Path $RepoRoot "target"' not in launcher
    assert "build_windows_msi.ps1" not in launcher
    assert "docker" not in launcher.lower()


def test_windows_gpu_route_builds_cuda_and_fails_closed() -> None:
    launcher = LAUNCHER.read_text(encoding="utf-8")

    assert "nvcc" in launcher
    assert '"cuda"' in launcher
    assert "--features" in launcher
    assert "FULLMAG_FDM_EXECUTION" in launcher
    assert "nvidia-smi" in launcher
    assert "CPU fallback" in launcher
    assert "fullmag_fdm.dll" in launcher


def test_windows_launcher_stages_cuda_dll_from_short_external_native_build_root() -> None:
    launcher = LAUNCHER.read_text(encoding="utf-8")

    assert 'FULLMAG_FDM_NATIVE_BUILD_ROOT' in launcher
    assert 'Join-Path $nativeFdmBuildRoot "backends\\fdm\\Release\\fullmag_fdm.dll"' in launcher
    assert launcher.index("$nativeFdmBuildRoot =") < launcher.index(
        "$env:FULLMAG_FDM_NATIVE_BUILD_ROOT = $nativeFdmBuildRoot"
    )
    assert 'Join-Path $TargetRoot "$TargetTriple\\release\\build"' not in launcher
    assert 'Join-Path $TargetRoot "release\\build"' not in launcher


def test_windows_launcher_rechecks_source_identity_before_publishing_manifest() -> None:
    launcher = LAUNCHER.read_text(encoding="utf-8")

    assert "$finalSourceIdentity = Get-SourceIdentity" in launcher
    assert "GIT_OPTIONAL_LOCKS" in launcher
    assert launcher.index("$finalSourceIdentity = Get-SourceIdentity") < launcher.index(
        "$manifest = [ordered]@{"
    )
    assert "source changed while the native runtime was building" in launcher


def test_windows_build_recipe_normalizes_named_arguments() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    assert 'case "$backend" in backend=*)' in justfile
    assert 'case "$device" in device=*)' in justfile
    assert '-Backend "$backend" -Device "$device"' in justfile


def test_windows_fdm_build_does_not_emit_unix_linker_rpath() -> None:
    build_script = (ROOT / "crates" / "fullmag-fdm-sys" / "build.rs").read_text(encoding="utf-8")

    assert "CARGO_CFG_TARGET_OS" in build_script
    assert '!= Ok("windows")' in build_script


def test_windows_launcher_supports_build_false_without_rebuilding() -> None:
    launcher = LAUNCHER.read_text(encoding="utf-8")

    assert "BuildMode" in launcher
    assert '"false"' in launcher
    assert "build-manifest.json" in launcher
    assert "release\\fullmag.exe" in launcher


def test_windows_launcher_builds_cli_and_api_as_sibling_release_binaries() -> None:
    launcher = LAUNCHER.read_text(encoding="utf-8")

    assert '"-p", "fullmag-cli", "-p", "fullmag-api"' in launcher
    assert '$FullmagApiExe = Join-Path $TargetRoot "$TargetTriple\\release\\fullmag-api.exe"' in launcher
    assert "Native Fullmag API binary was not produced" in launcher
    assert "Native Windows Fullmag API binary is missing" in launcher


def test_native_windows_control_room_uses_windows_command_lookup_and_opener() -> None:
    control_room = CONTROL_ROOM.read_text(encoding="utf-8")

    assert '#[cfg(windows)]\npub(crate) fn command_exists' in control_room
    assert 'ProcessCommand::new("where.exe")' in control_room
    assert 'if cfg!(windows) {\n        &["cmd.exe"]' in control_room
    assert "let frontend_ready = loop" in control_room
    assert "if !frontend_ready" in control_room
    assert "if !frontend_is_ready_for_bootstrap(web_port)" not in control_room


def test_windows_launcher_reuses_existing_msvc_rust_toolchain() -> None:
    launcher = LAUNCHER.read_text(encoding="utf-8")

    assert "rustup show active-toolchain" in launcher
    assert "x86_64-pc-windows-msvc" in launcher
    assert '"toolchain", "install"' not in launcher
    assert '"target", "add"' not in launcher


def test_windows_launcher_recognizes_pnpm_windows_swc_store_entry() -> None:
    launcher = LAUNCHER.read_text(encoding="utf-8")

    assert "node_modules\\.pnpm" in launcher
    assert "@next+swc-win32-x64-msvc@*" in launcher
    assert '$PinnedPnpmVersion = "10.8.1"' in launcher
    assert "$env:FULLMAG_PNPM_CLI = $PinnedPnpmCli" in launcher


def test_root_workspace_and_windows_setup_use_one_pnpm_lock_contract() -> None:
    package_json = (ROOT / "package.json").read_text(encoding="utf-8")
    setup = SETUP.read_text(encoding="utf-8")

    assert '"packageManager": "pnpm@10.8.1"' in package_json
    assert (ROOT / "pnpm-lock.yaml").is_file()
    assert not (ROOT / "package-lock.json").exists()
    assert "/package-lock.json" in (ROOT / ".gitignore").read_text(encoding="utf-8")
    assert '$PinnedPnpmVersion = "10.8.1"' in setup
    assert '$env:COREPACK_HOME = $CorepackHome' in setup
    assert '"install", "--global", "pnpm@$PinnedPnpmVersion"' in setup
    assert "Pinned pnpm validation failed" in setup


def test_windows_fem_gpu_routes_to_docker_before_posix_host_setup() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    assert "scripts/windows/run_fullmag_fem.ps1" in justfile
    assert "scripts/windows/run_fullmag_wsl.ps1" not in justfile
    assert '[ "$backend" = "fem" ]' in justfile
    assert '[ "$device" = "gpu" ]' in justfile
    fullmag_start = justfile.index("fullmag opt_1")
    assert justfile.index("run_fullmag_fem.ps1", fullmag_start) < justfile.index(
        "just ensure-python", fullmag_start
    )


def test_windows_fem_entrypoint_is_windows_powerShell_to_docker_and_wsl_free() -> None:
    launcher = FEM_LAUNCHER.read_text(encoding="utf-8")

    assert "Canonical Windows FEM entry point" in launcher
    assert "compose.windows.yaml" in launcher
    assert '$Contract -eq "gpu-benchmark-baseline"' in launcher
    assert '$Contract -eq "gpu-nsight"' in launcher
    assert '$Contract -eq "dmi-gpu"' in launcher
    assert 'Invoke-External "wsl.exe"' not in launcher


def test_windows_fem_compatibility_launchers_are_thin_direct_aliases() -> None:
    for path in (LEGACY_FEM_LAUNCHER, DOCKER_LAUNCHER):
        launcher = path.read_text(encoding="utf-8")
        assert "run_fullmag_fem.ps1" in launcher
        assert "@args" in launcher
        assert "compose.windows.yaml" not in launcher
        assert '$Contract -eq "gpu-benchmark-baseline"' not in launcher
        assert '$Contract -eq "gpu-nsight"' not in launcher
        assert "function Invoke-DockerCompose" not in launcher
        assert "wsl.exe" not in launcher.lower()
        assert "Invoke-External" not in launcher


def test_windows_fem_contract_attempt_id_is_a_safe_guid() -> None:
    launcher = FEM_LAUNCHER.read_text(encoding="utf-8")
    python_guid_pattern = (
        r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-"
        r"4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
    )
    powershell_guid_pattern = python_guid_pattern.replace("^", r"\A").replace(
        "$", r"\z"
    )

    assert f'[ValidatePattern("{powershell_guid_pattern}")]' in launcher
    assert re.fullmatch(
        python_guid_pattern, "46578ff1-efff-4bf4-8ce4-22ccda091dc3"
    )
    for invalid in (
        ".",
        "..",
        "attempt-1",
        "a/b",
        r"a\b",
        "46578ff1-efff-1bf4-8ce4-22ccda091dc3",
        "46578ff1-efff-4bf4-7ce4-22ccda091dc3",
        "46578ff1-efff-4bf4-8ce4-22ccda091dc3\n",
    ):
        assert re.fullmatch(python_guid_pattern, invalid) is None


def test_fem_gpu_execution_receipt_recipe_uses_canonical_windows_launcher() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")
    start = justfile.index("verify-fem-gpu-execution-receipt-contract:")
    end = justfile.index("\nverify-fem-mesh-runner-abi-contract:", start)
    recipe = justfile[start:end]

    assert "scripts/windows/run_fullmag_fem.ps1" in recipe
    assert "-Contract gpu-execution-receipt" in recipe
    assert "docker compose" not in recipe
    assert "compose.yaml" not in recipe

    launcher = FEM_LAUNCHER.read_text(encoding="utf-8")
    for required in (
        '[ValidateSet("gpu-execution-receipt", "dmi-gpu", "gpu-benchmark-baseline", "gpu-nsight")]',
        "/workspace/.fullmag-build/contracts/fem-gpu-execution-receipt",
        "/workspace/.fullmag-build/cargo-targets/fem-gpu-execution-receipt",
        'Invoke-DockerCompose @("run", "--rm", "--no-deps", $ServiceName',
        "tests::gpu_performance_snapshot_v2_has_stable_layout_and_symbol",
        "types::fem_gpu_execution_receipt_contract_tests::performance_snapshot_v2_serializes_every_native_field",
        "artifacts::tests::artifact_serializes_complete_fem_gpu_performance_snapshot_v2",
    ):
        assert required in launcher


def test_fem_dmi_gpu_contract_recipe_uses_canonical_windows_launcher() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")
    start = justfile.index("verify-fem-dmi-gpu-contract:")
    end = justfile.index("\nverify-fem-mesh-runner-abi-contract:", start)
    recipe = justfile[start:end]

    assert "scripts/windows/run_fullmag_fem.ps1" in recipe
    assert "-Contract dmi-gpu" in recipe
    assert "docker compose" not in recipe

    launcher = FEM_LAUNCHER.read_text(encoding="utf-8")
    assert '$Contract -eq "dmi-gpu"' in launcher
    assert "fem_dmi_gpu_contract" in launcher
    assert "CPU fallback is forbidden" in launcher


def test_windows_fem_launcher_is_container_backed_without_direct_wsl_dependency() -> None:
    launcher = FEM_LAUNCHER.read_text(encoding="utf-8")

    for required in (
        "GetPathRoot($RepoRoot)",
        "Require-ExternalBuildPath",
        "docker compose",
        "BUILDX_BUILDER",
        "fullmag-windows",
        "buildx",
        "builderListExitCode",
        "builderListOutput",
        'ErrorActionPreference = "Continue"',
        "Get-Sha256File",
        "System.Security.Cryptography.SHA256",
        "FULLMAG_WINDOWS_REBUILD_FEM_IMAGE",
        "FullmagWindowsFEMBuild",
        "Waiting for Fullmag Windows build lock",
        "AbandonedMutexException",
        "ReleaseMutex",
        "docker image inspect",
        "imageOutput",
        "capture_source_snapshot_identity.py",
        "--ignore-non-runtime-dirty",
        "GIT_OPTIONAL_LOCKS",
        "FULLMAG_SOURCE_SNAPSHOT_SHA256",
        "--load",
        "docker info",
        "nvidia-smi",
        "compose.windows.yaml",
        "Get-WorkspaceNamespace",
        "$ComposeProjectName = \"fullmag-windows-fem-$WorkspaceNamespace-$Device\"",
        '$env:COMPOSE_PROJECT_NAME = $ComposeProjectName',
        '$DefaultFemCpuImage = "fullmag/fem-cpu:windows-local-$WorkspaceNamespace"',
        '$DefaultFemGpuImage = "fullmag/fem-gpu:windows-local-$WorkspaceNamespace"',
        '$ServiceName = "fullmag-windows-fem-$Device"',
        "CudaBaseImage",
        "CudaCacheKey",
        "FULLMAG_FORCE_LOCAL_FEM_GPU",
        "FULLMAG_CARGO_TARGET_ROOT",
        "CARGO_TARGET_ROOT",
        "FULLMAG_WINDOWS_NODE_MODULES_ROOT",
        "pnpm --dir /workspace/apps/control-room install --frozen-lockfile",
        "grep -Fxq cuda-fem-gpu",
        "FULLMAG_FEM_EXECUTION",
        "FULLMAG_RELAX_DEVICE",
        "FULLMAG_SP4_DEVICE",
        "FULLMAG_SP4_COMPATIBILITY",
        "FULLMAG_SP4_TOPOLOGY_VARIANT",
        "FULLMAG_SP4_RELAX_MAX_STEPS",
        "GetEnvironmentVariable",
        "FULLMAG_API_PORT=0",
        "CPU fallback",
    ):
        assert required in launcher
    assert "Require-DPath" not in launcher
    assert 'Invoke-External "wsl.exe"' not in launcher
    assert '"buildx", "build"' in launcher
    assert "run_fullmag.ps1" not in launcher


def test_windows_fem_launcher_captures_image_inspect_exit_code() -> None:
    launcher = FEM_LAUNCHER.read_text(encoding="utf-8")

    inspect = launcher.index("docker image inspect")
    exit_code = launcher.index("$imageInspectExitCode = $LASTEXITCODE", inspect)
    selection = launcher.index("$imageId = if", inspect)

    assert inspect < exit_code < selection
    assert 'Invoke-External "wsl.exe"' not in launcher


def test_windows_launchers_and_setup_namespace_default_storage_per_worktree() -> None:
    launcher = LAUNCHER.read_text(encoding="utf-8")
    fem_launcher = FEM_LAUNCHER.read_text(encoding="utf-8")
    setup = SETUP.read_text(encoding="utf-8")

    for script in (launcher, fem_launcher, setup):
        assert "function Get-WorkspaceNamespace" in script
        assert "$WorkspaceNamespace = Get-WorkspaceNamespace $RepoRoot" in script
        assert '"fullmag-cache\\$WorkspaceNamespace"' in script
        assert '"fullmag-build\\$WorkspaceNamespace"' in script
    assert '"fullmag-tmp\\$WorkspaceNamespace"' in fem_launcher
    assert '"fullmag-tmp\\$WorkspaceNamespace"' in setup
    assert '$env:COMPOSE_PROJECT_NAME = "fullmag-windows-fem"' not in fem_launcher


def test_managed_compose_recipes_do_not_use_a_global_project_name() -> None:
    justfile = (ROOT / "justfile").read_text(encoding="utf-8")
    helper = (ROOT / "scripts" / "resolve_fullmag_compose_project.sh").read_text(
        encoding="utf-8"
    )

    assert "COMPOSE_PROJECT_NAME=fullmag" not in justfile
    assert 'resolve_fullmag_compose_project.sh' in justfile
    assert "sha256sum" in helper
    assert "FULLMAG_REPO_ROOT" in helper
    assert "FULLMAG_COMPOSE_PROJECT_NAME" in helper


def test_windows_fem_image_override_is_used_for_runtime_validation() -> None:
    launcher = FEM_LAUNCHER.read_text(encoding="utf-8")

    runtime_image_block = launcher[launcher.index("$RuntimeImage ="):]
    assert "FULLMAG_WINDOWS_FEM_CPU_IMAGE" in runtime_image_block
    assert "FULLMAG_WINDOWS_FEM_GPU_IMAGE" in runtime_image_block


def test_windows_setup_bootstraps_tools_and_validates_storage() -> None:
    setup = SETUP.read_text(encoding="utf-8")

    for required in (
        "InstallMissing",
        "cargo",
        "just",
        "uv",
        "GetPathRoot($RepoRoot)",
        "FULLMAG_WINDOWS_CACHE_ROOT",
        "FULLMAG_WINDOWS_BUILD_ROOT",
        "FULLMAG_WINDOWS_TEMP_ROOT",
        "must be outside the repository",
        "vcvars64.bat",
        "Git\\bin\\bash.exe",
    ):
        assert required in setup


def test_justfile_exposes_windows_setup_doctor_and_build_only_routes() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    for recipe in ("windows-setup:", "windows-doctor:", "windows-build "):
        assert recipe in justfile
    assert '[ "$windows" = "true" ] || [ "$host_windows" = "true" ]' in justfile
    assert "-BuildOnly" in justfile


def test_windows_fem_build_script_uses_binary_safe_bash_payload() -> None:
    launcher = FEM_LAUNCHER.read_text(encoding="utf-8")

    assert '[System.Text.Encoding]::UTF8.GetBytes($buildCommand)' in launcher
    assert '[Convert]::ToBase64String($buildCommandBytes)' in launcher
    assert "base64 --decode | bash" in launcher
    assert '.Replace("`r`n", "`n").Replace("`r", "`n")' in launcher


def test_windows_fem_launcher_uses_windows_powershell_relative_path_api() -> None:
    launcher = FEM_LAUNCHER.read_text(encoding="utf-8")

    assert "MakeRelativeUri" in launcher
    assert "Path.GetRelativePath" not in launcher


def test_windows_fem_interactive_launch_omits_empty_compose_environment_entries() -> None:
    launcher = FEM_LAUNCHER.read_text(encoding="utf-8")

    assert '$(if ($RunMode -eq "headless") { "FULLMAG_API_PORT=0" } else { $null })' in launcher
    assert "[string]::IsNullOrWhiteSpace([string]$entry)" in launcher
    assert 'if ([string]::IsNullOrWhiteSpace([string]$entry)) {\n      continue\n    }' in launcher


def test_windows_fem_build_mutex_is_released_before_long_running_simulation() -> None:
    launcher = FEM_LAUNCHER.read_text(encoding="utf-8")

    manifest_boundary = launcher.index('  if ($BuildOnly) {')
    release_boundary = launcher.index(
        '  if ($buildMutexHeld) {', manifest_boundary
    )
    run_boundary = launcher.index('  if ($Device -eq "gpu") {', release_boundary)
    assert manifest_boundary < release_boundary < run_boundary
    assert '$buildMutexHeld = $false' in launcher[release_boundary:run_boundary]
    assert '$buildMutex = $null' in launcher[release_boundary:run_boundary]


def test_windows_fem_interactive_launch_separates_host_and_container_web_ports() -> None:
    launcher = FEM_LAUNCHER.read_text(encoding="utf-8")
    compose = WINDOWS_COMPOSE.read_text(encoding="utf-8")

    assert '$env:FULLMAG_WINDOWS_WEB_PORT = $WebPort.ToString()' in launcher
    assert '$containerWebPort = 3100' in launcher
    assert '$cliArguments += @("--web-port", $containerWebPort.ToString())' in launcher
    assert '$cliArguments += @("--web-port", $WebPort.ToString())' not in launcher
    assert '"${FULLMAG_WINDOWS_WEB_PORT:-3100}:3100"' in compose


def test_windows_compose_uses_only_bind_mounts_for_build_and_cache() -> None:
    compose = WINDOWS_COMPOSE.read_text(encoding="utf-8")

    assert "fullmag-windows-fem-gpu:" in compose
    assert "fullmag-windows-fem-cpu:" in compose
    assert "gpus: all" in compose
    assert "FULLMAG_WINDOWS_REPO" in compose
    assert "FULLMAG_WINDOWS_BUILD_ROOT" in compose
    assert "FULLMAG_WINDOWS_CACHE_ROOT" in compose
    assert "FULLMAG_WINDOWS_TEMP_ROOT" in compose
    assert compose.count("CMAKE_BUILD_PARALLEL_LEVEL") == 2
    assert compose.count("CARGO_BUILD_JOBS") == 2
    assert compose.count("GIT_OPTIONAL_LOCKS") == 2
    assert compose.count("FULLMAG_SOURCE_SNAPSHOT_SHA256") == 4
    assert "FULLMAG_WINDOWS_NODE_MODULES_ROOT" in compose
    assert "FULLMAG_CUDA_BASE_IMAGE" in compose
    assert "/workspace/.fullmag-cargo" in compose
    assert "/workspace/.fullmag-rustup" in compose
    assert "target: /workspace/node_modules" in compose
    assert "target: /workspace/apps/control-room/node_modules" in compose
    assert "target: /root/.cargo" not in compose
    assert "target: /root/.rustup" not in compose
    assert "volumes:" in compose
    assert "type: bind" in compose
    assert "entrypoint: []" in compose
    assert "D:/fullmag" not in compose
    assert "- cargo-cache:" not in compose
    assert "- target-cache:" not in compose
    assert "- pnpm-store:" not in compose


def test_fem_gpu_dockerfile_treats_nsight_as_optional() -> None:
    dockerfile = FEM_GPU_DOCKERFILE.read_text(encoding="utf-8")

    assert "2024.1.1" not in dockerfile
    assert "command -v nsys" in dockerfile
    assert "profiler tools are optional" in dockerfile


def test_fem_cpu_dockerfile_provides_control_room_toolchain() -> None:
    dockerfile = FEM_CPU_DOCKERFILE.read_text(encoding="utf-8")

    assert "ARG NODE_VERSION=24.18.0" in dockerfile
    assert "corepack enable" in dockerfile
    assert "pnpm@10.8.1" in dockerfile


def test_makefile_can_build_local_fem_gpu_without_linux_only_managed_export() -> None:
    makefile = (ROOT / "Makefile").read_text(encoding="utf-8")

    assert "FULLMAG_FORCE_LOCAL_FEM_GPU" in makefile
    assert '"cuda fem-gpu"' in makefile
    assert 'build_mode="cuda-fem-gpu"' in makefile


def test_makefile_can_build_container_local_fem_cpu() -> None:
    makefile = (ROOT / "Makefile").read_text(encoding="utf-8")

    assert "FULLMAG_FORCE_LOCAL_FEM_CPU" in makefile
    assert 'build_mode="fem-cpu"' in makefile
    assert '"fem-gpu"' in makefile
