#!/usr/bin/env python3
"""Build and run the Fullmag FDM CPU-double M2 N/F diagnostic reference."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

import fullmag as fm


@dataclass(frozen=True)
class Resolution:
    nx: int
    ny: int
    nz_n: int
    nz_f: int
    cell_m: tuple[float, float, float] = (1.0e-7, 1.0e-7, 1.0e-9)
    solver_tolerance: float = 1.0e-9

    def __post_init__(self) -> None:
        for name in ("nx", "ny", "nz_n", "nz_f"):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
                raise ValueError(f"{name} must be a positive integer")
        if len(self.cell_m) != 3 or any(not math.isfinite(float(value)) or value <= 0.0 for value in self.cell_m):
            raise ValueError("cell_m must contain three positive finite values")
        if not math.isfinite(float(self.solver_tolerance)) or self.solver_tolerance <= 0.0:
            raise ValueError("solver_tolerance must be finite and positive")

    @property
    def shape(self) -> tuple[int, int, int]:
        return (self.nx, self.ny, self.nz_n + self.nz_f)

    @property
    def total_length_m(self) -> float:
        return self.shape[2] * self.cell_m[2]


BORIS_SHA = 0.1
BORIS_GI_SPM2 = 5.0e14
BORIS_GMIX_SPM2 = (1.5e15, 0.0)
CONDUCTIVITY_SPM = 5.8e7
DE_M2_PER_S = 0.01
LAMBDA_SF_M = 5.0e-9
CURRENT_DENSITY_APM2 = 1.0e11
MS_APM = 8.0e5
EXCHANGE_JPM = 1.3e-11
FORMULA_VERSION = "fullmag.fdm.m2.transport.v1"
REFERENCE_MAX_LINEAR_ITERATIONS = 500
REFERENCE_MAX_PICARD_ITERATIONS = 20


def _surface(object_id: str, surface_id: str, orientation: tuple[float, float, float]) -> fm.SurfaceRef:
    return fm.SurfaceRef(object_id, surface_id, orientation)


def _problem(resolution: Resolution) -> fm.Problem:
    dx, dy, dz = resolution.cell_m
    width = resolution.nx * dx
    height = resolution.ny * dy
    normal_thickness = resolution.nz_n * dz
    ferromagnet_thickness = resolution.nz_f * dz
    total_thickness = normal_thickness + ferromagnet_thickness
    stack = fm.Box(size=(width, height, total_thickness), name="stack")
    normal_shape = fm.Box(size=(width, height, normal_thickness), name="normal_metal_shape")
    ferromagnet_shape = fm.Box(size=(width, height, ferromagnet_thickness), name="ferromagnet_shape")
    normal_region = fm.ObjectRegion(
        owner_object="stack",
        name="normal_metal",
        region_id="normal_metal",
        shape=normal_shape.translate((0.0, 0.0, -ferromagnet_thickness / 2.0)),
    )
    ferromagnet_region = fm.ObjectRegion(
        owner_object="stack",
        name="ferromagnet",
        region_id="ferromagnet",
        shape=ferromagnet_shape.translate((0.0, 0.0, normal_thickness / 2.0)),
        priority=1,
    )
    magnetic_material = fm.Material(
        name="N_F_reference_magnet",
        Ms=MS_APM,
        A=EXCHANGE_JPM,
        alpha=0.01,
    )
    magnet = fm.Ferromagnet(
        name="stack",
        geometry=stack,
        material=magnetic_material,
        object_regions=[normal_region, ferromagnet_region],
    )
    normal = fm.RegionRef("stack", "normal_metal")
    ferromagnet = fm.RegionRef("stack", "ferromagnet")
    x_min = _surface("stack", "x_min", (-1.0, 0.0, 0.0))
    x_max = _surface("stack", "x_max", (1.0, 0.0, 0.0))
    side_surfaces = [
        _surface("stack", "y_min", (0.0, -1.0, 0.0)),
        _surface("stack", "y_max", (0.0, 1.0, 0.0)),
        _surface("stack", "z_min", (0.0, 0.0, -1.0)),
        _surface("stack", "z_max", (0.0, 0.0, 1.0)),
    ]
    charge = fm.CurrentTransport(
        name="charge",
        model="ohmic_poisson",
        coupling="bidirectional",
        domain=[normal, ferromagnet],
        materials=[
            fm.ChargeTransportMaterialAssignment(
                normal,
                fm.ChargeTransportMaterial(
                    sigma_Spm=CONDUCTIVITY_SPM,
                    sigma_parallel_Spm=CONDUCTIVITY_SPM,
                    sigma_perpendicular_Spm=CONDUCTIVITY_SPM,
                    sigma_AHE_Spm=0.0,
                ),
            ),
            fm.ChargeTransportMaterialAssignment(
                ferromagnet,
                fm.ChargeTransportMaterial(
                    sigma_Spm=CONDUCTIVITY_SPM,
                    sigma_parallel_Spm=CONDUCTIVITY_SPM,
                    sigma_perpendicular_Spm=CONDUCTIVITY_SPM,
                    sigma_AHE_Spm=0.0,
                ),
            ),
        ],
        boundaries=[
            fm.VoltageElectrode("ground", [x_min], potential_V=0.0),
            fm.VoltageElectrode(
                "drive",
                [x_max],
                potential_V=CURRENT_DENSITY_APM2 * width / CONDUCTIVITY_SPM,
            ),
            fm.ChargeInsulating("sidewalls", side_surfaces),
        ],
        gauge=fm.ChargePotentialGauge("dirichlet_reference"),
        solver=fm.ChargeSolverPolicy(
            engine="block_gmres",
            relative_tolerance=resolution.solver_tolerance,
            absolute_tolerance=0.0,
            max_iterations=REFERENCE_MAX_LINEAR_ITERATIONS,
            operator_version="fdm_coupled_charge_spin_fv_block_gmres.v1",
        ),
    )
    interface = fm.MixingConductanceSpinInterface(
        id="normal_ferromagnet",
        normal_to_ferromagnet=(0.0, 0.0, 1.0),
        normal_side=normal,
        ferromagnet_side=ferromagnet,
        g_up_Spm2=1.0e15,
        g_down_Spm2=0.5e15,
        g_r_Spm2=BORIS_GMIX_SPM2[0],
        g_i_Spm2=BORIS_GI_SPM2,
    )
    spin = fm.SpinDriftDiffusion(
        id="spin",
        current_source_id="charge",
        domain=[normal, ferromagnet],
        materials=[
            fm.SpinTransportMaterialAssignment(
                normal,
                fm.SpinTransportMaterial(
                    sigma_s_Spm=CONDUCTIVITY_SPM,
                    polarization_p=0.0,
                    theta_sh=BORIS_SHA,
                    lambda_sf_m=LAMBDA_SF_M,
                ),
            ),
            fm.SpinTransportMaterialAssignment(
                ferromagnet,
                fm.SpinTransportMaterial(
                    sigma_s_Spm=CONDUCTIVITY_SPM,
                    polarization_p=0.4,
                    theta_sh=BORIS_SHA,
                    lambda_sf_m=LAMBDA_SF_M,
                ),
            ),
        ],
        interfaces=[interface],
        solver=fm.SpinSolverPolicy(
            relative_tolerance=resolution.solver_tolerance,
            absolute_tolerance=0.0,
            max_iterations=REFERENCE_MAX_LINEAR_ITERATIONS,
            operator_version="fdm_coupled_charge_spin_fv_block_gmres.v1",
            reciprocal_nonlinear=fm.ReciprocalNonlinearSolverPolicy(
                gmres_restart=40,
                max_picard_iterations=REFERENCE_MAX_PICARD_ITERATIONS,
                relative_update_tolerance=resolution.solver_tolerance,
                eta_transport=0.25,
            ),
        ),
        requested_execution=fm.TransportExecution(
            discretization="fdm",
            device="cpu",
            precision="double",
            execution_mode="strict",
        ),
    )
    return fm.Problem(
        name="boris_fullmag_nf_m2_reference",
        magnets=[magnet],
        energy=[fm.Exchange()],
        study=fm.TimeEvolution(
            dynamics=fm.LLG(integrator="heun", fixed_timestep=1.0e-15),
            outputs=[fm.SaveScalar("E_total", every=1.0e-15)],
        ),
        discretization=fm.DiscretizationHints(fdm=fm.FDM(cell=resolution.cell_m)),
        runtime=fm.RuntimeSelection(
            backend_target=fm.BackendTarget.FDM,
            device_target=fm.DeviceTarget.CPU,
            execution_mode=fm.ExecutionMode.STRICT,
            execution_precision=fm.ExecutionPrecision.DOUBLE,
        ),
        current_modules=[charge],
        spin_transports=[spin],
        spin_torques=[fm.DriftDiffusionSpinTorque("spin_torque", "spin", ferromagnet)],
        runtime_metadata={
            "comparison_contract": "fullmag.boris_fullmag_she_nf.v1",
            "formula_version": FORMULA_VERSION,
            "mesh": {
                "shape": list(resolution.shape),
                "origin_m": [0.0, 0.0, -total_thickness / 2.0],
                "step_m": list(resolution.cell_m),
            },
        },
    )


def build_fullmag_nf_problem(
    resolution: Resolution, *, include_geometry_assets: bool = False
) -> dict[str, object]:
    """Build the public Python DSL and its canonical ProblemIR request."""

    problem = _problem(resolution)
    ir = problem.to_ir(
        requested_backend=fm.BackendTarget.FDM,
        execution_mode=fm.ExecutionMode.STRICT,
        execution_precision=fm.ExecutionPrecision.DOUBLE,
        include_geometry_assets=include_geometry_assets,
        entrypoint_kind="direct",
    )
    return {
        "schema_version": "fullmag.boris_fullmag_she_nf.request.v1",
        "execution": {
            "discretization": "fdm",
            "device": "cpu",
            "precision": "double",
            "mode": "strict",
        },
        "mesh": {
            "shape": list(resolution.shape),
            "origin_m": list(ir["problem_meta"]["runtime_metadata"]["mesh"]["origin_m"]),
            "step_m": list(resolution.cell_m),
        },
        "transport": {
            "coupling": "bidirectional",
            "SHA": BORIS_SHA,
            "iSHA": BORIS_SHA,
            "De_m2_per_s": DE_M2_PER_S,
            "elC_Spm": CONDUCTIVITY_SPM,
            "lambda_sf_m": LAMBDA_SF_M,
            "Gi_Spm2": BORIS_GI_SPM2,
            "Gmix_Spm2": list(BORIS_GMIX_SPM2),
            "current_density_apm2": [CURRENT_DENSITY_APM2, 0.0, 0.0],
            "solver": {
                "linear_relative_tolerance": resolution.solver_tolerance,
                "linear_max_iterations": REFERENCE_MAX_LINEAR_ITERATIONS,
                "gmres_restart": 40,
                "max_picard_iterations": REFERENCE_MAX_PICARD_ITERATIONS,
                "relative_update_tolerance": resolution.solver_tolerance,
                "operator_version": "fdm_coupled_charge_spin_fv_block_gmres.v1",
            },
            "interface": {
                "Gi_Spm2": BORIS_GI_SPM2,
                "Gmix_Spm2": list(BORIS_GMIX_SPM2),
            },
        },
        "problem_ir": ir,
    }


def _require_binary(path: Path) -> Path:
    resolved = path.expanduser().resolve()
    if not resolved.is_file() or not os.access(resolved, os.X_OK):
        raise RuntimeError(f"not_run: Fullmag binary is missing or not executable: {resolved}")
    return resolved


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _runtime_identity(binary: Path) -> dict[str, object]:
    try:
        probe = subprocess.run(
            [str(binary), "--help"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RuntimeError(f"not_run: Fullmag runtime identity probe failed: {error}") from error
    if probe.returncode != 0:
        raise RuntimeError(f"not_run: Fullmag runtime identity probe exited with {probe.returncode}")
    native = binary.with_name("fullmag-bin")
    identity: dict[str, object] = {
        "launcher": str(binary),
        "launcher_sha256": _sha256(binary),
        "native_binary": str(native) if native.is_file() else None,
        "native_binary_sha256": _sha256(native) if native.is_file() else None,
        "help_sha256": hashlib.sha256(probe.stdout.encode("utf-8")).hexdigest(),
        "build_identity": probe.stdout.splitlines()[0] if probe.stdout.splitlines() else "",
        "requested_execution": {
            "discretization": "fdm",
            "device": "cpu",
            "precision": "double",
            "mode": "strict",
        },
    }
    return identity


def _sum_vectors(values: object) -> list[float]:
    if not isinstance(values, list):
        raise RuntimeError("not_run: Fullmag torque field is missing")
    result = [0.0, 0.0, 0.0]
    for index, vector in enumerate(values):
        if not isinstance(vector, list) or len(vector) != 3:
            raise RuntimeError(f"not_run: Fullmag torque cell {index} is not a vector")
        for component, value in enumerate(vector):
            number = float(value)
            if not math.isfinite(number):
                raise RuntimeError(f"not_run: Fullmag torque cell {index} is non-finite")
            result[component] += number
    return result


def _materialize_comparison_artifact(
    accepted_path: Path, request: Mapping[str, object], output_path: Path
) -> Path:
    try:
        accepted = json.loads(accepted_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"not_run: cannot read Fullmag transport artifact: {error}") from error
    if not isinstance(accepted, dict) or accepted.get("schema") != "fullmag.fdm.spin_transport.accepted.v1":
        raise RuntimeError("not_run: Fullmag transport artifact schema is missing or unsupported")
    evaluation = accepted.get("evaluation")
    if not isinstance(evaluation, dict) or not isinstance(evaluation.get("modules"), list) or len(evaluation["modules"]) != 1:
        raise RuntimeError("not_run: Fullmag transport artifact has no unique module")
    module = evaluation["modules"][0]
    if not isinstance(module, dict):
        raise RuntimeError("not_run: Fullmag transport module is malformed")
    telemetry = module.get("telemetry")
    if not isinstance(telemetry, dict):
        raise RuntimeError("not_run: Fullmag transport telemetry is missing")
    interface_fluxes = module.get("interface_fluxes")
    if not isinstance(interface_fluxes, list) or len(interface_fluxes) != 1 or not isinstance(interface_fluxes[0], dict):
        raise RuntimeError("not_run: Fullmag transport interface flux is missing")
    interface_flux = interface_fluxes[0]
    absorbed = interface_flux.get("absorbed_transverse_apm2")
    if not isinstance(absorbed, list) or len(absorbed) != 3:
        raise RuntimeError("not_run: Fullmag absorbed interface flux is missing")
    mesh = request["mesh"]
    if not isinstance(mesh, dict):
        raise RuntimeError("not_run: Fullmag request mesh metadata is missing")
    torque = _sum_vectors(module.get("transport_torque_per_s"))
    transport = request["transport"]
    if not isinstance(transport, dict):
        raise RuntimeError("not_run: Fullmag request transport metadata is missing")
    artifact = {
        "schema": "fullmag.fdm.spin_transport.accepted.v1",
        "mesh": mesh,
        "component_order": "row_major_Q_ia",
        "formula_version": FORMULA_VERSION,
        "normal_axis": "z",
        "normal_sign": 1,
        "resolved_execution": request["execution"],
        "runtime_identity": request.get("runtime_identity"),
        "provenance": {
            "problem_ir_sha256": hashlib.sha256(
                json.dumps(request["problem_ir"], sort_keys=True, separators=(",", ":")).encode("utf-8")
            ).hexdigest(),
            "request_contract": request.get("schema_version"),
        },
        "potential_volts": module.get("potential_volts"),
        "spin_potential_volts": module.get("spin_potential_volts"),
        "current_density_apm2": module.get("current_density_apm2"),
        "spin_current_tensor_apm2": module.get("spin_current_tensor_apm2"),
        "transport_torque_per_s": module.get("transport_torque_per_s"),
        "residuals": {
            "charge": telemetry.get("scaled_charge_residual", telemetry.get("charge_residual_l2")),
            "spin": telemetry.get("spin_scaled_residual"),
        },
        "interface_balances": {
            "absorbed_spin_flux": absorbed,
            "torque": torque,
            "charge_closure": telemetry.get("charge_net_boundary_current_a", 0.0),
            "torque_source": "sum of Fullmag cellwise Gilbert transport torque; not BORIS Tsi",
        },
        "conventions": {
            "component_order": "row_major_Q_ia",
            "mu_s_convention": "full_spin_splitting_voltage",
            "potential_unit": "V",
            "charge_current_unit": "A_per_m2",
            "spin_current_unit": "A_per_m2",
            "torque_unit": "gilbert_source_per_s",
            "charge_closure_unit": "A",
        },
        "source": {
            "accepted_artifact": str(accepted_path),
            "resolved_execution": request["execution"],
        },
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(artifact, indent=2, sort_keys=True, allow_nan=False) + "\n", encoding="utf-8")
    return output_path


def run_fullmag_nf_reference(
    fullmag_binary: Path, resolution: Resolution, output_dir: Path, *, timeout_s: int = 300
) -> Path:
    """Run the strict FDM CPU-double lane and return the normalized artifact."""

    binary = _require_binary(fullmag_binary)
    output_dir = output_dir.expanduser().resolve()
    if output_dir.exists() and any(output_dir.iterdir()):
        raise RuntimeError(f"not_run: Fullmag output directory is not empty: {output_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)
    request = build_fullmag_nf_problem(resolution, include_geometry_assets=True)
    request["runtime_identity"] = _runtime_identity(binary)
    ir_path = output_dir / "problem_ir.json"
    ir_path.write_text(json.dumps(request["problem_ir"], indent=2, sort_keys=True, allow_nan=False) + "\n", encoding="utf-8")
    (output_dir / "request.json").write_text(json.dumps(request, indent=2, sort_keys=True, allow_nan=False) + "\n", encoding="utf-8")
    command = [
        str(binary),
        "run-json",
        str(ir_path),
        "--until",
        "1e-15",
        "--output-dir",
        str(output_dir),
    ]
    try:
        completed = subprocess.run(command, capture_output=True, text=True, timeout=timeout_s, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RuntimeError(f"not_run: Fullmag reference process failed to start or timed out: {error}") from error
    (output_dir / "fullmag.stdout.log").write_text(completed.stdout, encoding="utf-8")
    (output_dir / "fullmag.stderr.log").write_text(completed.stderr, encoding="utf-8")
    if completed.returncode != 0:
        raise RuntimeError(f"not_run: Fullmag reference exited with {completed.returncode}; see fullmag.stderr.log")
    accepted_path = output_dir / "transport" / "spin_transport_accepted.json"
    if not accepted_path.is_file():
        raise RuntimeError("not_run: Fullmag reference did not emit transport/spin_transport_accepted.json")
    return _materialize_comparison_artifact(
        accepted_path,
        request,
        output_dir / "transport" / "fullmag_m2_nf_reference.json",
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fullmag", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--resolution", choices=("coarse", "medium", "fine"), default="coarse")
    args = parser.parse_args()
    resolutions = {
        "coarse": Resolution(4, 2, 2, 2),
        "medium": Resolution(10, 4, 2, 2),
        "fine": Resolution(20, 8, 4, 4),
    }
    artifact = run_fullmag_nf_reference(args.fullmag, resolutions[args.resolution], args.output_dir)
    print(json.dumps({"status": "diagnostic", "artifact": str(artifact)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
