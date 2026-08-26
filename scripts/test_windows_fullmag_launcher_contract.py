from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
JUSTFILE = ROOT / "justfile"
LAUNCHER = ROOT / "scripts" / "windows" / "run_fullmag.ps1"
WSL_LAUNCHER = ROOT / "scripts" / "windows" / "run_fullmag_wsl.ps1"
WINDOWS_COMPOSE = ROOT / "compose.windows.yaml"
FEM_GPU_DOCKERFILE = ROOT / "docker" / "fem-gpu" / "Dockerfile"


def test_justfile_exposes_native_windows_fullmag_route() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    assert 'set windows-shell := ["C:\\\\Program Files\\\\Git\\\\bin\\\\bash.exe"' in justfile
    assert 'windows="false"' in justfile
    assert "--windows|windows)" in justfile
    assert "scripts/windows/run_fullmag.ps1" in justfile
    assert "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File" in justfile
    assert "windows=True" in justfile


def test_windows_launcher_keeps_build_and_cache_storage_on_d() -> None:
    launcher = LAUNCHER.read_text(encoding="utf-8")

    assert '$defaultCacheRoot = "D:\\fullmag-cache"' in launcher
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


def test_windows_fem_gpu_routes_to_wsl_before_posix_host_setup() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    assert "scripts/windows/run_fullmag_wsl.ps1" in justfile
    assert '[ "$backend" = "fem" ]' in justfile
    assert '[ "$device" = "gpu" ]' in justfile
    fullmag_start = justfile.index("fullmag opt_1")
    assert justfile.index("run_fullmag_wsl.ps1", fullmag_start) < justfile.index(
        "just ensure-python", fullmag_start
    )


def test_windows_wsl_fem_gpu_launcher_is_container_backed_and_d_resident() -> None:
    launcher = WSL_LAUNCHER.read_text(encoding="utf-8")

    for path in ("D:\\fullmag-cache", "D:\\fullmag-build", "D:\\fullmag-tmp"):
        assert path in launcher
    for required in (
        "wsl.exe",
        "docker compose",
        "BUILDX_BUILDER",
        "fullmag-windows",
        "buildx",
        "--load",
        "docker info",
        "nvidia-smi",
        "compose.windows.yaml",
        "fullmag-windows-fem-gpu",
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
    assert '"buildx", "build"' in launcher
    assert "run_fullmag.ps1" not in launcher


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
    assert "gpus: all" in compose
    assert "FULLMAG_WINDOWS_REPO" in compose
    assert "FULLMAG_WINDOWS_BUILD_ROOT" in compose
    assert "FULLMAG_WINDOWS_CACHE_ROOT" in compose
    assert "FULLMAG_WINDOWS_TEMP_ROOT" in compose
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
    assert "- cargo-cache:" not in compose
    assert "- target-cache:" not in compose
    assert "- pnpm-store:" not in compose


def test_fem_gpu_dockerfile_treats_nsight_as_optional() -> None:
    dockerfile = FEM_GPU_DOCKERFILE.read_text(encoding="utf-8")

    assert "2024.1.1" not in dockerfile
    assert "command -v nsys" in dockerfile
    assert "profiler tools are optional" in dockerfile


def test_makefile_can_build_local_fem_gpu_without_linux_only_managed_export() -> None:
    makefile = (ROOT / "Makefile").read_text(encoding="utf-8")

    assert "FULLMAG_FORCE_LOCAL_FEM_GPU" in makefile
    assert '"cuda fem-gpu"' in makefile
    assert 'build_mode="cuda-fem-gpu"' in makefile
