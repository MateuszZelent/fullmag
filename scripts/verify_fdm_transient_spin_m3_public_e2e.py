#!/usr/bin/env python3
"""Qualify public canonical authoring and exact-process M3 resume."""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import tempfile
from pathlib import Path

import fullmag as fm


def canonical_problem_ir() -> dict[str, object]:
    geometry = fm.Box(size=(4.0e-9, 1.0e-9, 1.0e-9), name="strip")
    material = fm.Material(name="Py", Ms=8.0e5, A=13.0e-12, alpha=0.02)
    magnet = fm.Ferromagnet(name="strip", geometry=geometry, material=material)
    region = fm.RegionRef("strip")
    x_min = fm.SurfaceRef("strip", "x_min", (-1.0, 0.0, 0.0))
    x_max = fm.SurfaceRef("strip", "x_max", (1.0, 0.0, 0.0))
    transverse_surfaces = [
        fm.SurfaceRef("strip", "y_min", (0.0, -1.0, 0.0)),
        fm.SurfaceRef("strip", "y_max", (0.0, 1.0, 0.0)),
        fm.SurfaceRef("strip", "z_min", (0.0, 0.0, -1.0)),
        fm.SurfaceRef("strip", "z_max", (0.0, 0.0, 1.0)),
    ]
    charge = fm.CurrentTransport(
        name="charge",
        model="ohmic_poisson",
        coupling="one_way",
        domain=[region],
        materials=[
            fm.ChargeTransportMaterialAssignment(
                region, fm.ChargeTransportMaterial(sigma_Spm=4.0e6)
            )
        ],
        boundaries=[
            fm.VoltageElectrode("ground", [x_min], potential_V=0.0),
            fm.VoltageElectrode("drive", [x_max], potential_V=0.1),
            fm.ChargeInsulating("sidewalls", transverse_surfaces),
        ],
        gauge=fm.ChargePotentialGauge("dirichlet_reference"),
        solver=fm.ChargeSolverPolicy(relative_tolerance=1.0e-10),
    )
    spin = fm.SpinDriftDiffusion(
        id="spin",
        current_source_id="charge",
        domain=[region],
        materials=[
            fm.SpinTransportMaterialAssignment(
                region,
                fm.SpinTransportMaterial(
                    sigma_s_Spm=3.0e6,
                    polarization_p=0.4,
                    theta_sh=0.1,
                    lambda_sf_m=5.0e-9,
                    spin_capacitance_As_per_V_m3=2.0,
                    capacitance_formula_version="dos_constant.fullmag.v1",
                ),
            )
        ],
        mode="transient",
        solver=fm.SpinSolverPolicy(
            relative_tolerance=1.0e-8, absolute_tolerance=1.0e-12
        ),
        requested_execution=fm.TransportExecution(
            discretization="fdm",
            device="cpu",
            precision="double",
            execution_mode="strict",
        ),
    )
    problem = fm.Problem(
        name="m3_public_process_qualification",
        magnets=[magnet],
        energy=[fm.Zeeman((0.0, 0.0, 0.0))],
        study=fm.TimeEvolution(
            dynamics=fm.LLG(
                integrator="coupled_imex_ark2", fixed_timestep=1.0e-13
            ),
            outputs=[fm.SaveScalar("E_total", every=1.0e-13)],
        ),
        discretization=fm.DiscretizationHints(
            fdm=fm.FDM(cell=(1.0e-9, 1.0e-9, 1.0e-9))
        ),
        current_modules=[charge],
        spin_transports=[spin],
        spin_torques=[fm.DriftDiffusionSpinTorque("spin_torque", "spin", region)],
        temperature=300.0,
    )
    return fm.Simulation(
        problem, backend="fdm", mode="strict", precision="double"
    ).to_ir(entrypoint_kind="direct")


def run(command: list[str]) -> dict[str, object]:
    completed = subprocess.run(command, text=True, capture_output=True)
    if completed.returncode != 0:
        raise RuntimeError(
            f"command failed ({completed.returncode}): {' '.join(command)}\n"
            f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
        )
    return json.loads(completed.stdout)


def load(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def assert_close(actual: object, expected: object, path: str = "root") -> None:
    if isinstance(actual, bool) or isinstance(expected, bool):
        assert actual == expected, f"{path}: {actual!r} != {expected!r}"
    elif isinstance(actual, (int, float)) and isinstance(expected, (int, float)):
        assert math.isclose(float(actual), float(expected), rel_tol=1.0e-12, abs_tol=1.0e-18), (
            f"{path}: {actual!r} != {expected!r}"
        )
    elif isinstance(actual, list) and isinstance(expected, list):
        assert len(actual) == len(expected), f"{path}: list length mismatch"
        for index, (actual_item, expected_item) in enumerate(zip(actual, expected)):
            assert_close(actual_item, expected_item, f"{path}[{index}]")
    elif isinstance(actual, dict) and isinstance(expected, dict):
        assert actual.keys() == expected.keys(), f"{path}: object keys mismatch"
        for key in actual:
            assert_close(actual[key], expected[key], f"{path}.{key}")
    else:
        assert actual == expected, f"{path}: {actual!r} != {expected!r}"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fullmag", required=True, type=Path)
    args = parser.parse_args()
    binary = str(args.fullmag.resolve())
    with tempfile.TemporaryDirectory(prefix="fullmag-m3-public-e2e-") as raw:
        root = Path(raw)
        problem_path = root / "problem.json"
        split_dir = root / "split"
        uninterrupted_dir = root / "uninterrupted"
        problem_path.write_text(
            json.dumps(canonical_problem_ir(), indent=2), encoding="utf-8"
        )
        run(
            [
                binary,
                "run-json",
                str(problem_path),
                "--until",
                "2e-13",
                "--output-dir",
                str(split_dir),
            ]
        )
        run(
            [
                binary,
                "run-json",
                str(problem_path),
                "--until",
                "4e-13",
                "--output-dir",
                str(uninterrupted_dir),
            ]
        )
        split_checkpoint_path = split_dir / "transport/coupled_checkpoint.json"
        resumed = run(
            [
                binary,
                "resume-json",
                str(problem_path),
                "--checkpoint",
                str(split_checkpoint_path),
                "--until",
                "4e-13",
            ]
        )["evidence"]
        uninterrupted_checkpoint = load(
            uninterrupted_dir / "transport/coupled_checkpoint.json"
        )
        uninterrupted_accepted = load(
            uninterrupted_dir / "transport/spin_transport_accepted.json"
        )
        assert resumed["status"] == "completed"
        assert_close(
            resumed["final_magnetization"],
            uninterrupted_checkpoint["magnetization"],
            "final_magnetization",
        )
        assert_close(
            resumed["accepted_transport"],
            uninterrupted_accepted,
            "accepted_transport",
        )
        resumed_rng = resumed["coupled_checkpoint"]
        assert (
            resumed_rng["thermal_rng_algorithm"]
            == uninterrupted_checkpoint["thermal_rng_algorithm"]
        )
        assert resumed_rng["thermal_seed"] == uninterrupted_checkpoint["thermal_seed"]
        assert (
            resumed_rng["thermal_counter"]
            == uninterrupted_checkpoint["thermal_counter"]
        )
    print("M3 public canonical authoring, planner/runner, and subprocess resume: PASS")


if __name__ == "__main__":
    main()
