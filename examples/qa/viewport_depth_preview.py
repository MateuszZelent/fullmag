"""Paused viewport fixture using the physical CoFeB ring scene dimensions.

The accepted startup contract requires an authored stage and prepares FEM mesh
assets before the wait gate. This fixture never starts Solve automatically.
Its visual evidence does not qualify the physical model or solver.
"""

import fullmag as fm


NM = 1e-9
LAYER_SIZE = (2000 * NM, 600 * NM, 1.6 * NM)
RING_OUTER_RADIUS = 150 * NM
RING_INNER_RADIUS = 50 * NM
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
study.engine("fem")
study.device("gpu", precision="double")
study.interactive(True)
study.wait_for_solve(True)

study.universe(
    mode="auto",
    size=(2.8e-6, 2.1e-6, 1.2e-6),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(maximum_element_size=500 * NM, minimum_element_size=10 * NM)
study.airbox.visualization(
    show=True,
    mode="vectors",
    active_quantity_id="h_eff",
    wireframe=False,
)

layer = study.geometry(
    fm.Box(size=LAYER_SIZE, name="permalloy_layer"),
    name="permalloy_layer",
)
layer.Ms = 1.6e6
layer.Aex = 15e-12
layer.alpha = 0.001
layer.Ku1 = 1e5
layer.anisU = (0, 0, 1)
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
top_ring.Ms = 1.51e6
top_ring.Aex = 15e-12
top_ring.alpha = 0.1
top_ring.Ku1 = 1.0e6
top_ring.anisU = RING_AXIS
top_ring.m = fm.texture.uniform(1, 0, 0)
top_ring.mesh(
    maximum_element_size=25 * NM,
    minimum_element_size=2.5 * NM,
    order=1,
)

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

# Accepted startup requires a real authored stage, even when paused before Solve.
study.stages.add_minimize(method="bb", max_steps=10, tolA=1e-4)
