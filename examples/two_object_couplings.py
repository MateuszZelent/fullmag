"""Two physical objects with explicit exchange and RKKY coupling intent.

Different magnetic objects do not exchange-couple by default. This example
declares both object-object exchange and surface-surface RKKY explicitly so the
authored coupling intent survives planning, diagnostics, and script export.
"""

import fullmag as fm


study = fm.study("two_object_couplings")
study.engine("fem")
study.device("cpu", precision="double")
study.universe(
    mode="auto",
    size=(220e-9, 140e-9, 120e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(minimum_element_size=2e-9, maximum_element_size=60e-9)

free_layer = study.geometry(
    fm.Box(size=(100e-9, 80e-9, 2e-9), name="free_layer").translate((0.0, 0.0, 1.5e-9)),
    name="free_layer",
)
reference_layer = study.geometry(
    fm.Box(
        size=(100e-9, 80e-9, 2e-9),
        name="reference_layer",
    ).translate((0.0, 0.0, -1.5e-9)),
    name="reference_layer",
)

for layer in (free_layer, reference_layer):
    layer.Ms = 800e3
    layer.Aex = 13e-12
    layer.alpha = 0.02

free_layer.m = fm.texture.uniform(1.0, 0.0, 0.0)
reference_layer.m = fm.texture.uniform(-1.0, 0.0, 0.0)

study.couplings.exchange(
    free_layer,
    reference_layer,
    mode="explicit",
    inter_exchange=6.5e-12,
    coupling_id="free_layer_reference_exchange",
)
study.couplings.rkky(
    free_layer.surface("top"),
    reference_layer.surface("bottom"),
    J1=-0.3e-3,
    coupling_id="free_layer_reference_rkky",
)

study.exchange()
study.demag(realization="poisson_robin")
study.stages.add_relax(
    algorithm="llg_overdamped",
    solver="rk23",
    max_error=1e-6,
    dt_min=1e-17,
    dt_max=1e-14,
    max_steps=200,
    tolA=1e-4,
)
