"""Relax a periodic uniform Permalloy film slab with exchange-coupled repeats.

Geometry:
    - Permalloy film: 200 nm x 200 nm x 10 nm.
    - Periodic unit cell: 200 nm x 200 nm laterally, so opposite magnetic
      boundaries touch their periodic neighbours.
    - No hole: this is the minimal static PBC-demag seam diagnostic before
      the antidot geometry.
    - PBC is intentionally x/y only: this is a 2D film array with open z,
      not a fully 3D-periodic stack.

Run with:
    fullmag --dev -i examples/fem_periodic_uniform_slab_relax_exchange_coupled.py
"""

import fullmag as fm


study = fm.study("fem_periodic_uniform_slab_relax")

# Engine and universe
study.engine("fem")
study.device("gpu", precision="double")
study.universe(
    mode="manual",
    size=(200e-9, 200e-9, 90e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    minimum_element_size=5e-9,
    maximum_element_size=20e-9,
    growth_rate=1.5,
)
study.pbc(x=True, y=True, demag="periodic_airbox_k0")
study.interactive(True)

# Geometry
film = fm.Box(size=(200e-9, 200e-9, 10e-9), name="periodic_uniform_slab_base")
body = study.geometry(film, name="periodic_uniform_slab_film")

# Material and mesh
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.02
body.m = fm.init.UniformMagnetization((0.0, 1.0, 0.0))
body.mesh.thin_film(
    minimum_element_size=5e-9,
    maximum_element_size=10e-9,
    curvature_factor=0.25,
    narrow_region_resolution=1.5,
    layers=1,
    order=1,
)

# Scenario provenance
study.runtime_metadata(
    "periodic_antidot_relaxation",
    {
        "scenario": "uniform_slab",
        "exchange_coupled_across_periods": True,
        "magnetostatic_pbc": "periodic_airbox_k0",
        "periodic_pair_ids": ["x_faces", "y_faces"],
        "film_size_m": [200e-9, 200e-9, 10e-9],
        "universe_size_m": [200e-9, 200e-9, 90e-9],
        "lateral_air_gap_m": [0.0, 0.0],
    },
)

# Interactions, mesh, and solver
study.b_ext(10e-3, 0.0, 0.0)
study.demag(realization="poisson_robin")
study.fem_demag_solver(
    solver="CG",
    preconditioner="AMG",
    rtol=1e-12,
    max_iterations=500,
)
study.objects.mesh.defaults(
    algorithm_2d=6,
    algorithm_3d=1,
    smoothing_steps=1,
    optimize_iterations=1,
    size_from_curvature=8,
    narrow_regions=1,
)
study.build_domain_mesh()
study.solver(dt=1e-13, g=2.115)
study.tableautosave(
    1e-12,
    quantities=[
        "time",
        "step",
        "mx",
        "my",
        "mz",
        "e_ex",
        "e_demag",
        "E_total",
        "max_h_demag",
        "max_torque",
    ],
)
study.save("m", every=10e-12)
study.save("H_demag", every=10e-12)
study.save("H_eff", every=10e-12)
study.save("demag_phi", every=10e-12)

study.stages.add_relax(
    algorithm="projected_gradient_bb",
    max_steps=120,
    tolA=5.0e2,  # A/m
)
