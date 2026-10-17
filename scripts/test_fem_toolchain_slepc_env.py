#!/usr/bin/env python3
"""Check the CPU SLEPc prefix-build environment contract.

This is an interpreted source/command-boundary check.  It deliberately uses
fake configure/make tools instead of Docker, CMake, or a native toolchain.
"""

from __future__ import annotations

import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


REPO_ROOT = Path(__file__).resolve().parents[1]
DOCKERFILE = REPO_ROOT / "docker" / "fem-gpu" / "Dockerfile"


def _section(source: str, start: str, end: str) -> str:
    start_at = source.index(start)
    end_at = source.index(end, start_at)
    return source[start_at:end_at]


def _assert_source_contract() -> None:
    source = DOCKERFILE.read_text(encoding="utf-8")
    cpu_slepc = _section(
        source,
        "RUN git clone --no-hardlinks /tmp/build/slepc /tmp/build/slepc-cpu",
        "# The CPU FEM client is compiled with the host C++ compiler.",
    )
    cpu_petsc = _section(
        source,
        "RUN git clone --no-hardlinks /tmp/build/petsc /tmp/build/petsc-cpu",
        "RUN git clone --no-hardlinks /tmp/build/slepc /tmp/build/slepc-cpu",
    )
    gpu_petsc = _section(
        source,
        "RUN git clone --depth 1 --branch ${PETSC_REF}",
        "RUN git clone --depth 1 --branch ${SLEPC_REF}",
    )

    assert "unset PETSC_ARCH" in cpu_slepc, cpu_slepc
    assert cpu_slepc.count("env -u PETSC_ARCH") == 3, cpu_slepc
    assert not re.search(r"(?<![A-Za-z0-9_])PETSC_ARCH\s*=", cpu_slepc), cpu_slepc
    for command in ("python3 ./configure", "make -j2 all", "make install"):
        assert command in cpu_slepc, (command, cpu_slepc)

    # The CPU PETSc build still owns its explicit arch; the GPU stack remains
    # explicitly CUDA-enabled.  This guards against a broad search/replace.
    assert "PETSC_ARCH=arch-linux-cpu" in cpu_petsc, cpu_petsc
    assert "PETSC_ARCH=arch-linux-cuda" in gpu_petsc, gpu_petsc


def _write_fake_tool(path: Path) -> None:
    path.write_text(
        """#!/usr/bin/env python3
import os
import sys

if len(sys.argv) < 2 or sys.argv[1] not in {"configure", "make"}:
    raise SystemExit("unexpected fake tool invocation")
if "PETSC_ARCH" in os.environ:
    print("inherited PETSC_ARCH must be unset", file=sys.stderr)
    raise SystemExit(21)
if any(argument.startswith("PETSC_ARCH=") for argument in sys.argv[2:]):
    print("SLEPc command-line PETSC_ARCH= is forbidden", file=sys.stderr)
    raise SystemExit(22)
""",
        encoding="utf-8",
    )


def _run_boundary_checks() -> None:
    env_command = shutil.which("env")
    assert env_command, "the env -u command boundary is required"

    with tempfile.TemporaryDirectory(prefix="fullmag-slepc-contract-") as temporary:
        fake_tool = Path(temporary) / "fake_slepc_tool.py"
        _write_fake_tool(fake_tool)
        inherited = os.environ.copy()
        inherited["PETSC_ARCH"] = "arch-linux-cpu"

        def run_unset(*arguments: str) -> subprocess.CompletedProcess[str]:
            return subprocess.run(
                [
                    env_command,
                    "-u",
                    "PETSC_ARCH",
                    sys.executable,
                    str(fake_tool),
                    *arguments,
                ],
                env=inherited,
                check=False,
                capture_output=True,
                text=True,
            )

        for arguments in (
            ("configure", "--prefix=/opt/fullmag-mfem-cpu"),
            ("make", "all"),
            ("make", "install"),
        ):
            result = run_unset(*arguments)
            assert result.returncode == 0, (arguments, result.stdout, result.stderr)

        # Both failure modes from the old Dockerfile are rejected: an
        # inherited variable and an empty command-line override.
        inherited_result = subprocess.run(
            [sys.executable, str(fake_tool), "make", "all"],
            env=inherited,
            check=False,
            capture_output=True,
            text=True,
        )
        assert inherited_result.returncode != 0, inherited_result

        empty_argument_result = run_unset("make", "PETSC_ARCH=")
        assert empty_argument_result.returncode != 0, empty_argument_result


def main() -> int:
    _assert_source_contract()
    _run_boundary_checks()
    print("PASS: fem toolchain SLEPc PETSC_ARCH contract")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
