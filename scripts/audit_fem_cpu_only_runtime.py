#!/usr/bin/env python3
"""Audit the dedicated managed FEM CPU verification lane before native build."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Mapping, Sequence


RECIPE_NAMES = (
    "verify-fem-steady-transport-cpu-only-contract",
    "verify-fem-time-domain-cpu-only-contract",
    "verify-fem-oersted-oet0-cpu-contract",
    "verify-fem-oersted-oet0-tsan-cpu-contract",
    "verify-fem-oersted-oef1-cpu-contract",
    "verify-fem-oersted-oef2-cpu-contract",
)

PLAN_RELATIVE_PATH = Path(
    "docs/superpowers/plans/2026-07-16-fem-oersted-conservative-current-direct-and-mixed.md"
)


class AuditViolation(ValueError):
    """Raised when evidence does not prove a CPU-only FEM runtime."""


@dataclass(frozen=True)
class AuditInputs:
    cmake_cache: Mapping[str, str]
    rust_features: Sequence[str]
    container_image: str
    compose_profiles: Sequence[str]
    device_runtime: str
    linked_libraries: Sequence[str]


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise AuditViolation(message)


def _normalized_tokens(values: Iterable[str]) -> list[str]:
    return sorted({value.strip().lower() for value in values if value.strip()})


def audit_configuration(inputs: AuditInputs) -> dict[str, object]:
    cmake = {key: str(value).strip().upper() for key, value in inputs.cmake_cache.items()}
    _require(
        cmake.get("FULLMAG_ENABLE_CUDA") == "OFF",
        "FULLMAG_ENABLE_CUDA must be recorded as OFF",
    )
    _require(
        cmake.get("FULLMAG_ENABLE_FEM_GPU") == "OFF",
        "FULLMAG_ENABLE_FEM_GPU must be recorded as OFF",
    )
    _require(
        cmake.get("FULLMAG_USE_MFEM_STACK") == "ON",
        "FULLMAG_USE_MFEM_STACK must be recorded as ON",
    )

    features = _normalized_tokens(inputs.rust_features)
    _require(
        not any(feature in {"cuda", "fem-gpu"} or "gpu" in feature for feature in features),
        "Rust GPU feature is forbidden in the FEM CPU-only lane",
    )

    image = inputs.container_image.strip().lower()
    _require(image == "fullmag/fem-cpu:local", "GPU image or unknown image selected")
    profiles = _normalized_tokens(inputs.compose_profiles)
    _require(not profiles, "GPU profile or any compose profile is forbidden")
    runtime = inputs.device_runtime.strip().lower()
    _require(runtime == "cpu", "device runtime must be exactly cpu")

    linked = [str(path).strip() for path in inputs.linked_libraries if str(path).strip()]
    _require(linked, "linked FEM dependency evidence is empty")
    lower_linked = [path.lower() for path in linked]
    forbidden_library_tokens = (
        "cuda",
        "cudart",
        "cusolver",
        "cusparse",
        "cublas",
        "nvrtc",
        "libnvidia",
        "libhip",
        "libamdhip",
    )
    _require(
        not any(token in path for path in lower_linked for token in forbidden_library_tokens),
        "CUDA-linked dependency or other accelerator library detected",
    )
    _require(any("libmfem" in path for path in lower_linked), "prebuilt MFEM library not evidenced")
    _require(any("libhypre" in path for path in lower_linked), "prebuilt hypre library not evidenced")

    return {
        "schema": "fullmag.fem.cpu_only_configuration_audit.v1",
        "status": "pass",
        "cmake": {
            "FULLMAG_ENABLE_CUDA": cmake["FULLMAG_ENABLE_CUDA"],
            "FULLMAG_ENABLE_FEM_GPU": cmake["FULLMAG_ENABLE_FEM_GPU"],
            "FULLMAG_USE_MFEM_STACK": cmake["FULLMAG_USE_MFEM_STACK"],
        },
        "rust_features": features,
        "container_image": image,
        "compose_profiles": profiles,
        "device_runtime": runtime,
        "linked_libraries": linked,
    }


def _recipe_body(justfile: str, name: str) -> str:
    match = re.search(
        rf"(?m)^{re.escape(name)}[^:]*:\s*\n(?P<body>(?:^[ \t]+.*(?:\n|$))*)",
        justfile,
    )
    _require(match is not None, f"missing CPU-only recipe: {name}")
    return match.group("body")


def _compose_service_body(compose: str, service: str) -> str:
    match = re.search(
        rf"(?m)^  {re.escape(service)}:\s*\n(?P<body>(?:^    .*(?:\n|$))*)",
        compose,
    )
    _require(match is not None, f"compose service {service} is missing")
    return match.group("body")


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def audit_repository_contract(root: Path) -> dict[str, object]:
    root = root.resolve()
    justfile_path = root / "justfile"
    compose_path = root / "compose.yaml"
    dockerfile_path = root / "docker/fem-cpu/Dockerfile"
    plan_path = root / PLAN_RELATIVE_PATH
    runner_path = root / "scripts/run_fem_cpu_only_contract.sh"
    fem_cmake_path = root / "backends/fem/CMakeLists.txt"
    for path in (justfile_path, compose_path, dockerfile_path, plan_path,
                 runner_path, fem_cmake_path):
        _require(path.is_file(), f"required CPU-only contract file is missing: {path}")

    justfile = justfile_path.read_text(encoding="utf-8")
    compose = compose_path.read_text(encoding="utf-8")
    dockerfile = dockerfile_path.read_text(encoding="utf-8")
    plan = plan_path.read_text(encoding="utf-8")
    runner = runner_path.read_text(encoding="utf-8")
    fem_cmake = fem_cmake_path.read_text(encoding="utf-8")

    for name in RECIPE_NAMES:
        body = _recipe_body(justfile, name)
        normalized = body.lower()
        _require(
            "--profile" not in normalized
            and "fem-gpu" not in normalized
            and "--features cuda" not in normalized,
            f"GPU-backed recipe is forbidden: {name}",
        )
        if name == "verify-fem-oersted-oet0-tsan-cpu-contract":
            _require(
                "docker compose build fem-cpu-tsan" in normalized,
                f"{name} does not build the isolated TSan service",
            )
            _require(
                "docker compose run --rm --no-deps fem-cpu-tsan" in normalized,
                f"{name} does not select the isolated TSan service",
            )
        else:
            _require(
                "docker compose build fem-cpu" in normalized,
                f"{name} does not build the repository-owned fem-cpu image",
            )
            _require(
                "docker compose run --rm --no-deps fem-cpu" in normalized,
                f"{name} does not select the isolated fem-cpu service",
            )
        _require(
            "scripts/run_fem_cpu_only_contract.sh" in normalized,
            f"{name} bypasses the pre-build CPU configuration audit",
        )
        if name == "verify-fem-oersted-oet0-tsan-cpu-contract":
            _require(
                "oersted-oet0-tsan" in normalized,
                "OE-T0 TSan recipe does not select its isolated scenario",
            )

    service = _compose_service_body(compose, "fem-cpu")
    lower_service = service.lower()
    _require(
        "image: fullmag/fem-cpu:local" in lower_service,
        "fem-cpu compose service must select fullmag/fem-cpu:local",
    )
    _require(
        not re.search(r"(?m)^    (?:profiles|gpus|runtime|devices):", lower_service),
        "fem-cpu compose service must not select a profile or device runtime",
    )
    _require(
        "fullmag_managed_fem_device: cpu" in lower_service,
        "fem-cpu compose service must attest device=cpu",
    )
    tsan_service = _compose_service_body(compose, "fem-cpu-tsan")
    lower_tsan_service = tsan_service.lower()
    _require(
        "service: fem-cpu" in lower_tsan_service
        and "security_opt:" in lower_tsan_service
        and "seccomp:unconfined" in lower_tsan_service,
        "fem-cpu-tsan must inherit fem-cpu and explicitly relax seccomp only for TSan",
    )

    lower_dockerfile = dockerfile.lower()
    dependency_forbidden = (
        "nvidia/cuda",
        "mfem_use_cuda=yes",
        "mfem_use_cuda=on",
        "--with-cuda",
        "--enable-cuda",
        "cuda_dir=",
    )
    _require(
        not any(token in lower_dockerfile for token in dependency_forbidden),
        "CPU dependency build contains an accelerator-enabled MFEM/hypre configuration",
    )
    _require(
        "mfem_use_cuda=no" in lower_dockerfile
        and "--without-cuda" in lower_dockerfile
        and "mfem_use_hypre=yes" in lower_dockerfile,
        "CPU dependency build must explicitly disable CUDA and enable hypre",
    )
    _require(
        "libboost-dev" in lower_dockerfile,
        "OE-T0 exact-rank build requires the managed Boost.Multiprecision headers",
    )

    forbidden_plan_patterns = (
        r"verify-fem-(steady-transport|time-domain)-native-contract",
        r"fem-gpu",
        r"gpu[-_ ]profile",
    )
    _require(
        not any(re.search(pattern, plan, flags=re.IGNORECASE) for pattern in forbidden_plan_patterns),
        "Oersted implementation plan references a forbidden GPU-backed verification lane",
    )

    for token in (
        "FULLMAG_OET0_DISABLE_MPI=1",
        "-fsanitize=thread",
        "-fno-omit-frame-pointer",
        "--tests-regex '^fem_conservative_current_view_contract$'",
        "conservative_constraint_rank.cpp",
        "periodic_charge_potential.cpp",
        "conservative_current_view.cpp",
        "OE-T0 TSan generated instrumentation rules audit: PASS",
        "setarch x86_64 -R ctest",
    ):
        _require(token in runner, f"OE-T0 TSan runner contract missing: {token}")
    for token in (
        "FULLMAG_OET0_DISABLE_MPI=1",
        "-fsanitize=thread -fno-omit-frame-pointer",
        "if(NOT FULLMAG_OET0_TSAN)",
        "target_sources(fullmag_fem PRIVATE",
        "target_sources(fem_conservative_current_view_contract PRIVATE",
        "OE-T0 production source set is partial",
        "conservative_constraint_rank.cpp",
        "periodic_charge_potential.cpp",
        "conservative_current_view.cpp",
    ):
        _require(token in fem_cmake, f"OE-T0 TSan CMake contract missing: {token}")

    return {
        "schema": "fullmag.fem.cpu_only_repository_contract.v1",
        "status": "pass",
        "recipes": list(RECIPE_NAMES),
        "evidence_sha256": {
            "justfile": _sha256(justfile_path),
            "compose": _sha256(compose_path),
            "dockerfile": _sha256(dockerfile_path),
            "plan": _sha256(plan_path),
            "runner": _sha256(runner_path),
            "fem_cmake": _sha256(fem_cmake_path),
        },
    }


def parse_cmake_cache(path: Path) -> dict[str, str]:
    cache: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith(("#", "//")) or "=" not in line:
            continue
        key_and_type, value = line.split("=", 1)
        key = key_and_type.split(":", 1)[0]
        cache[key] = value
    return cache


def linked_library_evidence(paths: Sequence[Path]) -> list[str]:
    evidence: list[str] = []
    for path in paths:
        _require(path.is_file(), f"dependency library is missing: {path}")
        evidence.append(str(path.resolve()))
        completed = subprocess.run(
            ["ldd", str(path)],
            check=False,
            capture_output=True,
            text=True,
        )
        _require(completed.returncode == 0, f"ldd failed for dependency library: {path}")
        for line in completed.stdout.splitlines():
            candidate = line.strip().split(" => ", 1)[-1].split(" ", 1)[0]
            if candidate.startswith("/"):
                evidence.append(candidate)
    return sorted(set(evidence))


def _write_report(path: Path, report: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("--repository-root", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--cmake-cache", type=Path)
    parser.add_argument("--rust-feature", action="append", default=[])
    parser.add_argument("--container-image", default="fullmag/fem-cpu:local")
    parser.add_argument("--compose-profile", action="append", default=[])
    parser.add_argument("--device-runtime", default="cpu")
    parser.add_argument("--dependency-library", action="append", type=Path, default=[])
    args = parser.parse_args()

    report: dict[str, object] = {
        "schema": "fullmag.fem.cpu_only_audit_bundle.v1",
        "status": "fail",
    }
    try:
        report["repository"] = audit_repository_contract(args.repository_root)
        if args.cmake_cache is not None:
            _require(args.dependency_library, "runtime audit requires dependency libraries")
            report["runtime"] = audit_configuration(
                AuditInputs(
                    cmake_cache=parse_cmake_cache(args.cmake_cache),
                    rust_features=args.rust_feature,
                    container_image=args.container_image,
                    compose_profiles=args.compose_profile,
                    device_runtime=args.device_runtime,
                    linked_libraries=linked_library_evidence(args.dependency_library),
                )
            )
        report["status"] = "pass"
    except (AuditViolation, OSError, ValueError) as error:
        report["violations"] = [str(error)]
        _write_report(args.report, report)
        print(str(error), file=sys.stderr)
        return 1

    _write_report(args.report, report)
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
