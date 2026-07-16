"""Managed FEM fixed-final-time workload for time-dependent Oersted RK stages."""

from __future__ import annotations

import os
from pathlib import Path

import fullmag as fm


INTEGRATOR = os.environ.get("FULLMAG_OERSTED_RK_INTEGRATOR", "heun")
STEPS = int(os.environ.get("FULLMAG_OERSTED_RK_STEPS", "8"))
DT_S = float(os.environ.get("FULLMAG_OERSTED_RK_DT_S", repr(2.0**-45)))
CURRENT_A = float(os.environ.get("FULLMAG_OERSTED_CURRENT_A", "8e-3"))
OBSERVABLE_PURE = os.environ.get("FULLMAG_OERSTED_OBSERVABLE_PURE", "0") == "1"
MESH_PATH = Path(__file__).with_name("assets") / "zhang_li_skew_tetra_r0.mesh.json"
DEFAULT_UNTIL = STEPS * DT_S


def build() -> fm.Problem:
    body = fm.Box(size=(20e-9, 10e-9, 10e-9), name="body")
    magnet = fm.Ferromagnet(
        name="body",
        geometry=body,
        material=fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.02),
        m0=fm.init.UniformMagnetization((1.0, 0.0, 0.0)),
    )
    final_time = STEPS * DT_S
    energy = [
        fm.OerstedCylinder(
            current=CURRENT_A,
            radius=3e-9,
            center=(10e-9, 5e-9, 0.0),
            time_dependence=fm.Sinusoidal(frequency_hz=1.0 / final_time, phase_rad=0.25, offset=0.2),
        ),
    ]
    if OBSERVABLE_PURE:
        energy.insert(0, fm.Zeeman(B=(0.0, 0.0, 0.0)))
    else:
        energy.insert(0, fm.Exchange())
    return fm.Problem(
        name="fem_oersted_rk_time_convergence",
        magnets=[magnet],
        energy=energy,
        study=fm.TimeEvolution(
            dynamics=fm.LLG(integrator=INTEGRATOR, fixed_timestep=DT_S),
            outputs=[
                fm.SaveField("m", every=final_time),
                fm.SaveField("H_oe", every=final_time),
                fm.SaveField("H_eff", every=final_time),
            ],
        ),
        discretization=fm.DiscretizationHints(fem=fm.FEM(order=1, maximum_element_size=20e-9, mesh=str(MESH_PATH))),
    )


problem = build()
