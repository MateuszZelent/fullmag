"""Permalloy layer with two ultrathin CoFeB rings above and below it.

Geometry:
    - Permalloy base layer: 300 nm x 1000 nm x 10 nm.
    - CoFeB top ring: circular vertical annulus, 300 nm outer diameter,
      200 nm inner diameter, 1 nm thick along y; its lower outer edge is
      10 nm above the top surface.
    - CoFeB bottom ring: same vertical annulus; its upper outer edge is 10 nm
      below the bottom surface.

Run with:
    fullmag --dev -i examples/permalloy_layer_cofeb_rings_relax_300nm.py
"""

import fullmag as fm


NM = 1e-9

LAYER_SIZE = (300 * NM, 1000 * NM, 10 * NM)
RING_OUTER_RADIUS = 150 * NM
RING_INNER_RADIUS = 50 * NM
RING_WIDTH = RING_OUTER_RADIUS - RING_INNER_RADIUS
RING_THICKNESS = 50 * NM
RING_GAP_FROM_LAYER = 10 * NM
RING_AXIS = (0.0, 0.0, 1.0)
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
    size=(1.7e-6, 2.4e-6, 9.0e-7),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)

study.universe.mesh(maximum_element_size=350 * NM, minimum_element_size=20 * NM)
study.interactive(True)

study.airbox.visualization(show=True, mode="vectors", active_quantity_id="h_eff", wireframe=False)

# Geometry and materials
layer = study.geometry(
    fm.Box(size=LAYER_SIZE, name="permalloy_layer"),
    name="permalloy_layer",
)
layer.Ms = 800e3
layer.Aex = 1.3e-12
layer.alpha = 0.15
# layer.Ku1 = 0.0
# layer.anisU = RING_AXIS
layer.m = fm.texture.uniform(0.0, 1.0, 0.0)
layer.mesh(maximum_element_size=8 * NM, minimum_element_size=2 * NM, order=1)

top_ring = study.geometry(
    ring_geometry("cofeb_top_ring", RING_CENTER_Z),
    name="cofeb_top_ring",
)
bottom_ring = study.geometry(
    ring_geometry("cofeb_bottom_ring", -RING_CENTER_Z),
    name="cofeb_bottom_ring",
)

for ring in (top_ring, bottom_ring):
    ring.Ms = 1.51e6
    ring.Aex = 15e-12
    ring.alpha = 0.1
    ring.Ku1 = 1.0e6
    ring.anisU = RING_AXIS
    ring.m = fm.texture.uniform(*RING_AXIS)
    ring.mesh(maximum_element_size=50 * NM, minimum_element_size=5 * NM, order=1)

# Interactions, mesh, and solver
# study.exchange()
study.demag(realization="poisson_robin")
study.objects.mesh.defaults(
    algorithm_2d=6,
    algorithm_3d=10,
    size_factor=1,
    size_from_curvature=0,
    smoothing_steps=1,
    optimize_iterations=1,
    narrow_regions=0,
    compute_quality=True,
    per_element_quality=True,
)
study.build_domain_mesh()

study.solver(dt=1e-18, integrator="heun", g=2.115)
study.save("m", every=1e-16)
study.save("E_total", every=1e-16)
study.tableautosave(1e-16, quantities=["t", "step", "mx", "my", "mz", "E_total"])


study.stages.add_minimize(
    method="bb",
    max_steps=4000,
    tol=1e-30,
)