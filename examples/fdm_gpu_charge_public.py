"""Minimalny publiczny fixture FDM GPU dla stacjonarnego transportu ładunku.

To jest mały test ścieżki Python -> ProblemIR -> planner -> runner -> CUDA
ABI. Nie jest to jeszcze benchmark ani kwalifikacja fizyki dla geometrii
częściowej: pierwszy publiczny wariant wymaga pełnej aktywnej siatki FDM,
dwóch elektrod napięciowych i czterech ścian izolujących.
"""

from __future__ import annotations

import fullmag as fm


NM = 1.0e-9
SIZE = (20.0 * NM, 10.0 * NM, 10.0 * NM)

study = fm.study("fdm_gpu_charge_public")
study.engine("fdm")
study.device("gpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=SIZE, center=(0.0, 0.0, 0.0))
study.cell(10.0 * NM, 10.0 * NM, 10.0 * NM)
study.demag(enabled=False)

strip = study.geometry(fm.Box(size=SIZE, name="charge_strip"), name="charge_strip")
strip.Ms = 8.0e5
strip.Aex = 13.0e-12
strip.alpha = 0.02
strip.m = fm.texture.uniform(1.0, 0.0, 0.0)

region = fm.RegionRef("charge_strip")
x_min = fm.SurfaceRef("charge_strip", "x_min", (-1.0, 0.0, 0.0))
x_max = fm.SurfaceRef("charge_strip", "x_max", (1.0, 0.0, 0.0))
sidewalls = [
    fm.SurfaceRef("charge_strip", "y_min", (0.0, -1.0, 0.0)),
    fm.SurfaceRef("charge_strip", "y_max", (0.0, 1.0, 0.0)),
    fm.SurfaceRef("charge_strip", "z_min", (0.0, 0.0, -1.0)),
    fm.SurfaceRef("charge_strip", "z_max", (0.0, 0.0, 1.0)),
]

study.current_transport(
    name="charge",
    model="ohmic_poisson",
    coupling="one_way",
    domain=[region],
    materials=[
        fm.ChargeTransportMaterialAssignment(
            region,
            fm.ChargeTransportMaterial(sigma_Spm=4.0e6),
        )
    ],
    boundaries=[
        fm.VoltageElectrode("source", [x_min], potential_V=0.0),
        fm.VoltageElectrode("drain", [x_max], potential_V=0.1),
        fm.ChargeInsulating("sidewalls", sidewalls),
    ],
    gauge=fm.ChargePotentialGauge("dirichlet_reference"),
    solver=fm.ChargeSolverPolicy(
        engine="cg",
        relative_tolerance=1.0e-10,
        absolute_tolerance=0.0,
        max_iterations=500,
    ),
)

study.stages.add_run(1.0e-15, stage_id="charge_only")
