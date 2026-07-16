"""Small deterministic native FEM CPU Brown-field runtime workload."""

from __future__ import annotations

import os
from pathlib import Path

import fullmag as fm


STEPS = int(os.environ.get("FULLMAG_FEM_THERMAL_STEPS", "8"))
DT_S = float(os.environ.get("FULLMAG_FEM_THERMAL_DT_S", repr(2.0**-50)))
SEED = int(os.environ.get("FULLMAG_FEM_THERMAL_SEED", "17"))
MESH_PATH = Path(__file__).with_name("assets") / "zhang_li_skew_tetra_r0.mesh.json"
DEFAULT_UNTIL = STEPS * DT_S


def build() -> fm.Problem:
    body = fm.Box(size=(20e-9, 10e-9, 10e-9), name="body")
    material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.02)
    magnet = fm.Ferromagnet(
        name="body",
        geometry=body,
        material=material,
        m0=fm.init.UniformMagnetization((1.0, 0.0, 0.0)),
    )
    return fm.Problem(
        name="fem_thermal_cpu_runtime",
        magnets=[magnet],
        energy=[fm.Exchange(), fm.ThermalNoise(temperature=300.0, seed=SEED)],
        study=fm.TimeEvolution(
            dynamics=fm.LLG(integrator="heun", fixed_timestep=DT_S),
            outputs=[fm.SaveField("H_therm", every=DT_S)],
        ),
        discretization=fm.DiscretizationHints(
            fem=fm.FEM(order=1, maximum_element_size=20e-9, mesh=str(MESH_PATH)),
        ),
    )


problem = build()
