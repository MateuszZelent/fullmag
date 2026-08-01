#!/usr/bin/env python3
"""Inspect native cubins and embedded PTX targets in a CUDA binary."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence


@dataclass(frozen=True)
class CudaCodeObjects:
    cubins: Sequence[str]
    ptx: Sequence[str]


def _architectures(output: str, prefix: str) -> Sequence[str]:
    pattern = re.compile(rf"\b{re.escape(prefix)}_[0-9]+\b")
    return tuple(sorted(set(pattern.findall(output))))


def _ptx_targets(output: str) -> Sequence[str]:
    pattern = re.compile(r"(?m)^\s*\.target\s+sm_([0-9]+[a-z]?)\b")
    return tuple(sorted({f"compute_{match}" for match in pattern.findall(output)}))


def inspect_cuda_binary(
    path: Path,
    cuobjdump: str = "cuobjdump",
    *,
    cuda_required: bool = False,
) -> CudaCodeObjects:
    path = path.resolve()
    if not path.is_file():
        raise RuntimeError(f"CUDA binary is missing: {path}")

    def run(flag: str) -> str:
        try:
            result = subprocess.run(
                [cuobjdump, flag, str(path)],
                check=False,
                capture_output=True,
                text=True,
            )
        except OSError as exc:
            raise RuntimeError(f"failed to execute {cuobjdump}: {exc}") from exc
        if result.returncode != 0:
            detail = result.stderr.strip() or result.stdout.strip()
            raise RuntimeError(f"{cuobjdump} {flag} failed for {path}: {detail}")
        return result.stdout

    objects = CudaCodeObjects(
        cubins=_architectures(run("--list-elf"), "sm"),
        ptx=_ptx_targets(run("--dump-ptx")),
    )
    if cuda_required and not objects.cubins and not objects.ptx:
        raise RuntimeError(f"no CUDA code objects found in required CUDA binary: {path}")
    return objects


def supports_native(objects: CudaCodeObjects, sm: str) -> bool:
    return sm in objects.cubins


def main() -> None:
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--cuobjdump", default="cuobjdump")
    parser.add_argument("--cuda-required", action="store_true")
    parser.add_argument("--require-native-cubin")
    args = parser.parse_args()
    try:
        objects = inspect_cuda_binary(
            args.binary,
            cuobjdump=args.cuobjdump,
            cuda_required=args.cuda_required,
        )
        if args.require_native_cubin and not supports_native(
            objects, args.require_native_cubin
        ):
            raise RuntimeError(
                f"required native cubin {args.require_native_cubin} is missing from "
                f"{args.binary.resolve()}; found {list(objects.cubins)}"
            )
        print(
            json.dumps(
                {
                    "binary": str(args.binary.resolve()),
                    "cubins": list(objects.cubins),
                    "ptx": list(objects.ptx),
                },
                sort_keys=True,
            )
        )
    except RuntimeError as exc:
        print(f"CUDA_ARCHITECTURE_INSPECTION_ERROR={exc}", file=sys.stderr)
        raise SystemExit(2) from exc


if __name__ == "__main__":
    main()
