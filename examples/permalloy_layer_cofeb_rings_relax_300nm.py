"""Thin magnetic layer with one CoFeB ring above it (FEM, energy minimization).

Geometry (as executed):
    - Base layer "permalloy_layer": 2000 nm x 600 nm x 1.6 nm box centred at
      the origin, meshed as a swept prism layer (one element through thickness).
    - CoFeB top ring "cofeb_top_ring": vertical annulus whose axis is x,
      300 nm outer / 100 nm inner diameter (radii 150 nm / 50 nm), 50 nm long
      along x; its lower outer edge is 10 nm above the layer's top surface.
    - The bottom ring below the layer is kept as a commented-out block and is
      not part of this model.

Study (as executed):
    - One minimization stage (``add_minimize``, method "bb") limited to
      ``MINIMIZE_MAX_STEPS`` steps; the default is 10 and can be changed with
      the ``FULLMAG_COFEB_RINGS_MINIMIZE_MAX_STEPS`` environment variable.
    - The LLG relax stage is commented out; despite the file name no relax
      stage runs. ``FULLMAG_COFEB_RINGS_RELAX_MAX_STEPS`` only matters if that
      block is re-enabled with ``max_steps=RELAX_MAX_STEPS``.

Run with:
    fullmag --dev -i examples/permalloy_layer_cofeb_rings_relax_300nm.py
"""

import os

import fullmag as fm


NM = 1e-9
# Default matches the previously hard-coded stage limit of 10 steps.
MINIMIZE_MAX_STEPS = int(os.environ.get("FULLMAG_COFEB_RINGS_MINIMIZE_MAX_STEPS", "10"))
RELAX_MAX_STEPS = int(os.environ.get("FULLMAG_COFEB_RINGS_RELAX_MAX_STEPS", "10000"))

LAYER_SIZE = (2000 * NM, 600 * NM, 1.6 * NM)
RING_OUTER_RADIUS = 150 * NM
RING_INNER_RADIUS = 50 * NM
RING_WIDTH = RING_OUTER_RADIUS - RING_INNER_RADIUS
RING_THICKNESS = 50 * NM
RING_GAP_FROM_LAYER = 10 * NM
RING_AXIS = (1.0, 0.0, 0.0)
RING_CENTER_Z = (LAYER_SIZE[2] / 2.0) + RING_GAP_FROM_LAYER + RING_OUTER_RADIUS


def ring_geometry(name: str, z_center: float) -> object:
    outer = fm.Cylinder(
        radius=RING_OUTER_RADIUS,
        height=RING_THICKNESS,
        axis=RING_AXIS,
        name=f"{name}_outer",
    )
    inner = fm.Cylinder(
        radius=RING_INNER_RADIUS,
        height=RING_THICKNESS,
        axis=RING_AXIS,
        name=f"{name}_inner",
    )
    return (outer - inner).translate((0.0, 0.0, z_center))


study = fm.study("permalloy_layer_cofeb_rings_relax_300nm")

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
layer.anisU = (0,0,1)
layer.m = fm.texture.uniform(-1.0, 0.0, 0.0)
layer.mesh(
    maximum_element_size=20 * NM,
    minimum_element_size=1.6 * NM,
    order=1,
    mesh_strategy="swept_prism",
    topology="prismatic",
    through_thickness_elements=1,
    through_thickness_distribution="fixed",
    sweep_face_meshing="triangular",
    sweep_direction="auto",
    element_family="prism",
    transition_policy="pyramid_to_tetrahedra",
    exact_layer_count=True,
)

top_ring = study.geometry(
    ring_geometry("cofeb_top_ring", RING_CENTER_Z),
    name="cofeb_top_ring",
)
# bottom_ring = study.geometry(
#     ring_geometry("cofeb_bottom_ring", -RING_CENTER_Z),
#     name="cofeb_bottom_ring",
# )

# for ring in (bottom_ring,):
#     ring.Ms = 1.51e6
#     ring.Aex = 15e-12
#     ring.alpha = 0.1
#     ring.Ku1 = 1.0e6
#     ring.anisU = RING_AXIS
#     ring.m = fm.texture.uniform(1,0,0)
#     ring.mesh(maximum_element_size=25 * NM, minimum_element_size=2.5 * NM, order=1)
for ring in (top_ring,):
    ring.Ms = 1.51e6
    ring.Aex = 15e-12
    ring.alpha = 0.1
    ring.Ku1 = 1.0e6
    ring.anisU = RING_AXIS
    ring.m = fm.texture.uniform(1,0,0)
    ring.mesh(maximum_element_size=25 * NM, minimum_element_size=2.5 * NM, order=1)

# Interactions, mesh, and solver
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
# study.save("m", every=1e-16)
# study.save("E_total", every=1e-16)
# Minimization has an iteration clock, so sample accepted steps rather than time.
study.tableautosave(every_steps=1, quantities=["t", "step", "mx", "my", "mz", "E_total"])


study.stages.add_minimize(
    method="bb",
    max_steps=MINIMIZE_MAX_STEPS,
    tolA=1e-4,
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
