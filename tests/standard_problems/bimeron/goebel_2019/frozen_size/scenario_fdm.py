"""FDM frozen-spin bimeron size-profile protocol.

Stages are deliberately explicit:

``initial_state`` -> ``constrained_relax`` -> ``constrained_hold`` ->
optional ``released_relax``.

The constraint reference is captured when the constrained stage activates.
The release stage retains the declaration as an inactive stage-scoped
reference, so its terminal state is a separate free relaxation result rather
than being confused with the constrained energy.
"""

from __future__ import annotations

import os

import fullmag as fm

from tests.standard_problems.bimeron.goebel_2019.frozen_size.common import (
    TRACK_SIZE,
    FrozenCase,
    alpha_from_environment,
    case_from_environment,
    material_from_environment,
)


CASE: FrozenCase = case_from_environment()
MATERIAL = material_from_environment()
RELAX_ALPHA = alpha_from_environment()
REQUESTED_DEVICE = os.environ.get("FULLMAG_BIMERON_DEVICE", "gpu").strip().lower()
if REQUESTED_DEVICE not in {"cpu", "gpu"}:
    raise ValueError("FULLMAG_BIMERON_DEVICE must be cpu or gpu")
RELAX_ALGORITHM = os.environ.get(
    "FULLMAG_BIMERON_RELAX_ALGORITHM", "llg_overdamped"
).strip().lower()
RELAX_ALGORITHM = {"bb": "projected_gradient_bb"}.get(
    RELAX_ALGORITHM, RELAX_ALGORITHM
)
if RELAX_ALGORITHM not in {"llg_overdamped", "projected_gradient_bb"}:
    raise ValueError(
        "FULLMAG_BIMERON_RELAX_ALGORITHM must be llg_overdamped or projected_gradient_bb"
    )

study = fm.study("goebel_2019_bimeron_frozen_size_fdm")
study.engine("fdm")
study.device(REQUESTED_DEVICE, precision="double")
study.mode("strict")
study.cell(*CASE.cell_m)
study.pbc(x=True, demag="truncated_images")

film = study.geometry(fm.Box(size=TRACK_SIZE, name="film"), name="film")
film.Ms = MATERIAL.msat_Apm
film.Aex = MATERIAL.aex_Jpm
film.alpha = RELAX_ALPHA
film.Ku1 = MATERIAL.ku_Jpm3
film.anisU = (1.0, 0.0, 0.0)
film.m = fm.texture.bimeron(
    radius=CASE.preset_radius_m,
    wall_width=CASE.wall_width_m,
    vorticity=CASE.vorticity,
    helicity_rad=CASE.helicity_rad,
    background_sign=CASE.background_sign,
    plane="xy",
)

study.terms.add(fm.RotatedInterfacialDMI(D=MATERIAL.d_Jpm2))
study.demag(realization="auto")
study.solver(fix_dt=CASE.dt_s, integrator="rk45")
fm.runtime_metadata(
    "bimeron_frozen_size",
    {
        "schema_version": "bimeron_frozen_size.experiment.v1",
        "source_scenario": "tests/standard_problems/bimeron/goebel_2019/frozen_size/scenario_fdm.py",
        "texture_preset": "bimeron",
        "material_parameters_source": "explicit_material_metadata_with_environment_overrides",
        "relaxation_algorithm": RELAX_ALGORITHM,
        "alpha": RELAX_ALPHA,
        "relaxation_tolerance_T": CASE.relax_tol_T,
        "relaxation_algorithm_status": (
            "implemented_frozen_spins_path;experiment_qualification_requires_verification"
            if RELAX_ALGORITHM == "llg_overdamped"
            else "diagnostic_only;"
            "projected_gradient_bb_requires_separate_native_receipt_qualification"
        ),
        "profile_energy_stage": "constrained_hold",
        "hold_role": "frozen_stability_check",
        "track_size_m": list(TRACK_SIZE),
        "track_size_nm": [value * 1e9 for value in TRACK_SIZE],
        "protocol": CASE.metadata(),
        "material": MATERIAL.metadata(),
        "measurement": {
            "R_area": "sqrt(selected_connected_area(background_sign*mx<0)/pi)",
            "R_core": "half minimum-image distance between texture-local opposite mz extrema",
            "topological_charge": "Berg-Luscher plaquette sum",
            "energy": "E_total and component terms from solver trace",
        },
        "frozen_reference_policy": "capture_current_at_activation",
        "frozen_energy_policy": "constraint has no penalty energy; frozen cells retain all fields and energy terms",
    },
)


def _disk_selector(x_m: float, y_m: float, radius_m: float) -> fm.Selection:
    disk = fm.shapes.disk(
        radius=radius_m,
        thickness=CASE.cell_m[2],
        center=(x_m, y_m, 0.0),
        extrusion="finite",
    )
    return fm.select.inside(disk, frame="world", boundary="inclusive")


def _constraint_for_case() -> fm.FrozenSpins | None:
    if CASE.protocol == "p0":
        return None
    core_centres = CASE.core_centres_m
    left, right = (
        _disk_selector(x, y, CASE.pin_radius_m)
        for x, y in core_centres
    )
    if CASE.protocol == "p2":
        selector = left | right
    elif CASE.protocol == "p3":
        selector = left | right | _disk_selector(0.0, 0.0, CASE.pin_radius_m)
    elif CASE.protocol == "ring":
        ring_radius = CASE.target_radius_m + CASE.ring_radius_offset_nm * 1e-9
        outer_radius = ring_radius + CASE.ring_width_m / 2.0
        inner_radius = ring_radius - CASE.ring_width_m / 2.0
        if inner_radius <= 0.0:
            raise ValueError("ring width must be smaller than twice target radius")
        outer = _disk_selector(0.0, 0.0, outer_radius)
        inner = _disk_selector(0.0, 0.0, inner_radius)
        selector = outer & ~inner
    else:  # pragma: no cover - case_from_environment validates this
        raise AssertionError(CASE.protocol)
    return fm.FrozenSpins(
        id=f"bimeron-frozen-{CASE.protocol}",
        name=f"Bimeron frozen {CASE.protocol}",
        selector=selector,
        membership="static",
        reference="capture_current_at_activation",
        empty_selection="error",
        inactive_selection="warn_and_intersect",
    )


FROZEN = _constraint_for_case()
CONSTRAINTS = [FROZEN] if FROZEN is not None else []
TABLE_QUANTITIES = [
    "step",
    "t",
    "mx",
    "my",
    "mz",
    "e_ex",
    "e_demag",
    "e_ext",
    "e_ani",
    "e_dmi",
    "e_total",
    "max_torque_Apm",
    "max_torque_T",
]

study.stages.add_save_state(
    artifact_name="initial_m.zarr",
    format="zarr",
    dataset="m",
)

relax_kwargs: dict[str, object] = {
    "stage_id": "constrained_relax",
    "algorithm": RELAX_ALGORITHM,
    "max_steps": CASE.relax_max_steps,
    "tolT": CASE.relax_tol_T,
    "constraints": CONSTRAINTS,
}
if RELAX_ALGORITHM == "llg_overdamped":
    relax_kwargs.update(
        solver="rk45",
        dt=CASE.dt_s,
        max_physical_time_s=CASE.relax_time_s,
    )
relax = study.stages.add_relax(**relax_kwargs)
relax.autosave(
    fm.StageAutosave(
        target="constrained",
        layout="separate",
        table=fm.TableAutosave(
            every_steps=CASE.table_every_steps,
            quantities=TABLE_QUANTITIES,
            table_id="constrained_relax",
        ),
        fields=[fm.FieldAutosave("m", every_steps=CASE.field_every_steps)],
    )
)
study.stages.add_save_state(
    artifact_name="constrained_relaxed_m.zarr",
    format="zarr",
    dataset="m",
)

hold = study.stages.add_run(
    stage_id="constrained_hold",
    # ``add_run.until`` is the duration of this stage.  The runtime carries
    # the accumulated physical time between stages, so adding relax_time here
    # would silently double the requested hold interval.
    until=CASE.hold_time_s,
    constraints=CONSTRAINTS,
)
hold.autosave(
    fm.StageAutosave(
        target="constrained",
        layout="separate",
        table=fm.TableAutosave(
            t_sampl=CASE.hold_sample_period_s,
            quantities=TABLE_QUANTITIES,
            table_id="constrained_hold",
        ),
        fields=[fm.FieldAutosave("m", every=CASE.hold_sample_period_s)],
    )
)
study.stages.add_save_state(
    artifact_name="constrained_held_m.zarr",
    format="zarr",
    dataset="m",
)

if CASE.include_release:
    released = study.stages.add_relax(
        stage_id="released_relax",
        algorithm="llg_overdamped",
        solver="rk45",
        dt=CASE.dt_s,
        max_steps=CASE.release_max_steps,
        max_physical_time_s=CASE.release_time_s,
        tolT=CASE.relax_tol_T,
    )
    released.autosave(
        fm.StageAutosave(
            target="released",
            layout="separate",
            table=fm.TableAutosave(
                every_steps=10,
                quantities=TABLE_QUANTITIES,
                table_id="released_relax",
            ),
            fields=[fm.FieldAutosave("m", every_steps=CASE.field_every_steps)],
        )
    )
    study.stages.add_save_state(
        artifact_name="released_m.zarr",
        format="zarr",
        dataset="m",
    )
