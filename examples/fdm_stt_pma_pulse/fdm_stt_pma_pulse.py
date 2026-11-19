"""Fullmag FDM translation of the supplied MuMax3 PMA-film pulse study."""

from math import cos, pi, radians, sin

import fullmag as fm

GRID = (512, 256, 1)
SIZE = (1600e-9, 800e-9, 1.7e-9)
CELL = (3.125e-9, 3.125e-9, 1.7e-9)
FIELD_AZIMUTH = radians(88.0)
JZ = -2.6e10
PREPARATION_DURATION = 20e-9
BEFORE_PULSE_DURATION = 50e-9  # Advance the physical clock from 20 to 70 ns.
PULSE_DURATION = 200e-9
AFTER_PULSE_DURATION = 100e-9
GAMMA = 1.7595e11 * (4.0 * pi * 1e-7)  # MuMax3 T^-1 s^-1 to Fullmag m/(A s)

study = fm.study("fdm_stt_pma_pulse")
study.engine("fdm")
study.device("gpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=SIZE, center=(0.0, 0.0, 0.0))
study.cell(*CELL)

film_shape = fm.Box(size=SIZE, name="film")
center_shape = fm.Box(size=(20e-9, 20e-9, SIZE[2]), name="center")
film = study.geometry(film_shape, name="film")
film.Ms = 521000.0
film.Aex = 15e-12
film.Ku1 = 161950.0
film.anisU = (0.0, 0.0, 1.0)
film.alpha = 1.0
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

# Like MuMax3 DefRegion(250, ...), the higher-priority center overwrites region 1.
current_region = film.add_region("current_region", film_shape, region_id="region-1")
film.add_region("center", center_shape, region_id="region-250", priority=1)

study.exchange()
study.demag()
study.b_ext(25e-3 * cos(FIELD_AZIMUTH), 25e-3 * sin(FIELD_AZIMUTH), 0.0)
study.solver(
    integrator="rk45", max_err=1e-7, dt_initial=1e-12,
    dt_min=1e-16, dt_max=1e-11, gamma=GAMMA,
)

# The canonical Fullmag torque uses m×p and m×(m×p), opposite to MuMax3's
# p×m and m×(p×m). Reverse the projected current via the stack normal to
# preserve MuMax3's FIXEDLAYER_TOP torque while keeping the authored Jz.
study.spin_torque(
    fm.SlonczewskiSTT(
        current_density=(0.0, 0.0, JZ),
        spin_polarization=(0.0, 1.0, 0.0),
        degree=0.21,
        lambda_asymmetry=1.0,
        epsilon_prime=0.0,
        free_layer_thickness_m=SIZE[2],
        id="slonczewski_pulse",
        target=fm.RegionRef("film", current_region.region_id),
        stack_normal=(0.0, 0.0, -1.0),
    )
)
# The two relaxations use a pseudotime clock. Fullmag requires a torque stop
# policy, while MuMax3's default relax() follows energy and torque trends.
relaxation = {
    "algorithm": "llg_overdamped",
    "relax_alpha": 1.0,
    "solver": "rk23",
    "dt_initial": 1e-12,
    "max_err": 1e-9,
    "dt_min": 1e-16,
    "dt_max": 1e-11,
    "tolT": 1e-6,
    "max_steps": 250000,
}
study.clear_outputs()
# Keep the same torque inventory and magnetization topology across the study.
study.stages.set_spin_torque_enabled(module_id="slonczewski_pulse", enabled=False)
study.stages.add_relax(stage_id="initial_relaxation", **relaxation)
study.stages.tableautosave(1e-12, quantities=("t", "mx", "my", "mz", "e_total"))
study.stages.add_run(PREPARATION_DURATION, stage_id="preparation")
# Physical-time table cadence applies only to dynamics.
study.stages.tableautosave(enabled=False)
study.stages.add_relax(stage_id="second_relaxation", **relaxation)
study.stages.tableautosave(1e-12, quantities=("t", "mx", "my", "mz", "e_total"))

film.alpha = 0.045

# Keep the 1 ps table and the original 5 ns full-vector snapshot cadence.
# Uncompressed f64 vectors at 24 GHz for both runs exceed the available disk.
study.stages.autosave("m", every=5e-9)
study.stages.add_run(BEFORE_PULSE_DURATION, stage_id="before_pulse")

study.stages.set_spin_torque_enabled(module_id="slonczewski_pulse", enabled=True)
study.stages.add_run(PULSE_DURATION, stage_id="pulse")
study.stages.set_spin_torque_enabled(module_id="slonczewski_pulse", enabled=False)
study.stages.add_run(AFTER_PULSE_DURATION, stage_id="after_pulse")

study.storage(
    output_dir="/state/fdm-stt-pulse/fdm_stt_pma_pulse.zarr",
    temp_dir="/state/fdm-stt-pulse/.fullmag-tmp",
)
