"""Bounded FEM GPU fixture for preview materialization surface qualification."""

from __future__ import annotations

import math
import os

import fullmag as fm


MODE = os.environ.get("FULLMAG_PREVIEW_MATRIX_MODE", "m")
SURFACE = os.environ.get("FULLMAG_PREVIEW_MATRIX_SURFACE", "headless")
CADENCE = int(os.environ.get("FULLMAG_PREVIEW_EVERY_N", "10"))
MAX_STEPS = int(os.environ.get("FULLMAG_PREVIEW_MATRIX_MAX_STEPS", "52"))
ENERGY_QUALIFICATION = os.environ.get("FULLMAG_TASK5_ENERGY_QUALIFICATION", "")

if MODE not in {"disabled", "m", "H_demag", "full_cache"}:
    raise ValueError(f"unsupported FULLMAG_PREVIEW_MATRIX_MODE={MODE!r}")
if SURFACE not in {"headless", "interactive_no_browser", "control_room"}:
    raise ValueError(f"unsupported FULLMAG_PREVIEW_MATRIX_SURFACE={SURFACE!r}")
if ENERGY_QUALIFICATION not in {
    "",
    "dg0_ms",
    "uniaxial",
    "cubic",
    "interfacial_dmi",
    "bulk_dmi",
}:
    raise ValueError(
        f"unsupported FULLMAG_TASK5_ENERGY_QUALIFICATION={ENERGY_QUALIFICATION!r}"
    )

active_quantity = {
    "disabled": "m",
    "m": "m",
    "H_demag": "H_demag",
    # A global scalar disables the active vector lane while the normal cache
    # materializer continues to cover all cacheable spatial quantities.
    "full_cache": "E_total",
}[MODE]
interactive = SURFACE != "headless"

study = fm.study("fem_preview_surface_matrix")
study.engine("fem")
study.device("cpu" if ENERGY_QUALIFICATION == "dg0_ms" else "gpu", precision="double")
study.interactive(interactive)
study.wait_for_solve(interactive)
study.visualization(active_quantity_id=active_quantity)
study.universe(
    mode="auto",
    size=(160e-9, 120e-9, 80e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(maximum_element_size=80e-9)

body = study.geometry(fm.Box(120e-9, 80e-9, 20e-9), name="body")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.5
if ENERGY_QUALIFICATION in {"", "cubic"}:
    body.Kc1 = 48e3
if ENERGY_QUALIFICATION == "uniaxial":
    body.Ku1 = 48e3
    body.anisU = (0.0, 0.0, 1.0)
if ENERGY_QUALIFICATION == "interfacial_dmi":
    body.Dind = 1e-3
elif ENERGY_QUALIFICATION == "bulk_dmi":
    body.Dbulk = 1e-3
body.m = fm.texture.random(seed=7)
body.mesh(maximum_element_size=40e-9, order=1)

# A regional Ms override forces the native plan to use a non-uniform material
# coefficient while remaining inside the production-executable nodal contract.
if ENERGY_QUALIFICATION in {"", "dg0_ms"}:
    lower_ms = body.add_region(
        "lower_ms",
        fm.Box(size=(40e-9, 40e-9, 20e-9)),
        priority=20,
        realization_policy=("conformal" if ENERGY_QUALIFICATION == "dg0_ms" else "inherit"),
    )
    if ENERGY_QUALIFICATION == "dg0_ms":
        lower_ms.material_transition(kind="sharp")
    lower_ms.material.Ms = 400e3

study.build_domain_mesh()
study.demag(realization="poisson_robin")
study.b_ext(0.0, 0.0, 0.02)
study.solver(dt=1e-13)
fm.snapshot("H_demag", every=MAX_STEPS * 1e-13)
if ENERGY_QUALIFICATION == "dg0_ms":
    # The qualified CPU DG0 owner is consistent-mass exchange in ordinary
    # time evolution. Direct native relaxation algorithms remain fail-closed.
    # Select the representable endpoint at or immediately below N*dt so the
    # time-bounded runner does not append a sub-ulp residual step.
    study.run(math.nextafter(MAX_STEPS * 1e-13, 0.0))
else:
    study.relax(
        algorithm="llg_overdamped",
        max_steps=MAX_STEPS,
        tolA=1e-30,
        dt=1e-13,
    )
