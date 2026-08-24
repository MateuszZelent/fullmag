"""Single Permalloy layer with a centered bimeron and one prism layer.

Geometry:
    - Permalloy layer: 2000 nm x 600 nm x 1.6 nm.
    - No CoFeB rings or other magnetic bodies.
    - Exactly one first-order prism element through the layer thickness.

The bimeron is centered at the origin in the xy plane. Its far-field
magnetization points along +x, the center points along -x, and the two meron
cores have opposite out-of-plane components.

Run with:
    fullmag --dev -i examples/permalloy_layer_bimeron_prism_single_layer_relax_300nm.py
"""

import os

import fullmag as fm


NM = 1e-9
MINIMIZE_MAX_STEPS = int(
    os.environ.get("FULLMAG_BIMERON_MINIMIZE_MAX_STEPS", "6000")
)

LAYER_SIZE = (2000 * NM, 600 * NM, 1.6 * NM)
BIMERON_RADIUS = 150 * NM
BIMERON_WALL_WIDTH = 40 * NM


study = fm.study("permalloy_layer_bimeron_prism_single_layer_relax_300nm")

# Engine
study.engine("fem")
study.device("gpu", precision="double")
study.universe(
    mode="auto",
    size=(2.8e-6, 2.1e-6, 1.2e-6),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)

study.universe.mesh(maximum_element_size=500 * NM, minimum_element_size=10 * NM)
study.interactive(True)

study.airbox.visualization(show=True, mode="vectors", active_quantity_id="h_eff", wireframe=False)

# Geometry and materials
layer = study.geometry(
    fm.Box(size=LAYER_SIZE, name="permalloy_layer"),
    name="permalloy_layer",
)
layer.Ms = 1.6e6
layer.Aex = 15e-12
layer.alpha = 0.001
layer.Ku1 = 1e5
layer.anisU = (0, 0, 1)
layer.m = fm.texture.bimeron(
    radius=BIMERON_RADIUS,
    wall_width=BIMERON_WALL_WIDTH,
    vorticity=1,
    helicity_rad=0.0,
    background_sign=1,
    plane="xy",
)
layer.mesh.thin_film(
    maximum_element_size=20 * NM,
    minimum_element_size=1.6 * NM,
    order=1,
    layers=1,
    topology="prismatic",
    exact_layers=True,
    transition="pyramid_to_tetrahedra",
)

# Interactions, mesh, and solver
# study.exchange()
study.demag(realization="poisson_robin")
study.objects.mesh.defaults(
    algorithm_2d=6,
    algorithm_3d=10,
    size_factor=1,
    size_from_curvature=0,
    smoothing_steps=4,
    optimize="Gmsh",
    optimize_iterations=4,
    narrow_regions=0,
    compute_quality=True,
    per_element_quality=True,
)
study.build_domain_mesh()

# study.solver(dt=1e-18, integrator="heun", g=2.115)
study.stages.add_relax(
    stage_id="bimeron_minimize",
    algorithm="projected_gradient_bb",
    max_steps=MINIMIZE_MAX_STEPS,
    tolA=1e-4,
).tableautosave(
    every_steps=1,
    quantities=["t", "step", "mx", "my", "mz", "E_total"],
)

# study.stages.add_relax(
#     algorithm="llg_overdamped",
#     solver="rk23",
#     max_error=1e-6,
#     dt_min=1e-17,
#     dt_max=1e-13,
#     max_steps=100,
#     tolA=1e-4,
# )
