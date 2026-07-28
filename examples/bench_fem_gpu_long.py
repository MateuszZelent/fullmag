"""FEM benchmark problem with machine-readable final-step summary."""

from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path

import fullmag as fm

DEFAULT_MESH_PATH = Path(__file__).with_name("assets").joinpath("bench_box_fine.mesh.json")
DEFAULT_STEPS = 1000
DEFAULT_DT = 1e-13
DEFAULT_SHARED_DOMAIN_HMAX = 12e-9
DEFAULT_AIRBOX_HMAX = 48e-9
DEFAULT_AIRBOX_SIZE = (360e-9, 180e-9, 90e-9)
BOX500_AIRBOX_SCENARIO = "exchange_only_box500_airbox1um"
BOX500_EXCHANGE_SCENARIO = "exchange_only_box500"
BOX500_AIRBOX_BODY_SIZE = (500e-9, 100e-9, 10e-9)
BOX500_AIRBOX_SIZE = (1e-6, 1e-6, 1e-6)
BOX500_DOMAIN_HMAX = 20e-9
BOX500_AIRBOX_HMAX = 100e-9
DEFAULT_RELAX_TORQUE_TOLERANCE = 1e-6
MU0 = 4.0 * math.pi * 1e-7
RELAX_TORQUE_TOLERANCE_T = 1e-4
RELAX_TORQUE_TOLERANCE_APM = RELAX_TORQUE_TOLERANCE_T / MU0
FULL_RELAXATION_MAX_STEPS = 50_000
BOX500_AIRBOX_SCENARIO_ALIASES = {
    BOX500_EXCHANGE_SCENARIO: "exchange_only",
    BOX500_AIRBOX_SCENARIO: "exchange_only",
    "box500_airbox_exchange_zeeman": "exchange_zeeman",
    "box500_airbox_exchange_demag": "exchange_demag",
    "box500_airbox_exchange_anis_uniaxial": "exchange_anis_uniaxial",
    "box500_airbox_exchange_anis_uniaxial_tilted": "exchange_anis_uniaxial_tilted",
    "box500_airbox_exchange_anis_cubic": "exchange_anis_cubic",
    "box500_airbox_exchange_demag_anis_uniaxial": "exchange_demag_anis_uniaxial",
    "box500_airbox_exchange_demag_anis_cubic": "exchange_demag_anis_cubic",
    "box500_airbox_exchange_dmi": "exchange_dmi",
    "box500_airbox_stt_oersted": "stt_oersted",
}
BOX500_AIRBOX_SCENARIOS = set(BOX500_AIRBOX_SCENARIO_ALIASES)
RELAXATION_SCENARIO_ALIASES = {
    "relax_exchange_only": "exchange_only",
    "relax_exchange_demag": "exchange_demag",
}
DEFAULT_DEMAG_SOLVER = "CG"
DEFAULT_DEMAG_PRECONDITIONER = "AMG"
OMITTED_DEMAG_POLICY_PRECONDITIONER = "OMIT"
DEFAULT_DEMAG_RTOL = 1e-8
DEFAULT_DEMAG_ATOL = None
DEFAULT_DEMAG_MAX_ITERATIONS = 500
DEFAULT_DEMAG_PRINT_LEVEL = 0
SUPPORTED_INTEGRATORS = {
    "heun",
    "rk4",
    "rk23",
    "rk45",
}
SUPPORTED_TIMESTEP_POLICIES = {
    "fixed",
    "adaptive",
}
SUPPORTED_RELAXATION_ALGORITHMS = {
    "llg_overdamped",
    "projected_gradient_bb",
    "nonlinear_cg",
    "tangent_plane_implicit",
}
SUPPORTED_SCENARIOS = {
    "exchange_only",
    "exchange_zeeman",
    "exchange_demag",
    "exchange_anis_uniaxial",
    "exchange_anis_uniaxial_tilted",
    "exchange_anis_cubic",
    "exchange_demag_anis_uniaxial",
    "exchange_demag_anis_cubic",
    "exchange_demag_anisotropy",
    "exchange_dmi",
    "stt_oersted",
    *BOX500_AIRBOX_SCENARIOS,
    *RELAXATION_SCENARIO_ALIASES,
}


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return max(value, 1)


def env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if value > 0.0 else default


DEFAULT_UNTIL = env_int("FULLMAG_BENCH_STEPS", DEFAULT_STEPS) * env_float(
    "FULLMAG_BENCH_DT", DEFAULT_DT
)


def env_scenario() -> str:
    scenario = os.environ.get("FULLMAG_BENCH_SCENARIO", "exchange_demag").strip().lower()
    if scenario not in SUPPORTED_SCENARIOS:
        supported = ", ".join(sorted(SUPPORTED_SCENARIOS))
        raise ValueError(f"FULLMAG_BENCH_SCENARIO must be one of: {supported}")
    return scenario


def env_integrator() -> str:
    integrator = os.environ.get("FULLMAG_BENCH_INTEGRATOR", "heun").strip().lower()
    if integrator not in SUPPORTED_INTEGRATORS:
        supported = ", ".join(sorted(SUPPORTED_INTEGRATORS))
        raise ValueError(f"FULLMAG_BENCH_INTEGRATOR must be one of: {supported}")
    return integrator


def env_timestep_policy() -> str:
    policy = os.environ.get("FULLMAG_BENCH_TIMESTEP_POLICY", "fixed").strip().lower()
    if policy not in SUPPORTED_TIMESTEP_POLICIES:
        supported = ", ".join(sorted(SUPPORTED_TIMESTEP_POLICIES))
        raise ValueError(f"FULLMAG_BENCH_TIMESTEP_POLICY must be one of: {supported}")
    return policy


def env_relaxation_algorithm() -> str:
    algorithm = os.environ.get(
        "FULLMAG_BENCH_RELAX_ALGORITHM",
        "llg_overdamped",
    ).strip().lower()
    if algorithm not in SUPPORTED_RELAXATION_ALGORITHMS:
        supported = ", ".join(sorted(SUPPORTED_RELAXATION_ALGORITHMS))
        raise ValueError(f"FULLMAG_BENCH_RELAX_ALGORITHM must be one of: {supported}")
    return algorithm


def env_demag_solver() -> str:
    return os.environ.get("FULLMAG_BENCH_DEMAG_SOLVER", DEFAULT_DEMAG_SOLVER).strip().upper()


def env_demag_preconditioner() -> str:
    return os.environ.get(
        "FULLMAG_BENCH_DEMAG_PRECONDITIONER",
        DEFAULT_DEMAG_PRECONDITIONER,
    ).strip().upper()


def env_demag_solver_policy() -> fm.FemLinearSolverPolicy | None:
    if env_demag_preconditioner() == OMITTED_DEMAG_POLICY_PRECONDITIONER:
        return None
    return fm.FemLinearSolverPolicy(
        solver=env_demag_solver(),
        preconditioner=env_demag_preconditioner(),
        rtol=env_float("FULLMAG_BENCH_DEMAG_RTOL", DEFAULT_DEMAG_RTOL),
        atol=env_demag_atol(),
        max_iterations=env_demag_max_iterations(),
        print_level=env_demag_print_level(),
    )


def env_demag_max_iterations() -> int:
    return env_int("FULLMAG_BENCH_DEMAG_MAX_ITERATIONS", DEFAULT_DEMAG_MAX_ITERATIONS)


def env_demag_atol() -> float | None:
    raw = os.environ.get("FULLMAG_BENCH_DEMAG_ATOL")
    if raw is None or not raw.strip():
        return DEFAULT_DEMAG_ATOL
    value = float(raw)
    return value if value > 0.0 else DEFAULT_DEMAG_ATOL


def env_demag_print_level() -> int:
    return max(env_int("FULLMAG_BENCH_DEMAG_PRINT_LEVEL", DEFAULT_DEMAG_PRINT_LEVEL), 0)


def env_domain_mesh_source() -> str | None:
    raw = os.environ.get("FULLMAG_BENCH_DOMAIN_MESH")
    if raw is None or not raw.strip():
        return None
    return raw.strip()


def env_export_domain_mesh_path() -> Path | None:
    raw = os.environ.get("FULLMAG_BENCH_EXPORT_DOMAIN_MESH")
    if raw is None or not raw.strip():
        return None
    return Path(raw)


def benchmark_config() -> tuple[Path, int, float, str, str, str]:
    mesh_path = Path(os.environ.get("FULLMAG_BENCH_MESH", str(DEFAULT_MESH_PATH)))
    steps = env_int("FULLMAG_BENCH_STEPS", DEFAULT_STEPS)
    dt = env_float("FULLMAG_BENCH_DT", DEFAULT_DT)
    scenario = env_scenario()
    integrator = env_integrator()
    timestep_policy = env_timestep_policy()
    return mesh_path, steps, dt, scenario, integrator, timestep_policy


def load_mesh_stats(mesh_path: Path) -> dict[str, object]:
    payload = json.loads(mesh_path.read_text(encoding="utf-8"))
    return {
        "mesh_name": payload.get("mesh_name", mesh_path.stem),
        "mesh_path": str(mesh_path),
        "node_count": len(payload.get("nodes", [])),
        "element_count": len(payload.get("elements", [])),
        "boundary_face_count": len(payload.get("boundary_faces", [])),
    }


def canonical_scenario(scenario: str) -> str:
    return RELAXATION_SCENARIO_ALIASES.get(
        scenario,
        BOX500_AIRBOX_SCENARIO_ALIASES.get(scenario, scenario),
    )


def scenario_is_box500_airbox(scenario: str) -> bool:
    return scenario in BOX500_AIRBOX_SCENARIOS


def scenario_terms(scenario: str) -> tuple[list[object], dict[str, object]]:
    scenario = canonical_scenario(scenario)
    if scenario in {"exchange_only", BOX500_AIRBOX_SCENARIO}:
        return [fm.Exchange()], {}
    if scenario == "exchange_zeeman":
        return [fm.Exchange(), fm.Zeeman(B=(0.0, 0.0, 0.05))], {}
    if scenario in {"exchange_anis_uniaxial", "exchange_anis_uniaxial_tilted"}:
        return [
            fm.Exchange(),
            fm.UniaxialAnisotropy(ku1=0.5e6, axis=(0.0, 0.0, 1.0)),
        ], {}
    if scenario == "exchange_anis_cubic":
        return [fm.Exchange()], {}
    if scenario == "exchange_demag":
        return [fm.Exchange(), fm.Demag(), fm.Zeeman(B=(0.0, 0.0, 0.05))], {}
    if scenario in {"exchange_demag_anis_uniaxial", "exchange_demag_anisotropy"}:
        return [
            fm.Exchange(),
            fm.Demag(),
            fm.Zeeman(B=(0.0, 0.0, 0.05)),
            fm.UniaxialAnisotropy(ku1=0.5e6, axis=(0.0, 0.0, 1.0)),
        ], {}
    if scenario == "exchange_demag_anis_cubic":
        return [fm.Exchange(), fm.Demag(), fm.Zeeman(B=(0.0, 0.0, 0.05))], {}
    if scenario == "exchange_dmi":
        return [
            fm.Exchange(),
            fm.InterfacialDMI(D=1.0e-3, interface_normal=(0.0, 0.0, 1.0)),
            fm.Zeeman(B=(0.0, 0.0, 0.05)),
        ], {}
    if scenario == "stt_oersted":
        return [
            fm.Exchange(),
            fm.Zeeman(B=(0.0, 0.0, 0.05)),
            fm.OerstedCylinder(current=2.0e-3, radius=25e-9, center=(0.0, 0.0, 0.0)),
        ], {
            "spin_torque": fm.ZhangLiSTT(
                current_density=(8.0e10, 0.0, 0.0),
                degree=0.55,
                beta=0.08,
            )
        }
    raise AssertionError(f"unsupported benchmark scenario: {scenario}")


def scenario_initial_magnetization(scenario: str):
    if canonical_scenario(scenario) == "exchange_anis_uniaxial_tilted":
        inv_sqrt_two = 1.0 / math.sqrt(2.0)
        body_size = scenario_body_size(scenario)
        return fm.init.texture.helical(
            wavevector=(2.0 * math.pi / body_size[0], 0.0, 0.0),
            e1=(inv_sqrt_two, 0.0, inv_sqrt_two),
            e2=(0.0, 1.0, 0.0),
        )
    if scenario_is_box500_airbox(scenario) or scenario in RELAXATION_SCENARIO_ALIASES:
        body_size = scenario_body_size(scenario)
        return fm.init.texture.helical(
            wavevector=(2.0 * math.pi / body_size[0], 0.0, 0.0),
            e1=(1.0, 0.0, 0.0),
            e2=(0.0, 1.0, 0.0),
        )
    return fm.init.UniformMagnetization((1.0, 0.0, 0.0))


def scenario_requires_shared_domain(scenario: str) -> bool:
    return (
        scenario_is_box500_airbox(scenario) and scenario != BOX500_EXCHANGE_SCENARIO
    ) or "demag" in canonical_scenario(scenario)


def scenario_uses_relaxation(scenario: str) -> bool:
    return scenario_is_box500_airbox(scenario) or scenario in RELAXATION_SCENARIO_ALIASES


def scenario_body_size(scenario: str) -> tuple[float, float, float]:
    if scenario_is_box500_airbox(scenario):
        return BOX500_AIRBOX_BODY_SIZE
    return (200e-9, 50e-9, 10e-9)


def scenario_airbox_size(scenario: str) -> tuple[float, float, float]:
    if scenario_is_box500_airbox(scenario):
        scale = env_float("FULLMAG_BENCH_AIRBOX_EXTENT_SCALE", 1.0)
        return tuple(component * scale for component in BOX500_AIRBOX_SIZE)
    return DEFAULT_AIRBOX_SIZE


def scenario_domain_hmax(scenario: str) -> float:
    default = BOX500_DOMAIN_HMAX if scenario_is_box500_airbox(scenario) else DEFAULT_SHARED_DOMAIN_HMAX
    return env_float("FULLMAG_BENCH_DOMAIN_HMAX", default)


def scenario_airbox_hmax(scenario: str) -> float:
    default = BOX500_AIRBOX_HMAX if scenario_is_box500_airbox(scenario) else DEFAULT_AIRBOX_HMAX
    return env_float("FULLMAG_BENCH_AIRBOX_HMAX", default)


def scenario_material_kwargs(scenario: str) -> dict[str, object]:
    scenario = canonical_scenario(scenario)
    if scenario in {"exchange_anis_cubic", "exchange_demag_anis_cubic"}:
        return {
            "Kc1": 4.8e4,
            "anisC1": (1.0, 0.0, 0.0),
            "anisC2": (0.0, 1.0, 0.0),
        }
    return {}


def build(
    mesh_path: Path | None = None,
    dt: float | None = None,
    steps: int | None = None,
    scenario: str | None = None,
    integrator: str | None = None,
    timestep_policy: str | None = None,
) -> fm.Problem:
    if (
        mesh_path is None
        or dt is None
        or steps is None
        or scenario is None
        or integrator is None
        or timestep_policy is None
    ):
        (
            default_mesh_path,
            default_steps,
            default_dt,
            default_scenario,
            default_integrator,
            default_timestep_policy,
        ) = benchmark_config()
        mesh_path = default_mesh_path if mesh_path is None else mesh_path
        dt = default_dt if dt is None else dt
        steps = default_steps if steps is None else steps
        scenario = default_scenario if scenario is None else scenario
        integrator = default_integrator if integrator is None else integrator
        timestep_policy = (
            default_timestep_policy if timestep_policy is None else timestep_policy
        )
    if timestep_policy == "adaptive" and integrator not in {"rk23", "rk45"}:
        raise ValueError("adaptive timestep policy requires integrator rk23 or rk45")
    dynamics = (
        fm.LLG(
            integrator=integrator,
            adaptive_timestep=fm.AdaptiveTimestep(
                atol=1e-6,
                dt_initial=dt,
                dt_min=dt * 1e-3,
                dt_max=dt,
            ),
        )
        if timestep_policy == "adaptive"
        else fm.LLG(integrator=integrator, fixed_timestep=dt)
    )

    body = fm.Box(size=scenario_body_size(scenario), name="body")
    material = fm.Material(
        name="Py",
        Ms=800e3,
        A=13e-12,
        alpha=0.5,
        **scenario_material_kwargs(scenario),
    )
    magnet = fm.Ferromagnet(
        name="body",
        geometry=body,
        material=material,
        m0=scenario_initial_magnetization(scenario),
    )
    energy_terms, extra_problem_kwargs = scenario_terms(scenario)
    requires_shared_domain = scenario_requires_shared_domain(scenario)
    runtime_metadata = {}
    if requires_shared_domain:
        domain_mesh_source = env_domain_mesh_source()
        mesh_workflow = {
            "build_target": "domain",
            "domain_mesh_mode": "generated_shared_domain_mesh",
        }
        if domain_mesh_source is not None:
            mesh_workflow.update(
                {
                    "domain_mesh_mode": "explicit_shared_domain_mesh",
                    "domain_mesh_source": domain_mesh_source,
                    "domain_region_markers": [
                        {"geometry_name": "body", "marker": 1},
                    ],
                }
            )
        runtime_metadata = {
            "study_universe": {
                "mode": "manual",
                "size": list(scenario_airbox_size(scenario)),
                "center": [0.0, 0.0, 0.0],
                "padding": [0.0, 0.0, 0.0],
                "airbox_hmax": scenario_airbox_hmax(scenario),
                "airbox_hmin": None,
                "airbox_growth_rate": None,
                "airbox_grading": None,
            },
            "mesh_workflow": mesh_workflow,
        }

    if scenario_uses_relaxation(scenario):
        relaxation_algorithm = env_relaxation_algorithm()
        relaxation_kwargs = {}
        if relaxation_algorithm == "llg_overdamped":
            relaxation_kwargs["dynamics"] = dynamics
        study = fm.Relaxation(
            algorithm=relaxation_algorithm,
            torque_tolerance=env_float(
                "FULLMAG_BENCH_RELAX_TORQUE_TOLERANCE",
                DEFAULT_RELAX_TORQUE_TOLERANCE,
            ),
            max_steps=steps,
            outputs=[fm.SaveScalar("E_total", every=dt * steps)],
            **relaxation_kwargs,
        )
    else:
        study = fm.TimeEvolution(
            dynamics=dynamics,
            outputs=[fm.SaveScalar("E_total", every=dt * steps)],
        )

    return fm.Problem(
        name=f"bench_fem_gpu_long_{scenario}",
        magnets=[magnet],
        energy=energy_terms,
        study=study,
        discretization=fm.DiscretizationHints(
            fem=fm.FEM(
                order=1,
                maximum_element_size=(
                    scenario_domain_hmax(scenario) if requires_shared_domain else 3e-9
                ),
                mesh=(
                    None
                    if requires_shared_domain or scenario == BOX500_EXCHANGE_SCENARIO
                    else str(mesh_path)
                ),
                demag_solver_policy=env_demag_solver_policy(),
            ),
        ),
        runtime=fm.backend.engine("fem"),
        runtime_metadata=runtime_metadata,
        **extra_problem_kwargs,
    )


def executed_problem_ir_sha256(problem: fm.Problem) -> str:
    canonical_bytes = json.dumps(
        problem.to_ir(include_geometry_assets=True),
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(canonical_bytes).hexdigest()


def emit_summary(
    result: fm.Result,
    mesh_path: Path,
    steps: int,
    dt: float,
    scenario: str,
    integrator: str,
    timestep_policy: str = "fixed",
    *,
    executed_problem_ir_sha256: str | None = None,
) -> None:
    final = result.steps[-1] if result.steps else None
    total_rhs_evals = sum(
        max(0, int(getattr(step, "rhs_evals", 0) or 0)) for step in result.steps
    )
    summary = {
        "status": result.status,
        "backend": result.backend.value,
        "mode": result.mode.value,
        "precision": result.precision.value,
        "scenario": scenario,
        "integrator": integrator,
        "timestep_policy": timestep_policy,
        "executed_problem_ir_sha256": executed_problem_ir_sha256,
        "relaxation_algorithm": (
            env_relaxation_algorithm() if scenario_uses_relaxation(scenario) else None
        ),
        "requested_steps": steps,
        "requested_dt_s": dt,
        "executed_steps": len(result.steps),
        "final_time_s": final.time if final is not None else None,
        "final_solver_dt_s": getattr(final, "dt", None) if final is not None else None,
        "error_estimate": (
            getattr(final, "error_estimate", None) if final is not None else None
        ),
        "dt_suggested_s": (
            getattr(final, "dt_suggested", None) if final is not None else None
        ),
        "final_e_total_j": final.e_total if final is not None else None,
        "final_e_ex_j": final.e_ex if final is not None else None,
        "final_e_ext_j": (
            getattr(final, "e_ext", None) if final is not None else None
        ),
        "final_e_demag_j": final.e_demag if final is not None else None,
        "wall_time_ns": final.wall_time_ns if final is not None else None,
        "exchange_wall_time_ns": final.exchange_wall_time_ns if final is not None else None,
        "demag_wall_time_ns": final.demag_wall_time_ns if final is not None else None,
        "demag_assemble_wall_time_ns": (
            getattr(final, "demag_assemble_wall_time_ns", None)
            if final is not None
            else None
        ),
        "demag_solve_wall_time_ns": (
            getattr(final, "demag_solve_wall_time_ns", None)
            if final is not None
            else None
        ),
        "demag_solver_setup_wall_time_ns": (
            getattr(final, "demag_solver_setup_wall_time_ns", None)
            if final is not None
            else None
        ),
        "demag_solver_apply_wall_time_ns": (
            getattr(final, "demag_solver_apply_wall_time_ns", None)
            if final is not None
            else None
        ),
        "demag_solver_setup_reused": (
            getattr(final, "demag_solver_setup_reused", None)
            if final is not None
            else None
        ),
        "demag_recover_wall_time_ns": (
            getattr(final, "demag_recover_wall_time_ns", None)
            if final is not None
            else None
        ),
        "demag_energy_wall_time_ns": (
            getattr(final, "demag_energy_wall_time_ns", None)
            if final is not None
            else None
        ),
        "rhs_wall_time_ns": final.rhs_wall_time_ns if final is not None else None,
        "extra_energy_wall_time_ns": (
            final.extra_energy_wall_time_ns if final is not None else None
        ),
        "snapshot_wall_time_ns": final.snapshot_wall_time_ns if final is not None else None,
        "rhs_evals": final.rhs_evals if final is not None else None,
        "total_rhs_evals": total_rhs_evals,
        "demag_solves": final.demag_solves if final is not None else None,
        "rejected_attempts": final.rejected_attempts if final is not None else None,
        "fsal_reused": final.fsal_reused if final is not None else None,
        "max_dm_dt": final.max_dm_dt if final is not None else None,
        "max_h_eff": final.max_h_eff if final is not None else None,
        "max_h_demag": final.max_h_demag if final is not None else None,
        "max_torque_Apm": (
            getattr(final, "max_torque_Apm", None) if final is not None else None
        ),
        "max_torque_T": (
            getattr(final, "max_torque_T", None) if final is not None else None
        ),
        "e_ani": final.e_ani if final is not None else None,
        "e_dmi": final.e_dmi if final is not None else None,
        **load_mesh_stats(mesh_path),
    }
    print(f"BENCHMARK_RESULT={json.dumps(summary, sort_keys=True)}")


def export_domain_mesh(
    mesh_path: Path,
    steps: int,
    dt: float,
    scenario: str,
    integrator: str,
    timestep_policy: str,
    output_path: Path,
) -> None:
    problem = build(mesh_path, dt, steps, scenario, integrator, timestep_policy)
    problem_ir = problem.to_ir(include_geometry_assets=True)
    geometry_assets = problem_ir.get("geometry_assets")
    if not isinstance(geometry_assets, dict):
        raise RuntimeError("benchmark problem did not produce geometry_assets")
    domain_asset = geometry_assets.get("fem_domain_mesh_asset")
    if not isinstance(domain_asset, dict):
        raise RuntimeError("benchmark problem did not produce a fem_domain_mesh_asset")
    mesh = domain_asset.get("mesh")
    if not isinstance(mesh, dict):
        raise RuntimeError("benchmark fem_domain_mesh_asset did not inline a mesh")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(mesh, sort_keys=True), encoding="utf-8")
    print(f"BENCHMARK_DOMAIN_MESH={output_path}")


if __name__ == "__main__":
    mesh_path, steps, dt, scenario, integrator, timestep_policy = benchmark_config()
    export_path = env_export_domain_mesh_path()
    if export_path is not None:
        export_domain_mesh(
            mesh_path,
            steps,
            dt,
            scenario,
            integrator,
            timestep_policy,
            export_path,
        )
        raise SystemExit(0)
    problem = build(mesh_path, dt, steps, scenario, integrator, timestep_policy)
    problem_ir_sha256 = executed_problem_ir_sha256(problem)
    result = fm.Simulation(problem, backend="fem").run(until=steps * dt)
    emit_summary(
        result,
        mesh_path,
        steps,
        dt,
        scenario,
        integrator,
        timestep_policy,
        executed_problem_ir_sha256=problem_ir_sha256,
    )
