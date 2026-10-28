"""FDM twin of ``permalloy_layer_cofeb_rings_relax_300nm.py`` (same geometry).

Geometry and materials match the FEM example exactly:
    - Base layer "permalloy_layer": 2000 nm x 600 nm x 1.6 nm box centred at
      the origin.
    - CoFeB top ring "cofeb_top_ring": vertical annulus whose axis is x,
      300 nm outer / 100 nm inner diameter (radii 150 nm / 50 nm), 50 nm long
      along x; its lower outer edge is 10 nm above the layer's top surface.

Engine: FDM on CPU. Multi-body FDM always uses the multilayer convolution,
and its CUDA lane is not yet qualified for a ring laterally offset from the
layer, so the CPU multilayer lane is the executable one for this geometry.

Grid: 10 nm x 10 nm x 1.6 nm cells, so the layer is exactly one cell thick
and the ring is voxelized from the same CSG solids. The universe is
2200 nm x 800 nm x 313.6 nm (220 x 80 x 196 = 3 449 600 cells): it starts at
the layer's bottom face and ends just above the ring, with 100 nm of air on
each side in x and y. Cells outside the magnetic support form the FDM Airbox.

Study: a bounded overdamped-LLG relaxation of
``FULLMAG_COFEB_RINGS_MINIMIZE_MAX_STEPS`` steps (default 10), the same step
budget as the FEM example's minimization. Accepted FDM GPU execution has no
Barzilai-Borwein minimizer (that GPU path is FEM-only), so relaxation is the
closest FDM stage. This pair is a runtime/visualization fixture; the coarse
in-plane cells do not resolve the exchange length, so it is not a physics
comparison.

Run with:
    fullmag --dev -i examples/permalloy_layer_cofeb_rings_relax_300nm_fdm.py
"""

import os

import fullmag as fm


NM = 1e-9
# Same environment knob and default as the FEM example.
MINIMIZE_MAX_STEPS = int(os.environ.get("FULLMAG_COFEB_RINGS_MINIMIZE_MAX_STEPS", "10"))

LAYER_SIZE = (2000 * NM, 600 * NM, 1.6 * NM)
RING_OUTER_RADIUS = 150 * NM
RING_INNER_RADIUS = 50 * NM
RING_THICKNESS = 50 * NM
RING_GAP_FROM_LAYER = 10 * NM
RING_AXIS = (1.0, 0.0, 0.0)
RING_CENTER_Z = (LAYER_SIZE[2] / 2.0) + RING_GAP_FROM_LAYER + RING_OUTER_RADIUS

CELL = (10 * NM, 10 * NM, 1.6 * NM)
UNIVERSE_CELLS = (220, 80, 196)
UNIVERSE_SIZE = tuple(count * size for count, size in zip(UNIVERSE_CELLS, CELL))
# The grid starts at the layer's bottom face, so the layer fills cell row 0.
UNIVERSE_CENTER_Z = -LAYER_SIZE[2] / 2.0 + UNIVERSE_SIZE[2] / 2.0


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


study = fm.study("permalloy_layer_cofeb_rings_relax_300nm_fdm")

study.engine("fdm")
# Multi-body FDM is planned as a multilayer stack; its CUDA operators are not
# qualified for this layer/ring offset (push-pull, xy offset), so the CPU
# multilayer path runs this geometry.
study.device("cpu", precision="double")
study.universe(
    mode="manual",
    size=UNIVERSE_SIZE,
    center=(0.0, 0.0, UNIVERSE_CENTER_Z),
    padding=(0.0, 0.0, 0.0),
)
study.cell(*CELL)
study.interactive(True)

study.airbox.visualization(show=True, mode="vectors", active_quantity_id="h_eff", wireframe=False)

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

study.demag()
# 1.6 nm cells across the ring make its exchange field ~1e7 A/m; an
# explicit 1e-13 s step is at the stability edge, so step at 1e-14 s.
study.solver(fix_dt=1e-14, integrator="heun", g=2.115)

study.stages.add_relax(
    algorithm="llg_overdamped",
    dt=1e-14,
    tolA=1e-4,
    max_steps=MINIMIZE_MAX_STEPS,
).tableautosave(
    every_steps=1,
    quantities=["step", "t", "dt", "mx", "my", "mz", "E_total"],
)
