#!/usr/bin/env python3
"""Run and validate the bounded BORIS/Fullmag N/F comparison matrix.

The Windows-only managed CPU matrix reuses three fixed BORIS runtime v2 references across
two Fullmag tolerances. Legacy 10/20/40 grids and a BORIS tolerance sweep are
unsupported. Solver failures remain ``not_run``; incompatible torques remain
``incomparable``. Structural validation never qualifies either solver.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path
from typing import Mapping, Sequence

from compare_boris_fullmag_she_nf import compare_transport_artifacts, load_fullmag_m2_artifact, normalize_boris_artifact
from run_managed_boris_nf import RESOLUTIONS, fixed_inputs, identifier, observe, read_json, storage
from run_fullmag_m2_nf_reference import Resolution, build_fullmag_nf_problem, run_fullmag_nf_reference


# The managed CPU launcher owns these three fixed meshes and BORIS tolerance.
# Reusing each reference below sweeps Fullmag tolerances only.
DEFAULT_RESOLUTIONS = tuple(
    Resolution(config.nx, config.ny, config.nz_n, config.nz_f,
               (config.cell_x_m, config.cell_y_m, config.cell_z_m))
    for config in (fixed_inputs(name)[0] for name in RESOLUTIONS)
)
DEFAULT_TOLERANCES = (1.0e-8, 1.0e-10)


def _finite(value: object, label: str) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)):
        raise ValueError(f"{label} must be finite")
    return float(value)


def _run_key(resolution: Resolution, tolerance: float) -> str:
    return (
        f"{resolution.nx}x{resolution.ny}x{resolution.nz_n}+{resolution.nz_f}"
        f"__tol-{tolerance:.0e}"
    )


def _sha256(path: Path) -> str:
    import hashlib

    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _write_json(path: Path, payload: object) -> None:
    path.write_text(json.dumps(payload, indent=2, sort_keys=True, allow_nan=False) + "\n", encoding="utf-8")


def _verify_fullmag_binary(binary: Path, expected: str, native_expected: str | None) -> dict[str, str]:
    pins = {"launcher": (binary, expected)}
    native = binary.with_name("fullmag-bin")
    if native.exists() or native_expected is not None:
        pins["native"] = (native, native_expected)
    result = {}
    for name, (path, sha256) in pins.items():
        if not isinstance(sha256, str) or re.fullmatch(r"[a-f0-9]{64}", sha256) is None:
            raise ValueError(f"Fullmag {name} requires an explicit SHA256 pin")
        if not path.is_file() or _sha256(path) != sha256:
            raise ValueError(f"Fullmag {name} binary differs from its SHA256 pin")
        result[name] = sha256
    return result


def _require_windows() -> None:
    if sys.platform != "win32":
        raise ValueError("managed BORIS matrix execution is Windows-only; Linux profiles are unsupported")


def _reference_pin(summary_path: Path) -> dict[str, object]:
    root = summary_path.parent.parent
    return {
        "identity": read_json(summary_path)["runtime"],
        "sha256": {name: _sha256(path) for name, path in (
            ("summary.json", summary_path),
            ("runtime.json", summary_path.parent / "runtime.json"),
            ("receipt.json", root / "receipt.json"),
            ("scenario.json", root / "input/scenario.json"),
        )},
    }


def _require_reference_pin(summary_path: Path, expected: Mapping[str, object]) -> None:
    try:
        unchanged = _reference_pin(summary_path) == expected
    except (OSError, ValueError, KeyError) as error:
        raise ValueError("managed BORIS pinned reference changed or became unreadable") from error
    if not unchanged:
        raise ValueError("managed BORIS pinned reference changed since initial admission")


def _managed_reference(repo_root: Path, name: str, runtime_id: str, resolution: Resolution):
    # Observe never launches/restarts a solver; pending IDs must be retried explicitly.
    observed = observe(repo_root, identifier(runtime_id))
    if isinstance(observed, dict):
        raise RuntimeError(f"managed BORIS {name} is pending: {runtime_id}; observe it before the matrix")
    summary_path = Path(observed)
    pin = _reference_pin(summary_path)
    artifact = normalize_boris_artifact(summary_path, repo_root=repo_root)
    _require_reference_pin(summary_path, pin)
    payload = read_json(summary_path)
    runtime = payload["runtime"]
    if runtime.get("schema_version") != "fullmag.boris.runtime.v2" or runtime.get("runtime_id") != runtime_id:
        raise ValueError("matrix requires the requested canonical managed BORIS runtime v2")
    if artifact.shape != resolution.shape or artifact.step_m != resolution.cell_m:
        raise ValueError(f"managed BORIS {name} grid differs from the requested Fullmag case")
    # Verify the common transport inputs through the same public DSL request used
    # by the Fullmag runner. Solver tolerances are intentionally separate.
    transport = build_fullmag_nf_problem(resolution)["transport"]
    parameters = payload["scenario"]["parameters"]
    for fullmag_key, boris_key in (
        ("SHA", "SHA"), ("iSHA", "iSHA"), ("De_m2_per_s", "De_m2_per_s"),
        ("elC_Spm", "elC_Spm"), ("lambda_sf_m", "lambda_sf_m"),
        ("Gi_Spm2", "Gi_Spm2"), ("Gmix_Spm2", "Gmix_Spm2"),
        ("current_density_apm2", "Jc_apm2"),
    ):
        if transport[fullmag_key] != parameters[boris_key]:
            raise ValueError(f"managed BORIS/Fullmag parameter differs: {boris_key}")
    _require_reference_pin(summary_path, pin)
    return summary_path, artifact, payload, pin


def run_resolution_matrix(
    resolutions: Sequence[Resolution],
    tolerances: Sequence[float],
    boris_runtime_ids: Mapping[str, str],
    fullmag_binary: Path,
    report_root: Path,
    *,
    repo_root: Path,
    fullmag_sha256: str,
    fullmag_native_sha256: str | None = None,
    device: str = "cpu",
) -> dict[str, object]:
    """Compare three verified fixed BORIS references at two Fullmag tolerances.

    Windows-only execution. This is not a BORIS convergence sweep. Legacy roots and
    CUDA are unsupported by the canonical managed CPU reference launcher.
    """
    _require_windows()
    if device != "cpu":
        raise ValueError("managed BORIS matrix requires CPU; legacy CUDA/build-root inputs are unsupported")
    if tuple(resolutions) != DEFAULT_RESOLUTIONS:
        raise ValueError("managed BORIS permits only its fixed coarse/medium/fine grids; legacy 10/20/40 matrix is unsupported")
    normalized_tolerances = tuple(_finite(value, "tolerance") for value in tolerances)
    if len(normalized_tolerances) != 2 or len(set(normalized_tolerances)) != 2 or any(value <= 0 for value in normalized_tolerances):
        raise ValueError("matrix requires two distinct positive Fullmag tolerances")
    if set(boris_runtime_ids) != set(RESOLUTIONS) or len(set(boris_runtime_ids.values())) != 3:
        raise ValueError("matrix requires three distinct managed BORIS runtime IDs: coarse, medium, fine")
    repo_root = repo_root.expanduser().resolve()
    binary = fullmag_binary.expanduser().resolve()
    binary_pins = _verify_fullmag_binary(binary, fullmag_sha256, fullmag_native_sha256)
    references = [
        _managed_reference(repo_root, name, boris_runtime_ids[name], resolution)
        for name, resolution in zip(RESOLUTIONS, resolutions)
    ]
    # A refinement matrix must not accidentally combine different BORIS builds.
    identities = [payload["runtime"] for _, _, payload, _ in references]
    for key in ("build_job_id", "binary_sha256", "source_manifest_sha256", "image_digest"):
        if len({identity[key] for identity in identities}) != 1:
            raise ValueError(f"managed BORIS matrix references different build identities: {key}")
    layout = storage.resolve_layout(repo_root, "windows-native")
    report_root = storage.validate_path(report_root.expanduser().resolve(), Path(layout["storage_root"]))
    if report_root.exists() and any(report_root.iterdir()):
        raise RuntimeError(f"matrix report directory is non-empty: {report_root}")
    report_root.mkdir(parents=True, exist_ok=True)
    runs: list[dict[str, object]] = []
    for name, resolution, reference in zip(RESOLUTIONS, resolutions, references):
        boris_summary, _, payload, reference_pin = reference
        for tolerance in normalized_tolerances:
            run_key = _run_key(resolution, tolerance)
            run_root = report_root / run_key
            run_root.mkdir()
            entry: dict[str, object] = {
                "run_key": run_key, "device": device,
                "resolution": {"nx": resolution.nx, "ny": resolution.ny,
                    "nz_n": resolution.nz_n, "nz_f": resolution.nz_f, "cell_m": list(resolution.cell_m)},
                "tolerance": tolerance, "status": "not_run",
                "boris_reference_reuse": "same_fixed_BORIS_runtime_for_both_Fullmag_tolerances",
                "boris_resolution": name, "boris_summary": str(boris_summary),
                "boris_runtime": payload["runtime"], "boris_scenario": payload["scenario"],
                "scenario_sha256": reference_pin["sha256"]["scenario.json"],
                "runtime_sha256": reference_pin["sha256"]["runtime.json"],
                "boris_reference_pin": reference_pin,
                "fullmag_binary_sha256": binary_pins["launcher"],
                "fullmag_binary_pins": binary_pins,
            }
            try:
                _verify_fullmag_binary(binary, fullmag_sha256, fullmag_native_sha256)
                # Revalidate canonical managed provenance before each comparison;
                # copied JSON, v1 and synthetic identities still fail admission.
                _require_reference_pin(boris_summary, reference_pin)
                boris_artifact = normalize_boris_artifact(boris_summary, repo_root=repo_root)
                _require_reference_pin(boris_summary, reference_pin)
                fullmag_artifact = run_fullmag_nf_reference(
                    binary, Resolution(resolution.nx, resolution.ny, resolution.nz_n,
                        resolution.nz_f, resolution.cell_m, solver_tolerance=tolerance),
                    run_root / "fullmag",
                )
                _require_reference_pin(boris_summary, reference_pin)
                _verify_fullmag_binary(binary, fullmag_sha256, fullmag_native_sha256)
                fullmag_result = load_fullmag_m2_artifact(fullmag_artifact)
                _require_reference_pin(boris_summary, reference_pin)
                report = compare_transport_artifacts(boris_artifact, fullmag_result)
                _require_reference_pin(boris_summary, reference_pin)
                _write_json(run_root / "comparison.json", report)
                entry.update(status=report["status"], fullmag_artifact=str(fullmag_artifact),
                    comparison={key: report[key] for key in ("status", "observables", "incomparable_observables")})
            except Exception as error:
                entry["reason"] = str(error)
                _write_json(run_root / "failure.json", entry)
                # Integrity drift aborts the matrix before launching another case.
                _require_reference_pin(boris_summary, reference_pin)
            runs.append(entry)
    summary: dict[str, object] = {
        "schema_version": "fullmag.boris_fullmag_she_nf_matrix.v2",
        "qualification": {"status": "diagnostic", "reason": "matrix is fail-closed; no solver qualification"},
        "device": device, "declared_resolutions": len(resolutions),
        "declared_tolerances": list(normalized_tolerances),
        "tolerance_scope": "Fullmag_only; BORIS_fixed_managed_defaults_reused",
        "legacy_matrix_scope": "10/20/40 grids and BORIS tolerance sweep NOT VERIFIED",
        "runs": runs,
    }
    for boris_summary, _, _, reference_pin in references:
        _require_reference_pin(boris_summary, reference_pin)
    _write_json(report_root / "matrix.json", summary)
    return summary


def _run_sort_key(entry: dict[str, object]) -> tuple[int, int, int, int, float]:
    resolution = entry["resolution"]
    if not isinstance(resolution, dict):
        raise ValueError("matrix resolution entry is malformed")
    return (
        int(resolution["nx"]),
        int(resolution["ny"]),
        int(resolution["nz_n"]),
        int(resolution["nz_f"]),
        float(entry["tolerance"]),
    )


def validate_matrix_summary(summary: dict[str, object]) -> None:
    """Check report structure/metrics only; this does not qualify a solver."""

    if summary.get("schema_version") != "fullmag.boris_fullmag_she_nf_matrix.v2":
        raise ValueError("legacy matrix v1 has no managed v2 provenance; rerun with --help inputs")
    if summary.get("tolerance_scope") != "Fullmag_only; BORIS_fixed_managed_defaults_reused":
        raise ValueError("matrix must declare the separate fixed BORIS reference tolerance scope")
    resolutions = summary.get("declared_resolutions")
    tolerances = summary.get("declared_tolerances")
    runs = summary.get("runs")
    if resolutions != 3:
        raise ValueError("matrix requires three resolutions")
    if not isinstance(tolerances, list) or len(tolerances) != 2:
        raise ValueError("matrix requires two tolerances")
    if not isinstance(runs, list) or len(runs) != 6:
        raise ValueError("matrix must contain six resolution/tolerance runs")
    identities: set[str] = set()
    for entry in runs:
        if not isinstance(entry, dict):
            raise ValueError("matrix run entry is malformed")
        runtime = entry.get("boris_runtime", {})
        if not isinstance(runtime, dict) or runtime.get("schema_version") != "fullmag.boris.runtime.v2" or runtime.get("identity_complete") is not True:
            raise ValueError("matrix requires managed BORIS v2 provenance for every run")
        identifier(runtime.get("runtime_id"))
        if entry.get("boris_reference_reuse") != "same_fixed_BORIS_runtime_for_both_Fullmag_tolerances":
            raise ValueError("matrix must disclose fixed BORIS reference reuse")
        run_key = entry.get("run_key")
        if not isinstance(run_key, str) or run_key in identities:
            raise ValueError("matrix contains a duplicate run identity")
        identities.add(run_key)
        if entry.get("status") != "diagnostic_match":
            raise ValueError(f"matrix run {run_key} is not diagnostic_match")
        comparison = entry.get("comparison")
        if not isinstance(comparison, dict) or comparison.get("status") != "diagnostic_match":
            raise ValueError(f"matrix run {run_key} has no comparable report")
        observables = comparison.get("observables")
        if not isinstance(observables, dict) or not observables:
            raise ValueError(f"matrix run {run_key} has no observables")
        for name, metric in observables.items():
            if not isinstance(metric, dict):
                raise ValueError(f"matrix observable {name} is malformed")
            for metric_name in ("max_absolute_error", "max_relative_error", "normalized_l2_error", "endpoint_error"):
                _finite(metric.get(metric_name), f"{run_key}.{name}.{metric_name}")
    ordered = sorted(runs, key=_run_sort_key)
    by_resolution: dict[tuple[int, int, int, int], list[dict[str, object]]] = {}
    for entry in ordered:
        resolution = entry["resolution"]
        assert isinstance(resolution, dict)
        key = tuple(int(resolution[name]) for name in ("nx", "ny", "nz_n", "nz_f"))
        by_resolution.setdefault(key, []).append(entry)
    if len(by_resolution) != 3 or any(len(items) != 2 for items in by_resolution.values()):
        raise ValueError("matrix does not contain two tolerances for each of three resolutions")
    for key, entries in by_resolution.items():
        loose, tight = sorted(entries, key=lambda item: float(item["tolerance"]), reverse=True)
        loose_obs = loose["comparison"]["observables"]
        tight_obs = tight["comparison"]["observables"]
        assert isinstance(loose_obs, dict) and isinstance(tight_obs, dict)
        for name in loose_obs:
            loose_error = _finite(loose_obs[name]["max_relative_error"], f"{key}.{name}.loose")
            tight_error = _finite(tight_obs[name]["max_relative_error"], f"{key}.{name}.tight")
            if tight_error > loose_error + 1.0e-15:
                raise ValueError(f"matrix error is not monotone across tolerance for {key}/{name}")
    resolution_groups = sorted(by_resolution.items())
    for index in range(1, len(resolution_groups)):
        previous = resolution_groups[index - 1][1][0]["comparison"]["observables"]
        current = resolution_groups[index][1][0]["comparison"]["observables"]
        assert isinstance(previous, dict) and isinstance(current, dict)
        for name in previous:
            if _finite(current[name]["max_relative_error"], f"{name}.fine") > _finite(
                previous[name]["max_relative_error"], f"{name}.coarse"
            ) + 1.0e-15:
                raise ValueError(f"matrix error is not monotone across resolution for {name}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--boris-build-root", help=argparse.SUPPRESS)
    parser.add_argument("--repo-root", type=Path, help="trusted Fullmag checkout used by managed BORIS receipts")
    for name in RESOLUTIONS:
        parser.add_argument(f"--boris-runtime-{name}", help=f"existing managed {name} runtime ID; start/observe it first")
    parser.add_argument("--fullmag", type=Path)
    parser.add_argument("--fullmag-sha256", help="required launcher/executable SHA256 pin")
    parser.add_argument("--fullmag-native-sha256", help="required when the launcher has a sibling fullmag-bin")
    parser.add_argument("--report-root", type=Path, required=True)
    parser.add_argument("--device", choices=("cpu",), default="cpu")
    parser.add_argument("--validate-only", action="store_true", help="check report structure/metrics only; does not admit runtime or qualify solvers")
    args = parser.parse_args()
    if args.boris_build_root is not None:
        parser.print_help()
        parser.error("legacy --boris-build-root is unsupported; use three verified --boris-runtime-* IDs")
    if not args.validate_only and any(value is None for value in (
        args.repo_root, args.fullmag, args.fullmag_sha256,
        *(getattr(args, "boris_runtime_" + name) for name in RESOLUTIONS),
    )):
        parser.error("execution requires --repo-root, all three --boris-runtime-* IDs, --fullmag and --fullmag-sha256; legacy --boris-build-root/CUDA are unsupported (see --help)")
    matrix_path = args.report_root / "matrix.json"
    if args.validate_only:
        summary = json.loads(matrix_path.read_text(encoding="utf-8"))
        validate_matrix_summary(summary)
    else:
        summary = run_resolution_matrix(
            DEFAULT_RESOLUTIONS,
            DEFAULT_TOLERANCES,
            {name: getattr(args, "boris_runtime_" + name) for name in RESOLUTIONS},
            args.fullmag,
            args.report_root,
            repo_root=args.repo_root,
            fullmag_sha256=args.fullmag_sha256,
            fullmag_native_sha256=args.fullmag_native_sha256,
            device=args.device,
        )
        validate_matrix_summary(summary)
    print(json.dumps({"status": "diagnostic_match", "matrix": str(matrix_path)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
