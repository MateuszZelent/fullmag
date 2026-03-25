"""Two-body FDM multilayer demag smoke example.

Two Py layers are stacked along z and coupled only through demagnetization.
Exchange remains body-local by default.

Run with:
    fullmag examples/fdm_multibody_two_layer_stack.py
"""

from __future__ import annotations

import fullmag as fm

DEFAULT_UNTIL = 2e-13


def build() -> fm.Problem:
    free_geom = fm.Box(size=(40e-9, 20e-9, 2e-9), name="free_geom").translate((0.0, 0.0, 0.0))
    ref_geom = fm.Box(size=(40e-9, 20e-9, 2e-9), name="ref_geom").translate((0.0, 0.0, 4e-9))

    py = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.2)
    free = fm.Ferromagnet(
        name="free",
        geometry=free_geom,
        material=py,
        m0=fm.uniform((1, 0, 0)),
    )
    ref = fm.Ferromagnet(
        name="ref",
        geometry=ref_geom,
        material=py,
        m0=fm.uniform((0, 1, 0)),
    )

    return fm.Problem(
        name="fdm_multibody_two_layer_stack",
        magnets=[free, ref],
        energy=[fm.Exchange(), fm.Demag()],
        study=fm.TimeEvolution(
            dynamics=fm.LLG(fixed_timestep=1e-13),
            outputs=[
                fm.SaveScalar("E_ex", every=1e-13),
                fm.SaveScalar("E_demag", every=1e-13),
                fm.SaveScalar("E_total", every=1e-13),
            ],
        ),
        discretization=fm.DiscretizationHints(
            fdm=fm.FDM(
                default_cell=(2e-9, 2e-9, 2e-9),
                demag=fm.FDMDemag(
                    strategy="multilayer_convolution",
                    mode="two_d_stack",
                ),
            ),
        ),
        runtime=fm.backend.engine("fdm"),
    )

problem = build()
