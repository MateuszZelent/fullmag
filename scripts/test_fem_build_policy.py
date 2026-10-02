"""Run FEM build-policy CMake checks without compiling any native sources."""

import itertools
from pathlib import Path
import shutil
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]
POLICY = ROOT / "native/cmake/RequireFemGpu.cmake"


def configure(source, build, arguments=()):
    cmake = shutil.which("cmake")
    if not cmake:
        pytest.skip("CMake is required for configuration checks")
    return subprocess.run(
        [cmake, "-S", str(source), "-B", str(build), *arguments],
        capture_output=True, text=True, errors="replace", timeout=30,
    )


@pytest.mark.parametrize("stack,cuda,gpu", itertools.product([False, True], repeat=3))
def test_required_gpu_rejects_every_disabled_prerequisite(tmp_path, stack, cuda, gpu):
    source = tmp_path / "source"
    source.mkdir()
    (source / "CMakeLists.txt").write_text(
        f'''cmake_minimum_required(VERSION 3.18)
project(policy LANGUAGES NONE)
set(FULLMAG_FEM_REQUIRE_GPU ON)
set(FULLMAG_USE_MFEM_STACK {'ON' if stack else 'OFF'})
set(FULLMAG_ENABLE_CUDA {'ON' if cuda else 'OFF'})
set(FULLMAG_ENABLE_FEM_GPU {'ON' if gpu else 'OFF'})
include("{POLICY.as_posix()}")
fullmag_require_fem_gpu_configuration()
''', encoding="utf-8",
    )
    result = configure(source, tmp_path / "configure")
    if stack and cuda and gpu:
        assert result.returncode == 0, result.stderr
    else:
        assert result.returncode != 0
        assert "Required FEM GPU needs" in result.stderr


@pytest.mark.parametrize("require_gpu", [False, True])
def test_native_frontdoor_cpu_does_not_probe_cuda_and_required_gpu_cannot_fallback(
    tmp_path, require_gpu
):
    source = tmp_path / "native"
    source.mkdir()
    # Keep production control flow; replace only compiler initialization.
    text = (ROOT / "native/CMakeLists.txt").read_text(encoding="utf-8")
    assert text.count("project(fullmag_native LANGUAGES C CXX)") == 1
    text = text.replace("project(fullmag_native LANGUAGES C CXX)",
                        "project(fullmag_native LANGUAGES NONE)")
    (source / "CMakeLists.txt").write_text(text, encoding="utf-8")
    shutil.copytree(ROOT / "native/cmake", source / "cmake")
    modules = source / "probe"
    modules.mkdir()
    # The GPU case models absence of nvcc; the CPU case must never probe it.
    body = "set(CMAKE_CUDA_COMPILER NOTFOUND PARENT_SCOPE)" if require_gpu else "message(FATAL_ERROR \"CPU build unexpectedly probed CUDA\")"
    (modules / "CheckLanguage.cmake").write_text(
        f"function(check_language language)\n{body}\nendfunction()\n", encoding="utf-8",
    )
    backends = tmp_path / "backends"
    for backend in ("fdm", "fem"):
        path = backends / backend
        path.mkdir(parents=True)
        (path / "CMakeLists.txt").write_text("# No solver sources in this configuration fixture\n")
    result = configure(source, tmp_path / "configure", [
        f"-DCMAKE_MODULE_PATH={modules.as_posix()}",
        f"-DFULLMAG_BACKENDS_ROOT={backends.as_posix()}",
        "-DFULLMAG_USE_MFEM_STACK=ON", "-DFULLMAG_FEM_WITH_SLEPC=OFF",
        f"-DFULLMAG_FEM_REQUIRE_GPU={'ON' if require_gpu else 'OFF'}",
        f"-DFULLMAG_ENABLE_CUDA={'ON' if require_gpu else 'OFF'}",
        f"-DFULLMAG_ENABLE_FEM_GPU={'ON' if require_gpu else 'OFF'}",
    ])
    if require_gpu:
        assert result.returncode != 0
        assert "Required FEM GPU has no CUDA compiler" in result.stderr
        assert "disabling" not in result.stderr
    else:
        assert result.returncode == 0, result.stderr


def test_cargo_and_managed_entrypoints_forward_explicit_build_policy():
    source = (ROOT / "crates/fullmag-fem-sys/build.rs").read_text(encoding="utf-8")
    assert "cargo:rerun-if-env-changed=FULLMAG_FEM_ENABLE_CUDA" in source
    assert "-DFULLMAG_FEM_REQUIRE_GPU={}" in source
    assert "-DFULLMAG_ENABLE_FEM_GPU={}" in source
    assert "FULLMAG_FEM_REQUIRE_GPU=1 conflicts with FULLMAG_FEM_ENABLE_CUDA=OFF" in source
    makefile = (ROOT / "Makefile").read_text(encoding="utf-8")
    cpu = makefile.split('elif [ "$${FULLMAG_FORCE_LOCAL_FEM_CPU:-0}" = "1" ]; then', 1)[1].split('elif [ -n "$$nvcc_bin" ]', 1)[0]
    assert cpu.count("FULLMAG_FEM_ENABLE_CUDA=OFF") == 2
    assert cpu.count('FULLMAG_FEM_WITH_SLEPC="$${FULLMAG_FEM_WITH_SLEPC:-OFF}"') == 2
    exporter = (ROOT / "scripts/export_fem_gpu_runtime.sh").read_text(encoding="utf-8")
    assert "FULLMAG_FEM_ENABLE_CUDA=ON FULLMAG_FEM_REQUIRE_GPU=1 cargo" in exporter
