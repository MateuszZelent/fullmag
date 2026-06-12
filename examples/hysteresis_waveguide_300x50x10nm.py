"""Tiny FEM hysteresis waveguide smoke test.

Geometry:
    - Permalloy waveguide: 300 nm x 50 nm x 10 nm.
    - Manual airbox: 1000 nm x 200 nm x 100 nm with deliberately sparse mesh.

This script is intentionally small enough for quick hysteresis-loop regression
checks. It exercises the canonical hysteresis stage, writes scalar loop points,
and can switch between lightweight average-only output and every-step
magnetization playback snapshots.

Run:
    just run-hysteresis-waveguide-smoke cpu
    just run-hysteresis-waveguide-playback-smoke cpu
"""

import os

import fullmag as fm


NM = 1e-9
FIELD_VALUES_MT = [
    float(value.strip())
    for value in os.environ.get(
        "FULLMAG_HYSTERESIS_FIELD_VALUES_MT",
        "50,25,0,-25,-50,-25,0,25,50",
    ).split(",")
    if value.strip()
]
MAX_MINIMIZE_STEPS = int(os.environ.get("FULLMAG_HYSTERESIS_MAX_STEPS", "200"))
MAGNETIZATION_STORAGE = os.environ.get(
    "FULLMAG_HYSTERESIS_MAGNETIZATION_STORAGE",
    "none",
)
ENABLE_ANGULAR_FAMILY = os.environ.get(
    "FULLMAG_HYSTERESIS_ANGULAR_FAMILY",
    "0",
).strip().lower() in {"1", "true", "yes", "on"}
ENABLE_SATURATION_PROBE = os.environ.get(
    "FULLMAG_HYSTERESIS_SATURATION_PROBE",
    "0",
).strip().lower() in {"1", "true", "yes", "on"}
ENABLE_MINOR_LOOP = os.environ.get(
    "FULLMAG_HYSTERESIS_MINOR_LOOP",
    "0",
).strip().lower() in {"1", "true", "yes", "on"}
SATURATION_MAX_FIELD_MT = float(
    os.environ.get("FULLMAG_HYSTERESIS_SATURATION_MAX_FIELD_MT", "20")
)
SATURATION_SUSCEPTIBILITY_THRESHOLD = float(
    os.environ.get("FULLMAG_HYSTERESIS_SATURATION_SUSCEPTIBILITY_THRESHOLD", "1e-12")
)
SATURATION_TRANSVERSE_THRESHOLD = float(
    os.environ.get("FULLMAG_HYSTERESIS_SATURATION_TRANSVERSE_THRESHOLD", "1e-12")
)
MINOR_LOOP_REVERSAL_MT = float(
    os.environ.get("FULLMAG_HYSTERESIS_MINOR_REVERSAL_MT", "50")
)
MINOR_LOOP_RETURN_MT = float(
    os.environ.get("FULLMAG_HYSTERESIS_MINOR_RETURN_MT", "-25")
)
INITIAL_PROTOCOL = (
    "positive_saturation" if ENABLE_SATURATION_PROBE else "as_authored"
)
BRANCH_MODE = "major_with_minor_loops" if ENABLE_MINOR_LOOP else "major_loop"

study = fm.study("hysteresis_waveguide_300x50x10nm")
study.engine("fem")
study.device("gpu", precision="double")
study.interactive(True)

study.universe(
    mode="manual",
    size=(1000 * NM, 200 * NM, 100 * NM),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    minimum_element_size=10 * NM,
    maximum_element_size=100 * NM,
    growth_rate=1.45,
)

waveguide = study.geometry(
    fm.Box(size=(300 * NM, 50 * NM, 10 * NM), name="py_waveguide"),
    name="py_waveguide",
)
waveguide.Ms = 800e3
waveguide.Aex = 13e-12
waveguide.alpha = 0.5
waveguide.m = fm.texture.uniform(0.0, 1.0, 0.0)
waveguide.mesh(
    minimum_element_size=5 * NM,
    maximum_element_size=25 * NM,
    order=1,
)

study.demag(realization="poisson_robin")
study.build_domain_mesh()
study.solver(dt=1e-13, g=2.115)
study.tableautosave(
    1e-12,
    quantities=["time", "step", "mx", "my", "mz", "E_total", "max_torque"],
)

study.stages.add_hysteresis_sweep(
    field_values_mT=FIELD_VALUES_MT,
    orientation=fm.FieldOrientation.preset("in_plane_x"),
    measurement_axis="field_axis",
    angular_family=(
        fm.HysteresisAngularFamily(
            family_id="waveguide_ip_oop_family",
            label="Waveguide IP/OOP family",
            variants=[
                fm.HysteresisAngularVariant(
                    "ip_x",
                    fm.FieldOrientation.preset("in_plane_x"),
                    label="In-plane x",
                    measurement_axis="field_axis",
                ),
                fm.HysteresisAngularVariant(
                    "oop",
                    fm.FieldOrientation.preset("oop_positive"),
                    label="OOP +z",
                    measurement_axis="field_axis",
                ),
                fm.HysteresisAngularVariant(
                    "custom_theta45_phi30",
                    fm.FieldOrientation.sample(theta_deg=45.0, phi_deg=30.0),
                    label="Custom theta=45 phi=30",
                    measurement_axis="field_axis",
                ),
            ],
        )
        if ENABLE_ANGULAR_FAMILY
        else None
    ),
    initial_protocol=INITIAL_PROTOCOL,
    saturation=(
        fm.SaturationProbe(
            max_field_mT=SATURATION_MAX_FIELD_MT,
            susceptibility_threshold=SATURATION_SUSCEPTIBILITY_THRESHOLD,
            transverse_threshold=SATURATION_TRANSVERSE_THRESHOLD,
        )
        if ENABLE_SATURATION_PROBE
        else None
    ),
    branch_mode=BRANCH_MODE,
    minor_loops=(
        [fm.MinorLoop(reversal_mT=MINOR_LOOP_REVERSAL_MT, return_mT=MINOR_LOOP_RETURN_MT)]
        if ENABLE_MINOR_LOOP
        else None
    ),
    settle_pipeline=fm.SettlePipeline(
        [
            fm.MinimizeStep(
                method="projected_gradient_bb",
                torque_tolerance=5e-5,
                energy_tolerance=1e-20,
                max_steps=MAX_MINIMIZE_STEPS,
                on_non_convergence="continue_with_warning",
            ),
        ],
    ),
    storage=fm.HysteresisStorage(
        scalar_history=True,
        magnetization=MAGNETIZATION_STORAGE,
        every_n=1,
        key_events=MAGNETIZATION_STORAGE == "key_events",
    ),
)
