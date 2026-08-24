from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
JUSTFILE = ROOT / "justfile"
LAUNCHER = ROOT / "scripts" / "windows" / "run_fullmag.ps1"
WSL_LAUNCHER = ROOT / "scripts" / "windows" / "run_fullmag_wsl.ps1"
WINDOWS_COMPOSE = ROOT / "compose.windows.yaml"


def test_justfile_exposes_native_windows_fullmag_route() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    assert 'set windows-shell := ["C:\\\\Program Files\\\\Git\\\\bin\\\\bash.exe"' in justfile
    assert 'windows="false"' in justfile
    assert "--windows|windows)" in justfile
    assert "--native|native)" in justfile
    assert "run_fullmag_wsl.ps1" in justfile
    assert "scripts/windows/run_fullmag.ps1" in justfile
    assert "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File" in justfile
    assert "windows=True" in justfile


def test_windows_wsl_launcher_uses_cuda_container_with_d_backed_storage() -> None:
    launcher = WSL_LAUNCHER.read_text(encoding="utf-8")

    assert '$defaultCacheRoot = "D:\\fullmag-cache"' in launcher
    assert '$defaultBuildRoot = "D:\\fullmag-build"' in launcher
    assert '"docker"' in launcher
    assert '"compose"' in launcher
    assert "compose.windows.yaml" in launcher
    assert "fullmag-wsl-gpu" in launcher
    assert "FULLMAG_WINDOWS_CACHE_ROOT" in launcher
    assert "FULLMAG_WINDOWS_BUILD_ROOT" in launcher
    assert "FULLMAG_CARGO_TARGET_DIR" in launcher
    assert "Require-DPath" in launcher
    assert '"nvidia-smi"' in launcher
    assert '"-L"' in launcher
    assert "CPU fallback" in launcher
    assert "Import-VsEnvironment" not in launcher
    assert "vcvars64.bat" not in launcher
    assert "fullmag.exe" not in launcher


def test_windows_compose_replaces_named_build_volumes_with_d_bind_mounts() -> None:
    compose = WINDOWS_COMPOSE.read_text(encoding="utf-8")

    assert "fullmag-wsl-gpu:" in compose
    assert "type: bind" in compose
    for target in (
        "/workspace",
        "/workspace/.fullmag",
        "/workspace/.fullmag-build",
        "/workspace/.fullmag-cache",
        "/tmp",
    ):
        assert target in compose
    assert "target-cache:" not in compose
    assert "pnpm-store:" not in compose


def test_windows_wsl_launcher_requires_linux_docker_wsl_and_gpu() -> None:
    launcher = WSL_LAUNCHER.read_text(encoding="utf-8")

    assert "wsl.exe" in launcher
    assert '"info"' in launcher
    assert "OSType" in launcher
    assert "Linux container backend" in launcher
    assert "FULLMAG_FDM_EXECUTION" in launcher
    assert "FULLMAG_SKIP_MANAGED_FEM_GPU_EXPORT" in launcher
    assert "build-manifest.json" in launcher


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
