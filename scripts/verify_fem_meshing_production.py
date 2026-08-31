#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
ARCH_WAVEGUIDE_NODE_BUDGET = 75_000
ARCH_WAVEGUIDE_TETRA_BUDGET = 450_000
DEFAULT_INTERACTIVE_DENSE_RAM_BUDGET_BYTES = 12 * 1024 * 1024 * 1024
EVIDENCE_MANIFEST_SCHEMA_VERSION = "fem_meshing_production_gate.v1"
DEFAULT_EVIDENCE_MANIFEST = (
    REPO_ROOT / ".fullmag" / "reports" / "fem-meshing-production" / "evidence.v1.json"
)
REQUIRED_EVIDENCE_STAGES = (
    "native_fem_contract",
    "managed_native_runtime",
    "browser_mesh_smoke",
)


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


def _resolve_manifest_artifact(manifest_path: Path, raw_path: object) -> Path | None:
    if not isinstance(raw_path, str) or not raw_path.strip():
        return None
    root = manifest_path.resolve().parent
    path = Path(raw_path)
    candidate = path if path.is_absolute() else root / path
    try:
        resolved = candidate.resolve(strict=False)
        resolved.relative_to(root)
    except (OSError, ValueError):
        # Evidence paths are scoped to the manifest directory.  Reject both
        # ``..`` traversal and symlinks/junctions that resolve outside it.
        return None
    return resolved


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _require_artifact(
    errors: list[str],
    manifest_path: Path,
    stage_name: str,
    field_name: str,
    stage: dict[str, object],
) -> None:
    raw_path = stage.get(field_name)
    artifact = _resolve_manifest_artifact(manifest_path, raw_path)
    if artifact is None:
        if isinstance(raw_path, str) and raw_path.strip():
            errors.append(
                f"{stage_name}.{field_name} must resolve inside the evidence manifest directory"
            )
        else:
            errors.append(f"{stage_name}.{field_name} is required")
        return
    if not artifact.is_file():
        errors.append(f"{stage_name}.{field_name} does not exist: {artifact}")
        return

    declared_digest = stage.get(f"{field_name}_sha256")
    if declared_digest is None:
        declared_digest = stage.get("artifact_sha256")
    if declared_digest is None:
        return
    if not isinstance(declared_digest, str) or not re.fullmatch(
        r"sha256:[0-9a-fA-F]{64}", declared_digest
    ):
        errors.append(
            f"{stage_name}.{field_name}_sha256 must be a sha256:<64-hex> token"
        )
        return
    observed = f"sha256:{_sha256_file(artifact)}"
    if observed.lower() != declared_digest.lower():
        errors.append(
            f"{stage_name}.{field_name}_sha256 does not match artifact content"
        )


def validate_evidence_manifest(manifest_path: Path) -> list[str]:
    """Validate fail-closed proof for native, managed, and browser stages."""

    errors: list[str] = []
    if not manifest_path.is_file():
        return [f"evidence manifest is missing: {manifest_path}"]
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return [f"evidence manifest cannot be read: {exc}"]
    if not isinstance(payload, dict):
        return ["evidence manifest must be a JSON object"]
    if payload.get("schema_version") != EVIDENCE_MANIFEST_SCHEMA_VERSION:
        errors.append(
            "evidence manifest schema_version must be "
            f"{EVIDENCE_MANIFEST_SCHEMA_VERSION!r}"
        )
    if payload.get("status") != "passed":
        errors.append("evidence manifest status must be 'passed'")
    fingerprint = payload.get("mesh_fingerprint")
    if not isinstance(fingerprint, str) or not fingerprint.startswith("sha256:"):
        errors.append("evidence manifest mesh_fingerprint must be a sha256 token")

    stages = payload.get("stages")
    if not isinstance(stages, dict):
        errors.append("evidence manifest stages must be an object")
        errors.extend(
            f"required evidence stage is missing: {stage_name}"
            for stage_name in REQUIRED_EVIDENCE_STAGES
        )
        return errors
    for stage_name in REQUIRED_EVIDENCE_STAGES:
        stage = stages.get(stage_name)
        if not isinstance(stage, dict):
            errors.append(f"required evidence stage is missing: {stage_name}")
            continue
        if stage.get("status") != "passed":
            errors.append(f"{stage_name}.status must be 'passed'")
        stage_fingerprint = stage.get("mesh_fingerprint")
        if stage_fingerprint != fingerprint:
            errors.append(
                f"{stage_name}.mesh_fingerprint must match evidence manifest mesh_fingerprint"
            )
        if stage_name == "native_fem_contract":
            _require_artifact(errors, manifest_path, stage_name, "result_path", stage)
        elif stage_name == "managed_native_runtime":
            _require_artifact(errors, manifest_path, stage_name, "artifact_path", stage)
        else:
            _require_artifact(errors, manifest_path, stage_name, "screenshot_path", stage)
            metrics = stage.get("metrics")
            if not isinstance(metrics, dict):
                errors.append("browser_mesh_smoke.metrics must be an object")
                continue
            if metrics.get("canvas_visible") is not True:
                errors.append("browser_mesh_smoke.metrics.canvas_visible must be true")
            if metrics.get("context_lost") is not False:
                errors.append("browser_mesh_smoke.metrics.context_lost must be false")
            for field_name in ("drawing_buffer_width", "drawing_buffer_height"):
                value = metrics.get(field_name)
                if not isinstance(value, (int, float)) or value <= 0:
                    errors.append(
                        f"browser_mesh_smoke.metrics.{field_name} must be > 0"
                    )
    return errors


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
    parser.add_argument("--manifest", type=Path, default=DEFAULT_EVIDENCE_MANIFEST)
    args = parser.parse_args()

    manifest_errors = validate_evidence_manifest(args.manifest)
    checks = [
        CheckResult(
            name="production_evidence_manifest",
            status="passed" if not manifest_errors else "failed",
            command=[sys.executable, str(Path(__file__)), "--manifest", str(args.manifest)],
            stdout_tail=json.dumps(
                {"manifest": str(args.manifest), "errors": manifest_errors},
                indent=2,
            ),
            stderr_tail="",
        ),
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
        run_check(
            "python_mixed_shared_domain_meshing_tests",
            [
                sys.executable,
                "-m",
                "pytest",
                "packages/fullmag-py/tests/test_mixed_element_meshing.py",
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
