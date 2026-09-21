"""Run the baseline-to-frozen-spins validation for one bimeron seed size.

The paired protocol deliberately separates two questions:

1. an unconstrained ``p0`` relaxation establishes the state selected by the
   same rDMI parameters and records its measured radius and opposite ``m_z``
   extrema;
2. a ``ring`` (or explicitly requested ``p3``) run is initialized from that
   measured baseline state, freezes the selected part of that same field, and
   checks whether the constrained hold and subsequent release preserve the
   texture.

This is a validation run, not an energy-profile sweep.  It keeps both
artifacts and writes an explicit comparison receipt so a later profile can
use a measured baseline rather than an independently authored seed.
"""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
from typing import Any

_ROOT = Path(__file__).resolve().parents[5]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tests.standard_problems.bimeron.goebel_2019.frozen_size.common import (
    DEFAULT_RELAX_TOL_T,
    DEFAULT_CELL_NM,
    DEFAULT_PIN_RADIUS_NM,
    DEFAULT_RING_WIDTH_NM,
    DEFAULT_TABLE_EVERY_STEPS,
    DEFAULT_TRACK_X_NM,
    DEFAULT_TRACK_Y_NM,
    DEFAULT_WALL_WIDTH_NM,
    preset_radius_for_contour,
)
from tests.standard_problems.bimeron.goebel_2019.frozen_size.run_sweep import (
    ANALYZER_REL,
    BACKGROUND_REL,
    PROFILE,
    SCENARIO_REL,
    THRESHOLDS_REL,
    _analysis_python,
    _assert_within,
    _case_contract,
    _environment,
    _launch,
    _managed_runtime_matches_source,
    _resolve_layout,
    _run_process,
    _sha256_file,
    _source_identity,
    _thresholds_path,
    _workspace_from_launcher_log,
    _verify_case,
    _write_json,
)
from tests.standard_problems.bimeron.goebel_2019.frozen_size.provenance import (
    CONTRACT_FILENAME,
)


DEFAULT_PAIRED_HOLD_ENERGY_DELTA_J = 1e-21
DEFAULT_PAIRED_HOLD_RMS_DELTA_M = 0.01
DEFAULT_PAIRED_HOLD_MAX_DELTA_M = 0.1
DEFAULT_PAIRED_HOLD_RADIUS_DELTA_NM = 0.25
WORKING_THRESHOLDS_REL = THRESHOLDS_REL.with_name("thresholds.working.v2.json")


def _args(namespace: argparse.Namespace) -> SimpleNamespace:
    """Project the paired CLI namespace onto the sweep launcher contract.

    ``run_sweep._environment`` and ``_launch`` intentionally share one
    argument contract.  Keep the paired protocol on that same contract so a
    baseline-to-frozen run cannot silently omit geometry, tolerance, table,
    or interactive-UI settings.  ``getattr`` keeps this adapter compatible
    with callers that construct a minimal namespace in focused tests.
    """

    track_x_nm = getattr(namespace, "track_x_nm", None)
    track_y_nm = getattr(namespace, "track_y_nm", None)
    return SimpleNamespace(
        device=namespace.device,
        thresholds=getattr(namespace, "thresholds", WORKING_THRESHOLDS_REL),
        run_mode=getattr(namespace, "run_mode", "interactive"),
        web_port=int(getattr(namespace, "web_port", 3100)),
        track_x_nm=DEFAULT_TRACK_X_NM if track_x_nm is None else track_x_nm,
        track_y_nm=DEFAULT_TRACK_Y_NM if track_y_nm is None else track_y_nm,
        cell_nm=namespace.cell_nm,
        pin_radius_nm=namespace.pin_radius_nm,
        ring_width_nm=namespace.ring_width_nm,
        helicity_rad=namespace.helicity_rad,
        vorticity=namespace.vorticity,
        background_sign=namespace.background_sign,
        release=False,
        relax_time_s=namespace.relax_time_s,
        tol_t=getattr(namespace, "tol_t", DEFAULT_RELAX_TOL_T),
        hold_time_s=namespace.hold_time_s,
        release_time_s=namespace.release_time_s,
        relax_max_steps=namespace.relax_max_steps,
        release_max_steps=namespace.release_max_steps,
        field_every_steps=namespace.field_every_steps,
        table_every_steps=getattr(
            namespace, "table_every_steps", DEFAULT_TABLE_EVERY_STEPS
        ),
    )


def _case(
    *,
    target_radius_nm: float,
    wall_width_nm: float,
    protocol: str,
    args: SimpleNamespace,
    release: bool,
    pin_centres_nm: list[list[float]] | None = None,
) -> dict[str, Any]:
    return {
        "case_id": f"paired-{protocol}-R{target_radius_nm:g}nm".replace(".", "p"),
        "target_radius_nm": target_radius_nm,
        "wall_width_nm": wall_width_nm,
        "protocol": protocol,
        "track_x_nm": args.track_x_nm,
        "track_y_nm": args.track_y_nm,
        "cell_nm": args.cell_nm,
        "cell_size_nm": [args.cell_nm, args.cell_nm, 0.5],
        "track_size_nm": [args.track_x_nm, args.track_y_nm, 0.5],
        "pin_radius_nm": args.pin_radius_nm,
        "ring_width_nm": args.ring_width_nm,
        "helicity_rad": args.helicity_rad,
        "vorticity": args.vorticity,
        "background_sign": args.background_sign,
        "relax_tol_T": args.tol_t,
        "relax_time_s": args.relax_time_s,
        "hold_time_s": args.hold_time_s,
        "release_time_s": args.release_time_s,
        "relax_max_steps": args.relax_max_steps,
        "release_max_steps": args.release_max_steps,
        "field_every_steps": args.field_every_steps,
        "table_every_steps": args.table_every_steps,
        "release": release,
        "preset_radius_nm": preset_radius_for_contour(
            target_radius_nm * 1e-9, wall_width_nm * 1e-9
        )
        * 1e9,
        "pin_centres_nm": pin_centres_nm,
    }


def _analyze(
    repo: Path,
    layout: dict[str, Any],
    artifact_root: Path,
    *,
    workspace: Path | None,
    background_root: Path,
    background_workspace: Path | None,
    environment: dict[str, str],
) -> dict[str, Any]:
    output = artifact_root / "analysis.json"
    command = [
        _analysis_python(repo, layout),
        str(repo / ANALYZER_REL),
        str(artifact_root),
        "--output",
        str(output),
        "--background",
        str(background_root),
    ]
    if workspace is not None:
        command.extend(["--workspace", str(workspace)])
    if background_workspace is not None:
        command.extend(["--background-workspace", str(background_workspace)])
    _run_process(command, cwd=repo, env=environment, log=artifact_root / "analysis.log")
    return json.loads(output.read_text(encoding="utf-8"))


def _persist_contract(
    artifact_root: Path,
    *,
    case: dict[str, Any],
    contract: dict[str, Any],
    kind: str,
) -> None:
    """Write the immutable request and its provenance sidecar before launch."""

    _write_json(artifact_root / CONTRACT_FILENAME, contract)
    _write_json(
        artifact_root / "request.json",
        {
            "kind": kind,
            "case": case,
            "cell_size_nm": case.get("cell_size_nm"),
            "track_size_nm": case.get("track_size_nm"),
            "provenance_contract": contract,
        },
    )


def _embed_contract(
    artifact_root: Path,
    analysis: dict[str, Any],
    contract: dict[str, Any],
) -> dict[str, Any]:
    """Attach the sidecar contract to the measured JSON for downstream import."""

    analysis = dict(analysis)
    analysis["provenance_contract"] = contract
    _write_json(artifact_root / "analysis.json", analysis)
    return analysis


def _measurement(analysis: dict[str, Any], label: str) -> dict[str, Any]:
    states = analysis.get("states")
    if not isinstance(states, dict) or not isinstance(states.get(label), dict):
        raise RuntimeError(f"missing {label} measurement in {analysis.get('artifact_root')}")
    measurement = states[label].get("measurement")
    if not isinstance(measurement, dict):
        raise RuntimeError(f"missing {label} measurement payload")
    return measurement


def _state_path(analysis: dict[str, Any], label: str) -> Path:
    """Return a named state artifact and fail loudly when it is absent."""

    states = analysis.get("states")
    state = states.get(label) if isinstance(states, dict) else None
    path = state.get("path") if isinstance(state, dict) else None
    if not isinstance(path, str) or not path:
        raise RuntimeError(f"missing {label} state path in {analysis.get('artifact_root')}")
    result = Path(path)
    if not result.is_file() and not result.is_dir():
        raise RuntimeError(f"missing {label} state artifact: {result}")
    return result


def _state_values(path: Path) -> list[tuple[float, float, float]]:
    """Load a state through the canonical analyzer reader."""

    # Keep the paired driver on the same Zarr/JSON/HDF5 decoding path as the
    # analysis receipt instead of introducing a second state format contract.
    from tests.standard_problems.bimeron.goebel_2019.frozen_size.analyze import (
        _state_values as load_state_values,
    )

    return load_state_values(path)


def _compare_state_vectors(
    reference_path: Path,
    candidate_path: Path,
    *,
    transfer_tolerance: float,
) -> dict[str, Any]:
    """Compare two complete unit-magnetization fields cell by cell.

    The radius is only a scalar projection.  A paired transfer check must also
    establish that the supplied P0 checkpoint reaches the frozen run without
    changing the texture.  The RMS, maximum component, angular, and vector
    differences are retained for the hold and release states as diagnostics;
    only the initial transfer is classified against ``transfer_tolerance``.
    """

    reference = _state_values(reference_path)
    candidate = _state_values(candidate_path)
    if len(reference) != len(candidate):
        return {
            "status": "incompatible_vector_count",
            "reference_vector_count": len(reference),
            "candidate_vector_count": len(candidate),
            "within_transfer_tolerance": False,
            "max_component_abs": None,
            "max_vector_l2": None,
            "rms_vector_l2": None,
            "mean_angular_difference_rad": None,
            "max_angular_difference_rad": None,
        }

    max_component = 0.0
    max_vector = 0.0
    sum_squared = 0.0
    sum_angle = 0.0
    max_angle = 0.0
    finite = True
    for left, right in zip(reference, candidate):
        if len(left) != 3 or len(right) != 3:
            finite = False
            continue
        delta = [float(right[index]) - float(left[index]) for index in range(3)]
        if not all(math.isfinite(value) for value in (*left, *right, *delta)):
            finite = False
            continue
        max_component = max(max_component, *(abs(value) for value in delta))
        vector_l2 = math.sqrt(sum(value * value for value in delta))
        max_vector = max(max_vector, vector_l2)
        sum_squared += vector_l2 * vector_l2
        left_norm = math.sqrt(sum(float(value) ** 2 for value in left))
        right_norm = math.sqrt(sum(float(value) ** 2 for value in right))
        if left_norm <= 0.0 or right_norm <= 0.0:
            finite = False
            continue
        cosine = sum(float(left[index]) * float(right[index]) for index in range(3))
        cosine /= left_norm * right_norm
        angle = math.acos(max(-1.0, min(1.0, cosine)))
        sum_angle += angle
        max_angle = max(max_angle, angle)

    count = len(reference)
    rms = math.sqrt(sum_squared / count) if count else None
    mean_angle = sum_angle / count if count else None
    status = "compared" if finite and count else "invalid_values"
    within = bool(
        status == "compared"
        and max_component <= float(transfer_tolerance)
        and max_vector <= float(transfer_tolerance) * math.sqrt(3.0)
    )
    return {
        "status": status,
        "reference_vector_count": len(reference),
        "candidate_vector_count": len(candidate),
        "within_transfer_tolerance": within,
        "transfer_tolerance": float(transfer_tolerance),
        "max_component_abs": max_component if status == "compared" else None,
        "max_vector_l2": max_vector if status == "compared" else None,
        "rms_vector_l2": rms if status == "compared" else None,
        "mean_angular_difference_rad": mean_angle if status == "compared" else None,
        "max_angular_difference_rad": max_angle if status == "compared" else None,
    }


def _threshold_number(
    thresholds: dict[str, Any], key: str, default: float
) -> float:
    value = thresholds.get(key, default)
    try:
        result = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"paired threshold {key} must be finite") from error
    if not math.isfinite(result) or result < 0.0:
        raise ValueError(f"paired threshold {key} must be finite and non-negative")
    return result


def _state_preservation_gates(
    *,
    baseline_hold: dict[str, Any],
    frozen_hold: dict[str, Any],
    baseline_analysis: dict[str, Any],
    frozen_analysis: dict[str, Any],
    full_state: dict[str, Any],
    thresholds: dict[str, Any],
) -> dict[str, Any]:
    """Check whether a frozen hold preserves the relaxed P0 texture.

    These are working-protocol acceptance gates for the paired control.  They
    are deliberately separate from the solver convergence thresholds: a
    frozen run can have a stable trace while still changing the texture or
    energy relative to the P0 reference.
    """

    limits = {
        "maximum_hold_energy_delta_J": _threshold_number(
            thresholds,
            "maximum_paired_hold_energy_delta_J",
            DEFAULT_PAIRED_HOLD_ENERGY_DELTA_J,
        ),
        "maximum_hold_rms_delta_m": _threshold_number(
            thresholds,
            "maximum_paired_hold_rms_delta_m",
            DEFAULT_PAIRED_HOLD_RMS_DELTA_M,
        ),
        "maximum_hold_max_delta_m": _threshold_number(
            thresholds,
            "maximum_paired_hold_max_delta_m",
            DEFAULT_PAIRED_HOLD_MAX_DELTA_M,
        ),
        "maximum_hold_radius_delta_nm": _threshold_number(
            thresholds,
            "maximum_paired_hold_radius_delta_nm",
            DEFAULT_PAIRED_HOLD_RADIUS_DELTA_NM,
        ),
    }
    baseline_energy = baseline_analysis.get("profile_energy", {}).get("E_total_J")
    frozen_energy = frozen_analysis.get("profile_energy", {}).get("E_total_J")
    try:
        energy_delta = abs(float(frozen_energy) - float(baseline_energy))
    except (TypeError, ValueError):
        energy_delta = None
    try:
        radius_delta = abs(
            float(frozen_hold["R_area_nm"]) - float(baseline_hold["R_area_nm"])
        )
    except (KeyError, TypeError, ValueError):
        radius_delta = None
    vector = full_state.get("baseline_vs_frozen_hold")
    vector = vector if isinstance(vector, dict) else {}
    rms_delta = vector.get("rms_vector_l2")
    max_delta = vector.get("max_vector_l2")
    checks = {
        "energy_delta_J": {
            "value": energy_delta,
            "limit": limits["maximum_hold_energy_delta_J"],
            "passed": energy_delta is not None
            and math.isfinite(energy_delta)
            and energy_delta <= limits["maximum_hold_energy_delta_J"],
        },
        "rms_delta_m": {
            "value": rms_delta,
            "limit": limits["maximum_hold_rms_delta_m"],
            "passed": isinstance(rms_delta, (int, float))
            and math.isfinite(float(rms_delta))
            and float(rms_delta) <= limits["maximum_hold_rms_delta_m"],
        },
        "max_delta_m": {
            "value": max_delta,
            "limit": limits["maximum_hold_max_delta_m"],
            "passed": isinstance(max_delta, (int, float))
            and math.isfinite(float(max_delta))
            and float(max_delta) <= limits["maximum_hold_max_delta_m"],
        },
        "radius_delta_nm": {
            "value": radius_delta,
            "limit": limits["maximum_hold_radius_delta_nm"],
            "passed": radius_delta is not None
            and math.isfinite(radius_delta)
            and radius_delta <= limits["maximum_hold_radius_delta_nm"],
        },
    }
    failures = [name for name, check in checks.items() if not check["passed"]]
    return {
        "status": "passed" if not failures else "failed",
        "checks": checks,
        "failures": failures,
        "interpretation": "working_state_preservation_gate",
    }


def _write_report(path: Path, summary: dict[str, Any]) -> None:
    baseline = summary["baseline"]
    frozen = summary["frozen"]
    comparison = summary["comparison"]
    frozen_protocol = summary["parameters"].get("frozen_protocol", frozen.get("protocol", "ring"))

    def _metric(label: str) -> str:
        value = comparison["full_state"].get(label)
        if not isinstance(value, dict):
            return "unavailable"
        return (
            f"{value.get('status')}; max|Δm|={value.get('max_component_abs')!s}; "
            f"RMS|Δm|={value.get('rms_vector_l2')!s}; "
            f"max angle={value.get('max_angular_difference_rad')!s} rad"
        )

    lines = [
        "# Walidacja przejścia P0 do frozen spins dla bimeronu",
        "",
        f"- Źródło: `{summary['source']['git_head']}`",
        f"- Żądane urządzenie: `{summary['source']['device']}`",
        f"- Promień początkowy: `{summary['parameters']['seed_radius_nm']:g} nm`",
        "- Odniesienie: swobodna relaksacja `p0`",
        f"- Walidacja frozen: `{frozen_protocol}` zainicjalizowana rzeczywiście zrelaksowanym stanem P0",
        "",
        "## Zmierzone stany",
        "",
        "| stan | R_area (nm) | R_core (nm) | Q | E_profile (J) | weryfikacja |",
        "|---|---:|---:|---:|---:|---|",
        f"| P0 hold | {baseline['R_area_hold_nm']:.6g} | {baseline['R_core_hold_nm']:.6g} | {baseline['Q_hold']:.7g} | {baseline['E_profile_J']:.7e} | {baseline['verification_status']} |",
        f"| frozen initial | {frozen['R_area_initial_nm']:.6g} | {frozen['R_core_initial_nm']:.6g} | {frozen['Q_initial']:.7g} | — | — |",
        f"| frozen hold | {frozen['R_area_hold_nm']:.6g} | {frozen['R_core_hold_nm']:.6g} | {frozen['Q_hold']:.7g} | {frozen['E_profile_J']:.7e} | {frozen['verification_status']} |",
        f"| frozen release | {frozen['R_area_release_nm']:.6g} | {frozen['R_core_release_nm']:.6g} | {frozen['Q_release']:.7g} | {frozen['E_terminal_J']:.7e} | — |",
        "",
        "## Porównanie pary",
        "",
        f"- P0 → frozen initial ΔR_area: `{comparison['delta_R_area_initial_minus_baseline_nm']:.6g} nm`",
        f"- P0 → frozen hold ΔR_area: `{comparison['delta_R_area_hold_minus_baseline_nm']:.6g} nm`",
        f"- P0 → frozen release ΔR_area: `{comparison['delta_R_area_release_minus_baseline_nm']:.6g} nm`",
        f"- P0 → frozen hold ΔE: `{comparison['delta_E_hold_minus_baseline_J']:.7e} J`",
        f"- dryf referencji frozen: `{comparison['frozen_reference_max_drift']!s}`",
        f"- zgodność promienia stanu początkowego: `{comparison['initial_state_radius_match']}`",
        f"- zgodność pełnego pola przy transferze: `{comparison['initial_state_full_match']}`",
        f"- bramka zachowania stanu w hold: `{comparison['state_preservation']['status']}`",
        f"- niepowodzenia bramki hold: `{comparison['state_preservation']['failures']}`",
        "",
        "## Porównanie pełnego pola",
        "",
        f"- P0 → frozen initial: `{_metric('baseline_vs_frozen_initial')}`",
        f"- P0 → frozen hold: `{_metric('baseline_vs_frozen_hold')}`",
        f"- P0 → frozen release: `{_metric('baseline_vs_frozen_release')}`",
        "",
        "To jest walidacja transferu stanu i dynamiki z ograniczeniem. Nie jest to "
        "potwierdzenie globalnego minimum energii; wymagane są zbieżność solvera i przejście bramek torque.",
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _write_baseline_diagnostic_report(path: Path, summary: dict[str, Any]) -> None:
    """Persist a Polish diagnostic when P0 cannot establish a reference state."""

    baseline = summary["baseline"]
    verification = baseline.get("verification", {})
    lines = [
        "# Diagnostyka paired validation: P0 nieustalony",
        "",
        "Nie uruchomiono etapu frozen, ponieważ swobodny przebieg P0 nie "
        "potwierdził zbieżności. Nie wolno traktować tego stanu jako naturalnego "
        "promienia bimeronu.",
        "",
        f"- status P0: `{baseline.get('verification_status')}`",
        f"- completion.converged: `{baseline.get('completion_converged')}`",
        f"- failures: `{verification.get('failures', [])}`",
        f"- warnings: `{verification.get('warnings', [])}`",
        f"- artefakt P0: `{baseline.get('artifact_root')}`",
        "",
        "Należy ponowić P0 z tym samym kontraktem materiału, geometrii i "
        "tolerancji, a dopiero potem wykonać test frozen z jego rzeczywistym "
        "stanem końcowym.",
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def run(namespace: argparse.Namespace) -> dict[str, Any]:
    if not namespace.run:
        raise SystemExit("pass --run to execute the paired validation")
    if getattr(namespace, "run_mode", "interactive") != "interactive":
        raise ValueError(
            "paired validation requires --run-mode interactive so the P0 and frozen stages remain inspectable in the UI"
        )
    repo = _ROOT
    layout = _resolve_layout(repo)
    runs_root = _assert_within(Path(layout["runs_root"]), Path(layout["storage_root"]))
    output_root = _assert_within(
        Path(namespace.output_root) if namespace.output_root else runs_root / "bimeron-rdmi-frozen-spins-paired-validation-v1",
        runs_root,
    )
    if output_root.exists() and any(output_root.iterdir()):
        raise RuntimeError(f"output root already contains artifacts: {output_root}")
    output_root.mkdir(parents=True, exist_ok=True)
    args = _args(namespace)
    thresholds_path = _thresholds_path(repo, namespace)
    thresholds = json.loads(thresholds_path.read_text(encoding="utf-8"))
    if not isinstance(thresholds, dict):
        raise ValueError(f"threshold policy must be a JSON object: {thresholds_path}")
    source_identity = _source_identity(repo)
    source = {
        "git_head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip(),
        "git_branch": subprocess.check_output(["git", "branch", "--show-current"], cwd=repo, text=True).strip(),
        "device": namespace.device,
        "source_identity": source_identity,
        "managed_runtime_matches_source_preflight": _managed_runtime_matches_source(
            repo,
            layout,
            device=namespace.device,
            needs_control_room_toolchain=True,
        ),
        "runtime_manifest": str(Path(layout["build_root"]) / "windows-runtime" / "build-manifest.json"),
        "threshold_policy": {
            "path": str(thresholds_path),
            "sha256": _sha256_file(thresholds_path),
            "schema_version": thresholds.get("schema_version"),
        },
        "scripts": {
            "scenario_fdm": {
                "path": str(repo / SCENARIO_REL),
                "sha256": _sha256_file(repo / SCENARIO_REL),
            },
            "background_fdm": {
                "path": str(repo / BACKGROUND_REL),
                "sha256": _sha256_file(repo / BACKGROUND_REL),
            },
            "analyzer": {
                "path": str(repo / ANALYZER_REL),
                "sha256": _sha256_file(repo / ANALYZER_REL),
            },
            "thresholds": {
                "path": str(thresholds_path),
                "sha256": _sha256_file(thresholds_path),
            },
            "paired_validation": {
                "path": str(Path(__file__).resolve()),
                "sha256": _sha256_file(Path(__file__).resolve()),
            },
        },
    }
    if not source["managed_runtime_matches_source_preflight"]:
        raise RuntimeError(
            "managed Windows runtime does not match the current paired-validation source "
            "or interactive toolchain; automatic build is disabled for this protocol. "
            "Prepare a matching managed runtime through the approved build queue first."
        )
    baseline_case = _case(
        target_radius_nm=namespace.seed_radius_nm,
        wall_width_nm=namespace.wall_width_nm,
        protocol="p0",
        args=args,
        release=False,
    )
    background_case = _case(
        target_radius_nm=namespace.seed_radius_nm,
        wall_width_nm=namespace.wall_width_nm,
        protocol="p0",
        args=args,
        release=False,
    )
    background_root = output_root / "background"
    background_root.mkdir(parents=True, exist_ok=True)
    background_contract = _case_contract(
        repo,
        background_case,
        args,
        source,
        kind="background",
    )
    _persist_contract(
        background_root,
        case=background_case,
        contract=background_contract,
        kind="background",
    )
    background_workspace = _launch(
        repo,
        layout,
        repo / BACKGROUND_REL,
        background_root,
        background_case,
        args,
        build=False,
    )
    background_analysis = _analyze(
        repo,
        layout,
        background_root,
        workspace=background_workspace,
        background_root=background_root,
        background_workspace=background_workspace,
        environment={**os.environ, **_environment(background_case, args)},
    )
    background_analysis = _embed_contract(
        background_root,
        background_analysis,
        background_contract,
    )
    baseline_root = output_root / "baseline-p0"
    baseline_root.mkdir(parents=True, exist_ok=True)
    baseline_contract = _case_contract(
        repo,
        baseline_case,
        args,
        source,
        kind="free_reference",
    )
    _persist_contract(
        baseline_root,
        case=baseline_case,
        contract=baseline_contract,
        kind="baseline_p0",
    )
    baseline_workspace = _launch(
        repo,
        layout,
        repo / SCENARIO_REL,
        baseline_root,
        baseline_case,
        args,
        build=False,
    )
    baseline_analysis = _analyze(
        repo,
        layout,
        baseline_root,
        workspace=baseline_workspace,
        background_root=background_root,
        background_workspace=background_workspace,
        environment={**os.environ, **_environment(baseline_case, args)},
    )
    baseline_analysis = _embed_contract(
        baseline_root,
        baseline_analysis,
        baseline_contract,
    )
    baseline_verification = _verify_case(
        repo,
        baseline_analysis,
        baseline_root,
        thresholds_path=thresholds_path,
    )
    baseline_completion = (
        baseline_analysis.get("runtime_provenance", {}).get("completion", {})
        if isinstance(baseline_analysis.get("runtime_provenance"), dict)
        else {}
    )
    if (
        baseline_completion.get("converged") is not True
        or baseline_verification.get("status") != "passed"
    ):
        diagnostic = {
            "schema_version": "bimeron_frozen_size.paired_validation.v1",
            "source": source,
            "layout": {
                "storage_root": layout["storage_root"],
                "runs_root": layout["runs_root"],
                "output_root": str(output_root),
            },
            "parameters": {
                key: str(value) if isinstance(value, Path) else value
                for key, value in vars(namespace).items()
            },
            "baseline": {
                "artifact_root": str(baseline_root),
                "analysis": baseline_analysis,
                "verification": baseline_verification,
                "verification_status": baseline_verification.get("status"),
                "completion_converged": baseline_completion.get("converged"),
                "provenance_contract_path": str(baseline_root / CONTRACT_FILENAME),
                "provenance_contract_sha256": baseline_contract.get("contract_sha256"),
            },
            "frozen": None,
            "comparison": None,
            "qualification": {
                "status": "diagnostic",
                "reason": "baseline_p0_not_converged_or_verification_failed",
                "frozen_stage_started": False,
            },
        }
        _write_json(output_root / "paired_summary.json", diagnostic)
        _write_baseline_diagnostic_report(output_root / "paired_report.md", diagnostic)
        return diagnostic
    baseline_hold = _measurement(baseline_analysis, "constrained_held")
    baseline_state_path = _state_path(baseline_analysis, "constrained_held")
    min_position = baseline_hold.get("mz_min_position_nm")
    max_position = baseline_hold.get("mz_max_position_nm")
    measured_radius_value = baseline_hold.get("R_area_nm") or baseline_hold.get("R_core_nm")
    if measured_radius_value is None:
        raise RuntimeError("baseline analysis did not expose R_area_nm or R_core_nm")
    measured_radius = float(measured_radius_value)
    frozen_protocol = getattr(namespace, "frozen_protocol", "ring")
    frozen_pin_centres = None
    if frozen_protocol == "p3":
        if not (
            isinstance(min_position, list)
            and len(min_position) == 2
            and isinstance(max_position, list)
            and len(max_position) == 2
        ):
            raise RuntimeError("baseline analysis did not expose opposite m_z extrema positions")
        frozen_pin_centres = [
            [float(min_position[0]), float(min_position[1])],
            [float(max_position[0]), float(max_position[1])],
        ]
    frozen_case = _case(
        target_radius_nm=measured_radius,
        wall_width_nm=namespace.wall_width_nm,
        protocol=frozen_protocol,
        args=args,
        release=True,
        pin_centres_nm=frozen_pin_centres,
    )
    frozen_root = output_root / f"frozen-{frozen_protocol}-from-baseline"
    frozen_root.mkdir(parents=True, exist_ok=True)
    frozen_contract = _case_contract(
        repo,
        frozen_case,
        args,
        source,
        kind="frozen_pair",
    )
    _persist_contract(
        frozen_root,
        case=frozen_case,
        contract=frozen_contract,
        kind="frozen_from_baseline",
    )
    _write_json(
        frozen_root / "initial_state_reference.json",
        {
            "role": "baseline_p0_constrained_held",
            "path": str(baseline_state_path),
            "sha256": _sha256_file(baseline_state_path),
            "source_analysis": str(baseline_root / "analysis.json"),
            "provenance_contract_sha256": baseline_contract.get("contract_sha256"),
        },
    )
    frozen_workspace = _launch(
        repo,
        layout,
        repo / SCENARIO_REL,
        frozen_root,
        frozen_case,
        args,
        build=False,
        initial_magnetization_state=baseline_state_path,
    )
    frozen_analysis = _analyze(
        repo,
        layout,
        frozen_root,
        workspace=frozen_workspace,
        background_root=background_root,
        background_workspace=background_workspace,
        environment={**os.environ, **_environment(frozen_case, args)},
    )
    frozen_analysis = _embed_contract(
        frozen_root,
        frozen_analysis,
        frozen_contract,
    )
    frozen_verification = _verify_case(
        repo,
        frozen_analysis,
        frozen_root,
        thresholds_path=thresholds_path,
    )
    frozen_initial = _measurement(frozen_analysis, "initial")
    frozen_hold = _measurement(frozen_analysis, "constrained_held")
    frozen_release = _measurement(frozen_analysis, "released")
    frozen_initial_path = _state_path(frozen_analysis, "initial")
    frozen_hold_path = _state_path(frozen_analysis, "constrained_held")
    frozen_release_path = _state_path(frozen_analysis, "released")
    full_state = {
        "baseline_vs_frozen_initial": _compare_state_vectors(
            baseline_state_path,
            frozen_initial_path,
            transfer_tolerance=getattr(namespace, "state_transfer_tolerance", 1e-12),
        ),
        "baseline_vs_frozen_hold": _compare_state_vectors(
            baseline_state_path,
            frozen_hold_path,
            transfer_tolerance=getattr(namespace, "state_transfer_tolerance", 1e-12),
        ),
        "baseline_vs_frozen_release": _compare_state_vectors(
            baseline_state_path,
            frozen_release_path,
            transfer_tolerance=getattr(namespace, "state_transfer_tolerance", 1e-12),
        ),
    }
    state_preservation = _state_preservation_gates(
        baseline_hold=baseline_hold,
        frozen_hold=frozen_hold,
        baseline_analysis=baseline_analysis,
        frozen_analysis=frozen_analysis,
        full_state=full_state,
        thresholds=thresholds,
    )
    baseline_r = float(baseline_hold["R_area_nm"])
    comparison = {
        "delta_R_area_initial_minus_baseline_nm": float(frozen_initial["R_area_nm"]) - baseline_r,
        "delta_R_area_hold_minus_baseline_nm": float(frozen_hold["R_area_nm"]) - baseline_r,
        "delta_R_area_release_minus_baseline_nm": float(frozen_release["R_area_nm"]) - baseline_r,
        "delta_E_hold_minus_baseline_J": float(frozen_analysis["profile_energy"]["E_total_J"])
        - float(baseline_analysis["profile_energy"]["E_total_J"]),
        "frozen_reference_max_drift": frozen_analysis.get("frozen_runtime", {}).get("frozen_reference_max_drift"),
        "initial_state_radius_match": abs(float(frozen_initial["R_area_nm"]) - baseline_r)
        <= max(float(baseline_hold.get("R_area_uncertainty_nm", 0.25)), 0.5 * namespace.cell_nm),
        "initial_state_full_match": full_state["baseline_vs_frozen_initial"][
            "within_transfer_tolerance"
        ],
        "full_state": full_state,
        "state_preservation": state_preservation,
    }
    summary = {
        "schema_version": "bimeron_frozen_size.paired_validation.v1",
        "source": source,
        "layout": {
            "storage_root": layout["storage_root"],
            "runs_root": layout["runs_root"],
            "output_root": str(output_root),
        },
        "parameters": {
            key: str(value) if isinstance(value, Path) else value
            for key, value in vars(namespace).items()
        },
        "baseline": {
            "artifact_root": str(baseline_root),
            "analysis": baseline_analysis,
            "verification": baseline_verification,
            "R_area_hold_nm": baseline_hold["R_area_nm"],
            "R_core_hold_nm": baseline_hold["R_core_nm"],
            "Q_hold": baseline_hold["topological_charge"],
            "E_profile_J": baseline_analysis["profile_energy"]["E_total_J"],
            "verification_status": baseline_verification["status"],
            "state_path": str(baseline_state_path),
            "state_sha256": _sha256_file(baseline_state_path),
            "provenance_contract_path": str(baseline_root / CONTRACT_FILENAME),
            "provenance_contract_sha256": baseline_contract.get("contract_sha256"),
        },
        "background": {
            "artifact_root": str(background_root),
            "provenance_contract_path": str(background_root / CONTRACT_FILENAME),
            "provenance_contract_sha256": background_contract.get("contract_sha256"),
        },
        "frozen": {
            "artifact_root": str(frozen_root),
            "analysis": frozen_analysis,
            "verification": frozen_verification,
            "R_area_initial_nm": frozen_initial["R_area_nm"],
            "R_core_initial_nm": frozen_initial["R_core_nm"],
            "Q_initial": frozen_initial["topological_charge"],
            "R_area_hold_nm": frozen_hold["R_area_nm"],
            "R_core_hold_nm": frozen_hold["R_core_nm"],
            "Q_hold": frozen_hold["topological_charge"],
            "E_profile_J": frozen_analysis["profile_energy"]["E_total_J"],
            "R_area_release_nm": frozen_release["R_area_nm"],
            "R_core_release_nm": frozen_release["R_core_nm"],
            "Q_release": frozen_release["topological_charge"],
            "E_terminal_J": frozen_analysis["energy"]["E_total_J"],
            "verification_status": frozen_verification["status"],
            "protocol": frozen_protocol,
            "initial_state_path": str(frozen_initial_path),
            "initial_state_sha256": _sha256_file(frozen_initial_path),
            "hold_state_path": str(frozen_hold_path),
            "release_state_path": str(frozen_release_path),
            "provenance_contract_path": str(frozen_root / CONTRACT_FILENAME),
            "provenance_contract_sha256": frozen_contract.get("contract_sha256"),
        },
        "comparison": comparison,
        "qualification": {
            "status": "diagnostic"
            if baseline_verification["status"] != "passed"
            or frozen_verification["status"] != "passed"
            or not comparison["initial_state_full_match"]
            or state_preservation["status"] != "passed"
            else "passed",
            "same_state_check": comparison["initial_state_radius_match"],
            "same_state_full_field_check": comparison["initial_state_full_match"],
            "hold_state_preservation_check": state_preservation["status"],
            "interpolation_allowed": False,
        },
    }
    _write_json(output_root / "paired_summary.json", summary)
    _write_report(output_root / "paired_report.md", summary)
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--seed-radius-nm", type=float, default=5.0)
    parser.add_argument("--wall-width-nm", type=float, default=DEFAULT_WALL_WIDTH_NM)
    parser.add_argument(
        "--frozen-protocol",
        choices=("ring", "p3"),
        default="ring",
        help="constraint used for the validation; ring is the primary same-state check",
    )
    parser.add_argument("--cell-nm", type=float, default=DEFAULT_CELL_NM)
    parser.add_argument("--track-x-nm", type=float, default=None)
    parser.add_argument("--track-y-nm", type=float, default=None)
    parser.add_argument("--pin-radius-nm", type=float, default=DEFAULT_PIN_RADIUS_NM)
    parser.add_argument("--ring-width-nm", type=float, default=DEFAULT_RING_WIDTH_NM)
    parser.add_argument("--helicity-rad", type=float, default=0.0)
    parser.add_argument("--vorticity", type=int, choices=(-1, 1), default=-1)
    parser.add_argument("--background-sign", type=int, choices=(-1, 1), default=1)
    parser.add_argument("--device", choices=("cpu", "gpu"), default="gpu")
    parser.add_argument(
        "--run-mode",
        choices=("interactive", "headless"),
        default="interactive",
        help="interactive keeps the Control Room session inspectable while stages run",
    )
    parser.add_argument("--web-port", type=int, default=3100)
    parser.add_argument("--relax-time-s", type=float, default=2e-11)
    parser.add_argument("--tol-t", type=float, default=DEFAULT_RELAX_TOL_T)
    parser.add_argument("--hold-time-s", type=float, default=2e-12)
    parser.add_argument("--release-time-s", type=float, default=2e-11)
    parser.add_argument("--relax-max-steps", type=int, default=8000)
    parser.add_argument("--release-max-steps", type=int, default=8000)
    parser.add_argument("--field-every-steps", type=int, default=100)
    parser.add_argument("--table-every-steps", type=int, default=DEFAULT_TABLE_EVERY_STEPS)
    parser.add_argument(
        "--state-transfer-tolerance",
        type=float,
        default=1e-12,
        help="maximum unit-vector difference accepted for P0 to frozen initial transfer",
    )
    parser.add_argument(
        "--thresholds",
        type=Path,
        default=WORKING_THRESHOLDS_REL,
        help="wersjonowana polityka weryfikacji; domyślnie progi robocze paired validation",
    )
    parser.add_argument("--output-root", type=Path)
    args = parser.parse_args()
    if args.track_x_nm is None:
        args.track_x_nm = DEFAULT_TRACK_X_NM
    if args.track_y_nm is None:
        args.track_y_nm = DEFAULT_TRACK_Y_NM
    if args.track_x_nm <= 0.0 or args.track_y_nm <= 0.0:
        parser.error("--track-x-nm and --track-y-nm must be positive")
    if args.web_port <= 0 or args.web_port > 65535:
        parser.error("--web-port must be between 1 and 65535")
    if args.tol_t <= 0.0 or args.state_transfer_tolerance <= 0.0:
        parser.error("--tol-t and --state-transfer-tolerance must be positive")
    if args.table_every_steps <= 0:
        parser.error("--table-every-steps must be positive")
    summary = run(args)
    print(json.dumps({
        "output_root": summary["layout"]["output_root"],
        "baseline_status": summary["baseline"]["verification_status"],
        "frozen_status": (
            summary["frozen"]["verification_status"]
            if isinstance(summary.get("frozen"), dict)
            else "not_run"
        ),
        "qualification_status": summary["qualification"]["status"],
        "comparison": summary["comparison"],
    }, indent=2, ensure_ascii=False))
    return 0 if summary["qualification"]["status"] == "passed" else 2


if __name__ == "__main__":
    raise SystemExit(main())
