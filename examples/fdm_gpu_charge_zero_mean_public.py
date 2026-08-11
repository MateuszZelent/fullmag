"""Bounded public FDM GPU pure-Neumann charge fixture.

This 2 x 1 x 1 example exercises Python -> ProblemIR -> planner -> runner ->
CUDA ABI with a balanced outward-normal current-density pair and a zero-mean
potential gauge. It is intentionally charge-only: spin, SHE, torque and
Oersted coupling remain outside this bounded public lane.
"""

from __future__ import annotations

import fullmag as fm


NM = 1.0e-9
SIZE = (20.0 * NM, 10.0 * NM, 10.0 * NM)

study = fm.study("fdm_gpu_charge_zero_mean_public")
study.engine("fdm")
study.device("gpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=SIZE, center=(0.0, 0.0, 0.0))
study.cell(10.0 * NM, 10.0 * NM, 10.0 * NM)
study.exchange()
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
        fm.NormalCurrentElectrode(
            "source",
            [x_min],
            outward_current_density_Apm2=2.0e13,
        ),
        fm.NormalCurrentElectrode(
            "drain",
            [x_max],
            outward_current_density_Apm2=-2.0e13,
        ),
        fm.ChargeInsulating("sidewalls", sidewalls),
    ],
    gauge=fm.ChargePotentialGauge("zero_mean"),
    solver=fm.ChargeSolverPolicy(
        engine="cg",
        relative_tolerance=1.0e-10,
        absolute_tolerance=0.0,
        max_iterations=500,
    ),
)

study.stages.add_run(1.0e-15, stage_id="charge_only")


def build_study() -> fm.Study:
    """Expose the executable public fixture through one stable source-map symbol."""
    return study
