"""Small fixed-final-time FEM workload for regional-drive RK order gates."""

import os
import fullmag as fm


integrator = os.environ.get("FULLMAG_RK_INTEGRATOR", "rk4")
dt = float(os.environ.get("FULLMAG_RK_DT_S", "1e-14"))
until = float(os.environ.get("FULLMAG_RK_UNTIL_S", "2e-12"))
device = os.environ.get("FULLMAG_FEM_EXECUTION", "cpu")
waveform_kind = os.environ.get("FULLMAG_DRIVE_WAVEFORM", "sinusoidal")
drive_frequency_hz = float(os.environ.get("FULLMAG_DRIVE_FREQUENCY_HZ", "5e9"))

study = fm.study("fem_regional_field_drive_manufactured")
study.engine("fem")
study.device(device, precision="double")
magnet = study.geometry(fm.Box(size=(4e-9, 4e-9, 4e-9), name="macrospin"), name="macrospin")
magnet.Ms = 800e3
magnet.Aex = 13e-12
magnet.alpha = 0.01
magnet.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.b_ext(0.0, 0.0, 20e-3)
study.exchange(enabled=False)
study.demag(enabled=False)
study.solver(integrator=integrator, dt=dt, g=2.0)
waveform = (
    fm.Pulse(t_on=0.35 * until, t_off=0.65 * until)
    if waveform_kind == "pulse"
    else fm.PiecewiseLinear(points=((0.0, 0.0), (0.35 * until, 1.0), (0.65 * until, -0.5), (until, 0.0)))
    if waveform_kind == "piecewise_linear"
    else fm.Sinusoidal(frequency_hz=drive_frequency_hz)
)
study.field_drives.add(
    fm.RegionalFieldDrive(
        id="manufactured-sine",
        name="Manufactured sinusoid",
        target=fm.FieldTarget.global_domain(),
        amplitude_B_T=1e-3,
        direction=(0.0, 1.0, 0.0),
        spatial_profile=fm.UniformFieldProfile(),
        waveform=waveform,
        time_origin="stage_local",
        activation=fm.DriveActivation.stage_ids(["run"]),
    )
)
study.tableautosave(dt, quantities=["time", "mx", "my", "mz", "E_drive", "E_total"])
study.stages.add_run(stage_id="run", until=until, output_every=dt)
