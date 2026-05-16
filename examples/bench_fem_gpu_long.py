"""FEM benchmark problem with machine-readable final-step summary."""

from __future__ import annotations

import json
import os
from pathlib import Path

import fullmag as fm

DEFAULT_MESH_PATH = Path(__file__).with_name("assets").joinpath("bench_box_fine.mesh.json")
DEFAULT_STEPS = 1000
DEFAULT_DT = 1e-13
DEFAULT_SHARED_DOMAIN_HMAX = 12e-9
DEFAULT_AIRBOX_HMAX = 48e-9
DEFAULT_AIRBOX_SIZE = (360e-9, 180e-9, 90e-9)
DEFAULT_DEMAG_SOLVER = "CG"
DEFAULT_DEMAG_PRECONDITIONER = "AMG"
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
SUPPORTED_SCENARIOS = {
    "exchange_only",
    "exchange_demag",
    "exchange_anis_uniaxial",
    "exchange_anis_cubic",
    "exchange_demag_anis_uniaxial",
    "exchange_demag_anis_cubic",
    "exchange_demag_anisotropy",
    "exchange_dmi",
    "stt_oersted",
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


def env_demag_solver() -> str:
    return os.environ.get("FULLMAG_BENCH_DEMAG_SOLVER", DEFAULT_DEMAG_SOLVER).strip().upper()


def env_demag_preconditioner() -> str:
    return os.environ.get(
        "FULLMAG_BENCH_DEMAG_PRECONDITIONER",
        DEFAULT_DEMAG_PRECONDITIONER,
    ).strip().upper()


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


def scenario_terms(scenario: str) -> tuple[list[object], dict[str, object]]:
    if scenario == "exchange_only":
        return [fm.Exchange()], {}
    if scenario in {"exchange_anis_uniaxial", "exchange_anis_cubic"}:
        return [fm.Exchange()], {}
    if scenario == "exchange_demag":
        return [fm.Exchange(), fm.Demag(), fm.Zeeman(B=(0.0, 0.0, 0.05))], {}
    if scenario in {
        "exchange_demag_anis_uniaxial",
        "exchange_demag_anis_cubic",
        "exchange_demag_anisotropy",
    }:
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


def scenario_requires_shared_domain(scenario: str) -> bool:
    return "demag" in scenario


def scenario_material_kwargs(scenario: str) -> dict[str, object]:
    if scenario in {"exchange_anis_uniaxial", "exchange_demag_anis_uniaxial", "exchange_demag_anisotropy"}:
        return {"Ku1": 0.5e6, "anisU": (0.0, 0.0, 1.0)}
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
            adaptive_timestep=fm.AdaptiveTimestep(atol=1e-6, dt_initial=dt),
        )
        if timestep_policy == "adaptive"
        else fm.LLG(integrator=integrator, fixed_timestep=dt)
    )

    body = fm.Box(size=(200e-9, 50e-9, 10e-9), name="body")
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
        m0=fm.init.UniformMagnetization((1.0, 0.0, 0.0)),
    )
    energy_terms, extra_problem_kwargs = scenario_terms(scenario)
    requires_shared_domain = scenario_requires_shared_domain(scenario)
    runtime_metadata = {}
    if requires_shared_domain:
        runtime_metadata = {
            "study_universe": {
                "mode": "manual",
                "size": list(DEFAULT_AIRBOX_SIZE),
                "center": [0.0, 0.0, 0.0],
                "padding": [0.0, 0.0, 0.0],
                "airbox_hmax": env_float("FULLMAG_BENCH_AIRBOX_HMAX", DEFAULT_AIRBOX_HMAX),
                "airbox_hmin": None,
                "airbox_growth_rate": None,
                "airbox_grading": None,
            },
            "mesh_workflow": {
                "build_target": "domain",
                "domain_mesh_mode": "generated_shared_domain_mesh",
            },
        }

    return fm.Problem(
        name=f"bench_fem_gpu_long_{scenario}",
        magnets=[magnet],
        energy=energy_terms,
        study=fm.TimeEvolution(
            dynamics=dynamics,
            outputs=[fm.SaveScalar("E_total", every=dt * steps)],
        ),
        discretization=fm.DiscretizationHints(
            fem=fm.FEM(
                order=1,
                maximum_element_size=(
                    env_float("FULLMAG_BENCH_DOMAIN_HMAX", DEFAULT_SHARED_DOMAIN_HMAX)
                    if requires_shared_domain
                    else 3e-9
                ),
                mesh=None if requires_shared_domain else str(mesh_path),
                demag_solver_policy=fm.FemLinearSolverPolicy(
                    solver=env_demag_solver(),
                    preconditioner=env_demag_preconditioner(),
                    rtol=env_float("FULLMAG_BENCH_DEMAG_RTOL", DEFAULT_DEMAG_RTOL),
                    atol=env_demag_atol(),
                    max_iterations=env_demag_max_iterations(),
                    print_level=env_demag_print_level(),
                ),
            ),
        ),
        runtime=fm.backend.engine("fem"),
        runtime_metadata=runtime_metadata,
        **extra_problem_kwargs,
    )


def emit_summary(
    result: fm.Result,
    mesh_path: Path,
    steps: int,
    dt: float,
    scenario: str,
    integrator: str,
    timestep_policy: str = "fixed",
) -> None:
    final = result.steps[-1] if result.steps else None
    summary = {
        "status": result.status,
        "backend": result.backend.value,
        "mode": result.mode.value,
        "precision": result.precision.value,
        "scenario": scenario,
        "integrator": integrator,
        "timestep_policy": timestep_policy,
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
        "demag_solves": final.demag_solves if final is not None else None,
        "rejected_attempts": final.rejected_attempts if final is not None else None,
        "fsal_reused": final.fsal_reused if final is not None else None,
        "max_dm_dt": final.max_dm_dt if final is not None else None,
        "max_h_eff": final.max_h_eff if final is not None else None,
        "max_h_demag": final.max_h_demag if final is not None else None,
        "e_ani": final.e_ani if final is not None else None,
        "e_dmi": final.e_dmi if final is not None else None,
        **load_mesh_stats(mesh_path),
    }
    print(f"BENCHMARK_RESULT={json.dumps(summary, sort_keys=True)}")


if __name__ == "__main__":
    mesh_path, steps, dt, scenario, integrator, timestep_policy = benchmark_config()
    problem = build(mesh_path, dt, steps, scenario, integrator, timestep_policy)
    result = fm.Simulation(problem, backend="fem").run(until=steps * dt)
    emit_summary(result, mesh_path, steps, dt, scenario, integrator, timestep_policy)
