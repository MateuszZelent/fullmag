#!/usr/bin/env python3
"""Contract tests for managed CUDA code-object inspection."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
INSPECTOR = REPO_ROOT / "scripts" / "inspect_cuda_architectures.py"


def load_inspector():
    spec = importlib.util.spec_from_file_location("inspect_cuda_architectures", INSPECTOR)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def fake_cuobjdump(tmp_path: Path, *, list_elf: str, ptx: str, fail: bool = False) -> Path:
    tool = tmp_path / "cuobjdump"
    tool.write_text(
        "#!/usr/bin/env python3\n"
        "import sys\n"
        f"LIST_ELF = {list_elf!r}\n"
        f"PTX = {ptx!r}\n"
        f"FAIL = {fail!r}\n"
        "if FAIL:\n"
        "    print('synthetic cuobjdump failure', file=sys.stderr)\n"
        "    raise SystemExit(7)\n"
        "print(LIST_ELF if sys.argv[1] == '--list-elf' else PTX)\n",
        encoding="utf-8",
    )
    tool.chmod(0o755)
    return tool


def test_parser_sorts_and_deduplicates_cubins_and_ptx_targets(tmp_path: Path) -> None:
    inspector = load_inspector()
    binary = tmp_path / "libcuda-bearing.so"
    binary.write_bytes(b"synthetic")
    tool = fake_cuobjdump(
        tmp_path,
        list_elf="ELF file 1: sm_89.cubin\nELF file 2: sm_80.cubin\nELF file 3: sm_89.cubin\n",
        ptx=".version 8.0\n.target sm_90\n.target sm_90\n",
    )

    objects = inspector.inspect_cuda_binary(binary, cuobjdump=str(tool))

    assert objects.cubins == ("sm_80", "sm_89")
    assert objects.ptx == ("compute_90",)
    assert inspector.supports_native(objects, "sm_89")
    assert not inspector.supports_native(objects, "sm_90")


def test_cuda_required_inspection_fails_when_no_code_objects_exist(tmp_path: Path) -> None:
    inspector = load_inspector()
    binary = tmp_path / "libempty.so"
    binary.write_bytes(b"synthetic")
    tool = fake_cuobjdump(tmp_path, list_elf="", ptx="")

    with pytest.raises(RuntimeError, match="no CUDA code objects"):
        inspector.inspect_cuda_binary(binary, cuobjdump=str(tool), cuda_required=True)


def test_inspection_reports_cuobjdump_failure_without_fallback(tmp_path: Path) -> None:
    inspector = load_inspector()
    binary = tmp_path / "libbroken.so"
    binary.write_bytes(b"synthetic")
    tool = fake_cuobjdump(tmp_path, list_elf="", ptx="", fail=True)

    with pytest.raises(RuntimeError, match="synthetic cuobjdump failure"):
        inspector.inspect_cuda_binary(binary, cuobjdump=str(tool))


def test_cli_requires_requested_native_cubin(tmp_path: Path) -> None:
    binary = tmp_path / "libsm52-only.so"
    binary.write_bytes(b"synthetic")
    tool = fake_cuobjdump(
        tmp_path,
        list_elf="ELF file 1: sm_52.cubin\n",
        ptx=".target sm_52\n",
    )

    result = subprocess.run(
        [
            sys.executable,
            str(INSPECTOR),
            "--binary",
            str(binary),
            "--cuobjdump",
            str(tool),
            "--require-native-cubin",
            "sm_89",
        ],
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode != 0
    assert "required native cubin sm_89" in result.stderr


def test_cli_emits_machine_readable_code_objects(tmp_path: Path) -> None:
    binary = tmp_path / "libsm89.so"
    binary.write_bytes(b"synthetic")
    tool = fake_cuobjdump(
        tmp_path,
        list_elf="ELF file 1: sm_89.cubin\n",
        ptx=".target sm_90\n",
    )

    result = subprocess.run(
        [
            sys.executable,
            str(INSPECTOR),
            "--binary",
            str(binary),
            "--cuobjdump",
            str(tool),
            "--cuda-required",
            "--require-native-cubin",
            "sm_89",
        ],
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {
        "binary": str(binary.resolve()),
        "cubins": ["sm_89"],
        "ptx": ["compute_90"],
    }


def test_build_script_tracks_and_forwards_cuda_architecture_environment() -> None:
    build_script = (REPO_ROOT / "crates" / "fullmag-fem-sys" / "build.rs").read_text(
        encoding="utf-8"
    )

    assert "cargo:rerun-if-env-changed=FULLMAG_CUDA_ARCHITECTURES" in build_script
    assert "FULLMAG_CUDA_ARCHITECTURES" in build_script
    assert "-DCMAKE_CUDA_ARCHITECTURES=" in build_script


def test_managed_build_paths_declare_portable_fullmag_and_hypre_matrices() -> None:
    compose = (REPO_ROOT / "compose.yaml").read_text(encoding="utf-8")
    dockerfile = (REPO_ROOT / "docker" / "fem-gpu" / "Dockerfile").read_text(
        encoding="utf-8"
    )
    exporter = (REPO_ROOT / "scripts" / "export_fem_gpu_runtime.sh").read_text(
        encoding="utf-8"
    )

    assert "80-real;89-real;90-real;90-virtual" in compose
    assert "FULLMAG_HYPRE_GPU_ARCHITECTURES" in compose
    assert "60 70 80 89 90" in compose
    assert "FULLMAG_CUDA_ARCHITECTURES" in dockerfile
    assert "FULLMAG_HYPRE_GPU_ARCHITECTURES" in dockerfile
    assert '--with-gpu-arch="${FULLMAG_HYPRE_GPU_ARCHITECTURES}"' in dockerfile
    assert 'FULLMAG_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES}"' in exporter
