"""Small FDM thin-film hysteresis validation fixture.

The fixture exercises the production hysteresis runtime on a tiny
100 nm x 20 nm x 10 nm strip. It compares an out-of-plane field with an
in-plane field that has a small azimuthal perturbation to avoid the exact
collinear torque-free saddle of deterministic minimization.
"""

import os

import fullmag as fm


NM = 1e-9
FIELD_VALUES_MT = [
    float(value.strip())
    for value in os.environ.get(
        "FULLMAG_HYSTERESIS_FIELD_VALUES_MT",
        "300,0,-300,0,300",
    ).split(",")
    if value.strip()
]
MAX_MINIMIZE_STEPS = int(os.environ.get("FULLMAG_HYSTERESIS_MAX_STEPS", "200"))
IN_PLANE_PHI_DEG = float(os.environ.get("FULLMAG_HYSTERESIS_IN_PLANE_PHI_DEG", "5.0"))
MAGNETIZATION_STORAGE = os.environ.get(
    "FULLMAG_HYSTERESIS_MAGNETIZATION_STORAGE",
    "none",
)

IN_PLANE_ORIENTATION = fm.FieldOrientation.sample(
    theta_deg=90.0,
    phi_deg=IN_PLANE_PHI_DEG,
)
OOP_ORIENTATION = fm.FieldOrientation.preset("oop_positive")

study = fm.study("hysteresis_fdm_thinfilm_oop_ip_validation")
study.engine("fdm")
study.device("cpu", precision="double")
study.universe(
    mode="manual",
    size=(100 * NM, 20 * NM, 10 * NM),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.cell(10 * NM, 10 * NM, 10 * NM)

strip = study.geometry(
    fm.Box(size=(100 * NM, 20 * NM, 10 * NM), name="thinfilm_strip"),
    name="thinfilm_strip",
)
strip.Ms = 800e3
strip.Aex = 13e-12
strip.alpha = 0.8
strip.m = fm.texture.uniform(0.999, 0.0447, 0.0)

study.demag()
study.solver(dt=1e-13)
study.tableautosave(
    1e-13,
    quantities=["time", "step", "mx", "my", "mz", "E_total", "max_torque"],
)
study.stages.add_hysteresis_sweep(
    field_values_mT=FIELD_VALUES_MT,
    orientation=IN_PLANE_ORIENTATION,
    measurement_axis="field_axis",
    angular_family=fm.HysteresisAngularFamily(
        family_id="thinfilm_oop_ip",
        label="Thin-film OOP/IP validation",
        variants=[
            fm.HysteresisAngularVariant(
                "ip_near_x",
                IN_PLANE_ORIENTATION,
                label=f"In-plane phi={IN_PLANE_PHI_DEG:g} deg",
                measurement_axis="field_axis",
            ),
            fm.HysteresisAngularVariant(
                "oop",
                OOP_ORIENTATION,
                label="Out of plane",
                measurement_axis="field_axis",
            ),
        ],
    ),
    initial_protocol="as_authored",
    branch_mode="major_loop",
    settle_pipeline=fm.SettlePipeline(
        [
            fm.MinimizeStep(
                method="projected_gradient_bb",
                torque_tolerance=2e-4,
                energy_tolerance=1e-19,
                max_steps=MAX_MINIMIZE_STEPS,
                on_non_convergence="continue_with_warning",
            )
        ],
    ),
    storage=fm.HysteresisStorage(
        scalar_history=True,
        magnetization=MAGNETIZATION_STORAGE,
        every_n=1,
        key_events=False,
    ),
)
