"""Uniform driven k=0 response control for the Table I linear A5 model.

This tests three prescribed RF fields, not a solved antenna, propagation
or the experimental Co/Ni sample. See physics note 0951 for preregistration.
"""

# %% Explicit execution intent
import math
import fullmag as fm

MU0 = 4e-7 * math.pi
study = fm.study("fdm_sushruth_2020_k0_rf_response")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")

# %% One uniform degree of freedom in SI
study.universe(
    mode="manual", size=(20e-9, 20e-9, 20e-9),
    center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0),
)
study.cell(20e-9, 20e-9, 20e-9)
body = study.geometry(fm.Box(size=(20e-9, 20e-9, 20e-9)), name="k0_control")
body.Ms = 0.89 / MU0
# Required positive material value; exchange is explicitly disabled below.
body.Aex = 13e-12
body.alpha = 0.01
body.m = fm.texture.uniform(0.0, 0.0, 1.0)
study.exchange(enabled=False)
study.demag(enabled=False)
study.b_ext(0.0, 0.0, 0.25)

# %% Known transverse RF fields; cosine convention and explicit stage clock
for drive_id, frequency_hz in (
    ("k0-rf-6ghz", 6e9), ("k0-rf-7p5ghz", 7.5e9), ("k0-rf-9ghz", 9e9),
):
    study.field_drives.add(fm.RegionalFieldDrive(
        id=drive_id, name=drive_id, target=fm.FieldTarget.global_domain(),
        amplitude_B_T=MU0 * 0.1, direction=(1.0, 0.0, 0.0),
        spatial_profile=fm.UniformFieldProfile(),
        waveform=fm.Sinusoidal(frequency_hz=frequency_hz, phase_rad=math.pi / 2),
        time_origin="stage_local", activation=fm.DriveActivation.stage_ids(["k0_rf_response"]),
    ))
study.solver(fix_dt=1e-12, integrator="rk4", gamma=MU0 * math.tau * 30e9)
study.tableautosave(2e-12, quantities=["step", "time", "dt", "mx", "my", "mz"])
study.stages.add_run(until=24e-9, stage_id="k0_rf_response")
