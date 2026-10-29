#!/usr/bin/env python3
"""Build and run the Fullmag FDM CPU-double M2 N/F diagnostic reference."""

from __future__ import annotations

import hashlib
import json
import math
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

import fullmag as fm
from boris_nf_common_case_v3 import CASE_KEYS, case_descriptor


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
LAMBDA_J_M = 2.0e-9
LAMBDA_PHI_M = 4.0e-9
FIXED_M_RTOL = 1.0e-6
FIXED_M_ATOL_APM = 1.0e-6
FORMULA_VERSION = "fullmag.fdm.m2.transport.v1"
REFERENCE_MAX_LINEAR_ITERATIONS = 2000
REFERENCE_MAX_PICARD_ITERATIONS = 20


def _surface(object_id: str, surface_id: str, orientation: tuple[float, float, float]) -> fm.SurfaceRef:
    return fm.SurfaceRef(object_id, surface_id, orientation)


def mesh_registration(resolution: Resolution) -> dict[str, object]:
    """Preregister the fixed translation of the entire homogeneous N/F case."""
    nx, ny, nz = resolution.shape
    dx, dy, dz = resolution.cell_m
    return {
        "schema": "fullmag.nf.sample-registration.v1",
        "fullmag_origin_m": [-nx * dx / 2.0, -ny * dy / 2.0, -nz * dz / 2.0],
        "boris_normal_origin_m": [0.0, 0.0, 0.0],
        "boris_ferromagnet_origin_m": [0.0, 0.0, resolution.nz_n * dz],
        "translation_fullmag_minus_boris_m": [-nx * dx / 2.0, -ny * dy / 2.0, -nz * dz / 2.0],
        "index_order": "x_fast_then_y_then_z", "sampling": "cell_centers",
        "interface_normal": "+z", "normal_cells": nx * ny * resolution.nz_n,
        "ferromagnet_cells": nx * ny * resolution.nz_f,
    }


def _problem(resolution: Resolution) -> fm.Problem:
    dx, dy, dz = resolution.cell_m
    width = resolution.nx * dx
    height = resolution.ny * dy
    normal_thickness = resolution.nz_n * dz
    ferromagnet_thickness = resolution.nz_f * dz
    total_thickness = normal_thickness + ferromagnet_thickness
    normal_geometry = fm.Translate(
        fm.Box(size=(width, height, normal_thickness), name="normal_shape"),
        offset=(0.0, 0.0, -ferromagnet_thickness / 2.0), name="normal")
    ferromagnet_geometry = fm.Translate(
        fm.Box(size=(width, height, ferromagnet_thickness), name="ferromagnet_shape"),
        offset=(0.0, 0.0, normal_thickness / 2.0), name="ferromagnet")
    ferromagnet_region = fm.ObjectRegion(
        owner_object="ferromagnet", name="ferromagnet", region_id="ferromagnet",
        shape=ferromagnet_geometry, frame="world", priority=1,
    )
    magnetic_material = fm.Material(
        name="N_F_reference_magnet",
        Ms=MS_APM,
        A=EXCHANGE_JPM,
        alpha=0.01,
    )
    magnet = fm.Ferromagnet(
        name="ferromagnet", object_id="ferromagnet", geometry=ferromagnet_geometry,
        material=magnetic_material, m0=fm.init.UniformMagnetization((1.0, 0.0, 0.0)),
        object_regions=[ferromagnet_region],
    )
    normal = fm.RegionRef(normal_geometry.geometry_name)
    ferromagnet = fm.RegionRef("ferromagnet", "ferromagnet")
    x_min = [_surface(owner, "x_min", (-1.0, 0.0, 0.0))
             for owner in (normal_geometry.geometry_name, "ferromagnet")]
    x_max = [_surface(owner, "x_max", (1.0, 0.0, 0.0))
             for owner in (normal_geometry.geometry_name, "ferromagnet")]
    side_surfaces = [
        *[_surface(owner, surface, orientation)
          for owner in (normal_geometry.geometry_name, "ferromagnet")
          for surface, orientation in (("y_min", (0.0, -1.0, 0.0)), ("y_max", (0.0, 1.0, 0.0)))],
        _surface(normal_geometry.geometry_name, "z_min", (0.0, 0.0, -1.0)),
        _surface("ferromagnet", "z_max", (0.0, 0.0, 1.0)),
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
            fm.VoltageElectrode("ground", x_min, potential_V=0.0),
            fm.VoltageElectrode(
                "drive",
                x_max,
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
        g_up_Spm2=0.0,
        g_down_Spm2=5.0e14,
        g_r_Spm2=BORIS_GMIX_SPM2[0],
        g_i_Spm2=BORIS_GMIX_SPM2[1],
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
                    theta_sh=-BORIS_SHA,
                    lambda_sf_m=LAMBDA_SF_M,
                ),
            ),
            fm.SpinTransportMaterialAssignment(
                ferromagnet,
                fm.SpinTransportMaterial(
                    sigma_s_Spm=CONDUCTIVITY_SPM,
                    polarization_p=-0.4,
                    theta_sh=0.0,
                    lambda_sf_m=LAMBDA_SF_M,
                    lambda_j_m=LAMBDA_J_M,
                    lambda_phi_m=LAMBDA_PHI_M,
                ),
            ),
        ],
        interfaces=[interface],
        boundaries=[
            fm.HomogeneousSpinPotentialGradient("terminal_gradient", [*x_min, *x_max]),
            fm.SpinInsulating("spin_sidewalls", side_surfaces),
        ],
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
        auxiliary_geometries=[normal_geometry],
        auxiliary_geometry_roles={normal_geometry.geometry_name: "conductor"},
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
        magnetization_constraints=[fm.FrozenSpins(
            id="nf_fixed_m", selector=fm.select.in_region("ferromagnet", "ferromagnet"),
            reference="capture_current_at_activation", membership="static",
        )],
        runtime_metadata={
            "comparison_contract": "fullmag.boris_nf_common.case.v3",
            "formula_version": FORMULA_VERSION,
            "mesh": {
                "shape": list(resolution.shape),
                "origin_m": mesh_registration(resolution)["fullmag_origin_m"],
                "step_m": list(resolution.cell_m),
            },
        },
    )


def build_fullmag_nf_problem(
    resolution: Resolution, *, include_geometry_assets: bool = False
) -> dict[str, object]:
    """Build the public Python DSL and its canonical ProblemIR request."""

    case_key = common_case_key(resolution)
    problem = _problem(resolution)
    ir = problem.to_ir(
        requested_backend=fm.BackendTarget.FDM,
        execution_mode=fm.ExecutionMode.STRICT,
        execution_precision=fm.ExecutionPrecision.DOUBLE,
        include_geometry_assets=include_geometry_assets,
        entrypoint_kind="direct",
    )
    return {
        "schema_version": "fullmag.boris_fullmag_she_nf.request.v3",
        "common_case": case_descriptor(case_key),
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
        "sample_registration": mesh_registration(resolution),
        "transport": {
            "coupling": "bidirectional",
            "SHA": -BORIS_SHA,
            "iSHA": -BORIS_SHA,
            "theta_F": 0.0,
            "boris_P": 0.4,
            "boris_betaD": 0.4,
            "De_m2_per_s": DE_M2_PER_S,
            "elC_Spm": CONDUCTIVITY_SPM,
            "lambda_sf_m": LAMBDA_SF_M,
            "lambda_j_m": LAMBDA_J_M,
            "lambda_phi_m": LAMBDA_PHI_M,
            "Ms_apm": MS_APM,
            "magnetization": [1.0, 0.0, 0.0],
            "polarization_p": -0.4,
            "current_control_convention": "positive_xmax_minus_xmin_voltage; Jc is measured separately",
            "Gi_Spm2": BORIS_GI_SPM2,
            "Gmix_Spm2": list(BORIS_GMIX_SPM2),
            "voltage_control_scale_apm2": CURRENT_DENSITY_APM2,
            "fixed_voltage_v": case_descriptor(case_key)["boundary"]["voltage_v"],
            "actual_current_source": "retained full reciprocal Jc field only",
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
                "g_up_Spm2": 0.0,
                "g_down_Spm2": 5.0e14,
                "Gmix_Spm2": list(BORIS_GMIX_SPM2),
            },
        },
        "problem_ir": ir,
    }



def common_resolutions() -> dict[str, Resolution]:
    result = {}
    for key in CASE_KEYS:
        geometry = case_descriptor(key)["geometry"]
        n, f = geometry["normal_shape"], geometry["ferromagnet_shape"]
        result[key] = Resolution(n[0], n[1], n[2], f[2], tuple(geometry["cell_m"]))
    return result


def common_case_key(resolution: Resolution) -> str:
    for key, fixed in common_resolutions().items():
        if (resolution.shape, resolution.nz_n, resolution.cell_m) == (fixed.shape, fixed.nz_n, fixed.cell_m):
            return key
    raise ValueError("common_case_v3 requires one of the three fixed-extent r0/r1/r2 grids")


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


_LOADED_SOURCE_SHA256 = _sha256(Path(__file__))


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


def _mean_interface_vectors(interface_fluxes: list[object], key: str) -> list[float]:
    total = [0.0, 0.0, 0.0]
    for index, observation in enumerate(interface_fluxes):
        if not isinstance(observation, dict):
            raise RuntimeError(f"not_run: Fullmag interface observation {index} is malformed")
        value = observation.get(key)
        if not isinstance(value, list) or len(value) != 3:
            raise RuntimeError(f"not_run: Fullmag interface observation is missing {key}")
        for component, raw in enumerate(value):
            number = float(raw)
            if not math.isfinite(number):
                raise RuntimeError(
                    f"not_run: Fullmag interface observation {index} has non-finite {key}"
                )
            total[component] += number
    if not interface_fluxes:
        raise RuntimeError("not_run: Fullmag transport interface flux is empty")
    return [value / len(interface_fluxes) for value in total]



def _bounded_transport_json(path: Path) -> dict[str, object]:
    maximum = 64 * 1024**2
    if path.is_symlink() or getattr(path.lstat(), "st_file_attributes", 0) & 0x400 or not path.is_file() or not 0 < path.stat().st_size <= maximum:
        raise RuntimeError("not_run: transport JSON must be bounded and regular")
    with path.open("rb") as stream:
        raw = stream.read(maximum + 1)
    if not 0 < len(raw) <= maximum:
        raise RuntimeError("not_run: transport JSON exceeds its byte bound")
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result: raise ValueError("duplicate transport JSON key")
            result[key] = value
        return result
    value = json.loads(raw.decode("utf-8"), object_pairs_hook=unique,
        parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite transport JSON")))
    if not isinstance(value, dict): raise ValueError("transport JSON must be an object")
    return value


def _materialize_comparison_artifact(
    accepted_path: Path, request: Mapping[str, object], output_path: Path
) -> Path:
    try:
        accepted = _bounded_transport_json(accepted_path)
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
    measured_charge_closure = telemetry.get("charge_net_boundary_current_a")
    if isinstance(measured_charge_closure, bool) or not isinstance(measured_charge_closure, (int, float)):
        raise RuntimeError("not_run: Fullmag measured charge closure is missing or invalid")
    try:
        charge_closure = float(measured_charge_closure)
    except OverflowError as error:
        raise RuntimeError("not_run: Fullmag measured charge closure is outside finite range") from error
    if not math.isfinite(charge_closure):
        raise RuntimeError("not_run: Fullmag measured charge closure is non-finite")
    interface_fluxes = module.get("interface_fluxes")
    if not isinstance(interface_fluxes, list) or not interface_fluxes:
        raise RuntimeError("not_run: Fullmag transport interface flux is missing")
    absorbed = _mean_interface_vectors(interface_fluxes, "absorbed_transverse_apm2")
    normal_spin_flux = _mean_interface_vectors(interface_fluxes, "from_side_outgoing_apm2")
    ferromagnet_spin_flux = _mean_interface_vectors(interface_fluxes, "to_side_transmitted_apm2")
    spin_flux_jump = [
        normal_spin_flux[index] - ferromagnet_spin_flux[index] for index in range(3)
    ]
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
            "normal_spin_flux": normal_spin_flux,
            "ferromagnet_spin_flux": ferromagnet_spin_flux,
            "spin_flux_jump": spin_flux_jump,
            "interface_observation_count": len(interface_fluxes),
            "torque": torque,
            "charge_closure": charge_closure,
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


def validate_fixed_m_outputs(root: Path, resolution: Resolution) -> dict[str, object]:
    """Recompute the preregistered fixed-F gate from native dimensionless m fields."""
    fields, hashes = [], []
    for name, expected_time in (("m_initial.json", 0.0), ("m_final.json", 1.0e-15)):
        path = Path(root) / name
        if (path.is_symlink() or getattr(path.lstat(), "st_file_attributes", 0) & 0x400
                or not path.is_file() or not 0 < path.stat().st_size <= 64 * 1024**2):
            raise RuntimeError("not_run: Fullmag fixed-M field must be bounded and regular")
        def unique(pairs):
            value = {}
            for key, item in pairs:
                if key in value:
                    raise ValueError("duplicate fixed-M field key")
                value[key] = item
            return value
        with path.open("rb") as stream:
            raw = stream.read(64 * 1024**2 + 1)
        if not 0 < len(raw) <= 64 * 1024**2:
            raise RuntimeError("not_run: Fullmag fixed-M field exceeds bound")
        field = json.loads(raw.decode("utf-8"), object_pairs_hook=unique,
            parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite fixed-M JSON")))
        if not isinstance(field, dict):
            raise RuntimeError("not_run: Fullmag fixed-M field must be an object")
        layout = field.get("layout", {})
        time = field.get("time")
        values = field.get("values")
        if (field.get("observable") != "m" or field.get("unit") != "1"
                or type(time) not in (int, float) or not math.isfinite(time) or time != expected_time
                or not isinstance(layout, dict) or layout.get("backend") != "fdm"
                or layout.get("grid_cells") != list(resolution.shape)
                or not isinstance(layout.get("active_mask"), list)
                or any(type(value) is not bool for value in layout["active_mask"])
                or layout.get("active_mask") != ([False] * (resolution.nx * resolution.ny * resolution.nz_n)
                    + [True] * (resolution.nx * resolution.ny * resolution.nz_f))
                or layout.get("cell_size") != list(resolution.cell_m)
                or not isinstance(layout.get("origin_m"), list) or len(layout["origin_m"]) != 3
                or any(type(value) not in (int, float) or not math.isfinite(value)
                    or not math.isclose(value, -size * step / 2.0, rel_tol=1.0e-12, abs_tol=1.0e-18)
                    for value, size, step in zip(layout["origin_m"], resolution.shape, resolution.cell_m))
                or not isinstance(values, list) or len(values) != math.prod(resolution.shape)
                or any(not isinstance(row, list) or len(row) != 3 or any(
                    type(value) not in (int, float) or not math.isfinite(value) for value in row)
                    for row in values)):
            raise RuntimeError("not_run: Fullmag fixed-M carrier/values differ")
        fields.append(field)
        hashes.append(hashlib.sha256(raw).hexdigest())
    before, after = fields
    if before["layout"] != after["layout"]:
        raise RuntimeError("not_run: Fullmag fixed-M carrier changed")
    nx, ny, nz = resolution.shape
    rows = range(nx * ny * resolution.nz_n, nx * ny * nz)
    inactive_count = nx * ny * resolution.nz_n
    if any(value != 0.0 for field in fields for row in field["values"][:inactive_count] for value in row):
        raise RuntimeError("not_run: Fullmag nonmagnetic N carrier contains magnetization")
    initial = [before["values"][index] for index in rows]
    final = [after["values"][index] for index in rows]
    error_before = max(abs(value - (1.0 if axis == 0 else 0.0)) * MS_APM
        for row in initial for axis, value in enumerate(row))
    error_after = max(abs(value - (1.0 if axis == 0 else 0.0)) * MS_APM
        for row in final for axis, value in enumerate(row))
    change = max(abs(a - b) * MS_APM for left, right in zip(initial, final) for a, b in zip(left, right))
    tolerance = FIXED_M_ATOL_APM + FIXED_M_RTOL * MS_APM
    if max(error_before, error_after, change) > tolerance:
        raise RuntimeError("not_run: Fullmag actual all-F-cell fixed-M gate failed")
    return {"schema_version": "fullmag.nf_fixed_m.proof.v1",
        "m_initial_sha256": hashes[0],
        "m_final_sha256": hashes[1],
        "sample_count": len(initial), "Ms_apm": MS_APM,
        "maximum_before_error_apm": error_before, "maximum_after_error_apm": error_after,
        "maximum_change_apm": change, "tolerance_apm": tolerance}


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
        "run-problem-json-direct",
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
    fixed_m = validate_fixed_m_outputs(output_dir, resolution)
    (output_dir / "fixed_m.json").write_text(
        json.dumps(fixed_m, indent=2, sort_keys=True, allow_nan=False) + "\n", encoding="utf-8")
    return _materialize_comparison_artifact(
        accepted_path,
        request,
        output_dir / "transport" / "fullmag_m2_nf_reference.json",
    )



def validate_common_fields(module: Mapping[str, object], *, resolution: Resolution) -> dict[str, object]:
    """Preregistered scope check and signed cell-quadrature; no electrode API claim."""
    common_case_key(resolution)
    nx, ny, nz = resolution.shape
    count = nx * ny * nz
    fields = {}
    for name, width in (("potential_volts", 1), ("spin_potential_volts", 3),
                        ("current_density_apm2", 3), ("spin_current_tensor_apm2", 9)):
        values = module.get(name)
        rows = [[v] for v in values] if width == 1 and isinstance(values, list) else values
        if not isinstance(rows, list) or len(rows) != count or any(
                not isinstance(row, list) or len(row) != width or any(type(v) not in (int, float)
                    or not math.isfinite(v) for v in row) for row in rows):
            raise ValueError("common-case actual field shape/finite gate failed: " + name)
        fields[name] = rows
    from types import SimpleNamespace
    from boris_nf_common_case_v3 import check_affine_x_invariance
    descriptor = case_descriptor(common_case_key(resolution))
    threshold = descriptor["observation_gate"]["relative_tolerance"]
    voltage = descriptor["boundary"]["voltage_v"]
    split = nx * ny * resolution.nz_n
    carrier = {}
    origin = mesh_registration(resolution)["fullmag_origin_m"]
    for label, start, end, thickness in (("normal",0,split,resolution.nz_n),
            ("ferromagnet",split,count,resolution.nz_f)):
        mesh_origin = [*origin[:2], origin[2] + (resolution.nz_n * resolution.cell_m[2] if start else 0)]
        arrays = {"V": fields["potential_volts"][start:end],
                  "S": fields["spin_potential_volts"][start:end],
                  "Jc": fields["current_density_apm2"][start:end]}
        for axis, name in enumerate(("Jsx","Jsy","Jsz")):
            arrays[name] = [row[axis*3:axis*3+3] for row in fields["spin_current_tensor_apm2"][start:end]]
        carrier[label] = {name: SimpleNamespace(shape=(nx,ny,thickness),origin_m=mesh_origin,
            step_m=resolution.cell_m, values=rows) for name,rows in arrays.items()}
    affine = check_affine_x_invariance(carrier, voltage_v=voltage,
        length_x_m=descriptor["physical_geometry"]["length_x_m"], origin_x_m=origin[0],
        voltage_at_xmin_v=descriptor["boundary"]["fullmag_xmin_potential_v"])
    mu = fields["spin_potential_volts"]
    current = fields["current_density_apm2"]
    mu_scale = max(math.hypot(*row) for row in mu)
    current_scale = max(math.hypot(*row) for row in current)
    if max(abs(row[0]) for row in mu) > threshold * mu_scale or max(abs(row[k]) for row in current for k in (1, 2)) > threshold * current_scale:
        raise ValueError("common-case actual fields leave the preregistered transverse invariant subspace")
    area = resolution.cell_m[1] * resolution.cell_m[2]
    planes = [math.fsum(current[ix + nx*(iy + ny*iz)][0] * area
                        for iz in range(nz) for iy in range(ny)) for ix in range(nx)]
    scale = max(abs(v) for v in planes)
    if any(v >= 0.0 for v in planes) or max(planes) - min(planes) > threshold * scale:
        raise ValueError("common-case full reciprocal Jc signed cross-sections fail")
    return {"schema": "fullmag.nf_common.field_scope.v1", "relative_gate": threshold,
            "affine_and_x_invariance": affine,
            "invariant_subspace": {"maximum_mu_x_v": max(abs(row[0]) for row in mu),
                "actual_mu_max_vector_norm_v": mu_scale,
                "maximum_transverse_J_apm2": max(abs(row[k]) for row in current for k in (1,2)),
                "actual_J_max_vector_norm_apm2": current_scale},
            "full_Jc_cell_quadrature": {"method": "dy*dz*sum(Jc_x), all four cell-center xplanes",
                "xplane_current_a": planes, "outward_terminal_current_a": [-planes[0], planes[-1]],
                "x_cell_centers_m": [origin[0]+(ix+0.5)*resolution.cell_m[0] for ix in range(nx)],
                "outward_normals": {"x_min":[-1,0,0],"x_max":[1,0,0]},
                "electrode_API": "not_claimed", "applies_after_affine_x_invariance_gate": True},
            "physics_qualified": False}


if __name__ == "__main__":
    raise SystemExit("Use verify-boris-fullmag-nf-common-managed-windows; no unmanaged common-case CLI")
