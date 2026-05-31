#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
ARCH_WAVEGUIDE_NODE_BUDGET = 75_000
ARCH_WAVEGUIDE_TETRA_BUDGET = 450_000
DEFAULT_INTERACTIVE_DENSE_RAM_BUDGET_BYTES = 12 * 1024 * 1024 * 1024


@dataclass
class CheckResult:
    name: str
    status: str
    command: list[str]
    stdout_tail: str
    stderr_tail: str


def _python_env(
    *,
    clear_thread_overrides: bool = False,
    gmsh_threads: int | None = None,
) -> dict[str, str]:
    env = dict(os.environ)
    package_path = str(REPO_ROOT / "packages" / "fullmag-py" / "src")
    existing = env.get("PYTHONPATH")
    env["PYTHONPATH"] = f"{package_path}:{existing}" if existing else package_path
    if clear_thread_overrides:
        env.pop("FULLMAG_GMSH_THREADS", None)
        env.pop("FULLMAG_CPU_THREADS", None)
    if gmsh_threads is not None:
        env["FULLMAG_GMSH_THREADS"] = str(gmsh_threads)
    return env


def run_check(name: str, command: list[str]) -> CheckResult:
    env = _python_env(clear_thread_overrides=True)
    completed = subprocess.run(
        command,
        cwd=REPO_ROOT,
        env=env,
        text=True,
        capture_output=True,
    )
    status = "passed" if completed.returncode == 0 else "failed"
    return CheckResult(
        name=name,
        status=status,
        command=command,
        stdout_tail=completed.stdout[-4000:],
        stderr_tail=completed.stderr[-4000:],
    )


def _estimate_dense_fem_ram_bytes(node_count: int) -> int:
    return int(node_count) * int(node_count) * 24


def _uses_poisson_demag(payload: dict[str, object]) -> bool:
    candidate_irs: list[dict[str, object]] = []
    ir = payload.get("ir")
    if isinstance(ir, dict):
        candidate_irs.append(ir)
    stages = payload.get("stages")
    if isinstance(stages, list):
        for stage in stages:
            if isinstance(stage, dict) and isinstance(stage.get("ir"), dict):
                candidate_irs.append(stage["ir"])
    for candidate in candidate_irs:
        terms = candidate.get("energy_terms")
        if not isinstance(terms, list):
            continue
        for term in terms:
            if (
                isinstance(term, dict)
                and term.get("kind") == "demag"
                and str(term.get("realization", "")).startswith("poisson_")
            ):
                return True
    return False


def _scope_by_role(stats: dict[str, object], role: str) -> dict[str, object] | None:
    scopes = stats.get("scopes")
    if not isinstance(scopes, list):
        return None
    for scope in scopes:
        if isinstance(scope, dict) and scope.get("role") == role:
            return scope
    return None


def run_arch_waveguide_budget_check() -> CheckResult:
    python = REPO_ROOT / ".fullmag" / "local" / "python" / "bin" / "python"
    command = [
        str(python),
        "-m",
        "fullmag.runtime.helper",
        "export-run-config",
        "--script",
        "examples/arch_waveguide_relax_50nm.py",
        "--backend",
        "fem",
    ]
    if not python.exists():
        return CheckResult(
            name="arch_waveguide_materialization_budget",
            status="failed",
            command=command,
            stdout_tail="",
            stderr_tail=f"missing local Python runtime: {python}",
        )

    started = time.perf_counter()
    completed = subprocess.run(
        command,
        cwd=REPO_ROOT,
        env=_python_env(gmsh_threads=8),
        text=True,
        capture_output=True,
    )
    elapsed = time.perf_counter() - started
    if completed.returncode != 0:
        return CheckResult(
            name="arch_waveguide_materialization_budget",
            status="failed",
            command=command,
            stdout_tail=completed.stdout[-4000:],
            stderr_tail=completed.stderr[-4000:],
        )

    try:
        payload = json.loads(completed.stdout)
        assets = payload["shared_geometry_assets"]
        mesh = assets["fem_domain_mesh_asset"]["mesh"]
        stats = mesh["mesh_statistics"]
        global_stats = stats["global"]
    except Exception as exc:  # noqa: BLE001 - verifier should report malformed payloads.
        return CheckResult(
            name="arch_waveguide_materialization_budget",
            status="failed",
            command=command,
            stdout_tail=completed.stdout[-4000:],
            stderr_tail=f"could not parse mesh statistics: {exc}\n{completed.stderr[-3000:]}",
        )

    node_count = int(global_stats.get("node_count", -1))
    element_count = int(global_stats.get("element_count", -1))
    dense_ram_bytes = _estimate_dense_fem_ram_bytes(node_count)
    dense_ram_status = (
        "not_applicable_poisson_demag"
        if _uses_poisson_demag(payload)
        else (
            "within_budget"
            if dense_ram_bytes <= DEFAULT_INTERACTIVE_DENSE_RAM_BUDGET_BYTES
            else "over_budget"
        )
    )
    air_scope = _scope_by_role(stats, "air")
    domain_scope = _scope_by_role(stats, "domain")
    summary = {
        "wall_time_seconds": round(elapsed, 3),
        "node_count": node_count,
        "tetrahedra": element_count,
        "boundary_faces": global_stats.get("boundary_face_count"),
        "node_budget": ARCH_WAVEGUIDE_NODE_BUDGET,
        "tetra_budget": ARCH_WAVEGUIDE_TETRA_BUDGET,
        "legacy_dense_ram_estimate_gb": round(dense_ram_bytes / 1e9, 2),
        "dense_ram_status": dense_ram_status,
        "gmsh_threads": 8,
        "airbox": {
            "nodes": air_scope.get("node_count") if air_scope else None,
            "tetrahedra": air_scope.get("element_count") if air_scope else None,
            "boundary_faces": air_scope.get("boundary_face_count") if air_scope else None,
            "sicn_p05": (air_scope.get("sicn") or {}).get("p05") if air_scope else None,
        },
        "magnetic_domain": {
            "nodes": domain_scope.get("node_count") if domain_scope else None,
            "tetrahedra": domain_scope.get("element_count") if domain_scope else None,
            "boundary_faces": domain_scope.get("boundary_face_count") if domain_scope else None,
            "sicn_p05": (domain_scope.get("sicn") or {}).get("p05") if domain_scope else None,
        },
    }
    failures: list[str] = []
    if node_count > ARCH_WAVEGUIDE_NODE_BUDGET:
        failures.append(f"node_count {node_count} exceeds {ARCH_WAVEGUIDE_NODE_BUDGET}")
    if element_count > ARCH_WAVEGUIDE_TETRA_BUDGET:
        failures.append(f"tetrahedra {element_count} exceeds {ARCH_WAVEGUIDE_TETRA_BUDGET}")
    if dense_ram_status == "over_budget":
        failures.append(
            "legacy dense FEM RAM estimate "
            f"{dense_ram_bytes / 1e9:.2f} GB exceeds "
            f"{DEFAULT_INTERACTIVE_DENSE_RAM_BUDGET_BYTES / 1e9:.2f} GB"
        )

    return CheckResult(
        name="arch_waveguide_materialization_budget",
        status="failed" if failures else "passed",
        command=command,
        stdout_tail=json.dumps(
            {"summary": summary, "failures": failures},
            indent=2,
        ),
        stderr_tail=completed.stderr[-4000:],
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    checks = [
        run_check(
            "python_meshing_tests",
            [
                sys.executable,
                "-m",
                "pytest",
                "packages/fullmag-py/tests/test_meshing.py",
                "-vv",
            ],
        ),
        run_check(
            "python_api_mesh_tests",
            [
                sys.executable,
                "-m",
                "pytest",
                "packages/fullmag-py/tests/test_api.py",
                "-k",
                "mesh or airbox or thin_film",
                "-vv",
            ],
        ),
        run_arch_waveguide_budget_check(),
    ]

    payload = {"checks": [asdict(check) for check in checks]}
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        for check in checks:
            print(f"{check.name}: {check.status}")
    return 0 if all(check.status == "passed" for check in checks) else 1


if __name__ == "__main__":
    raise SystemExit(main())
