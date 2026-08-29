from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
JUSTFILE = ROOT / "justfile"
LAUNCHER = ROOT / "scripts" / "windows" / "run_fullmag.ps1"
WSL_LAUNCHER = ROOT / "scripts" / "windows" / "run_fullmag_wsl.ps1"
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


def test_windows_launcher_stages_cuda_dll_from_target_triple_build_directory() -> None:
    launcher = LAUNCHER.read_text(encoding="utf-8")

    assert 'Join-Path $TargetRoot "$TargetTriple\\release\\build"' in launcher
    assert 'Join-Path $TargetRoot "release\\build"' not in launcher


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


def test_windows_fem_gpu_routes_to_wsl_before_posix_host_setup() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    assert "scripts/windows/run_fullmag_wsl.ps1" in justfile
    assert '[ "$backend" = "fem" ]' in justfile
    assert '[ "$device" = "gpu" ]' in justfile
    fullmag_start = justfile.index("fullmag opt_1")
    assert justfile.index("run_fullmag_wsl.ps1", fullmag_start) < justfile.index(
        "just ensure-python", fullmag_start
    )


def test_windows_fem_launcher_is_container_backed_without_direct_wsl_dependency() -> None:
    launcher = WSL_LAUNCHER.read_text(encoding="utf-8")

    for required in (
        "GetPathRoot($RepoRoot)",
        "Require-ExternalBuildPath",
        "docker compose",
        "BUILDX_BUILDER",
        "fullmag-windows",
        "buildx",
        "builderListExitCode",
        'ErrorActionPreference = "Continue"',
        "FULLMAG_WINDOWS_REBUILD_FEM_IMAGE",
        "docker image inspect",
        "capture_source_snapshot_identity.py",
        "FULLMAG_SOURCE_SNAPSHOT_SHA256",
        "--load",
        "docker info",
        "nvidia-smi",
        "compose.windows.yaml",
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
        "CPU fallback",
    ):
        assert required in launcher
    assert "Require-DPath" not in launcher
    assert 'Invoke-External "wsl.exe"' not in launcher
    assert '"buildx", "build"' in launcher
    assert "run_fullmag.ps1" not in launcher


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


def test_windows_wsl_build_script_uses_binary_safe_bash_payload() -> None:
    launcher = WSL_LAUNCHER.read_text(encoding="utf-8")

    assert '[System.Text.Encoding]::UTF8.GetBytes($buildCommand)' in launcher
    assert '[Convert]::ToBase64String($buildCommandBytes)' in launcher
    assert "base64 --decode | bash" in launcher
    assert '.Replace("`r`n", "`n").Replace("`r", "`n")' in launcher


def test_windows_wsl_launcher_uses_windows_powershell_relative_path_api() -> None:
    launcher = WSL_LAUNCHER.read_text(encoding="utf-8")

    assert "MakeRelativeUri" in launcher
    assert "Path.GetRelativePath" not in launcher


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
