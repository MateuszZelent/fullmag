"""Bounded FEM GPU fixture for preview materialization surface qualification."""

from __future__ import annotations

import os

import fullmag as fm


MODE = os.environ.get("FULLMAG_PREVIEW_MATRIX_MODE", "m")
SURFACE = os.environ.get("FULLMAG_PREVIEW_MATRIX_SURFACE", "headless")
CADENCE = int(os.environ.get("FULLMAG_PREVIEW_EVERY_N", "10"))
MAX_STEPS = int(os.environ.get("FULLMAG_PREVIEW_MATRIX_MAX_STEPS", "52"))

if MODE not in {"disabled", "m", "H_demag", "full_cache"}:
    raise ValueError(f"unsupported FULLMAG_PREVIEW_MATRIX_MODE={MODE!r}")
if SURFACE not in {"headless", "interactive_no_browser", "control_room"}:
    raise ValueError(f"unsupported FULLMAG_PREVIEW_MATRIX_SURFACE={SURFACE!r}")

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
study.device("gpu", precision="double")
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
body.m = fm.texture.random(seed=7)
body.mesh(maximum_element_size=40e-9, order=1)

study.build_domain_mesh()
study.exchange()
study.demag(realization="poisson_robin")
study.b_ext(0.0, 0.0, 0.02)
study.solver(dt=1e-13)
fm.snapshot("H_demag", every=MAX_STEPS * 1e-13)
study.relax(
    algorithm="llg_overdamped",
    max_steps=MAX_STEPS,
    tol=1e-30,
    dt=1e-13,
)
