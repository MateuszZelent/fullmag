"""Canonical bounded workload used by the source-bound relaxation receipts.

The qualification runner varies only the lane, precision, algorithm, physical
workload, and refinement level through environment variables.  The physical
problem remains fixed across refinement levels; changing a mesh/discretisation
parameter is not allowed to silently change the material, field, or initial
state.
"""

from __future__ import annotations

import os

import fullmag as fm


ALGORITHM = os.environ["FULLMAG_RELAXATION_ALGORITHM"]
BACKEND = os.environ["FULLMAG_RELAXATION_BACKEND"]
DEVICE = os.environ["FULLMAG_RELAXATION_DEVICE"]
PRECISION = os.environ["FULLMAG_RELAXATION_PRECISION"]
WORKLOAD = os.environ["FULLMAG_RELAXATION_WORKLOAD"]
MESH_LEVEL = os.environ["FULLMAG_RELAXATION_MESH_LEVEL"]

if ALGORITHM not in {
    "llg_overdamped",
    "projected_gradient_bb",
    "nonlinear_cg",
    "tangent_plane_implicit",
}:
    raise ValueError(f"unsupported qualification algorithm: {ALGORITHM}")
if BACKEND not in {"fdm", "fem"}:
    raise ValueError(f"unsupported qualification backend: {BACKEND}")
if WORKLOAD not in {"macrospin", "exchange_demag"}:
    raise ValueError(f"unsupported qualification workload: {WORKLOAD}")
if MESH_LEVEL not in {"coarse", "medium", "fine"}:
    raise ValueError(f"unsupported qualification mesh level: {MESH_LEVEL}")

CELL_SIZE_M = {
    "coarse": 10e-9,
    "medium": 5e-9,
    "fine": 2.5e-9,
}[MESH_LEVEL]
FEM_ELEMENT_SIZE_M = {
    "coarse": 20e-9,
    "medium": 10e-9,
    "fine": 5e-9,
}[MESH_LEVEL]

study = fm.study(
    f"relaxation_qualification_{BACKEND}_{DEVICE}_{PRECISION}_"
    f"{ALGORITHM}_{WORKLOAD}_{MESH_LEVEL}"
)
study.engine(BACKEND)
study.device(DEVICE, precision=PRECISION)
if BACKEND == "fem" and ALGORITHM == "tangent_plane_implicit":
    study.mode("extended")

if BACKEND == "fdm":
    # The physical magnetic body is always 40 nm × 40 nm × 10 nm.  The FDM
    # cell size changes only the discretisation, never the physical extent.
    study.universe(
        mode="manual",
        size=(40e-9, 40e-9, 10e-9),
        center=(0.0, 0.0, 0.0),
        padding=(0.0, 0.0, 0.0),
    )
    study.cell(CELL_SIZE_M, CELL_SIZE_M, CELL_SIZE_M)
    body = study.geometry(
        fm.Box(size=(40e-9, 40e-9, 10e-9), name="qualification_body"),
        name="qualification_body",
    )
else:
    study.universe(
        mode="auto",
        size=(120e-9, 120e-9, 80e-9),
        center=(0.0, 0.0, 0.0),
        padding=(0.0, 0.0, 0.0),
    )
    study.universe.mesh(
        maximum_element_size=FEM_ELEMENT_SIZE_M,
        maximum_element_growth_rate=1.5,
        grading="geometric",
    )
    body = study.geometry(
        fm.Box(size=(40e-9, 40e-9, 10e-9), name="qualification_body"),
        name="qualification_body",
    )
    body.mesh(maximum_element_size=FEM_ELEMENT_SIZE_M, order=1)

body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.5

if WORKLOAD == "macrospin":
    # Analytic oracle: a uniform state in a uniform +z Zeeman field has its
    # unique minimum at m=+z.  Exchange and demag are disabled deliberately.
    body.m = fm.texture.uniform(1.0, 0.0, 0.0)
    study.demag(enabled=False)
    study.b_ext(0.0, 0.0, 8.0e5)
else:
    # This is the same physical exchange+demag problem at every refinement.
    # A deterministic, slightly tilted uniform state avoids a symmetric
    # saddle while still exercising both conservative interactions.
    body.m = fm.texture.uniform(0.15, 0.98, 0.05)
    if BACKEND == "fdm":
        study.demag()
    else:
        study.demag(realization="poisson_robin")
        study.fem_demag_solver(
            solver="CG",
            preconditioner="AMG",
            rtol=1e-10,
            max_iterations=500,
        )

if BACKEND == "fem":
    study.build_domain_mesh()

study.solver(dt=1e-13, g=2.115)
relax = study.stages.add_relax(
    stage_id="relax",
    algorithm=ALGORITHM,
    tolA=1e-2,
    max_steps=512,
    dt=1e-13 if ALGORITHM == "llg_overdamped" else None,
)
relax.autosave(
    fm.StageAutosave(
        table=fm.TableAutosave(
            every_steps=1,
            quantities=[
                "step",
                "t",
                "dt",
                "mx",
                "my",
                "mz",
                "E_total",
                "max_torque_Apm",
                "max_torque_T",
            ],
        ),
        fields=[fm.FieldAutosave("m", every_steps=512)],
    )
)
