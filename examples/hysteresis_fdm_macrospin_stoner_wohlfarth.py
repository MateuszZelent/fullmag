"""Small FDM macrospin hysteresis validation fixture.

This one-cell uniaxial case is deliberately kept in the FDM CPU reference lane.
It is not a publication benchmark by itself, but it exercises the Stoner-
Wohlfarth-style angular trend through the real hysteresis runtime artifacts.
"""

import os

import fullmag as fm


FIELD_VALUES_MT = [
    float(value.strip())
    for value in os.environ.get(
        "FULLMAG_HYSTERESIS_FIELD_VALUES_MT",
        "35,25,15,5,-5,-15,-25,-35,-25,-15,-5,5,15,25,35",
    ).split(",")
    if value.strip()
]
MAX_MINIMIZE_STEPS = int(os.environ.get("FULLMAG_HYSTERESIS_MAX_STEPS", "2000"))
NEAR_EASY_AXIS_THETA_DEG = float(os.environ.get("FULLMAG_HYSTERESIS_NEAR_EASY_AXIS_THETA_DEG", "30.0"))
NEAR_EASY_AXIS_ORIENTATION = fm.FieldOrientation.sample(
    theta_deg=NEAR_EASY_AXIS_THETA_DEG,
    phi_deg=0.0,
)

study = fm.study("hysteresis_fdm_macrospin_stoner_wohlfarth")
study.engine("fdm")
study.device("cpu", precision="double")
study.universe(
    mode="manual",
    size=(5e-9, 5e-9, 5e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.cell(5e-9, 5e-9, 5e-9)

macrospin = study.geometry(
    fm.Box(size=(5e-9, 5e-9, 5e-9), name="macrospin"),
    name="macrospin",
)
macrospin.Ms = 800e3
macrospin.Aex = 1.0e-12
macrospin.Ku1 = 8.0e3
macrospin.anisU = (0.0, 0.0, 1.0)
macrospin.alpha = 1.0
macrospin.m = fm.texture.uniform(0.02, 0.0, 0.9998)

study.demag(enabled=False)
study.solver(dt=1e-13)
study.tableautosave(
    1e-13,
    quantities=["time", "step", "mx", "my", "mz", "E_total", "max_torque"],
)
study.stages.add_hysteresis_sweep(
    field_values_mT=FIELD_VALUES_MT,
    orientation=NEAR_EASY_AXIS_ORIENTATION,
    measurement_axis="field_axis",
    angular_family=fm.HysteresisAngularFamily(
        family_id="macrospin_sw_angles",
        label="Macrospin Stoner-Wohlfarth angular trend",
        variants=[
            fm.HysteresisAngularVariant(
                "easy_axis",
                NEAR_EASY_AXIS_ORIENTATION,
                label=f"Near easy axis ({NEAR_EASY_AXIS_THETA_DEG:g} deg)",
                measurement_axis="field_axis",
            ),
            fm.HysteresisAngularVariant(
                "theta45",
                fm.FieldOrientation.sample(theta_deg=45.0, phi_deg=0.0),
                label="Theta 45",
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
                torque_tolerance=5e-4,
                energy_tolerance=1e-24,
                max_steps=MAX_MINIMIZE_STEPS,
                on_non_convergence="continue_with_warning",
            )
        ],
    ),
    storage=fm.HysteresisStorage(
        scalar_history=True,
        magnetization="none",
        every_n=1,
        key_events=False,
    ),
)
