"""Run the bounded native modal ABI contract on GitHub Actions only."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import time


MODAL_ADDRESS_SANITIZER_ENV = "FULLMAG_MODAL_ADDRESS_SANITIZER"
ADDRESS_SANITIZER_COMPILE_FLAGS = ["-fsanitize=address", "-fno-omit-frame-pointer", "-g"]
ADDRESS_SANITIZER_LINKER_FLAGS = ["-fsanitize=address"]
ADDRESS_SANITIZER_RUNTIME_OPTIONS = (
    "detect_stack_use_after_return=1:halt_on_error=1:detect_leaks=0"
)


def main() -> int:
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("Native contract compilation is restricted to GitHub Actions")
    root = Path(os.environ["RUNNER_TEMP"]).resolve(strict=True) / "fullmag-modal-cabi"
    root.mkdir(exist_ok=False)
    build = root / "build"
    sanitizer_request = os.environ.get(MODAL_ADDRESS_SANITIZER_ENV)
    sanitizer_enabled = sanitizer_request == "1"
    sanitizer_value_valid = sanitizer_request in (None, "0", "1")
    diagnostic_mode = (
        "address_sanitizer" if sanitizer_enabled
        else "standard" if sanitizer_value_valid
        else "invalid_request"
    )
    cmake_flags = [
        "-DFULLMAG_ENABLE_CUDA=OFF", "-DFULLMAG_ENABLE_FEM_GPU=OFF",
        "-DFULLMAG_FEM_REQUIRE_GPU=OFF", "-DFULLMAG_USE_MFEM_STACK=OFF",
        "-DFULLMAG_FEM_WITH_SLEPC=OFF",
    ]
    if sanitizer_enabled:
        compile_flags = " ".join(ADDRESS_SANITIZER_COMPILE_FLAGS)
        linker_flags = " ".join(ADDRESS_SANITIZER_LINKER_FLAGS)
        cmake_flags.extend([
            f"-DCMAKE_C_FLAGS={compile_flags}",
            f"-DCMAKE_CXX_FLAGS={compile_flags}",
            f"-DCMAKE_EXE_LINKER_FLAGS={linker_flags}",
            f"-DCMAKE_SHARED_LINKER_FLAGS={linker_flags}",
        ])
    target = "fem_modal_eigen_contract"
    default_targets = [
        target, "fem_mode_kinematics_contract", "fem_floquet_modal_solver_contract",
        "fem_poisson_airbox_schur_matshell_contract",
    ]
    targets = [target] if sanitizer_enabled else default_targets
    default_test_pattern = (
        "^(fem_modal_eigen_contract|fem_mode_kinematics_contract|"
        "fem_floquet_modal_solver_contract|"
        "fem_poisson_airbox_window_retry_policy_contract)$"
    )
    test_pattern = f"^{target}$" if sanitizer_enabled else default_test_pattern
    receipt = {
        "schema": "fullmag.ci.native_contract.v1", "source_sha": None, "requested_sha": os.environ.get("GITHUB_SHA"),
        "target": target, "targets": targets, "cmake_flags": cmake_flags,
        "diagnostic_mode": diagnostic_mode,
        "diagnostic_options": {
            "environment_variable": MODAL_ADDRESS_SANITIZER_ENV,
            "requested_value": sanitizer_request,
            "compile_flags": ADDRESS_SANITIZER_COMPILE_FLAGS if sanitizer_enabled else [],
            "executable_linker_flags": ADDRESS_SANITIZER_LINKER_FLAGS if sanitizer_enabled else [],
            "shared_linker_flags": ADDRESS_SANITIZER_LINKER_FLAGS if sanitizer_enabled else [],
            "runtime_environment": (
                {"ASAN_OPTIONS": ADDRESS_SANITIZER_RUNTIME_OPTIONS}
                if sanitizer_enabled else {}
            ),
        },
        "scope": "dependency-free ABI contract only; no production FEM/GPU or scientific qualification",
        "started_at": time.time(), "steps": [], "status": "failed",
    }
    try:
        source = Path(os.environ["GITHUB_WORKSPACE"]).resolve(strict=True)
        sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()
        receipt["source_sha"] = sha
        if sha != os.environ["GITHUB_SHA"]:
            raise RuntimeError("Checkout identity differs from the requested CI source")
        if not sanitizer_value_valid:
            raise RuntimeError(
                f"{MODAL_ADDRESS_SANITIZER_ENV} must be unset, '0', or '1'"
            )
        commands = [
            ["cmake", "-S", str(source / "native"), "-B", str(build), *cmake_flags],
            ["cmake", "--build", str(build), "--target", *targets, "--parallel", "2"],
            ["ctest", "--test-dir", str(build / "backends" / "fem"),
             "-R", test_pattern, "--output-on-failure", "--no-tests=error"],
        ]
        for index, command in enumerate(commands):
            log = root / f"step-{index}.log"
            with log.open("wb") as output:
                command_env = None
                if sanitizer_enabled and command[0] == "ctest":
                    command_env = os.environ.copy()
                    command_env["ASAN_OPTIONS"] = ADDRESS_SANITIZER_RUNTIME_OPTIONS
                result = subprocess.run(
                    command, cwd=source, stdout=output, stderr=subprocess.STDOUT,
                    env=command_env,
                )
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
