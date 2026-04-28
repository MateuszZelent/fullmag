"""FEM benchmark problem with machine-readable final-step summary."""

from __future__ import annotations

import json
import os
from pathlib import Path

import fullmag as fm

DEFAULT_MESH_PATH = Path(__file__).with_name("assets").joinpath("bench_box_fine.mesh.json")
DEFAULT_STEPS = 1000
DEFAULT_DT = 1e-13


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


def benchmark_config() -> tuple[Path, int, float]:
    mesh_path = Path(os.environ.get("FULLMAG_BENCH_MESH", str(DEFAULT_MESH_PATH)))
    steps = env_int("FULLMAG_BENCH_STEPS", DEFAULT_STEPS)
    dt = env_float("FULLMAG_BENCH_DT", DEFAULT_DT)
    return mesh_path, steps, dt


def load_mesh_stats(mesh_path: Path) -> dict[str, object]:
    payload = json.loads(mesh_path.read_text(encoding="utf-8"))
    return {
        "mesh_name": payload.get("mesh_name", mesh_path.stem),
        "mesh_path": str(mesh_path),
        "node_count": len(payload.get("nodes", [])),
        "element_count": len(payload.get("elements", [])),
        "boundary_face_count": len(payload.get("boundary_faces", [])),
    }


def build(mesh_path: Path, dt: float, steps: int) -> fm.Problem:
    body = fm.Box(size=(200e-9, 50e-9, 10e-9), name="body")
    material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.5)
    magnet = fm.Ferromagnet(
        name="body",
        geometry=body,
        material=material,
        m0=fm.texture.uniform((1.0, 0.0, 0.0)),
    )

    return fm.Problem(
        name="bench_fem_gpu_long",
        magnets=[magnet],
        energy=[
            fm.Exchange(),
            fm.Demag(),
            fm.Zeeman(B=(0.0, 0.0, 0.05)),
        ],
        study=fm.TimeEvolution(
            dynamics=fm.LLG(integrator="heun", fixed_timestep=dt),
            outputs=[fm.SaveScalar("E_total", every=dt * steps)],
        ),
        discretization=fm.DiscretizationHints(
            fem=fm.FEM(order=1, hmax=3e-9, mesh=str(mesh_path)),
        ),
    )


def emit_summary(result: fm.Result, mesh_path: Path, steps: int, dt: float) -> None:
    final = result.steps[-1] if result.steps else None
    summary = {
        "status": result.status,
        "backend": result.backend.value,
        "mode": result.mode.value,
        "precision": result.precision.value,
        "requested_steps": steps,
        "requested_dt_s": dt,
        "executed_steps": len(result.steps),
        "final_time_s": final.time if final is not None else None,
        "final_e_total_j": final.e_total if final is not None else None,
        "final_e_ex_j": final.e_ex if final is not None else None,
        "final_e_demag_j": final.e_demag if final is not None else None,
        "wall_time_ns": final.wall_time_ns if final is not None else None,
        "exchange_wall_time_ns": final.exchange_wall_time_ns if final is not None else None,
        "demag_wall_time_ns": final.demag_wall_time_ns if final is not None else None,
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
    mesh_path, steps, dt = benchmark_config()
    problem = build(mesh_path, dt, steps)
    result = fm.Simulation(problem, backend="fem").run(until=steps * dt)
    emit_summary(result, mesh_path, steps, dt)
