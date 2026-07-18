"""Public Fullmag study for strict FEM SP4 qualification."""

from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path

import fullmag as fm

from ..common.contract import CONTRACT, validate_device


@dataclass(frozen=True)
class SP4RunRequest:
    phase: str
    case: str
    device: str
    mesh: str
    airbox: str
    initial_state: Path | None
    duration_s: float

    @classmethod
    def from_environment(cls) -> "SP4RunRequest":
        phase = os.environ.get("FULLMAG_SP4_PHASE", "relax")
        case = os.environ.get("FULLMAG_SP4_CASE", "case-a")
        device = validate_device(os.environ.get("FULLMAG_SP4_DEVICE", "cpu"))
        mesh = os.environ.get("FULLMAG_SP4_MESH", "medium")
        airbox = os.environ.get("FULLMAG_SP4_AIRBOX", "baseline")
        if phase not in {"relax", "dynamic", "replay-before", "replay-after"}:
            raise ValueError(f"unsupported SP4 phase: {phase}")
        if case not in {item.id for item in CONTRACT.cases}:
            raise ValueError(f"unsupported SP4 case: {case}")
        if mesh not in {item.id for item in CONTRACT.meshes}:
            raise ValueError(f"unsupported SP4 mesh: {mesh}")
        if airbox not in {item.id for item in CONTRACT.airboxes}:
            raise ValueError(f"unsupported SP4 airbox: {airbox}")
        state = os.environ.get("FULLMAG_SP4_INITIAL_STATE")
        if phase != "relax" and not state:
            raise ValueError("dynamic SP4 phase requires FULLMAG_SP4_INITIAL_STATE")
        duration = float(os.environ.get("FULLMAG_SP4_DURATION_S", "1e-9"))
        if not 0 < duration <= CONTRACT.maximum_duration_s:
            raise ValueError("SP4 duration is outside (0, 5 ns]")
        return cls(phase, case, device, mesh, airbox, Path(state) if state else None, duration)


def build_study(request: SP4RunRequest):
    mesh = next(item for item in CONTRACT.meshes if item.id == request.mesh)
    airbox = next(item for item in CONTRACT.airboxes if item.id == request.airbox)
    case = next(item for item in CONTRACT.cases if item.id == request.case)
    study = fm.study(f"mumag_sp4_fem_{request.phase}_{request.case}_{request.device}_{request.mesh}_{request.airbox}")
    study.engine("fem")
    study.device(request.device, precision="double")
    study.universe(mode="manual", size=airbox.dimensions_m, center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0))
    study.universe.mesh(maximum_element_size=airbox.hmax_m)
    body = study.geometry(fm.Box(size=CONTRACT.dimensions_m, name="film"), name="film")
    body.Ms = CONTRACT.ms_a_per_m
    body.Aex = CONTRACT.aex_j_per_m
    body.alpha = 1.0 if request.phase == "relax" else CONTRACT.alpha
    body.m = (fm.init.UniformMagnetization(CONTRACT.initial_m) if request.initial_state is None else fm.load_magnetization(request.initial_state, format="json"))
    body.mesh(maximum_element_size=mesh.hmax_m, order=1)
    study.demag(realization="poisson_robin")
    study.build_domain_mesh()
    study.solver(integrator="rk45", gamma=CONTRACT.gamma_mu0_m_per_as, dt_initial=1e-15, dt_min=1e-17, dt_max=1e-12, max_error=1e-7)
    study.tableautosave(CONTRACT.sample_period_s, quantities=["step", "t", "mx", "my", "mz", "e_total", "max_torque_T"])
    if request.phase == "relax":
        study.relax(algorithm="llg_overdamped", solver="rk45", max_error=1e-7, dt_min=1e-17, max_steps=int(os.environ.get("FULLMAG_SP4_RELAX_MAX_STEPS", "200000")), tol=1e-5)
    else:
        study.b_ext(*case.field_t)
        study.run(request.duration_s)
    return study, body


REQUEST = SP4RunRequest.from_environment()
study, magnet = build_study(REQUEST)
