"""Tracked FEM counterpart for the Gaussian-plane-wave contract tests."""

import fullmag as fm


study = fm.study("gaussian_plane_wave_fem_fixture")
study.engine("fem")
study.device("auto", precision="double")

yig = study.geometry(
    fm.Box(size=(1.0e-6, 4.0e-7, 2.0e-8), name="yig"),
    name="yig",
)
yig.Ms = 140.0e3
yig.Aex = 3.7e-12
yig.alpha = 0.01
yig.m = fm.texture.uniform(1.0, 0.0, 0.0)

py = study.geometry(
    fm.Box(size=(4.5e-6, 1.0e-6, 2.0e-8), name="py"),
    name="py",
)
py.Ms = 800.0e3
py.Aex = 13.0e-12
py.alpha = 0.01
py.m = fm.texture.uniform(1.0, 0.0, 0.0)

for index in range(100):
    gradient_region = py.add_region(
        f"py_ms_gradient_{index:03d}",
        fm.Box(size=(45.0e-9, 1.0e-6, 2.0e-8)),
        region_id=f"py:py_ms_gradient_{index:03d}",
        priority=index + 1,
    )
    gradient_region.material.Ms = 650.0e3 + index * 1.5e3

antenna = fm.GaussianPlaneWaveAntenna(
    id="mumax_4_5ghz_antenna",
    amplitude_B_T=1.0e-3,
    frequency_hz=4.5e9,
    wavelength_m=196.0e-9,
    sigma_x_m=196.0e-9,
    fwhm_y_m=440.0e-9,
    center_x_m=0.0,
    center_y_m=0.0,
    carrier_origin_x_m=0.0,
    activation=fm.DriveActivation.stage_ids(["antenna_run"]),
)
for drive in antenna.to_drives():
    study.field_drives.add(drive)

for index in range(98):
    study.stages.add_relax(
        stage_id=f"bias_minimize_{index:03d}",
        max_steps=1,
        dt=1.0e-13,
    )

study.stages.add_run(stage_id="antenna_run", until=1.0e-12)
