"""Run the baseline-to-frozen-spins validation for one bimeron seed size.

The paired protocol deliberately separates two questions:

1. an unconstrained ``p0`` relaxation establishes the state selected by the
   same rDMI parameters and records its measured radius and opposite ``m_z``
   extrema;
2. a ``p3`` run is initialized from that measured baseline state, freezes
   small full-thickness disks at those extrema plus the centre, and checks
   whether the constrained hold and subsequent release reproduce the same
   texture.

This is a validation run, not an energy-profile sweep.  It keeps both
artifacts and writes an explicit comparison receipt so a later profile can
use a measured baseline rather than an independently authored seed.
"""

from __future__ import annotations

import argparse
import json
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
    DEFAULT_CELL_NM,
    DEFAULT_PIN_RADIUS_NM,
    DEFAULT_RING_WIDTH_NM,
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
    _environment,
    _launch,
    _managed_runtime_matches_source,
    _resolve_layout,
    _run_process,
    _sha256_file,
    _source_identity,
    _verify_case,
    _workspace_from_launcher_log,
    _write_json,
)


def _args(namespace: argparse.Namespace) -> SimpleNamespace:
    return SimpleNamespace(
        device=namespace.device,
        cell_nm=namespace.cell_nm,
        pin_radius_nm=namespace.pin_radius_nm,
        ring_width_nm=namespace.ring_width_nm,
        helicity_rad=namespace.helicity_rad,
        vorticity=namespace.vorticity,
        background_sign=namespace.background_sign,
        release=False,
        relax_time_s=namespace.relax_time_s,
        hold_time_s=namespace.hold_time_s,
        release_time_s=namespace.release_time_s,
        relax_max_steps=namespace.relax_max_steps,
        release_max_steps=namespace.release_max_steps,
        field_every_steps=namespace.field_every_steps,
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
        "cell_nm": args.cell_nm,
        "pin_radius_nm": args.pin_radius_nm,
        "ring_width_nm": args.ring_width_nm,
        "helicity_rad": args.helicity_rad,
        "vorticity": args.vorticity,
        "background_sign": args.background_sign,
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


def _measurement(analysis: dict[str, Any], label: str) -> dict[str, Any]:
    states = analysis.get("states")
    if not isinstance(states, dict) or not isinstance(states.get(label), dict):
        raise RuntimeError(f"missing {label} measurement in {analysis.get('artifact_root')}")
    measurement = states[label].get("measurement")
    if not isinstance(measurement, dict):
        raise RuntimeError(f"missing {label} measurement payload")
    return measurement


def _write_report(path: Path, summary: dict[str, Any]) -> None:
    baseline = summary["baseline"]
    frozen = summary["frozen"]
    comparison = summary["comparison"]
    lines = [
        "# Baseline-to-frozen-spins bimeron validation",
        "",
        f"- Source: `{summary['source']['git_head']}`",
        f"- Requested device: `{summary['source']['device']}`",
        f"- Seed radius: `{summary['parameters']['seed_radius_nm']:g} nm`",
        "- Baseline: unconstrained `p0`",
        "- Frozen validation: `p3` with measured `m_z` extrema plus centre",
        "",
        "## Measured states",
        "",
        "| state | R_area (nm) | R_core (nm) | Q | E_profile (J) | verification |",
        "|---|---:|---:|---:|---:|---|",
        f"| baseline hold | {baseline['R_area_hold_nm']:.6g} | {baseline['R_core_hold_nm']:.6g} | {baseline['Q_hold']:.7g} | {baseline['E_profile_J']:.7e} | {baseline['verification_status']} |",
        f"| frozen initial | {frozen['R_area_initial_nm']:.6g} | {frozen['R_core_initial_nm']:.6g} | {frozen['Q_initial']:.7g} | — | — |",
        f"| frozen hold | {frozen['R_area_hold_nm']:.6g} | {frozen['R_core_hold_nm']:.6g} | {frozen['Q_hold']:.7g} | {frozen['E_profile_J']:.7e} | {frozen['verification_status']} |",
        f"| frozen release | {frozen['R_area_release_nm']:.6g} | {frozen['R_core_release_nm']:.6g} | {frozen['Q_release']:.7g} | {frozen['E_terminal_J']:.7e} | — |",
        "",
        "## Pair comparison",
        "",
        f"- baseline → frozen initial ΔR_area: `{comparison['delta_R_area_initial_minus_baseline_nm']:.6g} nm`",
        f"- baseline → frozen hold ΔR_area: `{comparison['delta_R_area_hold_minus_baseline_nm']:.6g} nm`",
        f"- baseline → frozen release ΔR_area: `{comparison['delta_R_area_release_minus_baseline_nm']:.6g} nm`",
        f"- baseline → frozen hold ΔE: `{comparison['delta_E_hold_minus_baseline_J']:.7e} J`",
        f"- frozen reference drift: `{comparison['frozen_reference_max_drift']!s}`",
        f"- same-state initial radius check: `{comparison['initial_state_radius_match']}`",
        "",
        "The run is a validation of state transfer and constrained dynamics. It is not "
        "an accepted energy minimum until the solver convergence and torque gates pass.",
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def run(namespace: argparse.Namespace) -> dict[str, Any]:
    if not namespace.run:
        raise SystemExit("pass --run to execute the paired validation")
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
            needs_control_room_toolchain=False,
        ),
        "runtime_manifest": str(Path(layout["build_root"]) / "windows-runtime" / "build-manifest.json"),
    }
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
    _write_json(background_root / "request.json", {"kind": "background", "case": background_case})
    built = bool(source["managed_runtime_matches_source_preflight"])
    background_workspace = _launch(
        repo,
        layout,
        repo / BACKGROUND_REL,
        background_root,
        background_case,
        args,
        build=not built,
    )
    built = True
    background_analysis = _analyze(
        repo,
        layout,
        background_root,
        workspace=background_workspace,
        background_root=background_root,
        background_workspace=background_workspace,
        environment={**os.environ, **_environment(background_case, args)},
    )
    baseline_root = output_root / "baseline-p0"
    baseline_root.mkdir(parents=True, exist_ok=True)
    _write_json(baseline_root / "request.json", {"kind": "baseline", "case": baseline_case})
    baseline_workspace = _launch(
        repo,
        layout,
        repo / SCENARIO_REL,
        baseline_root,
        baseline_case,
        args,
        build=not built,
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
    baseline_verification = _verify_case(repo, baseline_analysis, baseline_root)
    baseline_hold = _measurement(baseline_analysis, "constrained_held")
    baseline_state = baseline_analysis["states"]["constrained_held"]
    baseline_state_path = Path(baseline_state["path"])
    if not baseline_state_path.is_file():
        raise RuntimeError(f"baseline state artifact is missing: {baseline_state_path}")
    min_position = baseline_hold.get("mz_min_position_nm")
    max_position = baseline_hold.get("mz_max_position_nm")
    if not (
        isinstance(min_position, list)
        and len(min_position) == 2
        and isinstance(max_position, list)
        and len(max_position) == 2
    ):
        raise RuntimeError("baseline analysis did not expose opposite m_z extrema positions")
    measured_radius_value = baseline_hold.get("R_area_nm") or baseline_hold.get("R_core_nm")
    if measured_radius_value is None:
        raise RuntimeError("baseline analysis did not expose R_area_nm or R_core_nm")
    measured_radius = float(measured_radius_value)
    frozen_case = _case(
        target_radius_nm=measured_radius,
        wall_width_nm=namespace.wall_width_nm,
        protocol="p3",
        args=args,
        release=True,
        pin_centres_nm=[
            [float(min_position[0]), float(min_position[1])],
            [float(max_position[0]), float(max_position[1])],
        ],
    )
    frozen_root = output_root / "frozen-p3-from-baseline"
    frozen_root.mkdir(parents=True, exist_ok=True)
    _write_json(
        frozen_root / "request.json",
        {
            "kind": "frozen_from_baseline",
            "case": frozen_case,
            "initial_state": str(baseline_state_path),
            "initial_state_sha256": _sha256_file(baseline_state_path),
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
    frozen_verification = _verify_case(repo, frozen_analysis, frozen_root)
    frozen_initial = _measurement(frozen_analysis, "initial")
    frozen_hold = _measurement(frozen_analysis, "constrained_held")
    frozen_release = _measurement(frozen_analysis, "released")
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
        },
        "comparison": comparison,
        "qualification": {
            "status": "diagnostic"
            if baseline_verification["status"] != "passed" or frozen_verification["status"] != "passed"
            else "passed",
            "same_state_check": comparison["initial_state_radius_match"],
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
    parser.add_argument("--cell-nm", type=float, default=DEFAULT_CELL_NM)
    parser.add_argument("--pin-radius-nm", type=float, default=DEFAULT_PIN_RADIUS_NM)
    parser.add_argument("--ring-width-nm", type=float, default=DEFAULT_RING_WIDTH_NM)
    parser.add_argument("--helicity-rad", type=float, default=0.0)
    parser.add_argument("--vorticity", type=int, choices=(-1, 1), default=-1)
    parser.add_argument("--background-sign", type=int, choices=(-1, 1), default=1)
    parser.add_argument("--device", choices=("cpu", "gpu"), default="gpu")
    parser.add_argument("--relax-time-s", type=float, default=2e-11)
    parser.add_argument("--hold-time-s", type=float, default=2e-12)
    parser.add_argument("--release-time-s", type=float, default=2e-11)
    parser.add_argument("--relax-max-steps", type=int, default=8000)
    parser.add_argument("--release-max-steps", type=int, default=8000)
    parser.add_argument("--field-every-steps", type=int, default=100)
    parser.add_argument("--output-root", type=Path)
    args = parser.parse_args()
    summary = run(args)
    print(json.dumps({
        "output_root": summary["layout"]["output_root"],
        "baseline_status": summary["baseline"]["verification_status"],
        "frozen_status": summary["frozen"]["verification_status"],
        "comparison": summary["comparison"],
    }, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
