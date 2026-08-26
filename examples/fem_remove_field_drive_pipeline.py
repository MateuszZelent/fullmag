"""Managed FEM qualification for ordered field-drive removal."""

import fullmag as fm


study = fm.study("fem_remove_field_drive_pipeline")
study.engine("fem")
study.device("cpu", precision="double")

magnet = study.geometry(
    fm.Box(size=(4e-9, 4e-9, 4e-9), name="macrospin"),
    name="macrospin",
)
magnet.Ms = 800e3
magnet.Aex = 13e-12
magnet.alpha = 0.1
magnet.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))

study.disable_exchange()
study.demag(enabled=False)
study.b_ext(0.0, 0.0, 20e-3)
study.solver(integrator="rk4", fix_dt=1e-14, g=2.0)


def drive(drive_id: str, direction: tuple[float, float, float]):
    return fm.RegionalFieldDrive(
        id=drive_id,
        name=drive_id,
        target=fm.FieldTarget.global_domain(),
        amplitude_B_T=1e-3,
        direction=direction,
        spatial_profile=fm.UniformFieldProfile(),
        waveform=fm.Constant(),
        time_origin="stage_local",
    )


study.stages.add_field_drive(drive("remove-me", (0.0, 1.0, 0.0)), stage_id="add-remove-me")
study.stages.add_field_drive(drive("keep-me", (0.0, 0.0, 1.0)), stage_id="add-keep-me")
study.stages.add_run(stage_id="both-active", until=2e-14)
study.stages.remove_field_drive("remove-me", stage_id="remove-drive")
study.stages.add_run(stage_id="keep-only", until=2e-14)
