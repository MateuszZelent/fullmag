"""Run the bounded native modal ABI contract on GitHub Actions only."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import time


def main() -> int:
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("Native contract compilation is restricted to GitHub Actions")
    root = Path(os.environ["RUNNER_TEMP"]).resolve(strict=True) / "fullmag-modal-cabi"
    root.mkdir(exist_ok=False)
    build = root / "build"
    flags = [
        "-DFULLMAG_ENABLE_CUDA=OFF", "-DFULLMAG_ENABLE_FEM_GPU=OFF",
        "-DFULLMAG_FEM_REQUIRE_GPU=OFF", "-DFULLMAG_USE_MFEM_STACK=OFF",
        "-DFULLMAG_FEM_WITH_SLEPC=OFF",
    ]
    target = "fem_modal_eigen_contract"
    targets = [target, "fem_mode_kinematics_contract", "fem_floquet_modal_solver_contract"]
    receipt = {
        "schema": "fullmag.ci.native_contract.v1", "source_sha": None, "requested_sha": os.environ.get("GITHUB_SHA"),
        "target": target, "targets": targets, "cmake_flags": flags,
        "scope": "dependency-free ABI contract; no production FEM or scientific qualification",
        "started_at": time.time(), "steps": [], "status": "failed",
    }
    try:
        source = Path(os.environ["GITHUB_WORKSPACE"]).resolve(strict=True)
        sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()
        receipt["source_sha"] = sha
        if sha != os.environ["GITHUB_SHA"]:
            raise RuntimeError("Checkout identity differs from the requested CI source")
        commands = [
            ["cmake", "-S", str(source / "native"), "-B", str(build), *flags],
            ["cmake", "--build", str(build), "--target", *targets, "--parallel", "2"],
            ["ctest", "--test-dir", str(build / "backends" / "fem"),
             "-R", "^(fem_modal_eigen_contract|fem_mode_kinematics_contract|fem_floquet_modal_solver_contract)$", "--output-on-failure", "--no-tests=error"],
        ]
        for index, command in enumerate(commands):
            log = root / f"step-{index}.log"
            with log.open("wb") as output:
                result = subprocess.run(command, cwd=source, stdout=output, stderr=subprocess.STDOUT)
            print(log.read_text(encoding="utf-8", errors="replace"), flush=True)
            receipt["steps"].append({"argv": command, "exit_code": result.returncode,
                                    "log_sha256": hashlib.sha256(log.read_bytes()).hexdigest()})
            if result.returncode != 0:
                return result.returncode
        executable = build / "backends" / "fem" / target
        receipt["executable_sha256"] = hashlib.sha256(executable.read_bytes()).hexdigest()
        receipt["executable_sha256_by_target"] = {
            name: hashlib.sha256((build / "backends" / "fem" / name).read_bytes()).hexdigest()
            for name in targets
        }
        receipt["status"] = "passed"
        return 0
    except Exception as error:
        receipt["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        receipt["finished_at"] = time.time()
        (root / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    raise SystemExit(main())
