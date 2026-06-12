"""Permalloy 300 nm x 1000 nm x 10 nm strip with a central hole.

This is a FEM modal dynamics test case:

1. relax the initial state of a thin Permalloy strip with a central cylindrical
   through-hole,
2. assemble the linearized LLG eigenproblem around that relaxed equilibrium,
3. write the modal spectrum and a small set of mode profiles.

Run with the managed FEM runtime, for example:

    just run-permalloy-box-relax-headless cpu

The eigenmodes path is the modal eigensolver companion product. It is not the
driven frequency-response solver.
"""

import fullmag as fm


STRIP_SIZE = (300e-9, 1000e-9, 10e-9)
HOLE_RADIUS = 40e-9
HOLE_HEIGHT = 16e-9
N_MODES = 12


study = fm.study("permalloy_strip_hole_eigenmodes_300x1000x10nm")
study.engine("fem")
study.device("cpu", precision="double")

study.universe(
    mode="auto",
    size=(700e-9, 1400e-9, 180e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(minimum_element_size=5e-9, maximum_element_size=120e-9)
study.airbox.visualization(
    show=True,
    mode="vectors",
    active_quantity_id="h_eff",
    wireframe=False,
)

strip = study.geometry(
    fm.Box(size=STRIP_SIZE, name="permalloy_strip")
    - fm.Cylinder(radius=HOLE_RADIUS, height=HOLE_HEIGHT, name="central_hole"),
    name="permalloy_strip_with_hole",
)
strip.Ms = 800e3
strip.Aex = 13e-12
strip.alpha = 0.02
strip.m = fm.texture.uniform(0.02, 1.0, 0.0)
strip.mesh(minimum_element_size=5e-9, maximum_element_size=20e-9, order=1)

hole_refinement = strip.add_region(
    "hole_edge_refinement",
    fm.Cylinder(
        radius=HOLE_RADIUS + 25e-9,
        height=HOLE_HEIGHT,
        name="hole_refinement",
    ),
    priority=10,
    realization_policy="conformal",
)
hole_refinement.mesh(
    minimum_element_size=2.5e-9,
    maximum_element_size=7.5e-9,
    order=1,
)

study.demag(realization="poisson_robin")
study.solver(dt=1e-13, g=2.115)
study.tableautosave(
    1e-12,
    quantities=["time", "step", "mx", "my", "mz", "E_total"],
)

study.save("m", every=25e-12)
study.save("H_eff", every=25e-12)
study.save("spectrum")
study.save("mode", indices=(0, 1, 2, 3))

study.stages.add_relax(
    algorithm="llg_overdamped",
    solver="rk23",
    max_steps=500,
    tol=1e-5,
)
study.stages.add_eigenmodes(
    count=N_MODES,
    target="lowest",
    include_demag=True,
    equilibrium_source="relax",
    normalization="unit_l2",
    damping_policy="ignore",
    bc="free",
)
