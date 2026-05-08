"""FEM eigenmodes example — linearized LLG spin-wave spectrum.

Computes the normal-mode spectrum of a 200×50×10 nm Permalloy box under
50 mT applied along x using the CPU FEM eigen baseline solver.  The
lowest ``N_MODES`` eigenfrequencies and the spatial profiles of the first
three modes are written to the artifact directory.

The equilibrium state is obtained by relaxing the initial uniform
magnetization under the applied field before assembling the linearized
operator.

Physics background
------------------
For a thin magnetic film magnetized along x under an in-plane field H_x,
the uniform Kittel mode frequency is:

    f_K = (γ·μ₀)/(2π) · sqrt(H_x · (H_x + Ms))

For Py (Ms = 800 kA/m) at B = 50 mT (H_x ≈ 39 790 A/m):

    f_K ≈ 7–8 GHz

The lowest FEM eigenfrequencies should approach this value as the mesh
is refined toward a uniform state.

Usage
-----
    fullmag examples/fem_eigenmodes.py --headless

or with explicit CPU execution:

    FULLMAG_FEM_EXECUTION=cpu fullmag examples/fem_eigenmodes.py --headless

Artifacts written to workspace artifacts/eigen/:
    spectrum.json       — full mode list with frequencies
    modes/mode_0000.json — spatial profile of mode 0
    modes/mode_0001.json — spatial profile of mode 1
    modes/mode_0002.json — spatial profile of mode 2
    metadata/           — normalization and provenance
"""

from pathlib import Path

import fullmag as fm

MESH_PATH = Path(__file__).with_name("assets").joinpath("bench_box_fine.mesh.json")

N_MODES = 10
APPLIED_B = (0.05, 0.0, 0.0)  # 50 mT along x


def build() -> fm.Problem:
    body = fm.Box(size=(200e-9, 50e-9, 10e-9), name="body")
    material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.5)
    magnet = fm.Ferromagnet(
        name="body",
        geometry=body,
        material=material,
        m0=fm.texture.uniform((1.0, 0.0, 0.0)),
    )

    return fm.Problem(
        name="fem_eigenmodes",
        magnets=[magnet],
        energy=[
            fm.Exchange(),
            fm.Demag(),
            fm.Zeeman(B=APPLIED_B),
        ],
        study=fm.Eigenmodes(
            count=N_MODES,
            target="lowest",
            equilibrium_source="relax",
            include_demag=True,
            normalization="unit_l2",
            damping_policy="ignore",
            outputs=[
                fm.SaveSpectrum(),
                fm.SaveMode(indices=(0, 1, 2)),
            ],
        ),
        discretization=fm.DiscretizationHints(
            fem=fm.FEM(order=1, maximum_element_size=3e-9, mesh=str(MESH_PATH)),
        ),
    )


if __name__ == "__main__":
    problem = build()
    # runtime dispatch picks the CPU FEM eigen baseline lane for eigen studies
    fm.Simulation(problem, backend="fem").run()
