"""Public FDM/CUDA FP64 solved-current skyrmion racetrack fixture.

The module-level ``study`` is intentional: the script is a stage-first public
DSL workload, not a compositional helper.  It prepares a zero-current
skyrmion, checkpoints it, and starts every signed drive from that checkpoint.
"""

from __future__ import annotations

import fullmag as fm


TRACK_LENGTH = 512.0e-9
TRACK_WIDTH = 128.0e-9
HM_THICKNESS = 3.0e-9
FM_THICKNESS = 1.0e-9
CELL = (2.0e-9, 2.0e-9, 1.0e-9)
DRIVE_DURATION = 2.0e-9
FIXED_TIMESTEP = 1.0e-13
OUTPUT_PERIOD = 5.0e-12


def surface(object_id: str, face: str, normal: tuple[float, float, float]) -> fm.SurfaceRef:
    return fm.SurfaceRef(object_id, face, normal)


study = fm.study("racetrack_m1_v1_solved_current")
study.engine("fdm")
study.device("cuda:0", precision="double")
study.mode("strict")
study.universe(
    mode="manual",
    size=(TRACK_LENGTH, TRACK_WIDTH, HM_THICKNESS + FM_THICKNESS),
    center=(TRACK_LENGTH / 2.0, TRACK_WIDTH / 2.0, (HM_THICKNESS + FM_THICKNESS) / 2.0),
)
study.cell(*CELL)
study.exchange()
study.demag()
study.solver(integrator="rk4", fix_dt=FIXED_TIMESTEP, gamma=221_100.0)

fm_geometry = fm.Box(
    size=(TRACK_LENGTH, TRACK_WIDTH, FM_THICKNESS), name="fm_base"
).translate((TRACK_LENGTH / 2.0, TRACK_WIDTH / 2.0, HM_THICKNESS + FM_THICKNESS / 2.0))
fm_layer = study.geometry(fm_geometry, name="fm")
fm_layer.Ms = 5.8e5
fm_layer.Aex = 1.5e-11
fm_layer.alpha = 0.3
fm_layer.Ku1 = 8.0e5
fm_layer.anisU = (0.0, 0.0, 1.0)
fm_layer.Dind = 3.0e-3
fm_layer.m = (
    fm.texture.neel_skyrmion(
        radius=30.0e-9,
        wall_width=5.0e-9,
        chirality=1,
        core_polarity=1,
    )
    .with_mapping(space="world", projection="object_local")
    .translate(TRACK_LENGTH / 2.0, TRACK_WIDTH / 2.0, HM_THICKNESS + FM_THICKNESS / 2.0)
)

hm_geometry = fm.Box(
    size=(TRACK_LENGTH, TRACK_WIDTH, HM_THICKNESS), name="hm_base"
).translate((TRACK_LENGTH / 2.0, TRACK_WIDTH / 2.0, HM_THICKNESS / 2.0))
study.antenna_object(hm_geometry, name="hm")

hm = fm.RegionRef("hm")
ferromagnet = fm.RegionRef("fm")
charge_outer = [
    surface("hm", "y-", (0.0, -1.0, 0.0)),
    surface("hm", "y+", (0.0, 1.0, 0.0)),
    surface("hm", "z-", (0.0, 0.0, -1.0)),
    surface("fm", "y-", (0.0, -1.0, 0.0)),
    surface("fm", "y+", (0.0, 1.0, 0.0)),
    surface("fm", "z+", (0.0, 0.0, 1.0)),
]
spin_outer = [
    surface(object_id, face, normal)
    for object_id, face, normal in (
        ("hm", "x-", (-1.0, 0.0, 0.0)),
        ("hm", "x+", (1.0, 0.0, 0.0)),
        ("hm", "y-", (0.0, -1.0, 0.0)),
        ("hm", "y+", (0.0, 1.0, 0.0)),
        ("hm", "z-", (0.0, 0.0, -1.0)),
        ("fm", "x-", (-1.0, 0.0, 0.0)),
        ("fm", "x+", (1.0, 0.0, 0.0)),
        ("fm", "y-", (0.0, -1.0, 0.0)),
        ("fm", "y+", (0.0, 1.0, 0.0)),
        ("fm", "z+", (0.0, 0.0, 1.0)),
    )
]

study.current_transport(
    name="charge",
    model="ohmic_poisson",
    coupling="one_way",
    domain=[hm, ferromagnet],
    materials=[
        fm.ChargeTransportMaterialAssignment(hm, fm.ChargeTransportMaterial(5.0e6)),
        fm.ChargeTransportMaterialAssignment(
            ferromagnet, fm.ChargeTransportMaterial(1.0e6)
        ),
    ],
    boundaries=[
        fm.NormalCurrentElectrode(
            "terminal_x_minus",
            [
                surface("hm", "x-", (-1.0, 0.0, 0.0)),
                surface("fm", "x-", (-1.0, 0.0, 0.0)),
            ],
            outward_current_density_Apm2=0.0,
        ),
        fm.NormalCurrentElectrode(
            "terminal_x_plus",
            [
                surface("hm", "x+", (1.0, 0.0, 0.0)),
                surface("fm", "x+", (1.0, 0.0, 0.0)),
            ],
            outward_current_density_Apm2=0.0,
        ),
        fm.ChargeInsulating("insulating_outer", charge_outer),
    ],
    gauge=fm.ChargePotentialGauge("zero_mean"),
    solver=fm.ChargeSolverPolicy(
        engine="cg",
        relative_tolerance=1.0e-10,
        absolute_tolerance=0.0,
        max_iterations=10_000,
    ),
)
study.spin_transport(
    fm.SpinDriftDiffusion(
        id="spin",
        current_source_id="charge",
        domain=[hm, ferromagnet],
        materials=[
            fm.SpinTransportMaterialAssignment(
                hm,
                fm.SpinTransportMaterial(
                    sigma_s_Spm=5.0e6,
                    polarization_p=0.0,
                    theta_sh=0.2,
                    lambda_sf_m=1.5e-9,
                ),
            ),
            fm.SpinTransportMaterialAssignment(
                ferromagnet,
                fm.SpinTransportMaterial(
                    sigma_s_Spm=1.0e6,
                    polarization_p=0.4,
                    theta_sh=0.0,
                    lambda_sf_m=5.0e-9,
                    lambda_j_m=1.0e-9,
                    lambda_phi_m=1.0e-9,
                ),
            ),
        ],
        interfaces=[
            fm.MixingConductanceSpinInterface(
                id="hm_fm",
                normal_to_ferromagnet=(0.0, 0.0, 1.0),
                normal_side=hm,
                ferromagnet_side=ferromagnet,
                normal_surface=surface("hm", "z+", (0.0, 0.0, 1.0)),
                ferromagnet_surface=surface("fm", "z-", (0.0, 0.0, -1.0)),
                g_up_Spm2=2.5e14,
                g_down_Spm2=2.5e14,
                g_r_Spm2=5.0e14,
                g_i_Spm2=5.0e13,
            )
        ],
        boundaries=[fm.SpinInsulating("spin_insulating_outer", spin_outer)],
        solver=fm.SpinSolverPolicy(
            engine="native_m1_v1",
            relative_tolerance=1.0e-8,
            absolute_tolerance=0.0,
            max_iterations=500,
        ),
        requested_execution=fm.TransportExecution(
            discretization="fdm",
            device="gpu",
            precision="double",
            execution_mode="strict",
        ),
    )
)
study.spin_torque(fm.DriftDiffusionSpinTorque("transport_torque", "spin", ferromagnet))

for quantity in (
    "m",
    "V_electric",
    "J_charge",
    "spin_potential",
    "spin_current_tensor",
    "torque_stt",
):
    study.save(quantity, every=OUTPUT_PERIOD)

study.stages.set_spin_torque_enabled(
    module_id="transport_torque", enabled=False, stage_id="disable_transport_torque"
)
study.stages.add_relax(
    stage_id="relax_zero_current",
    algorithm="llg_overdamped",
    tolT=1.0e-6,
    max_steps=50_000,
    dt=FIXED_TIMESTEP,
)
study.stages.add_save_state(artifact_name="relaxed_zero_current", dataset="m")
study.stages.set_spin_torque_enabled(
    module_id="transport_torque", enabled=True, stage_id="drive_solved_current"
)

study.stages.add_load_state(artifact_name="relaxed_zero_current", dataset="m")
study.stages.set_transport_current(
    module_id="charge",
    terminal_outward_current_density_Apm2={"terminal_x_minus": 1.5e12, "terminal_x_plus": -1.5e12},
)
study.stages.add_run(DRIVE_DURATION, stage_id="drive_solved_current_minus_1_5")

study.stages.add_load_state(artifact_name="relaxed_zero_current", dataset="m")
study.stages.set_transport_current(
    module_id="charge",
    terminal_outward_current_density_Apm2={"terminal_x_minus": 1.0e12, "terminal_x_plus": -1.0e12},
)
study.stages.add_run(DRIVE_DURATION, stage_id="drive_solved_current_minus_1_0")

study.stages.add_load_state(artifact_name="relaxed_zero_current", dataset="m")
study.stages.set_transport_current(
    module_id="charge",
    terminal_outward_current_density_Apm2={"terminal_x_minus": 0.5e12, "terminal_x_plus": -0.5e12},
)
study.stages.add_run(DRIVE_DURATION, stage_id="drive_solved_current_minus_0_5")

study.stages.add_load_state(artifact_name="relaxed_zero_current", dataset="m")
study.stages.set_transport_current(
    module_id="charge",
    terminal_outward_current_density_Apm2={"terminal_x_minus": -0.5e12, "terminal_x_plus": 0.5e12},
)
study.stages.add_run(DRIVE_DURATION, stage_id="drive_solved_current_plus_0_5")

study.stages.add_load_state(artifact_name="relaxed_zero_current", dataset="m")
study.stages.set_transport_current(
    module_id="charge",
    terminal_outward_current_density_Apm2={"terminal_x_minus": -1.0e12, "terminal_x_plus": 1.0e12},
)
study.stages.add_run(DRIVE_DURATION, stage_id="drive_solved_current_plus_1_0")

study.stages.add_load_state(artifact_name="relaxed_zero_current", dataset="m")
study.stages.set_transport_current(
    module_id="charge",
    terminal_outward_current_density_Apm2={"terminal_x_minus": -1.5e12, "terminal_x_plus": 1.5e12},
)
study.stages.add_run(DRIVE_DURATION, stage_id="drive_solved_current_plus_1_5")
