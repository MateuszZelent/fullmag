"""Named native FEM Zhang-Li CPU/GPU time-domain workload.

This is intentionally a public Problem/runner workload, not a native test
binary.  It uses the checked-in skew tetra mesh, sampled nonuniform initial
magnetization, fixed-step Heun integration, and exactly ten LLG steps.
"""

from __future__ import annotations

import os
from pathlib import Path

import fullmag as fm


ASSET_DIR = Path(__file__).with_name("assets")
REFINEMENT = int(os.environ.get("FULLMAG_ZHANG_LI_REFINEMENT", "0"))
MESH_PATH = ASSET_DIR / f"zhang_li_skew_tetra_r{REFINEMENT}.mesh.json"
STEPS = int(os.environ.get("FULLMAG_ZHANG_LI_STEPS", "10"))
# A binary-exact default makes ten fixed steps terminate exactly at `until`,
# avoiding a roundoff-only partial final step in the public time loop.
DT_S = float(os.environ.get("FULLMAG_ZHANG_LI_DT_S", repr(2.0**-50)))
CURRENT_SIGN = float(os.environ.get("FULLMAG_ZHANG_LI_CURRENT_SIGN", "1"))
DEFAULT_UNTIL = STEPS * DT_S


def sampled_magnetization() -> fm.init.SampledMagnetization:
    """Sample one smooth physical initial state at every P1 mesh node."""
    nodes = __import__("json").loads(MESH_PATH.read_text(encoding="utf-8"))["nodes"]
    return fm.init.SampledMagnetization(
        [(1.0 + x / 20e-9, y / 10e-9, 0.2 + z / 10e-9) for x, y, z in nodes]
    )


def build() -> fm.Problem:
    body = fm.Box(size=(20e-9, 10e-9, 10e-9), name="body")
    material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.02)
    # Sampling the same smooth state at each refinement preserves the public
    # P1 authoring path while making spatial convergence meaningful.
    m0 = sampled_magnetization()
    magnet = fm.Ferromagnet(name="body", geometry=body, material=material, m0=m0)
    return fm.Problem(
        name="fem_zhang_li_skew_tetra_runtime",
        magnets=[magnet],
        energy=[fm.Exchange()],
        spin_torque=fm.ZhangLiSTT(
            current_density=(CURRENT_SIGN * 8.0e12, 0.0, 0.0),
            degree=0.55,
            beta=0.08,
        ),
        study=fm.TimeEvolution(
            dynamics=fm.LLG(integrator="heun", fixed_timestep=DT_S),
            outputs=[fm.SaveField("m", every=DT_S), fm.SaveScalar("E_total", every=DT_S)],
        ),
        discretization=fm.DiscretizationHints(
            fem=fm.FEM(order=1, maximum_element_size=20e-9, mesh=str(MESH_PATH)),
        ),
    )


problem = build()
